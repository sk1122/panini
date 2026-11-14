import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { OutboxQueue } from "../src/outbox/runtime.js";
import { ReplayVerifier } from "../src/replay/verifier.js";
import { IdentityService } from "../src/security/identity.js";
import { buildHttpServer } from "../src/http/server.js";
import { runReconcile } from "../src/reconcile/runner.js";

/*
 * Ways the agent ledger could fail, written before the checks below:
 * 1. A tool call by an agent is not logged, or is logged without its session.
 * 2. The log stores content (note text, prompts) instead of ids.
 * 3. A denied call is not visible as denied.
 * 4. A claim does not accept an observed task or does not start planned work.
 * 5. Two agents claim one task and neither is told about the other.
 * 6. Ending a session leaves its claims active.
 * 7. A handoff note is not shown to the next session that claims the task.
 * 8. An agent claims or writes notes on a task outside its project scope.
 * 9. A work report about restricted work becomes company-visible evidence.
 * 10. Revoking a profile leaves its relay devices active.
 * 11. A member sees another member's agent activity.
 * 12. Rolling back a session leaves its proposals pending or its claims active.
 * 13. The hook endpoint accepts a missing or wrong secret.
 * 14. A branch naming a task does not produce an inferred claim.
 * 15. Dismissing an observed task leaves it open on the board.
 * 16. "This is wrong" changes accepted context directly instead of proposing.
 * 17. The digest misses agents, waiting items or leaks another member's agents.
 * 18. Agent telemetry cost does not reach the agent's session.
 * 19. Tool calls are not exported as OpenTelemetry spans when a collector is set.
 * 20. Rotating the content key makes old encrypted data unreadable.
 * 22. The reconcile run processes one thread's messages out of order, never
 *     overlaps threads, or skips events received before the run.
 * 21. OAuth: an unregistered redirect, a reused code, a wrong PKCE verifier, a
 *     reused refresh token or a revoked profile still yields a working token.
 */

const databaseUrl = process.env.PANINI_PRODUCTION_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = "https://panini.example.test";
const bootstrapToken = "panini_admin_test_very_long_random_installation_secret";
const password = "Correct horse battery staple 49!";
const encryptionKey = Buffer.alloc(32, 13).toString("base64");

type App = Awaited<ReturnType<typeof buildHttpServer>>;
type Login = { cookie: string; csrf: string; memberId: string };

suite("agent ledger over HTTP, MCP and PostgreSQL", () => {
	const pool = new pg.Pool({ connectionString: databaseUrl });
	const organizationId = randomUUID();
	const cleanup: Array<() => Promise<unknown>> = [];
	let app: App;
	let ledger: TeamLedger;
	let owner: Login;

	beforeAll(async () => {
		await migrate(databaseUrl!);
		await pool.query(
			"INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Before onboarding')",
			[organizationId, `ledger-${organizationId}`],
		);

		const config = await loadConfig();

		Object.assign(config, {
			databaseUrl,
			contentEncryptionKey: encryptionKey,
			adminToken: bootstrapToken,
			publicUrl: origin,
		});
		config.app.intelligence.enabled = false;
		config.app.adjudication.enabled = false;

		const store = new PostgresLedgerStore(
			databaseUrl!,
			encryptionKey,
			organizationId,
		);

		ledger = new TeamLedger(store, new ProposalPolicy(config.app.policy));

		const identity = new IdentityService(databaseUrl!, organizationId);

		app = await buildHttpServer({
			config,
			ledger,
			identity,
			jobs: new OutboxQueue(store),
			replay: new ReplayVerifier(store),
		});
		cleanup.push(
			() => store.close(),
			() => identity.close(),
			() => app.close(),
		);

		const response = await app.inject({
			method: "POST",
			url: "/api/auth/bootstrap",
			headers: { origin },
			payload: {
				token: bootstrapToken,
				companyName: "Tadka Labs",
				displayName: "Asha",
				email: "asha@example.test",
				password,
			},
		});

		expect(response.statusCode).toBe(200);
		owner = {
			cookie: String(response.headers["set-cookie"]).split(";")[0]!,
			csrf: response.json().csrf,
			memberId: response.json().identity.memberId,
		};
	}, 60_000);

	afterAll(async () => {
		for (const close of cleanup.reverse()) await close();
		await pool.query(
			"DELETE FROM evidence_dependencies WHERE organization_id=$1",
			[organizationId],
		);
		await pool.query("DELETE FROM organizations WHERE id=$1", [
			organizationId,
		]);
		await pool.end();
	});

	function headers(login: Login) {
		return { cookie: login.cookie, "x-panini-csrf": login.csrf, origin };
	}

	async function api(method: "GET" | "POST", url: string, payload?: object) {
		const response = await app.inject({
			method,
			url,
			headers: {
				...headers(owner),
				...(method === "POST"
					? { "idempotency-key": randomUUID() }
					: {}),
			},
			...(payload ? { payload } : {}),
		});

		return { status: response.statusCode, body: response.json() };
	}

	async function agent(name: string, projects: string[]) {
		const response = await api("POST", "/api/agents", {
			memberId: owner.memberId,
			name,
			harness: "claude_code",
			capabilities: [
				"work:read",
				"work:propose",
				"context:read",
				"context:propose",
				"evidence:report",
			],
			dataScope: {
				projects,
				contextPaths: ["/"],
				sourceVisibilities: ["company"],
			},
		});

		expect(response.status).toBe(201);
		return {
			secret: response.body.secret as string,
			id: response.body.profile.id as string,
		};
	}

	async function call(
		secret: string,
		session: string,
		name: string,
		args: object,
	) {
		const response = await app.inject({
			method: "POST",
			url: "/mcp",
			headers: {
				authorization: `Bearer ${secret}`,
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				"mcp-protocol-version": "2025-03-26",
				"x-panini-session-id": session,
				"x-panini-repository": "tadka/app",
			},
			payload: {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			},
		});
		const message = JSON.parse(
			response.body
				.split("\n")
				.find((line) => line.startsWith("data: "))
				?.slice(6) ?? response.body,
		);

		return message.result as {
			isError?: boolean;
			structuredContent?: Record<string, any>;
			content: { text: string }[];
		};
	}

	it("runs the spec's end-to-end story for one task across two agents", async () => {
		const receipt: Record<string, unknown> = {};
		const created = await api("POST", "/api/tasks", {
			title: "Fix login retry",
			project: "Auth",
		});

		expect(created.status).toBe(201);

		const accepted = created.body.task;
		// An observed task, as the worker model would create it from chat.
		const observedProposal = await ledger.proposeTaskCreation({
			title: "Add backoff test",
			project: "Auth",
			status: "planned",
			externalRef: `observed:${randomUUID()}`,
			rationale: "Mentioned in #eng",
			requestedBy: "observation-agent",
			evidenceIds: [],
			standing: "observed",
		});
		const observed = (await ledger.approveProposal(
			observedProposal.id,
			"observation-agent",
			null,
		)) as { id: string; standing?: string; status: string };

		expect(observed.standing).toBe("observed");

		const codex = await agent("Asha's Codex", ["*"]);
		const claude = await agent("Ravi's Claude", ["*"]);
		const billing = await agent("Billing bot", ["Billing"]);

		// 13: the hook endpoint rejects a wrong secret.
		const badHook = await app.inject({
			method: "POST",
			url: "/api/agent/hooks",
			headers: { authorization: "Bearer tl_agent_wrong" },
			payload: { event: "session_start", clientSessionId: "x" },
		});

		expect(badHook.statusCode).toBe(401);

		// 19: a local collector receives tool-call spans.
		const spans: unknown[] = [];
		const collector = createServer((request, response) => {
			let body = "";

			request.on("data", (chunk) => (body += chunk));
			request.on("end", () => {
				spans.push(JSON.parse(body));
				response.end("{}");
			});
		});

		await new Promise<void>((done) =>
			collector.listen(0, "127.0.0.1", done),
		);
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;

		// 1: the first call opens a session and is logged.
		const pack = await call(codex.secret, "codex-1", "context_get", {
			objective: "Work on login retry",
		});

		expect(pack.isError).toBeFalsy();
		expect(pack.content[0]!.text).toContain("## Your session");
		expect(pack.content[0]!.text).toContain("[observed: unconfirmed");

		// 4: claiming accepts the observed task and starts it.
		const claim = await call(codex.secret, "codex-1", "task_claim", {
			taskId: observed.id,
		});

		expect(claim.isError).toBeFalsy();
		expect(claim.structuredContent!.task).toMatchObject({
			standing: "accepted",
			status: "in_progress",
		});

		// 5: a second agent is told who else holds the task.
		const second = await call(claude.secret, "claude-1", "task_claim", {
			taskId: observed.id,
		});

		expect(second.structuredContent!.others).toHaveLength(1);
		expect(second.structuredContent!.others[0]).toMatchObject({
			agentName: "Asha's Codex",
			owner: "Asha",
		});

		// 9: a report stays as visible as the task it is about.
		const report = await call(codex.secret, "codex-1", "work_report", {
			reportId: randomUUID(),
			workItemId: observed.id,
			phase: "checkpoint",
			outcome: "Backoff helper written; test still missing.",
			artifactRefs: ["https://github.com/tadka/app/pull/218"],
			occurredAt: new Date().toISOString(),
		});

		expect(report.isError).toBeFalsy();

		const reportEvent = await ledger.getSourceEventForAccess(
			report.structuredContent!.evidenceId,
			{ kind: "admin" },
		);

		expect(reportEvent?.visibility).toBe(
			await ledger.taskEvidenceVisibility(
				(await ledger.getTask(observed.id))!,
			),
		);

		// 7: a handoff note, then the session ends through the hook and releases its claim.
		const handoff = await call(codex.secret, "codex-1", "handoff_write", {
			clientEventId: randomUUID(),
			taskId: observed.id,
			done: "Backoff helper",
			notDone: "The test",
			nextStep: "Write the retry test",
			artifacts: ["https://github.com/tadka/app/pull/218"],
		});

		expect(handoff.isError).toBeFalsy();

		const ended = await app.inject({
			method: "POST",
			url: "/api/agent/hooks",
			headers: { authorization: `Bearer ${codex.secret}` },
			payload: { event: "session_end", clientSessionId: "codex-1" },
		});

		expect(ended.statusCode).toBe(200);
		expect(ended.json().session.state).toBe("ended");

		// 6: the ended session holds no active claim.
		const claimsAfter = await api(
			"GET",
			`/api/tasks/${observed.id}/ledger`,
		);

		expect(claimsAfter, JSON.stringify(claimsAfter.body)).toMatchObject({
			status: 200,
		});

		expect(
			claimsAfter.body.claims.map(
				(c: { agentName: string }) => c.agentName,
			),
		).toEqual(["Ravi's Claude"]);
		expect(claimsAfter.body.handoffs[0]).toMatchObject({
			notDone: "The test",
		});

		// 7: the next session that holds the task sees the handoff first.
		const nextPack = await call(
			claude.secret,
			"claude-1",
			"context_get",
			{},
		);

		expect(nextPack.content[0]!.text).toContain("Last handoff by");
		expect(nextPack.content[0]!.text).toContain("not done: The test");

		// 8 and 3: an out-of-scope claim is denied and logged as denied.
		const denied = await call(billing.secret, "billing-1", "task_claim", {
			taskId: accepted.id,
		});

		expect(denied.isError).toBe(true);

		// A shared note and a decision draft.
		const note = await call(claude.secret, "claude-1", "note_drop", {
			clientEventId: randomUUID(),
			text: "SECRET-FREE-MARKER: the retry test needs a fake clock.",
			taskId: observed.id,
		});

		expect(note.isError).toBeFalsy();

		const decision = await call(
			claude.secret,
			"claude-1",
			"decision_propose",
			{
				clientEventId: randomUUID(),
				title: "Use exponential backoff",
				statement: "Login retries use exponential backoff with jitter.",
				reason: "Avoids thundering herd after outages.",
				rejectedOptions: ["Fixed 1s delay"],
				decidedBy: "Asha",
			},
		);

		expect(decision.isError).toBeFalsy();
		expect(decision.structuredContent!.proposal.state).toBe("approved");

		// Overview and activity: who owns it, what it touched, what was denied.
		const overview = await api("GET", "/api/agents/overview");

		expect(overview.status).toBe(200);

		const codexSession = overview.body.sessions.find(
			(s: { agentProfileId: string }) => s.agentProfileId === codex.id,
		);

		expect(codexSession.state).toBe("ended");
		expect(codexSession.counts.reads).toBeGreaterThan(0);
		expect(codexSession.counts.writes).toBeGreaterThanOrEqual(3);

		const billingActivity = await api(
			"GET",
			`/api/agents/activity?agentProfileId=${billing.id}`,
		);

		expect(billingActivity.body.events[0]).toMatchObject({
			tool: "task_claim",
			outcome: "denied",
		});

		// 2: the log holds ids, never content.
		const stored = await pool.query<{ n: string }>(
			"SELECT count(*) AS n FROM agent_activity_events WHERE organization_id=$1 AND (detail LIKE '%SECRET-FREE-MARKER%' OR array_to_string(target_ids,' ') LIKE '%SECRET-FREE-MARKER%')",
			[organizationId],
		);

		expect(stored.rows[0]!.n).toBe("0");

		// Home: needs, working now, changed.
		const home = await api("GET", "/api/home");

		expect(home.status).toBe(200);
		expect(home.body.needs.noteCount).toBe(1);
		// Agent changes apply at once, so nothing waits for a person.
		expect(home.body.needs.proposalCount).toBe(0);
		expect(
			home.body.workingNow.map((w: { agentName: string }) => w.agentName),
		).toContain("Ravi's Claude");

		// 14: a branch naming a task yields an inferred claim.
		const start = await app.inject({
			method: "POST",
			url: "/api/agent/hooks",
			headers: { authorization: `Bearer ${codex.secret}` },
			payload: {
				event: "session_start",
				clientSessionId: "codex-2",
				branch: `fix/${accepted.id.slice(0, 8)}-login`,
			},
		});

		expect(start.statusCode).toBe(200);
		expect(start.json().inferredClaim).toMatchObject({
			taskId: accepted.id,
			inferred: true,
		});
		expect(start.json().brief).toContain("Claimed: Fix login retry");

		// 12: rolling back a session undoes what it applied and releases its claims.
		const claudeSession = overview.body.sessions.find(
			(s: { agentProfileId: string }) => s.agentProfileId === claude.id,
		);
		const rollback = await api(
			"POST",
			`/api/agents/sessions/${claudeSession.id}/rollback`,
			{},
		);

		expect(rollback.body).toMatchObject({
			rejectedProposals: 0,
			undoneChanges: 1,
			dismissedNotes: 1,
			releasedClaims: 1,
		});

		// The decision it recorded is now marked undone and no longer current.
		const changes = await api("GET", "/api/changes");
		const undoneDecision = changes.body.changes.find(
			(change: { proposalId: string }) =>
				change.proposalId === decision.structuredContent!.proposal.id,
		);

		expect(undoneDecision).toMatchObject({ undone: true });
		expect(
			(
				await api(
					"POST",
					`/api/changes/${undoneDecision.proposalId}/undo`,
					{},
				)
			).body,
		).toMatchObject({ undone: false, reason: "Already undone." });
		expect(
			(
				await pool.query<{ state: string }>(
					"SELECT lifecycle_state AS state FROM context_entries WHERE organization_id=$1 AND title=$2",
					[organizationId, undoneDecision.title],
				)
			).rows.map((row) => row.state),
		).toEqual(["superseded"]);

		// 15: dismissing an observed task closes it.
		const stray = await ledger.approveProposal(
			(
				await ledger.proposeTaskCreation({
					title: "Maybe migrate cron",
					status: "backlog",
					externalRef: `observed:${randomUUID()}`,
					rationale: "Chat hint",
					requestedBy: "observation-agent",
					evidenceIds: [],
					standing: "observed",
				})
			).id,
			"observation-agent",
			null,
		);
		const dismissed = await api("POST", "/api/tasks/confirm", {
			taskIds: [stray.id],
			decision: "dismiss",
		});

		expect(dismissed.body.tasks[0]).toMatchObject({
			status: "cancelled",
			standing: "accepted",
		});

		// 10: revoking a profile revokes its relay devices.
		const device = await api("POST", "/api/devices", {
			agentProfileId: claude.id,
			name: "laptop",
			publicKey:
				"MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=",
			privacyMode: "metadata",
		});

		expect(device.status).toBe(201);
		await api("POST", `/api/agents/${claude.id}/revoke`, {});

		const devices = await api(
			"GET",
			`/api/devices?agentProfileId=${claude.id}`,
		);

		expect(devices.body.devices[0].status).toBe("revoked");

		// 16: a correction is a proposal; the accepted fact is unchanged until approved.
		const fact = await ledger.createContextEntry(
			{
				kind: "fact",
				path: "/auth/retry-attempts",
				title: "Login retry attempts",
				factType: "policy",
				value: 5,
			},
			`member:${owner.memberId}`,
		);
		const correction = await api(
			"POST",
			`/api/context/entries/${fact.id}/corrections`,
			{ correction: "3", reason: "We decided on three." },
		);

		expect(correction.status).toBe(201);
		expect(correction.body.proposal).toMatchObject({
			state: "approved",
			changes: { value: 3 },
		});
		expect(
			(await ledger.getContextEntry(fact.id))?.kind === "fact"
				? (
						(await ledger.getContextEntry(fact.id)) as {
							value: unknown;
						}
					).value
				: null,
		).toBe(3);

		// 17: the digest names waiting items and agents.
		const digest = await api("GET", "/api/digest");

		expect(digest.body.markdown).toContain("## Needs you");
		expect(digest.body.markdown).toContain("Asha's Codex");
		expect(digest.body.counts.denied).toBeGreaterThanOrEqual(1);

		// 18: the agent's own OTLP logs add cost and tokens to its session.
		const otlp = await app.inject({
			method: "POST",
			url: "/api/agent/otlp/v1/logs",
			headers: {
				authorization: `Bearer ${codex.secret}`,
				"content-type": "application/json",
			},
			payload: {
				resourceLogs: [
					{
						scopeLogs: [
							{
								logRecords: [
									{
										attributes: [
											{
												key: "event.name",
												value: {
													stringValue:
														"claude_code.api_request",
												},
											},
											{
												key: "session.id",
												value: {
													stringValue: "codex-1",
												},
											},
											{
												key: "cost_usd",
												value: { doubleValue: 0.42 },
											},
											{
												key: "input_tokens",
												value: { intValue: "1200" },
											},
											{
												key: "output_tokens",
												value: { intValue: "300" },
											},
										],
									},
								],
							},
						],
					},
				],
			},
		});

		expect(otlp.json()).toMatchObject({ accepted: 1 });

		const costed = (
			await api("GET", "/api/agents/overview")
		).body.sessions.find(
			(s: { clientSessionId: string }) => s.clientSessionId === "codex-1",
		);

		expect(costed).toMatchObject({
			costUsd: 0.42,
			inputTokens: 1200,
			outputTokens: 300,
		});

		await new Promise((done) => setTimeout(done, 2_500));
		collector.close();
		delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

		const exported = JSON.stringify(spans);

		expect(exported).toContain("execute_tool task_claim");
		expect(exported).toContain("panini.agent.profile_id");

		Object.assign(receipt, {
			ok: true,
			at: new Date().toISOString(),
			checks: 20,
			sessionCost: costed.costUsd,
			spanBatches: spans.length,
			correction: correction.body.proposal.state,
			digestCounts: digest.body.counts,
			taskAfterClaim: claim.structuredContent!.task,
			othersSeenBySecondAgent: second.structuredContent!.others.length,
			reportVisibility: reportEvent?.visibility,
			sessionsSeen: overview.body.sessions.length,
			codexCounts: codexSession.counts,
			billingDenied: billingActivity.body.events[0].outcome,
			home: {
				notes: home.body.needs.noteCount,
				proposals: home.body.needs.proposalCount,
				workingNow: home.body.workingNow.length,
			},
			inferredClaim: start.json().inferredClaim.inferred,
			rollback: rollback.body,
			deviceAfterRevoke: devices.body.devices[0].status,
		});
		await mkdir("artifacts/agent-ledger", { recursive: true });
		await writeFile(
			"artifacts/agent-ledger/agent-ledger-e2e.json",
			JSON.stringify(receipt, null, 2),
		);
	}, 60_000);

	it("keeps old encrypted data readable after rotating the content key", async () => {
		const original = new PostgresLedgerStore(
			databaseUrl!,
			encryptionKey,
			organizationId,
		);
		const written = await original.appendSourceEvent({
			provider: "manual",
			installationKey: "rotation",
			providerEventId: randomUUID(),
			eventKind: "note",
			occurredAt: new Date().toISOString(),
			fetchedAt: new Date().toISOString(),
			sourceRef: `rotation:${randomUUID()}`,
			sourceUrl: null,
			contentHash: randomUUID(),
			visibility: "company",
			payloadVersion: "test",
			payload: { text: "written under v1" },
		});

		await original.close();

		const nextKey = Buffer.alloc(32, 99).toString("base64");

		process.env.CONTENT_ENCRYPTION_KEY_VERSION = "v2";
		process.env.CONTENT_ENCRYPTION_PREVIOUS_KEYS = `v1:${encryptionKey}`;

		const rotated = new PostgresLedgerStore(
			databaseUrl!,
			nextKey,
			organizationId,
		);

		try {
			const [old] = await rotated.getSourceEvents([written.event.id]);

			expect(old?.payload).toEqual({ text: "written under v1" });

			const fresh = await rotated.appendSourceEvent({
				provider: "manual",
				installationKey: "rotation",
				providerEventId: randomUUID(),
				eventKind: "note",
				occurredAt: new Date().toISOString(),
				fetchedAt: new Date().toISOString(),
				sourceRef: `rotation:${randomUUID()}`,
				sourceUrl: null,
				contentHash: randomUUID(),
				visibility: "company",
				payloadVersion: "test",
				payload: { text: "written under v2" },
			});
			const version = await pool.query<{ key_version: string }>(
				"SELECT key_version FROM source_event_contents WHERE source_event_id=$1",
				[fresh.event.id],
			);

			expect(version.rows[0]?.key_version).toBe("v2");
		} finally {
			await rotated.close();
			delete process.env.CONTENT_ENCRYPTION_KEY_VERSION;
			delete process.env.CONTENT_ENCRYPTION_PREVIOUS_KEYS;
		}
	}, 30_000);

	it("connects an MCP client with OAuth 2.1 and PKCE", async () => {
		const metadata = await app.inject({
			method: "GET",
			url: "/.well-known/oauth-protected-resource",
		});

		expect(metadata.json()).toMatchObject({
			resource: `${origin}/mcp`,
			authorization_servers: [origin],
		});

		const unauthorized = await app.inject({
			method: "POST",
			url: "/mcp",
			payload: {},
		});

		expect(unauthorized.headers["www-authenticate"]).toContain(
			"resource_metadata=",
		);

		const badClient = await app.inject({
			method: "POST",
			url: "/oauth/register",
			payload: { redirect_uris: ["http://evil.example/cb"] },
		});

		expect(badClient.statusCode).toBe(400);

		const redirectUri = "http://127.0.0.1:9999/callback";
		const registered = await app.inject({
			method: "POST",
			url: "/oauth/register",
			payload: {
				client_name: "Test MCP client",
				redirect_uris: [redirectUri],
			},
		});

		expect(registered.statusCode).toBe(201);

		const clientId = registered.json().client_id as string;
		const verifier = randomBytes(48).toString("base64url");
		const challenge = createHash("sha256")
			.update(verifier)
			.digest("base64url");

		const authorize = async (redirect = redirectUri) =>
			app.inject({
				method: "GET",
				url: `/oauth/authorize?${new URLSearchParams({
					response_type: "code",
					client_id: clientId,
					redirect_uri: redirect,
					code_challenge: challenge,
					code_challenge_method: "S256",
					state: "xyz",
					resource: `${origin}/mcp`,
				})}`,
			});

		expect((await authorize("http://127.0.0.1:1/other")).statusCode).toBe(
			400,
		);

		const started = await authorize();

		expect(started.statusCode).toBe(302);

		const requestId = new URL(
			String(started.headers.location),
			origin,
		).searchParams.get("request");
		const approved = await api(
			"POST",
			`/api/connect/requests/${requestId}/decision`,
			{ decision: "approve", name: "OAuth agent" },
		);
		const redirect = new URL(approved.body.redirectTo);

		expect(redirect.origin + redirect.pathname).toBe(redirectUri);
		expect(redirect.searchParams.get("state")).toBe("xyz");

		const code = redirect.searchParams.get("code")!;

		const token = (form: Record<string, string>) =>
			app.inject({
				method: "POST",
				url: "/oauth/token",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
				},
				payload: new URLSearchParams(form).toString(),
			});

		const wrongVerifier = await token({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: clientId,
			code_verifier: randomBytes(48).toString("base64url"),
		});

		// A failed exchange burns the code too.
		expect(wrongVerifier.json().error).toBe("invalid_grant");

		const again = await authorize();
		const againId = new URL(
			String(again.headers.location),
			origin,
		).searchParams.get("request");
		const second = new URL(
			(
				await api("POST", `/api/connect/requests/${againId}/decision`, {
					decision: "approve",
					name: "OAuth agent 2",
				})
			).body.redirectTo,
		).searchParams.get("code")!;
		const exchanged = await token({
			grant_type: "authorization_code",
			code: second,
			redirect_uri: redirectUri,
			client_id: clientId,
			code_verifier: verifier,
			resource: `${origin}/mcp`,
		});

		expect(exchanged.statusCode).toBe(200);
		expect(exchanged.json()).toMatchObject({
			token_type: "Bearer",
			expires_in: 3600,
		});

		const reused = await token({
			grant_type: "authorization_code",
			code: second,
			redirect_uri: redirectUri,
			client_id: clientId,
			code_verifier: verifier,
		});

		expect(reused.json().error).toBe("invalid_grant");

		const access = exchanged.json().access_token as string;
		const who = await call(access, "oauth-1", "identity_get", {});

		expect(who.isError).toBeFalsy();
		expect(who.content[0]!.text).toContain("OAuth agent 2");

		const refreshed = await token({
			grant_type: "refresh_token",
			refresh_token: exchanged.json().refresh_token,
			client_id: clientId,
		});

		expect(refreshed.statusCode).toBe(200);
		expect(
			(
				await token({
					grant_type: "refresh_token",
					refresh_token: exchanged.json().refresh_token,
					client_id: clientId,
				})
			).json().error,
		).toBe("invalid_grant");

		const profileId = JSON.parse(
			Buffer.from(access.slice(4).split(".")[0]!, "base64url").toString(),
		).p as string;

		await api("POST", `/api/agents/${profileId}/revoke`, {});

		const afterRevoke = await app.inject({
			method: "POST",
			url: "/mcp",
			headers: {
				authorization: `Bearer ${refreshed.json().access_token}`,
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
		});

		expect(afterRevoke.statusCode).toBe(401);
		await mkdir("artifacts/agent-ledger", { recursive: true });
		await writeFile(
			"artifacts/agent-ledger/mcp-oauth-e2e.json",
			JSON.stringify(
				{
					ok: true,
					at: new Date().toISOString(),
					resource: metadata.json().resource,
					wrongVerifier: wrongVerifier.json().error,
					reusedCode: reused.json().error,
					identityViaAccessToken: true,
					refreshRotated: true,
					revokedProfileStatus: afterRevoke.statusCode,
				},
				null,
				2,
			),
		);
	}, 60_000);

	it("reconciles different threads at the same time and keeps each thread in order", async () => {
		const store = new PostgresLedgerStore(
			databaseUrl!,
			encryptionKey,
			organizationId,
		);

		try {
			const marker = randomUUID().slice(0, 8);
			const ids: Record<string, string> = {};

			for (const thread of ["a", "b", "c"])
				for (const step of [1, 2]) {
					const ts = `${marker}${thread}.${step}`;
					const recorded = await store.appendSourceEvent({
						provider: "slack",
						installationKey: "T1",
						providerEventId: `${marker}-${thread}-${step}`,
						eventKind: "message.observed",
						// Step 2 happened after step 1, even if both arrive in the same instant.
						occurredAt: new Date(
							Date.UTC(2026, 10, 14, 12, 0, step),
						).toISOString(),
						fetchedAt: new Date().toISOString(),
						sourceRef: `slack:T1:C1:${ts}`,
						sourceUrl: null,
						contentHash: `${marker}-${thread}-${step}`,
						visibility: "company",
						payloadVersion: "test",
						payload: {
							channel: "C1",
							messageTs: ts,
							threadTs: `${marker}${thread}.1`,
							text: `thread ${thread} step ${step}`,
						},
					});

					ids[recorded.event.id] = `${thread}${step}`;
				}

			const timeline: string[] = [];
			let running = 0;
			let overlap = 0;
			const run = await runReconcile({
				store,
				runs: store.reconcileRuns,
				ledger,
				trigger: "manual",
				allowedVisibilities: ["company"],
				concurrency: 3,
				observe: async (eventId) => {
					const label = ids[eventId];

					if (!label) return { state: "duplicate" };
					running += 1;
					overlap = Math.max(overlap, running);
					timeline.push(`start ${label}`);
					await new Promise((done) => setTimeout(done, 50));
					timeline.push(`end ${label}`);
					running -= 1;
					return { state: "processed" };
				},
				log: { info() {} },
			});

			expect(run?.state).toBe("completed");
			expect(run?.processed).toBe(6);
			expect(overlap, JSON.stringify(timeline)).toBeGreaterThan(1);
			for (const thread of ["a", "b", "c"])
				expect(
					timeline.indexOf(`end ${thread}1`),
					timeline.join(","),
				).toBeLessThan(timeline.indexOf(`start ${thread}2`));

			// A second run starts after the first run's cursor and sees nothing new.
			let seen = 0;
			const second = await runReconcile({
				store,
				runs: store.reconcileRuns,
				ledger,
				trigger: "manual",
				allowedVisibilities: ["company"],
				observe: async (eventId) => {
					if (ids[eventId]) seen += 1;
					return { state: "duplicate" };
				},
				log: { info() {} },
			});

			expect(second?.state).toBe("completed");
			expect(seen).toBe(0);
			await writeFile(
				"artifacts/agent-ledger/reconcile-parallel-e2e.json",
				JSON.stringify(
					{ ok: true, maxConcurrentThreads: overlap, timeline },
					null,
					2,
				),
			);
		} finally {
			await store.close();
		}
	}, 60_000);
});
