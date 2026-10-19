import { randomUUID } from "node:crypto";
import { contentHash } from "../../domain/content-hash.js";
import type { LedgerStore } from "../../domain/store.js";
import type { JsonValue } from "../../domain/types.js";

type GithubReader = {
	repositoryData<T>(token: string, path: string): Promise<T>;
	conditionalRepositoryData?<T>(
		token: string,
		path: string,
		etag: string | null,
	): Promise<
		| {
				kind: "fresh";
				data: T;
				etag: string | null;
		  }
		| { kind: "not_modified"; etag: string | null }
	>;
};
type Pull = {
	id: number;
	number: number;
	head: { sha: string };
	merged: boolean;
	merged_at: string | null;
};
type File = { filename: string; status: string; patch?: string; sha?: string };
type Check = {
	id: number;
	name: string;
	head_sha: string;
	status: string;
	conclusion: string | null;
	started_at?: string | null;
	completed_at?: string | null;
};
type Deployment = { id: number; sha: string; environment: string };
type DeploymentStatus = { id: number; state: string; created_at: string };
type Commit = { sha: string };

export interface GithubVerificationRequest {
	repository: string;
	pullNumber: number;
	requiredHeadSha: string;
	requiredChecks: string[];
	requiredDeploymentEnvironment: string | null;
	requireMerge?: boolean;
	token: string;
}

export interface GithubVerificationResult {
	state: "verified" | "insufficient" | "unresolved";
	reasonCodes: string[];
	observedHeadSha: string | null;
	requestCount: number;
	sourceEventId: string | null;
}

class VerificationLimit extends Error {
	constructor(readonly reasonCode: string) {
		super(reasonCode);
	}
}

export class GithubEvidenceVerifier {
	constructor(
		private readonly options: {
			client: GithubReader;
			store: LedgerStore;
			installationKey: string;
			maxRequests?: number;
			maxFiles?: number;
			maxBytes?: number;
			maxContextTokens?: number;
		},
	) {}

	async verify(
		input: GithubVerificationRequest,
	): Promise<GithubVerificationResult> {
		if (
			!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
			!Number.isSafeInteger(input.pullNumber) ||
			input.pullNumber < 1 ||
			!/^[0-9a-f]{40}$/i.test(input.requiredHeadSha) ||
			input.requiredChecks.some((name) => !name.trim())
		) {
			throw new Error("GitHub verification target is invalid.");
		}

		const root = `/repos/${input.repository}`;
		const sourceRef = `github:verification:${input.repository.toLowerCase()}:pull:${input.pullNumber}:sha:${input.requiredHeadSha.toLowerCase()}`;
		const previous =
			await this.options.store.getLatestSourceEventBySourceRef(
				"github",
				this.options.installationKey,
				sourceRef,
			);
		const previousPayload =
			previous?.payload &&
			typeof previous.payload === "object" &&
			!Array.isArray(previous.payload)
				? previous.payload
				: null;
		const previousCache =
			previous?.eventKind === "artifact.verification" &&
			previous.payloadVersion === "github-verification-v1" &&
			previousPayload?.requiredHeadSha === input.requiredHeadSha &&
			previousPayload.responseCache &&
			typeof previousPayload.responseCache === "object" &&
			!Array.isArray(previousPayload.responseCache)
				? (previousPayload.responseCache as Record<string, unknown>)
				: {};
		const responseCache: Record<string, { etag: string; data: JsonValue }> =
			{};
		const reasonCodes: string[] = [];
		const fetchedAt = new Date().toISOString();
		let requestCount = 0;
		let fetchedBytes = 0;
		let cachedBytes = 0;
		let observedHeadSha: string | null = null;
		let pullId: number | null = null;
		let mergeVerified = false;
		const files: {
			filename: string;
			status: string;
			sha: string | null;
			patch: string | null;
		}[] = [];
		const checks: {
			id: number;
			name: string;
			sha: string;
			status: string;
			conclusion: string | null;
			startedAt: string | null;
			completedAt: string | null;
		}[] = [];
		const deployments: {
			id: number;
			sha: string;
			environment: string;
			latestState: string | null;
			latestStateAt: string | null;
		}[] = [];

		const read = async <T>(path: string): Promise<T> => {
			if (requestCount >= (this.options.maxRequests ?? 10))
				throw new VerificationLimit("request_limit");
			requestCount += 1;

			const cached = previousCache[path];
			const prior =
				cached &&
				typeof cached === "object" &&
				!Array.isArray(cached) &&
				typeof (cached as { etag?: unknown }).etag === "string" &&
				"data" in cached
					? (cached as { etag: string; data: T })
					: null;
			let value: T;

			if (this.options.client.conditionalRepositoryData) {
				const response =
					await this.options.client.conditionalRepositoryData<T>(
						input.token,
						path,
						prior?.etag ?? null,
					);

				if (response.kind === "not_modified") {
					if (!prior)
						throw new Error(
							"GitHub returned 304 without cached data.",
						);
					value = prior.data;
					cachedBytes += Buffer.byteLength(
						JSON.stringify(value),
						"utf8",
					);
					responseCache[path] = {
						etag: response.etag ?? prior.etag,
						data: value as JsonValue,
					};
				} else {
					value = response.data;
					fetchedBytes += Buffer.byteLength(
						JSON.stringify(value),
						"utf8",
					);
					if (response.etag)
						responseCache[path] = {
							etag: response.etag,
							data: value as JsonValue,
						};
				}
			} else {
				value = await this.options.client.repositoryData<T>(
					input.token,
					path,
				);
				fetchedBytes += Buffer.byteLength(
					JSON.stringify(value),
					"utf8",
				);
			}
			if (
				fetchedBytes + cachedBytes >
				(this.options.maxBytes ?? 200_000)
			) {
				throw new VerificationLimit("text_limit");
			}
			return value;
		};

		try {
			const pull = await read<Pull>(`${root}/pulls/${input.pullNumber}`);

			pullId = pull.id;
			observedHeadSha = pull.head?.sha ?? null;
			if (observedHeadSha !== input.requiredHeadSha)
				reasonCodes.push("head_changed");
			if (
				input.requireMerge !== false &&
				(!pull.merged || !pull.merged_at)
			)
				reasonCodes.push("pull_not_merged");

			if (observedHeadSha === input.requiredHeadSha) {
				const commitPath = `${root}/git/commits/${input.requiredHeadSha}`;
				const priorCommit = previousCache[commitPath];
				const cachedCommit =
					priorCommit &&
					typeof priorCommit === "object" &&
					!Array.isArray(priorCommit) &&
					"data" in priorCommit &&
					typeof (priorCommit as { data?: unknown }).data ===
						"object" &&
					(priorCommit as { data?: Commit }).data?.sha ===
						input.requiredHeadSha
						? (priorCommit as { etag?: string; data: Commit })
						: null;
				let commit: Commit;

				if (cachedCommit) {
					commit = cachedCommit.data;
					cachedBytes += Buffer.byteLength(
						JSON.stringify(commit),
						"utf8",
					);
					if (
						fetchedBytes + cachedBytes >
						(this.options.maxBytes ?? 200_000)
					) {
						throw new VerificationLimit("text_limit");
					}
					responseCache[commitPath] = {
						etag: cachedCommit.etag ?? "",
						data: commit as JsonValue,
					};
				} else {
					commit = await read<Commit>(commitPath);
					responseCache[commitPath] = {
						etag: responseCache[commitPath]?.etag ?? "",
						data: commit as JsonValue,
					};
				}
				if (commit.sha !== input.requiredHeadSha)
					reasonCodes.push("commit_sha_mismatch");
				for (let page = 1; page <= 31; page += 1) {
					const batch = await read<File[]>(
						`${root}/pulls/${input.pullNumber}/files?per_page=100&page=${page}`,
					);

					if (!Array.isArray(batch))
						throw new Error(
							"GitHub returned an invalid files response.",
						);
					for (const file of batch) {
						files.push({
							filename: file.filename,
							status: file.status,
							sha: file.sha ?? null,
							patch: file.patch ?? null,
						});
					}
					if (files.length > (this.options.maxFiles ?? 20))
						throw new VerificationLimit("file_limit");
					if (batch.length < 100) break;
					if (page === 31)
						throw new VerificationLimit("file_pagination_limit");
				}

				const response = await read<{
					total_count: number;
					check_runs: Check[];
				}>(
					`${root}/commits/${input.requiredHeadSha}/check-runs?per_page=100&page=1`,
				);

				if (!Array.isArray(response.check_runs))
					throw new Error(
						"GitHub returned an invalid checks response.",
					);
				checks.push(
					...response.check_runs.map((check) => ({
						id: check.id,
						name: check.name,
						sha: check.head_sha,
						status: check.status,
						conclusion: check.conclusion,
						startedAt: check.started_at ?? null,
						completedAt: check.completed_at ?? null,
					})),
				);
				if (response.total_count > checks.length)
					reasonCodes.push("check_pagination_incomplete");
				for (const name of input.requiredChecks) {
					const matching = checks.filter(
						(check) =>
							check.name === name &&
							check.sha === input.requiredHeadSha,
					);

					const time = (check: (typeof checks)[number]) =>
						Date.parse(check.completedAt ?? check.startedAt ?? "");

					if (
						matching.length > 1 &&
						matching.some((check) => !Number.isFinite(time(check)))
					) {
						reasonCodes.push("check_order_unknown");
					}

					const latest = [...matching].sort(
						(left, right) =>
							time(right) - time(left) || right.id - left.id,
					)[0];

					if (
						!latest ||
						latest.status !== "completed" ||
						latest.conclusion !== "success"
					) {
						reasonCodes.push("check_missing_for_sha");
					}
				}
				if (input.requiredDeploymentEnvironment) {
					const response = await read<Deployment[]>(
						`${root}/deployments?sha=${input.requiredHeadSha}&per_page=100&page=1`,
					);

					if (!Array.isArray(response))
						throw new Error(
							"GitHub returned an invalid deployments response.",
						);
					if (response.length === 100)
						reasonCodes.push("deployment_pagination_incomplete");
					for (const deployment of response.filter(
						(item) =>
							item.sha === input.requiredHeadSha &&
							item.environment ===
								input.requiredDeploymentEnvironment,
					)) {
						const statuses = await read<DeploymentStatus[]>(
							`${root}/deployments/${deployment.id}/statuses?per_page=100&page=1`,
						);

						if (!Array.isArray(statuses))
							throw new Error(
								"GitHub returned an invalid deployment statuses response.",
							);
						if (statuses.length === 100)
							reasonCodes.push("status_pagination_incomplete");

						const latest = [...statuses].sort((a, b) =>
							b.created_at.localeCompare(a.created_at),
						)[0];

						deployments.push({
							id: deployment.id,
							sha: deployment.sha,
							environment: deployment.environment,
							latestState: latest?.state ?? null,
							latestStateAt: latest?.created_at ?? null,
						});
					}
					if (
						deployments.length > 1 &&
						deployments.some(
							(deployment) =>
								!deployment.latestStateAt ||
								!Number.isFinite(
									Date.parse(deployment.latestStateAt),
								),
						)
					) {
						reasonCodes.push("deployment_order_unknown");
					}

					const latest = [...deployments].sort(
						(left, right) =>
							Date.parse(right.latestStateAt ?? "") -
								Date.parse(left.latestStateAt ?? "") ||
							right.id - left.id,
					)[0];

					if (
						deployments.some(
							(deployment) =>
								deployment.id !== latest?.id &&
								deployment.latestStateAt ===
									latest?.latestStateAt,
						)
					) {
						reasonCodes.push("deployment_order_unknown");
					}
					if (latest?.latestState !== "success") {
						reasonCodes.push("deployment_missing");
					}
				}

				const latestPull = await read<Pull>(
					`${root}/pulls/${input.pullNumber}`,
				);

				if (
					latestPull.id !== pullId ||
					latestPull.head?.sha !== input.requiredHeadSha ||
					(input.requireMerge !== false &&
						(!latestPull.merged || !latestPull.merged_at))
				) {
					reasonCodes.push("head_changed_during_verification");
				} else {
					mergeVerified = Boolean(
						latestPull.merged && latestPull.merged_at,
					);
				}
			}
		} catch (error) {
			reasonCodes.push(
				error instanceof VerificationLimit
					? error.reasonCode
					: "provider_error",
			);
		}

		// UTF-8 bytes are a conservative upper bound on byte-level model tokens.
		// Keep the artifact portion of any later assessment below its own limit.
		const verificationContextBytes = Buffer.byteLength(
			JSON.stringify({
				repository: input.repository,
				pullNumber: input.pullNumber,
				requiredHeadSha: input.requiredHeadSha,
				observedHeadSha,
				files,
				checks,
				deployments,
				requiredChecks: input.requiredChecks,
				requiredDeploymentEnvironment:
					input.requiredDeploymentEnvironment,
			}),
			"utf8",
		);

		if (
			verificationContextBytes > (this.options.maxContextTokens ?? 12_000)
		) {
			reasonCodes.push("verification_context_limit");
		}

		const uniqueReasons = [...new Set(reasonCodes)];
		const state: GithubVerificationResult["state"] =
			uniqueReasons.length === 0
				? "verified"
				: uniqueReasons.includes("provider_error")
					? "unresolved"
					: "insufficient";
		const payload = {
			schemaVersion: 1,
			repository: input.repository,
			pullNumber: input.pullNumber,
			pullId,
			requiredHeadSha: input.requiredHeadSha,
			observedHeadSha,
			mergeVerified,
			requireMerge: input.requireMerge !== false,
			requiredChecks: input.requiredChecks,
			requiredDeploymentEnvironment: input.requiredDeploymentEnvironment,
			files,
			checks,
			deployments,
			fetchedAt,
			requestCount,
			fetchedBytes,
			cachedBytes,
			verificationContextBytes,
			responseCache,
			state,
			reasonCodes: uniqueReasons,
		};
		const event = await this.options.store.appendSourceEvent({
			provider: "github",
			installationKey: this.options.installationKey,
			providerEventId: `verification:${randomUUID()}`,
			eventKind: "artifact.verification",
			occurredAt: fetchedAt,
			fetchedAt,
			sourceRef,
			sourceUrl: `https://github.com/${input.repository}/pull/${input.pullNumber}`,
			contentHash: contentHash(payload),
			visibility: `github:repository:${input.repository.toLowerCase()}`,
			payloadVersion: "github-verification-v1",
			payload,
			supersedesEventId:
				previous && previous.occurredAt < fetchedAt
					? previous.id
					: null,
		});

		return {
			state,
			reasonCodes: uniqueReasons,
			observedHeadSha,
			requestCount,
			sourceEventId: event.event.id,
		};
	}
}
