import type { TeamLedger } from "../../domain/team-ledger.js";
import type { SlackCaptureAdapter } from "./socket-mode.js";
import { SlackSocketConnection } from "./socket-mode.js";

interface SupervisedConnection {
	connect(): Promise<void>;
	close(): void;
}

export interface SlackSocketSupervisorOptions {
	appToken: string;
	adapter: SlackCaptureAdapter;
	ledger: TeamLedger;
	installationId: string;
	retryBaseMs?: number;
	retryMaximumMs?: number;
	connectionTimeoutMs?: number;
	leaseRetryMs?: number;
	fetchImpl?: typeof fetch;
	acquireLease?: () => Promise<boolean>;
	releaseLease?: () => Promise<void>;
	log: {
		info(message: string, fields?: object): void;
		error(message: string, fields?: object): void;
	};
	connectionFactory?: (callbacks: {
		onOpen(): void;
		onClose(event: { code: number; reason: string }): void;
		onError(error: unknown): void;
	}) => SupervisedConnection;
}

function cleanError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class SlackSocketSupervisor {
	private stopped = true;
	private attempts = 0;
	private generation = 0;
	private retryTimer: NodeJS.Timeout | null = null;
	private connectionTimer: NodeJS.Timeout | null = null;
	private connection: SupervisedConnection | null = null;
	private leaseHeld = false;

	constructor(private readonly options: SlackSocketSupervisorOptions) {}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.schedule(0);
	}

	stop(): void {
		this.stopped = true;
		this.generation += 1;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		if (this.connectionTimer) clearTimeout(this.connectionTimer);
		this.retryTimer = null;
		this.connectionTimer = null;
		this.connection?.close();
		this.connection = null;
		if (this.leaseHeld) {
			this.leaseHeld = false;
			void this.options
				.releaseLease?.()
				.catch((error: unknown) =>
					this.options.log.error(
						"Slack singleton lease release failed.",
						{ error: cleanError(error) },
					),
				);
		}
	}

	private schedule(delayMs: number): void {
		if (this.stopped || this.retryTimer) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			void this.connect();
		}, delayMs);
	}

	private async connect(): Promise<void> {
		if (this.stopped) return;

		const generation = ++this.generation;

		if (!this.leaseHeld && this.options.acquireLease) {
			try {
				const acquired = await this.options.acquireLease();

				if (this.stopped || generation !== this.generation) {
					if (acquired) await this.options.releaseLease?.();
					return;
				}
				if (!acquired) {
					this.options.log.info(
						"Slack Socket Mode lease is held by another worker.",
						{
							installationId: this.options.installationId,
						},
					);
					this.schedule(this.options.leaseRetryMs ?? 5_000);
					return;
				}
				this.leaseHeld = true;
			} catch (error) {
				await this.degradeAndRetry(
					generation,
					`Singleton lease failed: ${cleanError(error)}`,
				);
				return;
			}
		}
		this.attempts += 1;

		const callbacks = {
			onOpen: () => void this.onOpen(generation),
			onClose: (event: { code: number; reason: string }) =>
				void this.onClose(generation, event),
			onError: (error: unknown) =>
				this.options.log.error("Slack Socket Mode event failed.", {
					error: cleanError(error),
				}),
		};
		const connection = this.options.connectionFactory
			? this.options.connectionFactory(callbacks)
			: new SlackSocketConnection({
					appToken: this.options.appToken,
					adapter: this.options.adapter,
					onOpen: callbacks.onOpen,
					onClose: callbacks.onClose,
					onError: callbacks.onError,
					...(this.options.fetchImpl
						? { fetchImpl: this.options.fetchImpl }
						: {}),
				});

		this.connection = connection;
		this.connectionTimer = setTimeout(() => {
			if (this.stopped || generation !== this.generation) return;
			void this.onClose(generation, {
				code: 1006,
				reason: "connection timeout",
			});
		}, this.options.connectionTimeoutMs ?? 20_000);
		try {
			await connection.connect();
		} catch (error) {
			if (generation !== this.generation || this.stopped) return;
			await this.degradeAndRetry(generation, cleanError(error));
		}
	}

	private async onOpen(generation: number): Promise<void> {
		if (generation !== this.generation || this.stopped) return;
		if (this.connectionTimer) clearTimeout(this.connectionTimer);
		this.connectionTimer = null;
		this.attempts = 0;

		const now = new Date().toISOString();

		await this.options.ledger.updateInstallation(
			this.options.installationId,
			{
				status: "healthy",
				lastSyncAt: now,
				lastSuccessAt: now,
				lastError: null,
			},
			"system:slack-worker",
		);
		this.options.log.info("Slack Socket Mode connected.", {
			installationId: this.options.installationId,
		});
	}

	private async onClose(
		generation: number,
		event: { code: number; reason: string },
	): Promise<void> {
		if (generation !== this.generation || this.stopped) return;
		await this.degradeAndRetry(
			generation,
			`Socket closed (${event.code}${event.reason ? `: ${event.reason}` : ""}).`,
		);
	}

	private async degradeAndRetry(
		generation: number,
		error: string,
	): Promise<void> {
		if (generation !== this.generation || this.stopped) return;
		if (this.connectionTimer) clearTimeout(this.connectionTimer);
		this.connectionTimer = null;

		const connection = this.connection;

		this.connection = null;
		this.generation += 1;
		connection?.close();
		await this.options.ledger.updateInstallation(
			this.options.installationId,
			{
				status: "degraded",
				lastSyncAt: new Date().toISOString(),
				lastError: error.slice(0, 4_000),
			},
			"system:slack-worker",
		);

		const delay = Math.min(
			this.options.retryMaximumMs ?? 60_000,
			(this.options.retryBaseMs ?? 1_000) *
				2 ** Math.max(0, this.attempts - 1),
		);

		this.options.log.error(
			"Slack Socket Mode disconnected; retry scheduled.",
			{
				installationId: this.options.installationId,
				attempts: this.attempts,
				retryInMs: delay,
				error,
			},
		);
		this.schedule(delay);
	}
}
