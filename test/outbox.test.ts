import { describe, expect, it, vi } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { projectionOutboxHandlers } from "../src/outbox/projection-handler.js";
import { OutboxDispatcher, OutboxQueue } from "../src/outbox/runtime.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

const quietLog = { info: vi.fn(), error: vi.fn() };

function dispatcher(
	store: MemoryLedgerStore,
	handlers = projectionOutboxHandlers(store),
	maxAttempts = 3,
) {
	return new OutboxDispatcher(store, {
		workerId: "worker:test",
		batchSize: 20,
		leaseSeconds: 30,
		pollIntervalMs: 1_000,
		maxAttempts,
		retryBaseMs: 100,
		retryMaximumMs: 1_000,
		handlers,
		log: quietLog,
	});
}

describe("OutboxDispatcher", () => {
	it("verifies accepted projections before completing their durable jobs", async () => {
		const store = new MemoryLedgerStore();
		const ledger = new TeamLedger(
			store,
			new ProposalPolicy({
				autoApproveNewTasks: true,
				autoApproveContext: true,
				requireReviewForTaskChanges: true,
			}),
		);

		await ledger.createTask(
			{ title: "Verify the projection" },
			"user:reviewer",
		);

		expect(await dispatcher(store).runOnce()).toEqual({
			claimed: 1,
			completed: 1,
			retried: 0,
			failed: 0,
		});
		expect(await store.listOutboxJobs(10)).toMatchObject([
			{ state: "completed", completedAt: expect.any(String) },
		]);
	});

	it("retries handler failures and dead-letters exhausted jobs", async () => {
		const store = new MemoryLedgerStore();
		const queue = new OutboxQueue(store);

		await queue.enqueue("test.failure", "test-failure:one", { safe: true });

		const handlers = new Map([
			[
				"test.failure",
				async () => {
					throw new Error("transport unavailable");
				},
			],
		]);

		expect(await dispatcher(store, handlers, 1).runOnce()).toEqual({
			claimed: 1,
			completed: 0,
			retried: 0,
			failed: 1,
		});
		expect(await queue.list()).toMatchObject([
			{
				state: "failed",
				attempts: 1,
				lockedBy: null,
				lastError: "transport unavailable",
			},
		]);
	});

	it("verifies a persisted escalation as a completed proposal decision", async () => {
		const store = new MemoryLedgerStore();
		const ledger = new TeamLedger(
			store,
			new ProposalPolicy({
				mode: "autonomous",
				autoApproveNewTasks: false,
				autoApproveContext: false,
				requireReviewForTaskChanges: true,
			}),
		);
		const task = await ledger.createTask(
			{ title: "Resolve ownership" },
			"user:reviewer",
		);
		const proposal = await ledger.propose({
			taskId: task.id,
			baseRevision: task.version,
			changes: { owner: "Rina" },
			rationale: "Two sources disagree.",
			requestedBy: "agent:test",
		});

		await ledger.adjudicateProposal(proposal.id, {
			action: "escalate",
			actor: "adjudicator:test",
			note: "Credible unresolved conflict.",
			details: { confidence: 0.9 },
		});

		expect(await dispatcher(store).runOnce()).toEqual({
			claimed: 2,
			completed: 2,
			retried: 0,
			failed: 0,
		});
	});

	it("deduplicates explicitly queued operations", async () => {
		const store = new MemoryLedgerStore();
		const queue = new OutboxQueue(store);
		const first = await queue.enqueue(
			"connector.sync",
			"sync:notion:request-1",
			{ provider: "notion" },
		);
		const duplicate = await queue.enqueue(
			"connector.sync",
			"sync:notion:request-1",
			{ provider: "notion" },
		);

		expect(duplicate.id).toBe(first.id);
		expect(await queue.list()).toHaveLength(1);
	});
});
