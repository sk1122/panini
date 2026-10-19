import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GithubWebhookAdapter } from "../src/connectors/github/webhook.js";
import { SlackCaptureAdapter } from "../src/connectors/slack/socket-mode.js";
import { syncSlackMemberDirectory } from "../src/connectors/slack/startup-sync.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import type { Observation, TaskFields } from "../src/domain/types.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

const taskFields: TaskFields = {
	externalRef: "notion:task:ACME-42",
	title: "ACME-42 Ship verified import",
	description: "",
	status: "in_progress",
	priority: "high",
	owner: "Mira",
	project: "Import",
	dueDate: null,
	dependencyRefs: [],
	sourceUrl: null,
};

async function system() {
	const store = new MemoryLedgerStore();
	const ledger = new TeamLedger(
		store,
		new ProposalPolicy({
			autoApproveNewTasks: true,
			autoApproveContext: true,
			requireReviewForTaskChanges: true,
		}),
	);
	const observation: Observation = {
		event: {
			provider: "legacy-board",
			installationKey: "default",
			providerEventId: "task-1",
			eventKind: "snapshot.retrieved",
			occurredAt: "2026-09-16T10:00:00.000Z",
			fetchedAt: "2026-09-16T10:00:01.000Z",
			sourceRef: taskFields.externalRef!,
			sourceUrl: null,
			contentHash: "task-1",
			visibility: "company",
			payloadVersion: "test",
			payload: { task: "ACME-42" },
		},
		signal: { type: "task_snapshot", fields: taskFields },
	};
	const imported = await ledger.ingest(observation);

	await ledger.approveProposal(
		imported.proposal!.id,
		"user:reviewer",
		"Reviewed source task.",
	);
	return { store, ledger };
}

describe("source connector adapters", () => {
	it("persists Slack member-directory coverage separately from healthy evidence capture", async () => {
		const { ledger } = await system();
		const installation = await ledger.configureInstallation(
			{
				provider: "slack",
				installationKey: "T1",
				displayName: "Slack",
				transport: "socket_mode",
				config: { channels: ["C-PROJECT"] },
			},
			"test:slack",
		);
		const messages: string[] = [];
		const log = {
			info(message: string) {
				messages.push(message);
			},
			error(message: string) {
				messages.push(message);
			},
		};

		await expect(
			syncSlackMemberDirectory({
				adapter: {
					async syncMembers() {
						throw new Error(
							"Slack users.list failed: missing_scope.",
						);
					},
				},
				ledger,
				installationId: installation.id,
				log,
			}),
		).resolves.toBeNull();

		expect((await ledger.workspace()).connectorSyncs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					installationId: installation.id,
					resourceKey: "member-directory",
					status: "degraded",
					observedCount: 0,
					lastError: "Slack users.list failed: missing_scope.",
				}),
			]),
		);
		expect(messages).toContain(
			"Slack organization-member synchronization failed; evidence capture will continue without resolved people.",
		);

		await expect(
			syncSlackMemberDirectory({
				adapter: {
					async syncMembers() {
						return {
							discovered: 3,
							synced: 2,
							disabled: 0,
							skippedBots: 1,
							unresolved: 0,
						};
					},
				},
				ledger,
				installationId: installation.id,
				log,
			}),
		).resolves.toMatchObject({ discovered: 3, synced: 2 });

		expect((await ledger.workspace()).connectorSyncs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					installationId: installation.id,
					resourceKey: "member-directory",
					status: "healthy",
					observedCount: 3,
					lastError: null,
				}),
			]),
		);
	});

	it("acknowledges Slack Socket Mode before fetching and captures only designated allowlisted messages", async () => {
		const { store, ledger } = await system();
		let acknowledged = false;
		const adapter = new SlackCaptureAdapter(
			{
				installationKey: "T1",
				channels: ["C-PROJECT"],
				captureReactions: ["panini"],
			},
			{
				async getMessage(channel, ts) {
					expect(acknowledged).toBe(true);
					return {
						channel,
						ts,
						threadTs: null,
						user: "U1",
						text: "ACME-42 is blocked waiting on credentials",
						permalink: "https://slack.example/message",
					};
				},
			},
			{ record: (input) => store.appendSourceEvent(input) },
			ledger,
		);
		const result = await adapter.handleEnvelope(
			{
				envelope_id: "E1",
				type: "events_api",
				payload: {
					event_id: "Ev1",
					event_time: 1_789_500_000,
					team_id: "T1",
					event: {
						type: "reaction_added",
						reaction: "panini",
						user: "U2",
						item: {
							type: "message",
							channel: "C-PROJECT",
							ts: "1789500000.1",
						},
					},
				},
			},
			(id) => {
				expect(id).toBe("E1");
				acknowledged = true;
			},
		);

		expect(result).toMatchObject({
			outcome: "captured",
			proposalId: expect.any(String),
		});
		expect((await ledger.board()).proposals[0]).toMatchObject({
			changes: { status: "blocked" },
			requestedBy: "connector:slack",
		});
	});

	it("replaces and deletes only Slack messages that were deliberately captured", async () => {
		const { store, ledger } = await system();
		const adapter = new SlackCaptureAdapter(
			{
				installationKey: "T1",
				channels: ["C-PROJECT"],
				captureReactions: ["panini"],
			},
			{
				async getMessage(channel, ts) {
					return {
						channel,
						ts,
						threadTs: null,
						user: "U1",
						text: "ACME-42 is blocked",
						permalink: "https://slack.example/message",
					};
				},
			},
			{ record: (input) => store.appendSourceEvent(input) },
			ledger,
		);
		const captured = await adapter.handleEnvelope(
			{
				envelope_id: "E1",
				type: "events_api",
				payload: {
					event_id: "Ev1",
					event_time: 1_789_500_000,
					team_id: "T1",
					event: {
						type: "reaction_added",
						reaction: "panini",
						item: {
							type: "message",
							channel: "C-PROJECT",
							ts: "1789500000.1",
						},
					},
				},
			},
			() => undefined,
		);

		const edited = await adapter.handleEnvelope(
			{
				envelope_id: "E2",
				type: "events_api",
				payload: {
					event_id: "Ev2",
					team_id: "T1",
					event: {
						type: "message",
						subtype: "message_changed",
						channel: "C-PROJECT",
						event_ts: "1789500100.1",
						message: {
							ts: "1789500000.1",
							user: "U1",
							text: "ACME-42 is moving again",
						},
					},
				},
			},
			() => undefined,
		);

		expect(edited).toMatchObject({
			outcome: "captured",
			reason: expect.stringContaining("replaced"),
		});
		expect(
			(await ledger.listEvidence()).find(
				(event) => event.id === captured.eventId,
			),
		).toBeUndefined();
		expect(
			await ledger.latestEvidenceBySourceRef(
				"slack",
				"T1",
				"slack:T1:C-PROJECT:1789500000.1",
			),
		).toMatchObject({
			id: edited.eventId,
			eventKind: "message.edited",
			supersedesEventId: captured.eventId,
		});

		const duplicateEdit = await adapter.handleEnvelope(
			{
				envelope_id: "E2-repeat",
				type: "events_api",
				payload: {
					event_id: "Ev2",
					team_id: "T1",
					event: {
						type: "message",
						subtype: "message_changed",
						channel: "C-PROJECT",
						event_ts: "1789500100.1",
						message: {
							ts: "1789500000.1",
							user: "U1",
							text: "ACME-42 is moving again",
						},
					},
				},
			},
			() => undefined,
		);

		expect(duplicateEdit).toMatchObject({
			outcome: "duplicate",
			eventId: edited.eventId,
		});

		const deleted = await adapter.handleEnvelope(
			{
				envelope_id: "E3",
				type: "events_api",
				payload: {
					event_id: "Ev3",
					team_id: "T1",
					event: {
						type: "message",
						subtype: "message_deleted",
						channel: "C-PROJECT",
						event_ts: "1789500200.1",
						deleted_ts: "1789500000.1",
					},
				},
			},
			() => undefined,
		);

		expect(deleted).toMatchObject({
			outcome: "captured",
			reason: expect.stringContaining("removed"),
		});
		expect(
			(await ledger.listEvidence()).find(
				(event) => event.id === edited.eventId,
			),
		).toBeUndefined();
		expect(
			await ledger.latestEvidenceBySourceRef(
				"slack",
				"T1",
				"slack:T1:C-PROJECT:1789500000.1",
			),
		).toMatchObject({
			id: deleted.eventId,
			eventKind: "message.deleted",
			payload: { deletionObserved: true },
		});
	});

	it("backfills every message and thread reply in an allowlisted Slack channel and then observes new messages", async () => {
		const { store, ledger } = await system();
		const adapter = new SlackCaptureAdapter(
			{
				installationKey: "T1",
				channels: ["C-PROJECT"],
				captureMode: "all_messages",
				captureReactions: ["panini"],
			},
			{
				async getMessage() {
					throw new Error(
						"Full-channel capture does not fetch one reacted message.",
					);
				},
				async identifyWorkspace() {
					return {
						teamId: "T1",
						workspaceUrl: "https://acme.slack.com/",
					};
				},
				async listMembers() {
					return {
						members: [
							{
								id: "U1",
								displayName: "Mira",
								realName: "Mira Shah",
								deleted: false,
								isBot: false,
								isAppUser: false,
							},
							{
								id: "U2",
								displayName: "Dev",
								realName: "Dev Rao",
								deleted: false,
								isBot: false,
								isAppUser: false,
							},
							{
								id: "UBOT",
								displayName: "Build Bot",
								realName: null,
								deleted: false,
								isBot: true,
								isAppUser: false,
							},
						],
						nextCursor: null,
					};
				},
				async listChannelMessages(channel) {
					return {
						messages: [
							{
								channel,
								ts: "1789500000.1",
								threadTs: null,
								user: "U1",
								text: "Implement the importer",
								permalink: "https://slack.example/root",
								replyCount: 1,
							},
							{
								channel,
								ts: "1789500001.1",
								threadTs: null,
								user: "U2",
								text: "Verify it against production-shaped data",
								permalink: "https://slack.example/message",
							},
							{
								channel,
								ts: "1789500002.1",
								threadTs: null,
								user: "U3",
								text: "joined",
								permalink: null,
								subtype: "channel_join",
							},
						],
						nextCursor: null,
					};
				},
				async listThreadReplies(channel, threadTs) {
					return {
						messages: [
							{
								channel,
								ts: threadTs,
								threadTs,
								user: "U1",
								text: "Implement the importer",
								permalink: "https://slack.example/root",
							},
							{
								channel,
								ts: "1789500000.2",
								threadTs,
								user: "U2",
								text: "Blocked on credentials",
								permalink: "https://slack.example/reply",
							},
						],
						nextCursor: null,
					};
				},
			},
			{ record: (input) => store.appendSourceEvent(input) },
			ledger,
		);

		const memberSync = await adapter.syncMembers();
		const first = await adapter.backfill();
		const repeat = await adapter.backfill();

		expect(memberSync).toEqual({
			discovered: 3,
			synced: 2,
			disabled: 0,
			skippedBots: 1,
			unresolved: 0,
		});
		expect((await ledger.workspace()).members).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					subject: "slack:T1:U1",
					displayName: "Mira",
					role: "member",
					status: "active",
				}),
				expect.objectContaining({
					subject: "slack:T1:U2",
					displayName: "Dev",
					role: "member",
					status: "active",
				}),
			]),
		);
		expect((await ledger.workspace()).memberIdentities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					provider: "slack",
					installationKey: "T1",
					externalId: "U1",
				}),
				expect.objectContaining({
					provider: "slack",
					installationKey: "T1",
					externalId: "U2",
				}),
			]),
		);
		expect(first).toMatchObject({
			fetched: 4,
			captured: 3,
			duplicates: 0,
			ignored: 1,
			errors: [],
		});
		expect(repeat).toMatchObject({
			fetched: 4,
			captured: 0,
			duplicates: 3,
			ignored: 1,
			errors: [],
		});

		const live = await adapter.handleEnvelope(
			{
				envelope_id: "E-live",
				type: "events_api",
				payload: {
					event_id: "Ev-live",
					team_id: "T1",
					event: {
						type: "message",
						channel: "C-PROJECT",
						ts: "1789500010.1",
						event_ts: "1789500010.1",
						user: "U4",
						text: "Remaining: document the rollout",
					},
				},
			},
			() => undefined,
		);

		expect(live).toMatchObject({ outcome: "captured" });

		const imported = (await ledger.listEvidence()).find(
			(event) => event.sourceRef === "slack:T1:C-PROJECT:1789500000.1",
		);

		expect(imported?.payload).toMatchObject({
			messageUserId: "U1",
			messageUserDisplayName: "Mira",
		});
		expect(
			await ledger.latestEvidenceBySourceRef(
				"slack",
				"T1",
				"slack:T1:C-PROJECT:1789500010.1",
			),
		).toMatchObject({
			eventKind: "message.observed",
			payloadVersion: "slack-channel-message-v1",
		});
		expect(
			(await ledger.listEvidence()).filter(
				(event) => event.provider === "slack",
			),
		).toHaveLength(4);
	});

	it("verifies and deduplicates GitHub deliveries before autonomous interpretation", async () => {
		const { store, ledger } = await system();
		const secret = "github-secret";
		const adapter = new GithubWebhookAdapter(
			{ secret, installationKey: "acme", repositories: ["acme/panini"] },
			{ record: (input) => store.appendSourceEvent(input) },
			ledger,
		);
		const rawBody = Buffer.from(
			JSON.stringify({
				action: "closed",
				repository: {
					full_name: "acme/panini",
					html_url: "https://github.com/acme/panini",
				},
				pull_request: {
					merged: true,
					title: "ACME-42 implementation",
					body: "Verified delivery",
					html_url: "https://github.com/acme/panini/pull/7",
					head: { ref: "ACME-42" },
				},
			}),
		);
		const headers = {
			"x-github-event": "pull_request",
			"x-github-delivery": "delivery-7",
			"x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
		};
		const first = await adapter.handle(headers, rawBody);
		const duplicate = await adapter.handle(headers, rawBody);

		expect(first).toMatchObject({
			outcome: "captured",
			eventId: expect.any(String),
		});
		expect(duplicate).toMatchObject({
			outcome: "duplicate",
			eventId: first.eventId,
		});
		expect((await ledger.board()).proposals).toEqual([]);
	});

	it("rejects a GitHub webhook with a bad signature", async () => {
		const { store, ledger } = await system();
		const adapter = new GithubWebhookAdapter(
			{
				secret: "right",
				installationKey: "acme",
				repositories: ["acme/panini"],
			},
			{ record: (input) => store.appendSourceEvent(input) },
			ledger,
		);

		await expect(
			adapter.handle(
				{
					"x-github-event": "pull_request",
					"x-github-delivery": "bad",
					"x-hub-signature-256": "sha256=00",
				},
				Buffer.from("{}"),
			),
		).rejects.toThrow("signature");
	});

	it("projects GitHub installation suspension and revokes repository-scoped content", async () => {
		const { store, ledger } = await system();
		const installation = await ledger.configureInstallation(
			{
				provider: "github",
				installationKey: "acme",
				displayName: "GitHub",
				transport: "webhook",
				config: { repositories: ["acme/panini"] },
			},
			"test",
		);
		const secret = "github-secret";
		const adapter = new GithubWebhookAdapter(
			{ secret, installationKey: "acme", repositories: ["acme/panini"] },
			{ record: (input) => store.appendSourceEvent(input) },
			ledger,
		);
		const deliveryBody = Buffer.from(
			JSON.stringify({
				action: "completed",
				repository: { full_name: "acme/panini" },
				check_run: {
					conclusion: "success",
					name: "test",
					check_suite: { head_branch: "ACME-42" },
				},
			}),
		);

		const signedHeaders = (
			event: string,
			delivery: string,
			body: Buffer,
		) => ({
			"x-github-event": event,
			"x-github-delivery": delivery,
			"x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
		});

		const delivery = await adapter.handle(
			signedHeaders("check_run", "check-1", deliveryBody),
			deliveryBody,
		);

		expect(delivery.outcome).toBe("captured");

		const suspendBody = Buffer.from(JSON.stringify({ action: "suspend" }));
		const suspended = await adapter.handle(
			signedHeaders("installation", "install-1", suspendBody),
			suspendBody,
		);

		expect(suspended).toMatchObject({
			outcome: "captured",
			reason: expect.stringContaining("1 repository receipt revoked"),
		});
		expect(
			(await ledger.listEvidence()).find(
				(event) => event.id === delivery.eventId,
			),
		).toBeUndefined();
		expect(
			(await ledger.workspace()).installations.find(
				(item) => item.id === installation.id,
			),
		).toMatchObject({
			status: "degraded",
			lastError: expect.stringContaining("suspended"),
		});
	});
});
