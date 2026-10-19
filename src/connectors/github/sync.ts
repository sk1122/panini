import { contentHash } from "../../domain/content-hash.js";
import { DomainError } from "../../domain/errors.js";
import type { TeamLedger } from "../../domain/team-ledger.js";
import type { EventAppendResult } from "../../domain/store.js";
import type {
	JsonValue,
	SourceEventInput,
	SourceInstallation,
} from "../../domain/types.js";
import type { GithubAppClient, GithubRepository } from "./app-client.js";

interface GithubBranch {
	name: string;
	commit: { sha: string };
	protected: boolean;
}

interface GithubPull {
	id: number;
	number: number;
	title: string;
	body: string | null;
	state: string;
	merged_at: string | null;
	updated_at: string;
	created_at: string;
	html_url: string;
	head: { ref: string; sha: string };
	base: { ref: string };
	user: { id: number; login: string } | null;
}

interface GithubCommit {
	sha: string;
	html_url: string;
	commit: {
		message: string;
		author: { date: string } | null;
		committer: { date: string } | null;
	};
	author: { id: number; login: string } | null;
}

interface GithubCompare {
	ahead_by: number;
	commits: GithubCommit[];
}

interface GithubReview {
	id: number;
	state: string;
	submitted_at: string | null;
	html_url: string;
	user: { id: number; login: string } | null;
}

interface GithubCheck {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	completed_at: string | null;
	html_url: string;
}

export interface GithubSyncClient extends Pick<
	GithubAppClient,
	"installationToken" | "installationRepositories" | "repositoryData"
> {}
export interface GithubSyncRecorder {
	record(input: SourceEventInput): Promise<EventAppendResult>;
}

function validTime(value: string | null | undefined, fallback: string): string {
	return value && !Number.isNaN(Date.parse(value))
		? new Date(value).toISOString()
		: fallback;
}

function connectionConfig(installation: SourceInstallation): {
	installationId: number;
	repositoryIds: number[];
	repositories: string[];
} {
	const { installationId, repositoryIds, repositories } = installation.config;

	if (
		typeof installationId !== "number" ||
		!Array.isArray(repositoryIds) ||
		!Array.isArray(repositories) ||
		repositoryIds.some((id) => typeof id !== "number") ||
		repositories.some((name) => typeof name !== "string") ||
		repositoryIds.length !== repositories.length
	) {
		throw new DomainError(
			"GitHub installation configuration is invalid.",
			"INVALID",
		);
	}
	return {
		installationId,
		repositoryIds: repositoryIds as number[],
		repositories: repositories as string[],
	};
}

export class GithubRepositorySync {
	constructor(
		private readonly client: GithubSyncClient,
		private readonly ledger: TeamLedger,
		private readonly recorder: GithubSyncRecorder,
	) {}

	async syncInstallation(
		installationId: string,
	): Promise<{ observed: number; incomplete: boolean }> {
		const installation = (await this.ledger.workspace()).installations.find(
			(item) =>
				item.id === installationId &&
				item.provider === "github" &&
				item.status !== "revoked" &&
				item.status !== "disabled",
		);

		if (!installation)
			throw new DomainError(
				"GitHub installation is not active.",
				"NOT_FOUND",
			);

		const config = connectionConfig(installation);
		const permissions = installation.config.permissions;
		const checksReadable =
			!permissions ||
			(typeof permissions === "object" &&
				!Array.isArray(permissions) &&
				permissions.checks === "read");
		// Discover with the current installation grant first. A scoped token requested
		// for a removed repository can fail before we get a chance to revoke its data.
		let available: GithubRepository[];

		try {
			const discoveryToken = await this.client.installationToken(
				config.installationId,
			);

			available =
				await this.client.installationRepositories(discoveryToken);
		} catch (error) {
			// Even a 403 can mean rate limiting, and a 404 can hide a private
			// resource. Revoke only after a successful repository listing proves
			// removal, or after a verified installation webhook/disconnect.
			await this.ledger.updateInstallation(
				installation.id,
				{
					status: "degraded",
					lastSyncAt: new Date().toISOString(),
					lastError:
						error instanceof Error ? error.message : String(error),
				},
				"connector:github",
			);
			return { observed: 0, incomplete: true };
		}

		const activeIds = config.repositoryIds.filter((id) =>
			available.some((repository) => repository.id === id),
		);
		let token: string | null = null;

		try {
			token =
				activeIds.length > 0
					? await this.client.installationToken(
							config.installationId,
							activeIds,
						)
					: null;
		} catch (error) {
			await this.ledger.updateInstallation(
				installation.id,
				{
					status: "degraded",
					lastSyncAt: new Date().toISOString(),
					lastError:
						error instanceof Error ? error.message : String(error),
				},
				"connector:github",
			);
			return { observed: 0, incomplete: true };
		}

		let observed = 0;
		let successfulRepositories = 0;
		let incomplete = false;

		for (const [index, repositoryId] of config.repositoryIds.entries()) {
			const name = config.repositories[index]!;
			const repository = available.find(
				(item) =>
					item.id === repositoryId &&
					item.full_name.toLowerCase() === name.toLowerCase(),
			);
			const resourceKey = `github:repository:${repositoryId}`;

			if (!repository) {
				const revokedCount =
					await this.ledger.revokeEvidenceByVisibility(
						"github",
						installation.installationKey,
						`github:repository:${name.toLowerCase()}`,
						"connector:github",
					);

				await this.ledger.updateConnectorSyncState(
					installation.id,
					resourceKey,
					{
						status: "revoked",
						revokedCount,
						lastAttemptAt: new Date().toISOString(),
						lastError:
							"Repository is no longer available to this installation.",
					},
				);
				incomplete = true;
				continue;
			}
			await this.ledger.updateConnectorSyncState(
				installation.id,
				resourceKey,
				{
					status: "running",
					lastAttemptAt: new Date().toISOString(),
					lastError: null,
				},
			);
			try {
				if (!token)
					throw new DomainError(
						"No selected repository is available to the installation.",
						"FORBIDDEN",
					);

				const result = await this.syncRepository(
					installation,
					token,
					repository,
					checksReadable,
				);

				successfulRepositories += 1;
				observed += result.observed;
				incomplete ||= result.incomplete;
				await this.ledger.updateConnectorSyncState(
					installation.id,
					resourceKey,
					{
						status: result.incomplete ? "degraded" : "healthy",
						lastSuccessAt: new Date().toISOString(),
						observedCount: result.observed,
						cursor: {
							coverage: result.incomplete
								? "bounded_backfill"
								: "default_plus_branch_comparisons",
							checks: checksReadable ? "included" : "not_granted",
							branchComparisonLimit: 1_000,
							fetchedAt: new Date().toISOString(),
						},
						lastError: result.incomplete
							? "Backfill reached its page or review/check limit."
							: null,
					},
				);
			} catch (error) {
				incomplete = true;
				await this.ledger.updateConnectorSyncState(
					installation.id,
					resourceKey,
					{
						status: "degraded",
						lastError:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}
		}
		await this.ledger.updateInstallation(
			installation.id,
			{
				status: incomplete ? "degraded" : "healthy",
				lastSyncAt: new Date().toISOString(),
				...(successfulRepositories > 0
					? { lastSuccessAt: new Date().toISOString() }
					: {}),
				lastError: incomplete
					? "One or more selected repositories have incomplete coverage."
					: null,
			},
			"connector:github",
		);
		return { observed, incomplete };
	}

	private async syncRepository(
		installation: SourceInstallation,
		token: string,
		repository: GithubRepository,
		checksReadable: boolean,
	): Promise<{ observed: number; incomplete: boolean }> {
		const name = repository.full_name;
		const root = `/repos/${encodeURIComponent(name.split("/")[0]!)}/${encodeURIComponent(name.split("/")[1]!)}`;
		const now = new Date().toISOString();
		let observed = 0;
		let incomplete = false;

		const record = async (
			kind: string,
			stableRef: string,
			sourceUrl: string | null,
			occurredAt: string,
			payload: JsonValue,
		) => {
			const hash = contentHash(payload);
			const sourceRef = `github:${repository.id}:${kind}:${stableRef}`;
			const observedAt = validTime(occurredAt, now);
			const previous = await this.ledger.latestEvidenceBySourceRef(
				"github",
				installation.installationKey,
				sourceRef,
			);
			const receipt = await this.recorder.record({
				provider: "github",
				installationKey: installation.installationKey,
				providerEventId: `${repository.id}:${kind}:${stableRef}:${hash}`,
				eventKind: kind,
				occurredAt: observedAt,
				fetchedAt: now,
				sourceRef,
				sourceUrl,
				contentHash: hash,
				visibility: `github:repository:${name.toLowerCase()}`,
				payloadVersion: "github-rest-v1",
				payload,
				supersedesEventId:
					previous && observedAt > previous.occurredAt
						? previous.id
						: null,
			});

			if (receipt.inserted) observed += 1;
		};

		const branches = await this.pages<GithubBranch>(
			token,
			`${root}/branches`,
			10,
		);

		incomplete ||= branches.incomplete;
		for (const branch of branches.items) {
			await record(
				"branch.snapshot",
				branch.name,
				`${repository.html_url}/tree/${encodeURIComponent(branch.name)}`,
				now,
				{
					repositoryId: repository.id,
					repository: name,
					branch: branch.name,
					sha: branch.commit.sha,
					protected: branch.protected,
					text: branch.name,
				},
			);
		}

		const pulls = await this.pages<GithubPull>(
			token,
			`${root}/pulls?state=all&sort=updated&direction=desc`,
			10,
		);

		incomplete ||= pulls.incomplete;
		for (const [index, pull] of pulls.items.entries()) {
			const reviews =
				index < 50
					? await this.client.repositoryData<GithubReview[]>(
							token,
							`${root}/pulls/${pull.number}/reviews?per_page=100`,
						)
					: [];

			if (index >= 50) incomplete = true;
			incomplete ||= reviews.length === 100;
			await record(
				"pull_request.snapshot",
				String(pull.id),
				pull.html_url,
				pull.updated_at,
				{
					repositoryId: repository.id,
					repository: name,
					pullId: pull.id,
					number: pull.number,
					title: pull.title,
					body: (pull.body ?? "").slice(0, 20_000),
					state: pull.state,
					mergedAt: pull.merged_at,
					head: pull.head.ref,
					headSha: pull.head.sha,
					base: pull.base.ref,
					authorId: pull.user?.id ?? null,
					authorLogin: pull.user?.login ?? null,
					reviews: reviews.map((review) => ({
						id: review.id,
						state: review.state,
						submittedAt: review.submitted_at,
						reviewerId: review.user?.id ?? null,
						reviewerLogin: review.user?.login ?? null,
						url: review.html_url,
					})),
					text: `${pull.title} ${(pull.body ?? "").slice(0, 20_000)} ${pull.head.ref}`,
				},
			);
		}

		const recordCommit = async (commit: GithubCommit) => {
			const committedAt = commit.commit.committer?.date;

			if (!committedAt || Number.isNaN(Date.parse(committedAt))) {
				incomplete = true;
				return; // Capture time and an inherited author date cannot establish commit creation.
			}
			await record(
				"commit.snapshot",
				commit.sha,
				commit.html_url,
				committedAt,
				{
					repositoryId: repository.id,
					repository: name,
					sha: commit.sha,
					message: commit.commit.message.slice(0, 20_000),
					authorId: commit.author?.id ?? null,
					authorLogin: commit.author?.login ?? null,
					text: commit.commit.message.slice(0, 20_000),
					authoredAt: commit.commit.author?.date
						? validTime(commit.commit.author.date, "") || null
						: null,
					committedAt: new Date(committedAt).toISOString(),
					timestampBasis: "committer",
				},
			);
		};

		const commits = await this.pages<GithubCommit>(
			token,
			`${root}/commits`,
			10,
		);

		incomplete ||= commits.incomplete;
		for (const commit of commits.items) await recordCommit(commit);

		// Compare observed heads so shared default-branch ancestors do not consume
		// the per-branch history budget. GitHub paginates comparison commits.
		const nonDefaultBranches = branches.items.filter(
			(branch) => branch.name !== repository.default_branch,
		);

		if (nonDefaultBranches.length > 50) incomplete = true;

		const base =
			branches.items.find(
				(branch) => branch.name === repository.default_branch,
			)?.commit.sha ?? repository.default_branch;

		for (const branch of nonDefaultBranches.slice(0, 50)) {
			const comparePath = `${root}/compare/${encodeURIComponent(`${base}...${branch.commit.sha}`)}`;

			try {
				let aheadBy = 0;

				for (let page = 1; page <= 10; page += 1) {
					const comparison =
						await this.client.repositoryData<GithubCompare>(
							token,
							`${comparePath}?per_page=100&page=${page}`,
						);

					if (
						!Number.isSafeInteger(comparison.ahead_by) ||
						comparison.ahead_by < 0 ||
						!Array.isArray(comparison.commits)
					) {
						incomplete = true;
						break;
					}
					aheadBy = comparison.ahead_by;
					for (const commit of comparison.commits)
						await recordCommit(commit);
					if (
						comparison.commits.length <
						Math.min(100, aheadBy - (page - 1) * 100)
					) {
						incomplete = true;
						break;
					}
					if (page * 100 >= aheadBy) break;
				}
				if (aheadBy > 1_000) incomplete = true;
			} catch {
				incomplete = true;
			}
		}

		if (checksReadable) {
			const headShas = [
				...new Set(pulls.items.map((pull) => pull.head.sha)),
			].slice(0, 50);

			if (pulls.items.length > headShas.length) incomplete = true;
			for (const sha of headShas) {
				const checks = await this.client.repositoryData<{
					check_runs: GithubCheck[];
				}>(token, `${root}/commits/${sha}/check-runs?per_page=100`);

				incomplete ||= checks.check_runs.length === 100;
				for (const check of checks.check_runs) {
					await record(
						"check_run.snapshot",
						String(check.id),
						check.html_url,
						check.completed_at ?? now,
						{
							repositoryId: repository.id,
							repository: name,
							sha,
							checkId: check.id,
							name: check.name,
							status: check.status,
							conclusion: check.conclusion,
							text: `${check.name} ${check.status} ${check.conclusion ?? ""}`,
						},
					);
				}
			}
		}
		return { observed, incomplete };
	}

	private async pages<T>(
		token: string,
		path: string,
		maxPages: number,
	): Promise<{ items: T[]; incomplete: boolean }> {
		const items: T[] = [];

		for (let page = 1; page <= maxPages; page += 1) {
			const separator = path.includes("?") ? "&" : "?";
			const batch = await this.client.repositoryData<T[]>(
				token,
				`${path}${separator}per_page=100&page=${page}`,
			);

			items.push(...batch);
			if (batch.length < 100) return { items, incomplete: false };
		}
		return { items, incomplete: true };
	}
}
