import { createHmac, timingSafeEqual } from "node:crypto";
import { contentHash } from "../../domain/content-hash.js";
import type { TeamLedger } from "../../domain/team-ledger.js";
import type { EventAppendResult } from "../../domain/store.js";
import type {
	JsonValue,
	SourceEventInput,
	TaskStatus,
} from "../../domain/types.js";

export interface GithubEvidenceRecorder {
	record(input: SourceEventInput): Promise<EventAppendResult>;
}

export interface GithubWebhookPolicy {
	secret: string;
	installationKey: string;
	repositories: string[];
}

export interface GithubWebhookResult {
	outcome: "captured" | "duplicate" | "ignored" | "abstained";
	reason: string;
	eventId?: string;
	proposalId?: string;
}

export function verifyGithubSignature(
	secret: string,
	rawBody: Buffer,
	signature: string | undefined,
): boolean {
	if (!signature?.startsWith("sha256=")) return false;

	const expected = Buffer.from(
		createHmac("sha256", secret).update(rawBody).digest("hex"),
		"hex",
	);
	const provided = Buffer.from(signature.slice(7), "hex");

	return (
		expected.length === provided.length &&
		timingSafeEqual(expected, provided)
	);
}

function githubEvent(
	payload: Record<string, unknown>,
	eventName: string,
): {
	kind: string;
	text: string;
	sourceUrl: string | null;
	proposedStatus: TaskStatus | null;
} | null {
	if (eventName === "pull_request") {
		const pull = payload.pull_request as
			| {
					merged?: boolean;
					html_url?: string;
					title?: string;
					body?: string;
					head?: { ref?: string };
			  }
			| undefined;
		const action = String(payload.action ?? "unknown");

		if (
			!pull ||
			(action !== "closed" &&
				action !== "opened" &&
				action !== "synchronize")
		)
			return null;
		return {
			kind: pull.merged
				? "pull_request.merged"
				: `pull_request.${action}`,
			text: `${pull.title ?? ""} ${pull.body ?? ""} ${pull.head?.ref ?? ""}`,
			sourceUrl: pull.html_url ?? null,
			proposedStatus: pull.merged ? "review" : null,
		};
	}
	if (eventName === "check_run") {
		const check = payload.check_run as
			| {
					conclusion?: string;
					html_url?: string;
					name?: string;
					check_suite?: { head_branch?: string };
			  }
			| undefined;

		if (!check || payload.action !== "completed") return null;
		return {
			kind: `check_run.${check.conclusion ?? "unknown"}`,
			text: `${check.name ?? ""} ${check.check_suite?.head_branch ?? ""}`,
			sourceUrl: check.html_url ?? null,
			proposedStatus: null,
		};
	}
	if (eventName === "deployment_status") {
		const status = payload.deployment_status as
			| { state?: string; target_url?: string; environment_url?: string }
			| undefined;
		const deployment = payload.deployment as
			{ ref?: string; environment?: string } | undefined;

		if (!status) return null;
		return {
			kind: `deployment.${status.state ?? "unknown"}`,
			text: `${deployment?.ref ?? ""} ${deployment?.environment ?? ""}`,
			sourceUrl: status.environment_url ?? status.target_url ?? null,
			proposedStatus: status.state === "success" ? "review" : null,
		};
	}
	return null;
}

export class GithubWebhookAdapter {
	private readonly repositories: Set<string>;

	constructor(
		private readonly policy: GithubWebhookPolicy,
		private readonly recorder: GithubEvidenceRecorder,
		private readonly ledger: TeamLedger,
	) {
		this.repositories = new Set(
			policy.repositories.map((repository) => repository.toLowerCase()),
		);
	}

	async handle(
		headers: Record<string, string | string[] | undefined>,
		rawBody: Buffer,
	): Promise<GithubWebhookResult> {
		const signatureValue = headers["x-hub-signature-256"];
		const signature = Array.isArray(signatureValue)
			? signatureValue[0]
			: signatureValue;

		if (!verifyGithubSignature(this.policy.secret, rawBody, signature))
			throw new Error("GitHub webhook signature is invalid.");

		const deliveryValue = headers["x-github-delivery"];
		const eventValue = headers["x-github-event"];
		const deliveryId = Array.isArray(deliveryValue)
			? deliveryValue[0]
			: deliveryValue;
		const eventName = Array.isArray(eventValue)
			? eventValue[0]
			: eventValue;

		if (!deliveryId || !eventName)
			throw new Error("GitHub webhook delivery headers are missing.");

		const payload = JSON.parse(rawBody.toString("utf8")) as Record<
			string,
			unknown
		>;
		const lifecycle = await this.handleInstallationLifecycle(
			payload,
			eventName,
			deliveryId,
		);

		if (lifecycle) return lifecycle;

		const repository = payload.repository as
			{ full_name?: string; html_url?: string } | undefined;
		const repositoryFullName = repository?.full_name;
		const repositoryName = repositoryFullName?.toLowerCase();

		if (
			!repositoryFullName ||
			!repositoryName ||
			!this.repositories.has(repositoryName)
		) {
			return {
				outcome: "ignored",
				reason: "The repository is not in the installation allowlist.",
			};
		}

		const normalized = githubEvent(payload, eventName);

		if (!normalized)
			return {
				outcome: "ignored",
				reason: "The GitHub event is not a supported delivery signal.",
			};

		const occurredAt =
			typeof payload["updated_at"] === "string"
				? String(payload["updated_at"])
				: new Date().toISOString();
		const safePayload: JsonValue = {
			repository: repositoryFullName,
			event: eventName,
			action: typeof payload.action === "string" ? payload.action : null,
			normalizedKind: normalized.kind,
			text: normalized.text,
		};
		const source: SourceEventInput = {
			provider: "github",
			installationKey: this.policy.installationKey,
			providerEventId: deliveryId,
			eventKind: normalized.kind,
			occurredAt: Number.isNaN(Date.parse(occurredAt))
				? new Date().toISOString()
				: new Date(occurredAt).toISOString(),
			fetchedAt: new Date().toISOString(),
			sourceRef: `github:${repositoryFullName}:${deliveryId}`,
			sourceUrl: normalized.sourceUrl ?? repository?.html_url ?? null,
			contentHash: contentHash(safePayload),
			visibility: `github:repository:${repositoryName}`,
			payloadVersion: "github-webhook-v1",
			payload: safePayload,
		};
		const receipt = await this.recorder.record(source);

		if (!receipt.inserted)
			return {
				outcome: "duplicate",
				reason: "GitHub delivery was already recorded.",
				eventId: receipt.event.id,
			};
		return {
			outcome: "captured",
			reason: "Delivery evidence recorded for the autonomous Jev and LLM pipeline.",
			eventId: receipt.event.id,
		};
	}

	private async handleInstallationLifecycle(
		payload: Record<string, unknown>,
		eventName: string,
		deliveryId: string,
	): Promise<GithubWebhookResult | null> {
		const action =
			typeof payload.action === "string" ? payload.action : "unknown";
		const isInstallationState =
			eventName === "installation" &&
			[
				"created",
				"deleted",
				"suspend",
				"unsuspend",
				"new_permissions_accepted",
			].includes(action);
		const removedRepositories =
			eventName === "installation_repositories" && action === "removed"
				? (
						(payload.repositories_removed as
							{ full_name?: string }[] | undefined) ?? []
					)
						.flatMap((repository) =>
							repository.full_name ? [repository.full_name] : [],
						)
						.filter((repository) =>
							this.repositories.has(repository.toLowerCase()),
						)
				: [];

		if (!isInstallationState && removedRepositories.length === 0)
			return null;

		const safePayload: JsonValue = {
			event: eventName,
			action,
			removedRepositories,
		};
		const now = new Date().toISOString();
		const receipt = await this.recorder.record({
			provider: "github",
			installationKey: this.policy.installationKey,
			providerEventId: deliveryId,
			eventKind:
				eventName === "installation"
					? `installation.${action}`
					: "installation.repositories_removed",
			occurredAt: now,
			fetchedAt: now,
			sourceRef: `github:installation:${this.policy.installationKey}:${deliveryId}`,
			sourceUrl: null,
			contentHash: contentHash(safePayload),
			visibility: "github:installation",
			payloadVersion: "github-installation-lifecycle-v1",
			payload: safePayload,
		});

		if (!receipt.inserted) {
			return {
				outcome: "duplicate",
				reason: "GitHub installation event was already recorded.",
				eventId: receipt.event.id,
			};
		}

		let revoked = 0;
		const repositories =
			action === "deleted" || action === "suspend"
				? [...this.repositories]
				: removedRepositories;

		for (const repository of repositories) {
			revoked += await this.ledger.revokeEvidenceByVisibility(
				"github",
				this.policy.installationKey,
				`github:repository:${repository}`,
				"connector:github",
			);
		}
		if (isInstallationState) {
			const installation = (
				await this.ledger.workspace()
			).installations.find(
				(candidate) =>
					candidate.provider === "github" &&
					candidate.installationKey === this.policy.installationKey,
			);

			if (installation) {
				const status =
					action === "deleted"
						? "revoked"
						: action === "suspend"
							? "degraded"
							: "healthy";

				await this.ledger.updateInstallation(
					installation.id,
					{
						status,
						lastSyncAt: now,
						...(status === "healthy"
							? { lastSuccessAt: now, lastError: null }
							: {
									lastError:
										action === "deleted"
											? "GitHub App installation was deleted."
											: "GitHub App installation was suspended.",
								}),
					},
					"connector:github",
				);
			}
		}
		return {
			outcome: "captured",
			reason:
				removedRepositories.length > 0
					? `Repository access was removed and ${revoked} stored receipt${revoked === 1 ? "" : "s"} revoked.`
					: `GitHub installation state changed to ${action}; ${revoked} repository receipt${revoked === 1 ? "" : "s"} revoked.`,
			eventId: receipt.event.id,
		};
	}
}
