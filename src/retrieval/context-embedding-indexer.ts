import { isContextEffective } from "../domain/context-catalog.js";
import type { LedgerStore } from "../domain/store.js";
import type { ContextFile } from "../domain/types.js";
import type { EmbeddingAdapter } from "./embedding-adapter.js";
import { containsCredentialLikeText } from "./external-text-policy.js";
import {
	embeddingInput,
	embeddingInputHash,
	type ContextEmbeddingIndex,
} from "./context-embedding-index.js";

const chunkSize = 3_000;
const overlap = 200;

export function chunkDocument(input: string): string[] {
	const chunks: string[] = [];

	for (let start = 0; start < input.length; start += chunkSize - overlap) {
		chunks.push(input.slice(start, start + chunkSize));
		if (start + chunkSize >= input.length) break;
	}
	return chunks;
}

export interface EmbeddingSyncReport {
	indexed: number;
	unchanged: number;
	skippedSensitive: number;
	pruned: number;
	failed: number;
}

/** Periodically reconciles a derived index from accepted, active ledger files. */
export class ContextEmbeddingIndexer {
	private timer: NodeJS.Timeout | null = null;
	private active: Promise<EmbeddingSyncReport> | null = null;

	constructor(
		private readonly store: LedgerStore,
		private readonly index: ContextEmbeddingIndex,
		private readonly adapter: EmbeddingAdapter,
		private readonly log: {
			info(message: string, fields?: object): void;
			error(message: string, fields?: object): void;
		},
	) {}

	start(intervalMs = 300_000): void {
		if (this.timer) return;
		void this.tick();
		this.timer = setInterval(() => void this.tick(), intervalMs);
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.active;
	}

	syncOnce(): Promise<EmbeddingSyncReport> {
		if (this.active) return this.active;

		const run = this.sync().finally(() => {
			if (this.active === run) this.active = null;
		});

		this.active = run;
		return run;
	}

	private async tick(): Promise<void> {
		try {
			this.log.info(
				"Context embedding sync completed.",
				await this.syncOnce(),
			);
		} catch (error) {
			this.log.error("Context embedding sync failed.", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async sync(): Promise<EmbeddingSyncReport> {
		const report: EmbeddingSyncReport = {
			indexed: 0,
			unchanged: 0,
			skippedSensitive: 0,
			pruned: 0,
			failed: 0,
		};
		const files = (await this.store.listContextEntries()).filter(
			(entry): entry is ContextFile =>
				entry.kind === "file" && isContextEffective(entry),
		);
		const evidenceIds = [
			...new Set(files.flatMap((entry) => entry.evidenceIds)),
		];
		const activeEvidence = new Set(
			(await this.store.getSourceEvents(evidenceIds)).map(
				(event) => event.id,
			),
		);
		const eligible = files.filter(
			(entry) =>
				entry.evidenceIds.length > 0 &&
				entry.evidenceIds.includes(entry.sourceEventId) &&
				entry.evidenceIds.every((id) => activeEvidence.has(id)),
		);
		const safe = eligible.filter((entry) => {
			const allowed = !containsCredentialLikeText(embeddingInput(entry));

			if (!allowed) report.skippedSensitive += 1;
			return allowed;
		});

		report.pruned = await this.index.prune(
			this.adapter.model,
			safe.map((entry) => entry.id),
		);

		const indexed = new Map(
			(await this.index.list(this.adapter.model)).map((entry) => [
				entry.entryId,
				entry.inputHash,
			]),
		);

		for (const entry of safe) {
			const input = embeddingInput(entry);
			const inputHash = embeddingInputHash(input);

			if (indexed.get(entry.id) === inputHash) {
				report.unchanged += 1;
				continue;
			}
			try {
				const chunks = chunkDocument(input);
				const vectors: number[][] = [];

				for (let offset = 0; offset < chunks.length; offset += 16) {
					const batch = chunks.slice(offset, offset + 16);

					vectors.push(
						...(this.adapter.embedDocuments
							? await this.adapter.embedDocuments(batch)
							: await this.adapter.embed(batch)),
					);
				}
				if (
					await this.index.replace(
						entry,
						this.adapter.model,
						inputHash,
						vectors,
					)
				)
					report.indexed += 1;
				else report.failed += 1; // The canonical entry changed while it was being embedded.
			} catch (error) {
				report.failed += 1;
				this.log.error("Context document embedding failed.", {
					entryId: entry.id,
					error:
						error instanceof Error ? error.message : String(error),
				});
			}
		}
		return report;
	}
}
