import { z } from "zod";
import { DomainError } from "../domain/errors.js";
import type { LedgerStore } from "../domain/store.js";
import type { OutboxJob } from "../domain/types.js";
import type { OutboxHandler } from "./runtime.js";

const decidedProposalPayload = z
	.object({
		proposalId: z.string().uuid(),
		state: z.enum([
			"escalated",
			"approved",
			"rejected",
			"auto_applied",
			"superseded",
		]),
	})
	.strict();

const taskRevisionPayload = z
	.object({
		proposalId: z.string().uuid(),
		taskId: z.string().uuid(),
		revisionId: z.string().uuid(),
		version: z.number().int().positive(),
	})
	.strict();

const contextUpdatePayload = z
	.object({
		proposalId: z.string().uuid(),
		contextEntryId: z.string().uuid(),
		revisionId: z.string().uuid(),
		version: z.number().int().positive(),
		path: z.string().startsWith("/"),
	})
	.strict();

async function verifyProposalDecision(
	store: LedgerStore,
	job: OutboxJob,
): Promise<void> {
	const payload = decidedProposalPayload.parse(job.payload);
	const proposal = await store.getProposal(payload.proposalId);

	if (!proposal || proposal.state !== payload.state) {
		throw new DomainError(
			`Proposal projection ${payload.proposalId} does not match its outbox event.`,
			"CONFLICT",
		);
	}
}

async function verifyTaskRevision(
	store: LedgerStore,
	job: OutboxJob,
): Promise<void> {
	const payload = taskRevisionPayload.parse(job.payload);
	const [task, proposal, revisions] = await Promise.all([
		store.getTask(payload.taskId),
		store.getProposal(payload.proposalId),
		store.listTaskRevisions(payload.taskId),
	]);
	const revision = revisions.find(
		(candidate) => candidate.id === payload.revisionId,
	);

	if (
		!task ||
		!revision ||
		revision.version !== payload.version ||
		revision.proposalId !== payload.proposalId
	) {
		throw new DomainError(
			`Task revision projection ${payload.revisionId} is incomplete.`,
			"CONFLICT",
		);
	}
	if (
		!proposal ||
		(proposal.state !== "approved" && proposal.state !== "auto_applied")
	) {
		throw new DomainError(
			`Task revision proposal ${payload.proposalId} is not accepted.`,
			"CONFLICT",
		);
	}
}

async function verifyContextUpdate(
	store: LedgerStore,
	job: OutboxJob,
): Promise<void> {
	const payload = contextUpdatePayload.parse(job.payload);
	const [entry, proposal, revisions] = await Promise.all([
		store.getContextEntry(payload.contextEntryId),
		store.getProposal(payload.proposalId),
		store.listContextRevisions(payload.contextEntryId),
	]);
	const revision = revisions.find(
		(candidate) => candidate.id === payload.revisionId,
	);

	if (
		!entry ||
		!revision ||
		revision.version !== payload.version ||
		revision.proposalId !== payload.proposalId
	) {
		throw new DomainError(
			`Context revision projection ${payload.revisionId} is incomplete.`,
			"CONFLICT",
		);
	}
	if (
		!proposal ||
		(proposal.state !== "approved" && proposal.state !== "auto_applied")
	) {
		throw new DomainError(
			`Context proposal ${payload.proposalId} is not accepted.`,
			"CONFLICT",
		);
	}
}

export function projectionOutboxHandlers(
	store: LedgerStore,
): Map<string, OutboxHandler> {
	return new Map([
		["proposal.decided", (job) => verifyProposalDecision(store, job)],
		["projection.task.revised", (job) => verifyTaskRevision(store, job)],
		[
			"projection.context.updated",
			(job) => verifyContextUpdate(store, job),
		],
	]);
}
