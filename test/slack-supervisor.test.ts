import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlackCaptureAdapter } from "../src/connectors/slack/socket-mode.js";
import { SlackSocketSupervisor } from "../src/connectors/slack/supervisor.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

afterEach(() => vi.useRealTimers());

describe("SlackSocketSupervisor", () => {
	it("marks failed connections degraded and reconnects with bounded backoff", async () => {
		vi.useFakeTimers();

		const ledger = new TeamLedger(
			new MemoryLedgerStore(),
			new ProposalPolicy({
				autoApproveNewTasks: true,
				autoApproveContext: true,
				requireReviewForTaskChanges: true,
			}),
		);
		const installation = await ledger.configureInstallation(
			{
				provider: "slack",
				installationKey: "default",
				displayName: "Slack",
				transport: "socket_mode",
				config: {},
			},
			"test",
		);
		let attempt = 0;
		let open: (() => void) | null = null;
		const supervisor = new SlackSocketSupervisor({
			appToken: "xapp-test",
			adapter: {} as SlackCaptureAdapter,
			ledger,
			installationId: installation.id,
			retryBaseMs: 100,
			retryMaximumMs: 200,
			connectionTimeoutMs: 5_000,
			log: { info: vi.fn(), error: vi.fn() },
			connectionFactory: (callbacks) => ({
				async connect() {
					attempt += 1;
					if (attempt === 1)
						throw new Error("temporary Slack outage");
					open = callbacks.onOpen;
				},
				close() {},
			}),
		});

		supervisor.start();
		await vi.advanceTimersByTimeAsync(0);
		expect((await ledger.workspace()).installations[0]).toMatchObject({
			status: "degraded",
			lastError: "temporary Slack outage",
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(attempt).toBe(2);
		(open as (() => void) | null)?.();
		await Promise.resolve();
		await Promise.resolve();
		expect((await ledger.workspace()).installations[0]).toMatchObject({
			status: "healthy",
			lastError: null,
		});
		supervisor.stop();
	});

	it("allows only one Socket Mode owner through the singleton lease", async () => {
		vi.useFakeTimers();

		const store = new MemoryLedgerStore();
		const ledger = new TeamLedger(
			store,
			new ProposalPolicy({
				autoApproveNewTasks: true,
				autoApproveContext: true,
				requireReviewForTaskChanges: true,
			}),
		);
		const installation = await ledger.configureInstallation(
			{
				provider: "slack",
				installationKey: "singleton",
				displayName: "Slack singleton",
				transport: "socket_mode",
				config: {},
			},
			"test",
		);
		let firstConnections = 0;
		let secondConnections = 0;

		const supervisor = (owner: string, connected: () => void) =>
			new SlackSocketSupervisor({
				appToken: "xapp-test",
				adapter: {} as SlackCaptureAdapter,
				ledger,
				installationId: installation.id,
				leaseRetryMs: 100,
				acquireLease: () =>
					store.acquireSingletonLease(
						`slack:${installation.id}`,
						owner,
					),
				releaseLease: () =>
					store.releaseSingletonLease(
						`slack:${installation.id}`,
						owner,
					),
				log: { info: vi.fn(), error: vi.fn() },
				connectionFactory: () => ({
					async connect() {
						connected();
					},
					close() {},
				}),
			});

		const first = supervisor("worker:first", () => {
			firstConnections += 1;
		});
		const second = supervisor("worker:second", () => {
			secondConnections += 1;
		});

		first.start();
		second.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(firstConnections).toBe(1);
		expect(secondConnections).toBe(0);

		first.stop();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(100);
		expect(secondConnections).toBe(1);
		second.stop();
	});
});
