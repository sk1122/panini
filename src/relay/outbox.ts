import { DatabaseSync } from "node:sqlite";
import { PayloadCipher } from "../security/payload-cipher.js";
import {
	createRelayEnvelope,
	serializeRelayEnvelope,
	signRelayEnvelope,
	type WorkReport,
} from "./protocol.js";

export interface QueuedRelayDelivery {
	id: string;
	body: Buffer;
	signature: string;
	attempts: number;
}

export interface RelayDeliveryResult {
	accepted: boolean;
	retryable: boolean;
	message?: string;
}

interface OutboxRow {
	id: string;
	ciphertext: string;
	iv: string;
	auth_tag: string;
	key_version: string;
	signature: string;
	attempts: number;
}

/**
 * Device-local encrypted delivery queue. The stable report ID is both the row
 * key and the server-side semantic idempotency key.
 */
export class RelayOutbox {
	private readonly database: DatabaseSync;
	private readonly cipher: PayloadCipher;

	constructor(databasePath: string, encryptionKey: string) {
		this.database = new DatabaseSync(databasePath);
		this.cipher = new PayloadCipher(encryptionKey, "relay-v1");
		this.database.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS relay_outbox (
        id TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        key_version TEXT NOT NULL,
        signature TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','delivered','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );
    `);
	}

	enqueue(
		deviceId: string,
		report: WorkReport,
		privateKeyPem: string,
	): { inserted: boolean; id: string } {
		const envelope = createRelayEnvelope(deviceId, report);
		const body = serializeRelayEnvelope(envelope);
		const encrypted = this.cipher.encrypt(
			JSON.parse(body.toString("utf8")),
		);
		const result = this.database
			.prepare(
				`
      INSERT OR IGNORE INTO relay_outbox
        (id, ciphertext, iv, auth_tag, key_version, signature, state, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `,
			)
			.run(
				envelope.idempotencyKey,
				encrypted.ciphertext,
				encrypted.iv,
				encrypted.authTag,
				encrypted.keyVersion,
				signRelayEnvelope(body, privateKeyPem),
				new Date().toISOString(),
				new Date().toISOString(),
			);

		return { inserted: result.changes === 1, id: envelope.idempotencyKey };
	}

	pending(limit = 100): QueuedRelayDelivery[] {
		const rows = this.database
			.prepare(
				`
      SELECT id, ciphertext, iv, auth_tag, key_version, signature, attempts
        FROM relay_outbox
       WHERE state='pending' AND next_attempt_at <= ?
       ORDER BY created_at
       LIMIT ?
    `,
			)
			.all(new Date().toISOString(), limit) as unknown as OutboxRow[];

		return rows.map((row) => ({
			id: row.id,
			body: Buffer.from(
				JSON.stringify(
					this.cipher.decrypt({
						ciphertext: row.ciphertext,
						iv: row.iv,
						authTag: row.auth_tag,
						keyVersion: row.key_version,
					}),
				),
				"utf8",
			),
			signature: row.signature,
			attempts: row.attempts,
		}));
	}

	async flush(
		sender: (delivery: QueuedRelayDelivery) => Promise<RelayDeliveryResult>,
		limit = 100,
	): Promise<{ delivered: number; deferred: number }> {
		let delivered = 0;
		let deferred = 0;

		for (const delivery of this.pending(limit)) {
			try {
				const result = await sender(delivery);

				if (result.accepted) {
					this.database
						.prepare(
							"UPDATE relay_outbox SET state='delivered', delivered_at=?, last_error=NULL WHERE id=?",
						)
						.run(new Date().toISOString(), delivery.id);
					delivered += 1;
					continue;
				}
				this.fail(
					delivery,
					result.message ?? "Delivery was rejected.",
					result.retryable,
				);
				deferred += 1;
			} catch (error) {
				this.fail(
					delivery,
					error instanceof Error ? error.message : String(error),
					true,
				);
				deferred += 1;
			}
		}
		return { delivered, deferred };
	}

	count(state: "pending" | "delivered" | "failed"): number {
		const row = this.database
			.prepare("SELECT count(*) AS count FROM relay_outbox WHERE state=?")
			.get(state) as { count: number };

		return Number(row.count);
	}

	close(): void {
		this.database.close();
	}

	private fail(
		delivery: QueuedRelayDelivery,
		message: string,
		retryable: boolean,
	): void {
		const attempts = delivery.attempts + 1;
		const delaySeconds = Math.min(3_600, 2 ** Math.min(attempts, 10));
		const next = new Date(Date.now() + delaySeconds * 1_000).toISOString();

		this.database
			.prepare(
				`
      UPDATE relay_outbox
         SET state=?, attempts=?, next_attempt_at=?, last_error=?
       WHERE id=?
    `,
			)
			.run(
				retryable ? "pending" : "failed",
				attempts,
				next,
				message.slice(0, 2_000),
				delivery.id,
			);
	}
}
