import { contentHash } from "../../domain/content-hash.js";
import type { TeamLedger } from "../../domain/team-ledger.js";
import type { EventAppendResult } from "../../domain/store.js";
import type { SourceEventInput } from "../../domain/types.js";

export interface SlackMessage {
	channel: string;
	ts: string;
	threadTs: string | null;
	user: string | null;
	userDisplayName?: string | null;
	text: string;
	permalink: string | null;
	replyCount?: number;
	subtype?: string | null;
}

export interface SlackMessageClient {
	getMessage(channel: string, ts: string): Promise<SlackMessage>;
}

export interface SlackHistoryPage {
	messages: SlackMessage[];
	nextCursor: string | null;
}

export interface SlackWorkspaceMember {
	id: string;
	displayName: string;
	realName: string | null;
	email?: string | null;
	deleted: boolean;
	isBot: boolean;
	isAppUser: boolean;
}

export interface SlackMemberPage {
	members: SlackWorkspaceMember[];
	nextCursor: string | null;
}

export interface SlackHistoryClient extends SlackMessageClient {
	identifyWorkspace(): Promise<{
		teamId: string;
		workspaceUrl: string | null;
	}>;
	listMembers(cursor?: string): Promise<SlackMemberPage>;
	listChannelMessages(
		channel: string,
		cursor?: string,
	): Promise<SlackHistoryPage>;
	listThreadReplies(
		channel: string,
		threadTs: string,
		cursor?: string,
	): Promise<SlackHistoryPage>;
}

export interface SlackEvidenceRecorder {
	record(input: SourceEventInput): Promise<EventAppendResult>;
}

interface SlackSocketEnvelope {
	envelope_id?: string;
	type?: string;
	payload?: {
		event_id?: string;
		event_time?: number;
		team_id?: string;
		api_app_id?: string;
		event?: {
			type?: string;
			subtype?: string;
			reaction?: string;
			user?: string;
			user_profile?: { display_name?: string; real_name?: string };
			event_ts?: string;
			channel?: string;
			ts?: string;
			text?: string;
			thread_ts?: string;
			deleted_ts?: string;
			message?: {
				ts?: string;
				thread_ts?: string;
				user?: string;
				text?: string;
				user_profile?: { display_name?: string; real_name?: string };
			};
			previous_message?: {
				ts?: string;
				thread_ts?: string;
				user?: string;
				text?: string;
				user_profile?: { display_name?: string; real_name?: string };
			};
			item?: { type?: string; channel?: string; ts?: string };
		};
	};
}

export interface SlackCapturePolicy {
	installationKey: string;
	channels: string[];
	captureMode?: "reaction" | "all_messages";
	captureReactions: string[];
}

export interface SlackBackfillResult {
	channels: number;
	fetched: number;
	captured: number;
	duplicates: number;
	ignored: number;
	errors: { channel: string; error: string }[];
}

export interface SlackMemberSyncResult {
	discovered: number;
	synced: number;
	disabled: number;
	skippedBots: number;
	unresolved: number;
}

function isCapturableMessage(
	message: Pick<SlackMessage, "subtype" | "text">,
): boolean {
	return (
		(!message.subtype ||
			["file_share", "thread_broadcast", "me_message"].includes(
				message.subtype,
			)) &&
		message.text.trim().length > 0
	);
}

export interface SlackCaptureResult {
	outcome: "captured" | "duplicate" | "ignored" | "abstained";
	reason: string;
	eventId?: string;
	proposalId?: string;
}

export class SlackCaptureAdapter {
	private readonly channelSet: Set<string>;
	private readonly reactionSet: Set<string>;
	private readonly memberNames = new Map<string, string>();
	private readonly observedMemberProfiles = new Map<string, string | null>();

	constructor(
		private readonly policy: SlackCapturePolicy,
		private readonly client: SlackMessageClient | SlackHistoryClient,
		private readonly recorder: SlackEvidenceRecorder,
		private readonly ledger: TeamLedger,
	) {
		this.channelSet = new Set(policy.channels);
		this.reactionSet = new Set(policy.captureReactions);
	}

	async handleEnvelope(
		envelope: SlackSocketEnvelope,
		acknowledge: (envelopeId: string) => void,
	): Promise<SlackCaptureResult> {
		if (envelope.envelope_id) acknowledge(envelope.envelope_id);

		const outer = envelope.payload;
		const event = outer?.event;

		if (envelope.type !== "events_api" || !outer?.event_id || !event) {
			return {
				outcome: "ignored",
				reason: "The envelope is not a supported Slack event.",
			};
		}
		if (
			event.type === "message" &&
			(event.subtype === "message_changed" ||
				event.subtype === "message_deleted")
		) {
			return this.handleMessageMutation(
				outer.event_id,
				outer.team_id ?? "unknown",
				event,
			);
		}
		if (
			event.type === "message" &&
			(this.policy.captureMode ?? "reaction") === "all_messages"
		) {
			if (
				!event.channel ||
				!event.ts ||
				!this.channelSet.has(event.channel) ||
				!isCapturableMessage({
					subtype: event.subtype ?? null,
					text: event.text ?? "",
				})
			) {
				return {
					outcome: "ignored",
					reason: "The message is not a normal message in an allowlisted channel.",
				};
			}
			return this.recordChannelMessage(
				outer.event_id,
				outer.team_id ?? "unknown",
				{
					channel: event.channel,
					ts: event.ts,
					threadTs: event.thread_ts ?? null,
					user: event.user ?? null,
					userDisplayName:
						event.user_profile?.display_name?.trim() ||
						event.user_profile?.real_name?.trim() ||
						null,
					text: event.text ?? "",
					permalink: null,
				},
				"message.observed",
			);
		}
		if (event.type !== "reaction_added") {
			return {
				outcome: "ignored",
				reason: "The envelope is not a reaction capture event.",
			};
		}
		if ((this.policy.captureMode ?? "reaction") === "all_messages") {
			return {
				outcome: "ignored",
				reason: "Reaction capture is redundant in all-messages mode.",
			};
		}

		const item = event.item;

		if (!event.reaction || !this.reactionSet.has(event.reaction)) {
			return {
				outcome: "ignored",
				reason: "The reaction is not designated for Panini capture.",
			};
		}
		if (
			item?.type !== "message" ||
			!item.channel ||
			!item.ts ||
			!this.channelSet.has(item.channel)
		) {
			return {
				outcome: "ignored",
				reason: "The message channel is not in the installation allowlist.",
			};
		}

		const message = await this.client.getMessage(item.channel, item.ts);
		const occurredAt = outer.event_time
			? new Date(outer.event_time * 1_000).toISOString()
			: new Date(Number(event.event_ts ?? item.ts) * 1_000).toISOString();
		const messageUserDisplayName = await this.observeMessageIdentity(
			outer.team_id ?? "unknown",
			message,
		);
		const payload = {
			teamId: outer.team_id ?? null,
			apiAppId: outer.api_app_id ?? null,
			channel: message.channel,
			messageTs: message.ts,
			threadTs: message.threadTs,
			messageUserId: message.user,
			messageUserDisplayName,
			capturedByUserId: event.user ?? null,
			captureReaction: event.reaction,
			text: message.text,
		};
		const source: SourceEventInput = {
			provider: "slack",
			installationKey: this.policy.installationKey,
			providerEventId: outer.event_id,
			eventKind: "message.explicitly_captured",
			occurredAt,
			fetchedAt: new Date().toISOString(),
			sourceRef: `slack:${outer.team_id ?? "unknown"}:${message.channel}:${message.ts}`,
			sourceUrl: message.permalink,
			contentHash: contentHash(payload),
			visibility: `slack:channel:${message.channel}`,
			payloadVersion: "slack-reaction-capture-v1",
			payload,
		};
		const receipt = await this.recorder.record(source);

		if (!receipt.inserted)
			return {
				outcome: "duplicate",
				reason: "Slack event was already recorded.",
				eventId: receipt.event.id,
			};

		const references = [
			...new Set(message.text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []),
		];
		const tasks = (await this.ledger.board()).tasks;
		const matches = tasks.filter((task) =>
			references.some(
				(reference) =>
					task.externalRef?.toUpperCase().includes(reference) ||
					task.title.toUpperCase().includes(reference),
			),
		);

		if (matches.length !== 1) {
			return {
				outcome: "abstained",
				reason:
					matches.length === 0
						? "No task reference matched."
						: "Multiple task references matched.",
				eventId: receipt.event.id,
			};
		}

		const blocker =
			/\b(blocked|blocking|cannot proceed|waiting on)\b/i.test(
				message.text,
			);

		if (!blocker) {
			return {
				outcome: "captured",
				reason: "Evidence recorded without inferring a state change.",
				eventId: receipt.event.id,
			};
		}

		const proposal = await this.ledger.propose({
			taskId: matches[0]!.id,
			changes: { status: "blocked" },
			rationale:
				"A deliberately captured Slack message states that the linked work is blocked.",
			requestedBy: "connector:slack",
			evidenceIds: [receipt.event.id],
		});

		return {
			outcome: "captured",
			reason: "Evidence recorded and a blocker proposal created.",
			eventId: receipt.event.id,
			proposalId: proposal.id,
		};
	}

	async backfill(
		options: { occurredAfter?: string } = {},
	): Promise<SlackBackfillResult> {
		const cutoff =
			options.occurredAfter === undefined
				? null
				: Date.parse(options.occurredAfter);

		if (cutoff !== null && !Number.isFinite(cutoff)) {
			throw new Error("Slack backfill cutoff must be a valid timestamp.");
		}

		const client = this.client as Partial<SlackHistoryClient>;

		if (
			!client.identifyWorkspace ||
			!client.listChannelMessages ||
			!client.listThreadReplies
		) {
			throw new Error(
				"The configured Slack client does not support channel history backfill.",
			);
		}

		const workspace = await client.identifyWorkspace.call(this.client);
		const result: SlackBackfillResult = {
			channels: this.policy.channels.length,
			fetched: 0,
			captured: 0,
			duplicates: 0,
			ignored: 0,
			errors: [],
		};

		for (const channel of this.policy.channels) {
			try {
				const messages: SlackMessage[] = [];
				let cursor: string | undefined;

				do {
					const page = await client.listChannelMessages.call(
						this.client,
						channel,
						cursor,
					);

					messages.push(...page.messages);
					cursor = page.nextCursor ?? undefined;
				} while (cursor);

				const rootsWithReplies = messages.filter(
					(message) => (message.replyCount ?? 0) > 0,
				);

				for (const root of rootsWithReplies) {
					let replyCursor: string | undefined;

					do {
						const page = await client.listThreadReplies.call(
							this.client,
							channel,
							root.ts,
							replyCursor,
						);

						messages.push(
							...page.messages.filter(
								(message) => message.ts !== root.ts,
							),
						);
						replyCursor = page.nextCursor ?? undefined;
					} while (replyCursor);
				}

				const unique = [
					...new Map(
						messages.map((message) => [message.ts, message]),
					).values(),
				].sort((left, right) => Number(left.ts) - Number(right.ts));

				result.fetched += unique.length;
				for (const message of unique) {
					if (
						cutoff !== null &&
						Number(message.ts) * 1_000 <= cutoff
					) {
						result.ignored += 1;
						continue;
					}
					if (!isCapturableMessage(message)) {
						result.ignored += 1;
						continue;
					}

					const imported = await this.recordChannelMessage(
						`history:${channel}:${message.ts}`,
						workspace.teamId,
						message,
						"message.imported",
					);

					if (imported.outcome === "captured") result.captured += 1;
					else if (imported.outcome === "duplicate")
						result.duplicates += 1;
					else result.ignored += 1;
				}
			} catch (error) {
				result.errors.push({
					channel,
					error:
						error instanceof Error ? error.message : String(error),
				});
			}
		}
		return result;
	}

	async syncMembers(): Promise<SlackMemberSyncResult> {
		const client = this.client as Partial<SlackHistoryClient>;

		if (!client.identifyWorkspace || !client.listMembers) {
			throw new Error(
				"The configured Slack client does not support workspace-member synchronization.",
			);
		}

		const workspace = await client.identifyWorkspace.call(this.client);
		const result: SlackMemberSyncResult = {
			discovered: 0,
			synced: 0,
			disabled: 0,
			skippedBots: 0,
			unresolved: 0,
		};
		let cursor: string | undefined;

		do {
			const page = await client.listMembers.call(this.client, cursor);

			result.discovered += page.members.length;
			for (const candidate of page.members) {
				if (candidate.isBot || candidate.isAppUser) {
					result.skippedBots += 1;
					continue;
				}

				const displayName =
					candidate.displayName.trim() ||
					candidate.realName?.trim() ||
					null;
				const reconciliation =
					await this.ledger.reconcileMemberIdentity(
						{
							provider: "slack",
							installationKey: workspace.teamId,
							externalId: candidate.id,
							displayName,
							email: candidate.email ?? null,
							status: candidate.deleted ? "disabled" : "active",
						},
						"connector:slack-members",
					);

				if (reconciliation.member) {
					this.memberNames.set(
						candidate.id,
						reconciliation.member.displayName,
					);
					this.observedMemberProfiles.set(candidate.id, displayName);
					result.synced += 1;
				} else {
					result.unresolved += 1;
				}
				if (candidate.deleted) result.disabled += 1;
			}
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		return result;
	}

	private async recordChannelMessage(
		providerEventId: string,
		teamId: string,
		message: SlackMessage,
		eventKind: "message.observed" | "message.imported",
	): Promise<SlackCaptureResult> {
		if (!this.channelSet.has(message.channel)) {
			return {
				outcome: "ignored",
				reason: "The message channel is not in the installation allowlist.",
			};
		}

		const messageUserDisplayName = await this.observeMessageIdentity(
			teamId,
			message,
		);
		const payload = {
			teamId,
			channel: message.channel,
			messageTs: message.ts,
			threadTs: message.threadTs,
			messageUserId: message.user,
			messageUserDisplayName,
			text: message.text,
		};
		const source: SourceEventInput = {
			provider: "slack",
			installationKey: this.policy.installationKey,
			providerEventId,
			eventKind,
			occurredAt: new Date(Number(message.ts) * 1_000).toISOString(),
			fetchedAt: new Date().toISOString(),
			sourceRef: `slack:${teamId}:${message.channel}:${message.ts}`,
			sourceUrl: message.permalink,
			contentHash: contentHash(payload),
			visibility: `slack:channel:${message.channel}`,
			payloadVersion: "slack-channel-message-v1",
			payload,
		};
		const receipt = await this.recorder.record(source);

		return receipt.inserted
			? {
					outcome: "captured",
					reason: "Allowlisted Slack channel message recorded.",
					eventId: receipt.event.id,
				}
			: {
					outcome: "duplicate",
					reason: "Slack channel message was already recorded.",
					eventId: receipt.event.id,
				};
	}

	private async observeMessageIdentity(
		teamId: string,
		message: SlackMessage,
	): Promise<string | null> {
		if (!message.user) return null;

		const observedName = message.userDisplayName?.trim() || null;

		if (!observedName && this.memberNames.has(message.user))
			return this.memberNames.get(message.user)!;

		const hasObservedProfile = this.observedMemberProfiles.has(
			message.user,
		);

		if (
			!hasObservedProfile ||
			this.observedMemberProfiles.get(message.user) !== observedName
		) {
			const reconciliation = await this.ledger.reconcileMemberIdentity(
				{
					provider: "slack",
					installationKey: teamId,
					externalId: message.user,
					displayName: observedName,
					email: null,
					status: "active",
				},
				"connector:slack-messages",
			);

			this.observedMemberProfiles.set(message.user, observedName);
			if (reconciliation.member)
				this.memberNames.set(
					message.user,
					reconciliation.member.displayName,
				);
		}
		return this.memberNames.get(message.user) ?? null;
	}

	private async handleMessageMutation(
		providerEventId: string,
		teamId: string,
		event: NonNullable<
			NonNullable<SlackSocketEnvelope["payload"]>["event"]
		>,
	): Promise<SlackCaptureResult> {
		const channel = event.channel;
		const changedMessage = event.message;
		const messageTs =
			event.subtype === "message_deleted"
				? (event.deleted_ts ?? event.previous_message?.ts)
				: (changedMessage?.ts ?? event.previous_message?.ts);

		if (!channel || !messageTs || !this.channelSet.has(channel)) {
			return {
				outcome: "ignored",
				reason: "The changed message is not in the installation allowlist.",
			};
		}

		const sourceRef = `slack:${teamId}:${channel}:${messageTs}`;
		const previous = await this.ledger.latestEvidenceBySourceRef(
			"slack",
			this.policy.installationKey,
			sourceRef,
		);

		if (!previous) {
			return {
				outcome: "ignored",
				reason: "The changed message was never deliberately captured by Panini.",
			};
		}
		if (
			previous.eventKind === "message.deleted" &&
			event.subtype !== "message_deleted"
		) {
			return {
				outcome: "ignored",
				reason: "A deletion tombstone prevents restoring message content from a late edit.",
			};
		}

		const deleted = event.subtype === "message_deleted";
		const mutationAt = new Date(
			Number(event.event_ts ?? messageTs) * 1_000,
		).toISOString();
		const orderedAfterPrevious = mutationAt > previous.occurredAt;
		const replacesPrevious = deleted || orderedAfterPrevious;
		const payload = deleted
			? { teamId, channel, messageTs, deletionObserved: true }
			: {
					teamId,
					channel,
					messageTs,
					threadTs: changedMessage?.thread_ts ?? null,
					messageUserId: changedMessage?.user ?? null,
					messageUserDisplayName: changedMessage?.user
						? (this.memberNames.get(changedMessage.user) ?? null)
						: null,
					text: changedMessage?.text ?? "",
				};
		const source: SourceEventInput = {
			provider: "slack",
			installationKey: this.policy.installationKey,
			providerEventId,
			eventKind: deleted ? "message.deleted" : "message.edited",
			occurredAt: mutationAt,
			fetchedAt: new Date().toISOString(),
			sourceRef,
			sourceUrl: deleted ? null : previous.sourceUrl,
			contentHash: contentHash(payload),
			visibility: `slack:channel:${channel}`,
			payloadVersion: "slack-message-mutation-v1",
			payload,
			supersedesEventId: replacesPrevious ? previous.id : null,
		};
		const receipt = await this.recorder.record(source);

		if (!receipt.inserted) {
			return {
				outcome: "duplicate",
				reason: "Slack mutation was already recorded.",
				eventId: receipt.event.id,
			};
		}
		if (!replacesPrevious) {
			return {
				outcome: "captured",
				reason: "Slack mutation order is uncertain; earlier content remains available for review.",
				eventId: receipt.event.id,
			};
		}

		const revoked = await this.ledger.revokeEvidenceBySourceRef(
			"slack",
			this.policy.installationKey,
			sourceRef,
			"connector:slack",
			receipt.event.id,
		);

		return {
			outcome: "captured",
			reason: deleted
				? `The captured message body was removed; ${revoked} earlier receipt${revoked === 1 ? "" : "s"} revoked.`
				: `The captured message was replaced; ${revoked} earlier receipt${revoked === 1 ? "" : "s"} revoked.`,
			eventId: receipt.event.id,
		};
	}
}

interface SlackApiMessage {
	ts: string;
	thread_ts?: string;
	user?: string;
	username?: string;
	user_profile?: { display_name?: string; real_name?: string };
	text?: string;
	reply_count?: number;
	subtype?: string;
}

interface SlackApiUser {
	id: string;
	name?: string;
	real_name?: string;
	deleted?: boolean;
	is_bot?: boolean;
	is_app_user?: boolean;
	profile?: { display_name?: string; real_name?: string; email?: string };
}

export class SlackWebApiClient implements SlackHistoryClient {
	private identity: { teamId: string; workspaceUrl: string | null } | null =
		null;

	constructor(
		private readonly botToken: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	async getMessage(channel: string, ts: string): Promise<SlackMessage> {
		const query = new URLSearchParams({
			channel,
			ts,
			inclusive: "true",
			limit: "1",
		});
		const response = await this.fetchImpl(
			`https://slack.com/api/conversations.history?${query}`,
			{
				headers: { authorization: `Bearer ${this.botToken}` },
			},
		);
		const body = (await response.json()) as {
			ok: boolean;
			error?: string;
			messages?: SlackApiMessage[];
		};

		if (!response.ok || !body.ok || !body.messages?.[0])
			throw new Error(
				`Slack message fetch failed: ${body.error ?? response.status}.`,
			);

		const message = body.messages[0];

		return this.toMessage(
			channel,
			message,
			await this.permalink(channel, ts),
		);
	}

	async identifyWorkspace(): Promise<{
		teamId: string;
		workspaceUrl: string | null;
	}> {
		if (this.identity) return this.identity;

		const response = await this.fetchImpl(
			"https://slack.com/api/auth.test",
			{
				headers: { authorization: `Bearer ${this.botToken}` },
			},
		);
		const body = (await response.json()) as {
			ok: boolean;
			error?: string;
			team_id?: string;
			url?: string;
		};

		if (!response.ok || !body.ok || !body.team_id) {
			throw new Error(
				`Slack workspace identity fetch failed: ${body.error ?? response.status}.`,
			);
		}
		this.identity = {
			teamId: body.team_id,
			workspaceUrl: body.url ?? null,
		};
		return this.identity;
	}

	async listChannelMessages(
		channel: string,
		cursor?: string,
	): Promise<SlackHistoryPage> {
		return this.list("conversations.history", channel, undefined, cursor);
	}

	async listMembers(cursor?: string): Promise<SlackMemberPage> {
		const query = new URLSearchParams({ limit: "200" });

		if (cursor) query.set("cursor", cursor);

		const response = await this.fetchImpl(
			`https://slack.com/api/users.list?${query}`,
			{
				headers: { authorization: `Bearer ${this.botToken}` },
			},
		);
		const body = (await response.json()) as {
			ok: boolean;
			error?: string;
			members?: SlackApiUser[];
			response_metadata?: { next_cursor?: string };
		};

		if (!response.ok || !body.ok)
			throw new Error(
				`Slack users.list failed: ${body.error ?? response.status}.`,
			);
		return {
			members: (body.members ?? []).map((member) => ({
				id: member.id,
				displayName:
					member.profile?.display_name?.trim() ||
					member.profile?.real_name?.trim() ||
					member.real_name?.trim() ||
					member.name?.trim() ||
					"",
				realName:
					member.profile?.real_name?.trim() ||
					member.real_name?.trim() ||
					null,
				email: member.profile?.email?.trim() || null,
				deleted: member.deleted ?? false,
				isBot: member.is_bot ?? false,
				isAppUser: member.is_app_user ?? false,
			})),
			nextCursor: body.response_metadata?.next_cursor?.trim() || null,
		};
	}

	async listThreadReplies(
		channel: string,
		threadTs: string,
		cursor?: string,
	): Promise<SlackHistoryPage> {
		return this.list("conversations.replies", channel, threadTs, cursor);
	}

	private async list(
		method: "conversations.history" | "conversations.replies",
		channel: string,
		threadTs?: string,
		cursor?: string,
	): Promise<SlackHistoryPage> {
		const query = new URLSearchParams({ channel, limit: "200" });

		if (threadTs) query.set("ts", threadTs);
		if (cursor) query.set("cursor", cursor);

		const response = await this.fetchImpl(
			`https://slack.com/api/${method}?${query}`,
			{
				headers: { authorization: `Bearer ${this.botToken}` },
			},
		);
		const body = (await response.json()) as {
			ok: boolean;
			error?: string;
			messages?: SlackApiMessage[];
			response_metadata?: { next_cursor?: string };
		};

		if (!response.ok || !body.ok)
			throw new Error(
				`Slack ${method} failed for ${channel}: ${body.error ?? response.status}.`,
			);

		const identity = await this.identifyWorkspace();

		return {
			messages: (body.messages ?? []).map((message) =>
				this.toMessage(
					channel,
					message,
					this.constructPermalink(
						identity.workspaceUrl,
						channel,
						message.ts,
						message.thread_ts ?? null,
					),
				),
			),
			nextCursor: body.response_metadata?.next_cursor?.trim() || null,
		};
	}

	private toMessage(
		channel: string,
		message: SlackApiMessage,
		permalink: string | null,
	): SlackMessage {
		return {
			channel,
			ts: message.ts,
			threadTs: message.thread_ts ?? null,
			user: message.user ?? null,
			userDisplayName:
				message.user_profile?.display_name?.trim() ||
				message.user_profile?.real_name?.trim() ||
				message.username?.trim() ||
				null,
			text: message.text ?? "",
			permalink,
			replyCount: message.reply_count ?? 0,
			subtype: message.subtype ?? null,
		};
	}

	private async permalink(
		channel: string,
		ts: string,
	): Promise<string | null> {
		const response = await this.fetchImpl(
			`https://slack.com/api/chat.getPermalink?${new URLSearchParams({ channel, message_ts: ts })}`,
			{
				headers: { authorization: `Bearer ${this.botToken}` },
			},
		);

		if (!response.ok) return null;

		const body = (await response.json()) as {
			ok: boolean;
			permalink?: string;
		};

		return body.ok ? (body.permalink ?? null) : null;
	}

	private constructPermalink(
		workspaceUrl: string | null,
		channel: string,
		ts: string,
		threadTs: string | null,
	): string | null {
		if (!workspaceUrl) return null;

		const base = `${workspaceUrl.replace(/\/$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;

		return threadTs && threadTs !== ts
			? `${base}?thread_ts=${encodeURIComponent(threadTs)}&cid=${encodeURIComponent(channel)}`
			: base;
	}
}

export interface SlackSocketConnectionOptions {
	appToken: string;
	adapter: SlackCaptureAdapter;
	fetchImpl?: typeof fetch;
	webSocketFactory?: (url: string) => WebSocket;
	onError?: (error: unknown) => void;
	onOpen?: () => void;
	onClose?: (event: CloseEvent) => void;
}

/** Minimal Socket Mode loop. Call connect again after close from the worker's supervised retry loop. */
export class SlackSocketConnection {
	private socket: WebSocket | null = null;

	constructor(private readonly options: SlackSocketConnectionOptions) {}

	async connect(): Promise<void> {
		const fetchImpl = this.options.fetchImpl ?? fetch;
		const response = await fetchImpl(
			"https://slack.com/api/apps.connections.open",
			{
				method: "POST",
				headers: { authorization: `Bearer ${this.options.appToken}` },
			},
		);
		const body = (await response.json()) as {
			ok: boolean;
			url?: string;
			error?: string;
		};

		if (!response.ok || !body.ok || !body.url)
			throw new Error(
				`Slack Socket Mode connection failed: ${body.error ?? response.status}.`,
			);

		const socket = (
			this.options.webSocketFactory ?? ((url) => new WebSocket(url))
		)(body.url);

		this.socket = socket;
		socket.addEventListener("open", () => this.options.onOpen?.());
		socket.addEventListener("close", (event) => {
			if (this.socket === socket) this.socket = null;
			this.options.onClose?.(event);
		});
		socket.addEventListener("error", (event) =>
			this.options.onError?.(event),
		);
		socket.addEventListener("message", (message) => {
			void this.onMessage(String(message.data)).catch((error) =>
				this.options.onError?.(error),
			);
		});
	}

	close(): void {
		this.socket?.close();
		this.socket = null;
	}

	private async onMessage(data: string): Promise<void> {
		const envelope = JSON.parse(data) as SlackSocketEnvelope;

		await this.options.adapter.handleEnvelope(envelope, (envelopeId) => {
			this.socket?.send(JSON.stringify({ envelope_id: envelopeId }));
		});
	}
}
