import { randomUUID } from "node:crypto";
import type { AccessScope } from "../domain/access.js";
import type { TeamLedger } from "../domain/team-ledger.js";
import type { Member } from "../domain/types.js";

/**
 * A small fictional company so a new install shows something real at once:
 * accepted and observed tasks, two agents with sessions, a claim, a handoff,
 * a team note, a decision waiting for review, and some context.
 * Every write goes through the same ledger methods agents use.
 */
// Spec 7.3: a coding agent gets every grant except reading raw sources.
const codingGrants = [
	"work:read",
	"work:propose",
	"context:read",
	"context:propose",
	"evidence:report",
	"workspace:read",
	"workspace:write",
] as const;

export async function seedDemoCompany(
	ledger: TeamLedger,
	owner: Member,
): Promise<{ seeded: boolean; tasks: number }> {
	if ((await ledger.board()).tasks.length > 0)
		return { seeded: false, tasks: 0 };

	const actor = `member:${owner.id}`;
	const ravi = await ledger.syncMember(
		{
			subject: "demo:ravi",
			displayName: "Ravi",
			email: "ravi@demo.invalid",
			role: "member",
		},
		actor,
	);

	await ledger.createProject(
		{
			name: "Auth",
			outcome: "People sign in reliably.",
			owner: owner.displayName,
		},
		actor,
	);
	await ledger.createProject(
		{ name: "Billing", outcome: "Invoices export cleanly.", owner: "Ravi" },
		actor,
	);

	const login = await ledger.createTask(
		{
			title: "Fix login retry",
			description:
				"Login retries hammer the auth service after an outage.\n\nRequirements:\n- Retry 3 times with exponential backoff\n- Log each failure\n- Add a test",
			status: "planned",
			priority: "high",
			owner: owner.displayName,
			project: "Auth",
		},
		actor,
	);
	const exportTask = await ledger.createTask(
		{
			title: "Billing CSV export",
			description: "Finance needs a monthly CSV of paid invoices.",
			status: "planned",
			priority: "medium",
			owner: "Ravi",
			project: "Billing",
		},
		actor,
	);

	await ledger.createTask(
		{
			title: "Rotate staging database password",
			status: "done",
			priority: "medium",
			project: "Auth",
		},
		actor,
	);

	for (const title of [
		"Move nightly cron to the worker",
		"Add rate limit to the invite endpoint",
	]) {
		const proposal = await ledger.proposeTaskCreation({
			title,
			project: "Auth",
			status: "backlog",
			externalRef: `demo:observed:${randomUUID()}`,
			rationale: "Mentioned in #eng; not yet confirmed.",
			requestedBy: "observation-agent",
			evidenceIds: [],
			standing: "observed",
		});

		await ledger.approveProposal(proposal.id, "observation-agent", null);
	}

	await ledger.createContextEntry(
		{
			kind: "file",
			path: "/auth/architecture",
			title: "Auth architecture",
			body: "# Auth architecture\n\nThe web app calls the auth service, which checks sessions in PostgreSQL. Retries go through one shared helper.",
		},
		actor,
	);

	const codex = await ledger.createAgentProfile(
		{
			memberId: owner.id,
			name:
				owner.displayName === "You"
					? "Your Codex"
					: `${owner.displayName}'s Codex`,
			harness: "codex",
			description: "Coding agent for the Auth project.",
			capabilities: [...codingGrants],
			dataScope: {
				projects: ["*"],
				contextPaths: ["/"],
				sourceVisibilities: ["company"],
			},
		},
		actor,
	);
	const claude = await ledger.createAgentProfile(
		{
			memberId: ravi.id,
			name: "Ravi's Claude",
			harness: "claude_code",
			description: "Coding agent for Billing.",
			capabilities: [...codingGrants],
			dataScope: {
				projects: ["Billing"],
				contextPaths: ["/"],
				sourceVisibilities: ["company"],
			},
		},
		actor,
	);
	const codexAccess = agentAccess(owner, codex.profile.id, ["*"]);
	const claudeAccess = agentAccess(ravi, claude.profile.id, ["Billing"]);
	const codexOld = await ledger.resolveAgentSession(codexAccess, {
		clientSessionId: "demo-codex-yesterday",
		harness: "codex",
		repository: "demo/app",
		branch: "fix/login-retry",
	});

	await ledger.claimTask({
		access: codexAccess,
		session: codexOld,
		taskId: login.id,
		actor: `agent:${codex.profile.id}:${codex.profile.name}`,
	});
	await ledger.writeHandoff({
		access: codexAccess,
		session: codexOld,
		taskId: login.id,
		author: `agent:${codex.profile.id}:${codex.profile.name}`,
		done: "Backoff helper with jitter.",
		notDone: "Failure logging and the test.",
		openQuestions: "Should retries stop after a 401?",
		nextStep:
			"Wire the logger, then write the retry test with a fake clock.",
		artifacts: ["https://github.com/demo/app/pull/218"],
		clientEventId: "demo-handoff-1",
	});
	await ledger.agents.endSession(codexOld.id, "ended");
	await activity(ledger, codexOld.id, codex.profile.id, owner.id, [
		["context_get", "read", [login.id]],
		["task_claim", "claim", [login.id]],
		["work_report", "report", [login.id]],
		["handoff_write", "report", [login.id]],
	]);

	const claudeNow = await ledger.resolveAgentSession(claudeAccess, {
		clientSessionId: "demo-claude-now",
		harness: "claude_code",
		repository: "demo/app",
		branch: "feat/billing-export",
	});

	await ledger.claimTask({
		access: claudeAccess,
		session: claudeNow,
		taskId: exportTask.id,
		actor: `agent:${claude.profile.id}:${claude.profile.name}`,
	});
	await activity(ledger, claudeNow.id, claude.profile.id, ravi.id, [
		["context_get", "read", [exportTask.id]],
		["task_claim", "claim", [exportTask.id]],
		[
			"source_read",
			"read",
			[],
			"Agent profile lacks the source:read capability grant.",
		],
	]);
	await ledger.dropNote({
		access: claudeAccess,
		session: claudeNow,
		author: `agent:${claude.profile.id}:${claude.profile.name}`,
		text: "Invoices before March use the old currency field; the export must map both.",
		taskId: exportTask.id,
		project: null,
		links: [],
		clientEventId: "demo-note-1",
	});
	await ledger.proposeDecision({
		access: codexAccess,
		session: null,
		clientEventId: "demo-decision-1",
		title: "Use exponential backoff for login retries",
		statement:
			"Login retries use exponential backoff with jitter, three attempts.",
		reason: "Avoids a thundering herd after an outage.",
		rejectedOptions: ["Fixed one-second delay"],
		decidedBy: owner.displayName,
		decidedAt: new Date().toISOString(),
		supersedes: null,
		evidenceIds: [],
		requestedBy: `agent:${codex.profile.id}:${codex.profile.name}`,
	});
	return { seeded: true, tasks: (await ledger.board()).tasks.length };
}

function agentAccess(
	member: Member,
	agentProfileId: string,
	projects: string[],
): Extract<AccessScope, { kind: "agent" }> {
	return {
		kind: "agent",
		organizationId: member.organizationId,
		memberId: member.id,
		agentProfileId,
		dataScope: {
			projects,
			contextPaths: ["/"],
			sourceVisibilities: ["company"],
		},
	};
}

async function activity(
	ledger: TeamLedger,
	sessionId: string,
	agentProfileId: string,
	memberId: string,
	calls: [string, "read" | "claim" | "report", string[], string?][],
) {
	for (const [tool, actionClass, targetIds, denied] of calls)
		await ledger.agents.recordActivity({
			agentProfileId,
			memberId,
			sessionId,
			tool,
			actionClass,
			targetIds,
			resultCount: targetIds.length,
			outcome: denied ? "denied" : "ok",
			detail: denied ?? null,
			durationMs: 40,
		});
}
