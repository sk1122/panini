import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { PayloadCipher } from "../security/payload-cipher.js";

/*
 * The code an agent changed, one row per file edit. Text is encrypted with the
 * content key, secrets are masked before storage, and large edits are cut.
 */

export interface CodeEditInput {
	sessionId: string;
	agentProfileId: string;
	toolUseId: string;
	tool: string;
	filePath: string;
	/** Text before and after; `before` is null when a file was written whole. */
	before: string | null;
	after: string;
}

export interface CodeEdit {
	id: string;
	sessionId: string;
	tool: string;
	filePath: string;
	linesAdded: number;
	linesRemoved: number;
	before: string | null;
	after: string;
	truncated: boolean;
	createdAt: string;
}

const maxChars = 60_000;

const secretPatterns = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\b(?:sk|pk|rk)-(?:ant-|proj-|or-|live_|test_)?[A-Za-z0-9_-]{16,}/g,
	/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
	/\bxapp-[A-Za-z0-9-]{10,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
	/\btl_agent_[A-Za-z0-9_-]{16,}/g,
	/((?:api[_-]?key|secret|password|passwd|token|auth)["']?\s*[:=]\s*["']?)[^\s"'`,;]{8,}/gi,
];

/** Replaces anything that looks like a credential with a mask. */
export function maskSecrets(text: string): string {
	return secretPatterns.reduce(
		(result, pattern) =>
			result.replace(pattern, (match, prefix?: string) =>
				typeof prefix === "string" && match.startsWith(prefix)
					? `${prefix}••••••`
					: "••••••",
			),
		text,
	);
}

/** Lines added and removed between two texts, counted as a multiset of lines. */
export function countLineChanges(before: string | null, after: string) {
	const remaining = new Map<string, number>();

	for (const line of (before ?? "").split("\n"))
		if (before !== null)
			remaining.set(line, (remaining.get(line) ?? 0) + 1);

	let added = 0;

	for (const line of after.split("\n")) {
		const left = remaining.get(line) ?? 0;

		if (left > 0) remaining.set(line, left - 1);
		else added += 1;
	}

	const removed = [...remaining.values()].reduce((sum, n) => sum + n, 0);

	return { added, removed };
}

export class PostgresCodeEdits {
	constructor(
		private readonly pool: pg.Pool,
		private readonly organizationId: string,
		private readonly cipher: PayloadCipher,
	) {}

	/** Records one edit; repeating the same tool call changes nothing. */
	async record(input: CodeEditInput): Promise<void> {
		const cut = (text: string | null) =>
			text === null ? null : maskSecrets(text).slice(0, maxChars);

		const before = cut(input.before);
		const after = cut(input.after) ?? "";
		const truncated =
			(input.before?.length ?? 0) > maxChars ||
			input.after.length > maxChars;
		const { added, removed } = countLineChanges(before, after);

		await this.pool.query(
			`INSERT INTO agent_code_edits (id,organization_id,session_id,agent_profile_id,tool_use_id,tool,file_path,lines_added,lines_removed,envelope)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
			 ON CONFLICT (organization_id,session_id,tool_use_id) DO NOTHING`,
			[
				randomUUID(),
				this.organizationId,
				input.sessionId,
				input.agentProfileId,
				input.toolUseId.slice(0, 200),
				input.tool.slice(0, 40),
				input.filePath.slice(0, 500),
				added,
				removed,
				JSON.stringify(
					this.cipher.encrypt({ before, after, truncated }),
				),
			],
		);
	}

	async listForSession(sessionId: string): Promise<CodeEdit[]> {
		const rows = (
			await this.pool.query(
				`SELECT id, session_id, tool, file_path, lines_added, lines_removed, envelope, created_at
				 FROM agent_code_edits WHERE organization_id=$1 AND session_id=$2
				 ORDER BY created_at, id LIMIT 500`,
				[this.organizationId, sessionId],
			)
		).rows;

		return rows.map((row) => {
			const text = this.cipher.decrypt(row.envelope) as unknown as {
				before: string | null;
				after: string;
				truncated: boolean;
			};

			return {
				id: row.id,
				sessionId: row.session_id,
				tool: row.tool,
				filePath: row.file_path,
				linesAdded: row.lines_added,
				linesRemoved: row.lines_removed,
				before: text.before,
				after: text.after,
				truncated: text.truncated,
				createdAt: new Date(row.created_at).toISOString(),
			};
		});
	}

	/** Files changed and line counts per session, for lists. */
	async summaries(
		sessionIds: string[],
	): Promise<Map<string, { files: number; added: number; removed: number }>> {
		if (sessionIds.length === 0) return new Map();

		const rows = (
			await this.pool.query(
				`SELECT session_id, count(DISTINCT file_path)::int AS files,
				        sum(lines_added)::int AS added, sum(lines_removed)::int AS removed
				 FROM agent_code_edits WHERE organization_id=$1 AND session_id = ANY($2::uuid[])
				 GROUP BY session_id`,
				[this.organizationId, sessionIds],
			)
		).rows;

		return new Map(
			rows.map((row) => [
				row.session_id,
				{ files: row.files, added: row.added, removed: row.removed },
			]),
		);
	}
}
