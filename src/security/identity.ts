import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import type { Member, MemberRole, Organization } from "../domain/types.js";
import { DEFAULT_ORGANIZATION_ID } from "../store/postgres.js";
import { AuthError, hashPassword, verifyPassword } from "./passwords.js";

export { AuthError } from "./passwords.js";
export const SESSION_SECONDS = 8 * 60 * 60;
export const SESSION_IDLE_SECONDS = 60 * 60;

export const hashToken = (value: string) =>
	createHash("sha256").update(value).digest("hex");

export const isAdministrator = (member: Pick<Member, "role">) =>
	member.role === "owner" || member.role === "admin";

interface MemberRow {
	id: string;
	organization_id: string;
	subject: string;
	display_name: string;
	email: string | null;
	role: MemberRole;
	status: "active" | "disabled";
	created_at: Date;
	updated_at: Date;
}

const memberFromRow = (row: MemberRow): Member => ({
	id: row.id,
	organizationId: row.organization_id,
	subject: row.subject,
	displayName: row.display_name,
	email: row.email,
	role: row.role,
	status: row.status,
	createdAt: row.created_at.toISOString(),
	updatedAt: row.updated_at.toISOString(),
});

export interface BrowserSession {
	hash: string;
	csrf: string;
	expiresAt: string;
	member: Member;
}
export interface SessionGrant {
	token: string;
	session: BrowserSession;
}
export type GithubLoginIntent =
	| { purpose: "login" }
	| {
			purpose: "setup";
			email: string;
			displayName: string;
			companyName: string;
	  }
	| { purpose: "join"; token: string; displayName: string }
	| { purpose: "link"; memberId: string; sessionHash: string };
export interface AccountToken {
	id: string;
	email: string;
	role: MemberRole;
	purpose: "invite" | "reset";
	expiresAt: string;
	createdAt: string;
	consumedAt: string | null;
	revokedAt: string | null;
}
interface TokenRow {
	id: string;
	email: string;
	role: MemberRole;
	purpose: "invite" | "reset";
	member_id: string | null;
	expires_at: Date;
	created_at: Date;
	consumed_at: Date | null;
	revoked_at: Date | null;
}

const tokenFromRow = (row: TokenRow): AccountToken => ({
	id: row.id,
	email: row.email,
	role: row.role,
	purpose: row.purpose,
	expiresAt: row.expires_at.toISOString(),
	createdAt: row.created_at.toISOString(),
	consumedAt: row.consumed_at?.toISOString() ?? null,
	revokedAt: row.revoked_at?.toISOString() ?? null,
});

/** Durable local accounts for one organization. Source identities never authenticate a person. */
export class IdentityService {
	private readonly pool: pg.Pool;

	constructor(
		databaseUrl: string,
		readonly organizationId = DEFAULT_ORGANIZATION_ID,
	) {
		this.pool = new pg.Pool({
			connectionString: databaseUrl,
			max: 5,
			connectionTimeoutMillis: 5_000,
			statement_timeout: 15_000,
		});
	}

	async close() {
		await this.pool.end();
	}

	private async transaction<T>(
		operation: (client: PoolClient) => Promise<T>,
	): Promise<T> {
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const result = await operation(client);

			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK");
			if ((error as { code?: string }).code === "23505")
				throw new AuthError(
					"An account already exists for that email.",
					409,
				);
			throw error;
		} finally {
			client.release();
		}
	}

	private async lockOrganization(client: PoolClient) {
		const result = await client.query(
			"SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
			[this.organizationId],
		);

		if (!result.rowCount)
			throw new AuthError("The company has not been initialized.", 503);
	}

	private async audit(
		client: PoolClient,
		actor: string,
		action: string,
		targetId: string,
		details: Record<string, unknown> = {},
	) {
		await client.query(
			"INSERT INTO audit_events(id,organization_id,actor,action,target_type,target_id,details) VALUES($1,$2,$3,$4,'account',$5,$6)",
			[
				randomUUID(),
				this.organizationId,
				actor,
				action,
				targetId,
				JSON.stringify(details),
			],
		);
	}

	async isConfigured(): Promise<boolean> {
		return Boolean(
			(
				await this.pool.query(
					"SELECT 1 FROM member_accounts WHERE organization_id=$1 LIMIT 1",
					[this.organizationId],
				)
			).rowCount,
		);
	}

	async organization(): Promise<Organization> {
		const { rows } = await this.pool.query(
			"SELECT * FROM organizations WHERE id=$1",
			[this.organizationId],
		);
		const row = rows[0];

		if (!row) throw new AuthError("Company unavailable.", 503);
		return {
			id: row.id,
			name: row.name,
			slug: row.slug,
			createdAt: row.created_at.toISOString(),
			updatedAt: row.updated_at.toISOString(),
		};
	}

	async initializeCompanyName(name: string): Promise<Organization> {
		await this.transaction(async (client) => {
			await this.lockOrganization(client);
			await client.query(
				`UPDATE organizations SET name=$2,updated_at=now() WHERE id=$1
        AND NOT EXISTS (SELECT 1 FROM member_accounts WHERE organization_id=$1)`,
				[this.organizationId, name],
			);
		});
		return this.organization();
	}

	async limit(
		category: string,
		key: string,
		maximum = 10,
		seconds = 900,
	): Promise<void> {
		const digest = hashToken(`${this.organizationId}:${category}:${key}`);
		const result = await this.pool.query<{ attempts: number }>(
			`INSERT INTO auth_rate_limits(key_hash,organization_id,attempts,expires_at)
      VALUES($1,$2,1,now()+$3*interval '1 second') ON CONFLICT(key_hash) DO UPDATE SET
      attempts=CASE WHEN auth_rate_limits.expires_at<=now() THEN 1 ELSE auth_rate_limits.attempts+1 END,
      expires_at=CASE WHEN auth_rate_limits.expires_at<=now() THEN now()+$3*interval '1 second' ELSE auth_rate_limits.expires_at END RETURNING attempts`,
			[digest, this.organizationId, seconds],
		);

		if (result.rows[0]!.attempts > maximum)
			throw new AuthError(
				"Too many attempts. Please try again in 15 minutes.",
				429,
			);
	}

	private async grant(
		client: PoolClient,
		member: Member,
	): Promise<SessionGrant> {
		const token = randomBytes(32).toString("base64url");
		const hash = hashToken(token);
		const csrf = randomBytes(24).toString("base64url");
		const expiresAt = new Date(
			Date.now() + SESSION_SECONDS * 1_000,
		).toISOString();

		await client.query(
			"DELETE FROM web_sessions WHERE organization_id=$1 AND (expires_at<now() OR last_seen_at<now()-interval '1 hour')",
			[this.organizationId],
		);
		await client.query(
			"DELETE FROM auth_rate_limits WHERE organization_id=$1 AND expires_at<now()",
			[this.organizationId],
		);
		await client.query(
			"INSERT INTO web_sessions(token_hash,organization_id,member_id,csrf,expires_at) VALUES($1,$2,$3,$4,$5)",
			[hash, this.organizationId, member.id, csrf, expiresAt],
		);
		// Keep the most recent ten sessions per person; older sessions are revoked.
		await client.query(
			`DELETE FROM web_sessions WHERE organization_id=$1 AND member_id=$2 AND token_hash IN
      (SELECT token_hash FROM web_sessions WHERE organization_id=$1 AND member_id=$2 ORDER BY created_at DESC OFFSET 10)`,
			[this.organizationId, member.id],
		);
		return { token, session: { hash, csrf, expiresAt, member } };
	}

	async bootstrap(input: {
		email: string;
		displayName: string;
		password: string;
		companyName: string;
	}): Promise<SessionGrant> {
		const passwordHash = await hashPassword(input.password);

		return this.transaction(async (client) => {
			await this.lockOrganization(client);
			if (
				(
					await client.query(
						"SELECT 1 FROM member_accounts WHERE organization_id=$1 LIMIT 1",
						[this.organizationId],
					)
				).rowCount
			) {
				throw new AuthError(
					"This installation already has an owner. Sign in instead.",
					409,
				);
			}

			const member = await this.createAccount(
				client,
				input,
				"owner",
				passwordHash,
			);

			await client.query(
				"UPDATE organizations SET name=$2, updated_at=now() WHERE id=$1",
				[this.organizationId, input.companyName],
			);
			await client.query(
				"UPDATE members SET status='disabled',updated_at=now() WHERE organization_id=$1 AND subject='bootstrap:local-admin'",
				[this.organizationId],
			);
			await this.audit(
				client,
				`member:${member.id}`,
				"account.owner_created",
				member.id,
			);
			return this.grant(client, member);
		});
	}

	private async createAccount(
		client: PoolClient,
		input: { email: string; displayName: string },
		role: MemberRole,
		passwordHash: string | null,
	): Promise<Member> {
		const id = randomUUID();
		const email = input.email.trim().toLowerCase();
		const { rows } = await client.query<MemberRow>(
			`INSERT INTO members(id,organization_id,subject,display_name,email,role,status)
      VALUES($1,$2,$3,$4,$5,$6,'active') RETURNING *`,
			[
				id,
				this.organizationId,
				`local:${id}`,
				input.displayName,
				email,
				role,
			],
		);

		await client.query(
			"INSERT INTO member_accounts(member_id,organization_id,email,password_hash) VALUES($1,$2,$3,$4)",
			[id, this.organizationId, email, passwordHash],
		);
		return memberFromRow(rows[0]!);
	}

	async login(email: string, password: string): Promise<SessionGrant> {
		email = email.trim().toLowerCase();
		await this.limit("login-email", email);

		const { rows } = await this.pool.query<
			MemberRow & { password_hash: string }
		>(
			`SELECT m.*,a.password_hash FROM member_accounts a JOIN members m ON m.id=a.member_id
      WHERE a.organization_id=$1 AND m.organization_id=$1 AND a.email=$2`,
			[this.organizationId, email],
		);
		const row = rows[0];

		if (
			!(await verifyPassword(
				password,
				row?.password_hash ?? undefined,
			)) ||
			row?.status !== "active"
		) {
			throw new AuthError("Email or password is incorrect.", 401);
		}
		return this.transaction(async (client) => {
			// Recheck credentials under a lock so password changes and disabling cannot race a login.
			const current = await client.query<MemberRow>(
				`SELECT m.* FROM members m JOIN member_accounts a ON a.member_id=m.id
        WHERE m.id=$1 AND m.organization_id=$2 AND m.status='active' AND a.password_hash=$3 FOR UPDATE OF m,a`,
				[row.id, this.organizationId, row.password_hash],
			);

			if (!current.rows[0])
				throw new AuthError("Email or password is incorrect.", 401);
			await this.audit(
				client,
				`member:${row.id}`,
				"account.signed_in",
				row.id,
			);
			return this.grant(client, memberFromRow(current.rows[0]));
		});
	}

	async authenticate(token: string | null): Promise<BrowserSession | null> {
		if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;

		const hash = hashToken(token);
		const { rows } = await this.pool.query<
			MemberRow & { csrf: string; expires_at: Date }
		>(
			`UPDATE web_sessions s SET last_seen_at=now()
      FROM members m, member_accounts a WHERE s.token_hash=$1 AND s.organization_id=$2 AND m.id=s.member_id AND m.organization_id=$2
      AND a.member_id=m.id AND a.organization_id=$2 AND m.status='active' AND s.expires_at>now() AND s.last_seen_at>now()-interval '1 hour'
      RETURNING m.*,s.csrf,s.expires_at`,
			[hash, this.organizationId],
		);
		const row = rows[0];

		return row
			? {
					hash,
					csrf: row.csrf,
					expiresAt: row.expires_at.toISOString(),
					member: memberFromRow(row),
				}
			: null;
	}

	async logout(session: BrowserSession): Promise<void> {
		await this.transaction(async (client) => {
			await client.query(
				"DELETE FROM web_sessions WHERE token_hash=$1 AND organization_id=$2",
				[session.hash, this.organizationId],
			);
			await this.audit(
				client,
				`member:${session.member.id}`,
				"account.signed_out",
				session.member.id,
			);
		});
	}

	async onboarding(memberId: string) {
		const { rows } = await this.pool.query<{
			onboarding_completed_at: Date | null;
		}>(
			"SELECT onboarding_completed_at FROM member_accounts WHERE organization_id=$1 AND member_id=$2",
			[this.organizationId, memberId],
		);

		return {
			completedAt:
				rows[0]?.onboarding_completed_at?.toISOString() ?? null,
		};
	}

	async completeOnboarding(memberId: string) {
		await this.pool.query(
			"UPDATE member_accounts SET onboarding_completed_at=COALESCE(onboarding_completed_at,now()),updated_at=now() WHERE organization_id=$1 AND member_id=$2",
			[this.organizationId, memberId],
		);
		return this.onboarding(memberId);
	}

	async updateProfile(
		memberId: string,
		displayName: string,
	): Promise<Member> {
		return this.transaction(async (client) => {
			const { rows } = await client.query<MemberRow>(
				"UPDATE members SET display_name=$3,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *",
				[this.organizationId, memberId, displayName],
			);

			if (!rows[0]) throw new AuthError("Account not found.", 404);
			await this.audit(
				client,
				`member:${memberId}`,
				"account.profile_updated",
				memberId,
			);
			return memberFromRow(rows[0]);
		});
	}

	async updateCompany(member: Member, name: string): Promise<Organization> {
		if (!isAdministrator(member))
			throw new AuthError(
				"Only an administrator can change company settings.",
				403,
			);
		await this.transaction(async (client) => {
			await this.lockOrganization(client);
			await this.requireManager(client, member.id);
			await client.query(
				"UPDATE organizations SET name=$2,updated_at=now() WHERE id=$1",
				[this.organizationId, name],
			);
			await this.audit(
				client,
				`member:${member.id}`,
				"company.updated",
				this.organizationId,
			);
		});
		return this.organization();
	}

	async changePassword(
		session: BrowserSession,
		currentPassword: string,
		password: string,
	): Promise<SessionGrant> {
		await this.limit("password-change", session.member.id);

		const { rows } = await this.pool.query<{
			password_hash: string | null;
		}>(
			"SELECT password_hash FROM member_accounts WHERE member_id=$1 AND organization_id=$2",
			[session.member.id, this.organizationId],
		);

		if (!rows[0]) throw new AuthError("Please sign in again.", 401);
		if (
			rows[0].password_hash &&
			!(await verifyPassword(currentPassword, rows[0].password_hash))
		)
			throw new AuthError("The current password is incorrect.", 400);

		const nextHash = await hashPassword(password);

		return this.transaction(async (client) => {
			const current = await client.query<MemberRow>(
				"SELECT * FROM members WHERE id=$1 AND organization_id=$2 AND status='active' FOR UPDATE",
				[session.member.id, this.organizationId],
			);

			if (!current.rows[0])
				throw new AuthError("Please sign in again.", 401);

			const activeSession = await client.query(
				"SELECT 1 FROM web_sessions WHERE token_hash=$1 AND member_id=$2 AND expires_at>now() AND last_seen_at>now()-interval '1 hour'",
				[session.hash, session.member.id],
			);

			if (!activeSession.rowCount)
				throw new AuthError("Please sign in again.", 401);

			const updated = await client.query(
				"UPDATE member_accounts SET password_hash=$3,password_changed_at=now(),updated_at=now() WHERE member_id=$1 AND organization_id=$2 AND password_hash IS NOT DISTINCT FROM $4",
				[
					session.member.id,
					this.organizationId,
					nextHash,
					rows[0]!.password_hash,
				],
			);

			if (!updated.rowCount)
				throw new AuthError(
					"Your password changed. Please sign in again.",
					409,
				);
			await this.revokeCredentials(client, session.member.id);
			await this.audit(
				client,
				`member:${session.member.id}`,
				"account.password_changed",
				session.member.id,
			);
			return this.grant(client, memberFromRow(current.rows[0]));
		});
	}

	private async revokeCredentials(client: PoolClient, memberId: string) {
		await client.query(
			"DELETE FROM web_sessions WHERE organization_id=$1 AND member_id=$2",
			[this.organizationId, memberId],
		);
		await client.query(
			"UPDATE account_tokens SET revoked_at=now() WHERE organization_id=$1 AND member_id=$2 AND consumed_at IS NULL AND revoked_at IS NULL",
			[this.organizationId, memberId],
		);
	}

	async listAccounts(): Promise<Member[]> {
		const { rows } = await this.pool.query<MemberRow>(
			"SELECT m.* FROM members m JOIN member_accounts a ON a.member_id=m.id WHERE m.organization_id=$1 ORDER BY m.created_at",
			[this.organizationId],
		);

		return rows.map(memberFromRow);
	}

	async authenticationMethods(memberId: string) {
		const { rows } = await this.pool.query<{
			has_password: boolean;
			github_user_id: string | null;
			github_login: string | null;
		}>(
			"SELECT password_hash IS NOT NULL AS has_password,github_user_id,github_login FROM member_accounts WHERE organization_id=$1 AND member_id=$2",
			[this.organizationId, memberId],
		);
		const row = rows[0];

		return {
			hasPassword: Boolean(row?.has_password),
			github: row?.github_user_id
				? { id: row.github_user_id, login: row.github_login }
				: null,
		};
	}

	async saveGithubFlow(
		state: string,
		browser: string,
		encryptedPayload: string,
	) {
		await this.pool.query(
			"DELETE FROM github_login_flows WHERE organization_id=$1 AND expires_at<=now()",
			[this.organizationId],
		);
		await this.pool.query(
			"INSERT INTO github_login_flows(state_hash,organization_id,browser_hash,payload,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",
			[
				hashToken(state),
				this.organizationId,
				hashToken(browser),
				encryptedPayload,
			],
		);
	}

	async consumeGithubFlow(state: string, browser: string): Promise<string> {
		const { rows } = await this.pool.query<{ payload: string }>(
			"DELETE FROM github_login_flows WHERE state_hash=$1 AND organization_id=$2 AND browser_hash=$3 AND expires_at>now() RETURNING payload",
			[hashToken(state), this.organizationId, hashToken(browser)],
		);

		if (!rows[0])
			throw new AuthError(
				"This GitHub sign-in expired. Start again.",
				400,
			);
		return rows[0].payload;
	}

	async completeGithubLogin(
		intent: GithubLoginIntent,
		github: { id: string; login: string },
	): Promise<SessionGrant | null> {
		return this.transaction(async (client) => {
			await this.lockOrganization(client);

			const existing = await client.query<MemberRow>(
				`SELECT m.* FROM member_accounts a JOIN members m ON m.id=a.member_id
        WHERE a.organization_id=$1 AND a.github_user_id=$2 FOR UPDATE OF m,a`,
				[this.organizationId, github.id],
			);
			let member: Member;

			if (intent.purpose === "login") {
				if (!existing.rows[0]) throw new AuthError("not_linked", 403);
				if (existing.rows[0].status !== "active")
					throw new AuthError("This account is disabled.", 403);
				member = memberFromRow(existing.rows[0]);
			} else if (intent.purpose === "link") {
				const active = await client.query<MemberRow>(
					`SELECT m.* FROM members m JOIN member_accounts a ON a.member_id=m.id
          JOIN web_sessions s ON s.member_id=m.id WHERE m.id=$1 AND m.organization_id=$2 AND m.status='active'
          AND s.token_hash=$3 AND s.expires_at>now() AND s.last_seen_at>now()-interval '1 hour' FOR UPDATE OF m,a,s`,
					[intent.memberId, this.organizationId, intent.sessionHash],
				);

				if (!active.rows[0])
					throw new AuthError(
						"Please sign in again before connecting GitHub.",
						401,
					);
				if (existing.rows[0] && existing.rows[0].id !== intent.memberId)
					throw new AuthError(
						"This GitHub account is already connected.",
						409,
					);

				const linked = await client.query<{
					github_user_id: string | null;
				}>(
					"SELECT github_user_id FROM member_accounts WHERE member_id=$1",
					[intent.memberId],
				);

				if (
					linked.rows[0]?.github_user_id &&
					linked.rows[0].github_user_id !== github.id
				)
					throw new AuthError(
						"Disconnect the current GitHub account first.",
						409,
					);
				member = memberFromRow(active.rows[0]);
			} else {
				if (existing.rowCount)
					throw new AuthError(
						"This GitHub account already belongs to a workspace member. Sign in instead.",
						409,
					);
				if (intent.purpose === "setup") {
					if (
						(
							await client.query(
								"SELECT 1 FROM member_accounts WHERE organization_id=$1 LIMIT 1",
								[this.organizationId],
							)
						).rowCount
					)
						throw new AuthError("An owner already exists.", 409);
					member = await this.createAccount(
						client,
						intent,
						"owner",
						null,
					);
					await client.query(
						"UPDATE organizations SET name=$2,updated_at=now() WHERE id=$1",
						[this.organizationId, intent.companyName],
					);
					await client.query(
						"UPDATE members SET status='disabled',updated_at=now() WHERE organization_id=$1 AND subject='bootstrap:local-admin'",
						[this.organizationId],
					);
				} else {
					const invitation = await this.consume(
						client,
						intent.token,
						"invite",
					);

					member = await this.createAccount(
						client,
						{
							email: invitation.email,
							displayName: intent.displayName,
						},
						invitation.role,
						null,
					);
				}
			}
			await client.query(
				"UPDATE member_accounts SET github_user_id=$3,github_login=$4,updated_at=now() WHERE organization_id=$1 AND member_id=$2",
				[this.organizationId, member.id, github.id, github.login],
			);
			await this.audit(
				client,
				`member:${member.id}`,
				`account.github_${intent.purpose}`,
				member.id,
				{ githubUserId: github.id },
			);
			return intent.purpose === "link"
				? null
				: this.grant(client, member);
		});
	}

	async disconnectGithub(session: BrowserSession): Promise<SessionGrant> {
		return this.transaction(async (client) => {
			await this.lockOrganization(client);

			const { rows } = await client.query<
				MemberRow & { password_hash: string | null }
			>(
				`SELECT m.*,a.password_hash FROM members m JOIN member_accounts a ON a.member_id=m.id
        WHERE m.organization_id=$1 AND m.id=$2 AND m.status='active' FOR UPDATE OF m,a`,
				[this.organizationId, session.member.id],
			);

			if (!rows[0]?.password_hash)
				throw new AuthError(
					"Set a password before disconnecting your only sign-in method.",
					409,
				);
			await client.query(
				"UPDATE member_accounts SET github_user_id=NULL,github_login=NULL,updated_at=now() WHERE member_id=$1",
				[session.member.id],
			);
			await this.revokeCredentials(client, session.member.id);
			await this.audit(
				client,
				`member:${session.member.id}`,
				"account.github_disconnected",
				session.member.id,
			);
			return this.grant(client, memberFromRow(rows[0]));
		});
	}

	private async requireManager(
		client: PoolClient,
		memberId: string,
	): Promise<Member> {
		const { rows } = await client.query<MemberRow>(
			"SELECT * FROM members WHERE id=$1 AND organization_id=$2 AND status='active' FOR UPDATE",
			[memberId, this.organizationId],
		);

		if (!rows[0] || !isAdministrator(rows[0]))
			throw new AuthError("An active administrator is required.", 403);
		return memberFromRow(rows[0]);
	}

	async changeMembership(
		actor: Member,
		memberId: string,
		change: { role?: MemberRole; status?: "active" | "disabled" },
	): Promise<Member> {
		return this.transaction(async (client) => {
			await this.lockOrganization(client);

			const manager = await this.requireManager(client, actor.id);
			const { rows } = await client.query<MemberRow>(
				"SELECT m.* FROM members m JOIN member_accounts a ON a.member_id=m.id WHERE m.id=$1 AND m.organization_id=$2 FOR UPDATE OF m",
				[memberId, this.organizationId],
			);
			const target = rows[0];

			if (!target) throw new AuthError("Account not found.", 404);
			if (
				manager.role !== "owner" &&
				(target.role === "owner" ||
					target.role === "admin" ||
					change.role === "owner" ||
					change.role === "admin")
			) {
				throw new AuthError(
					"Only an owner can manage administrator and owner accounts.",
					403,
				);
			}

			const role = change.role ?? target.role;
			const status = change.status ?? target.status;

			if (
				target.role === "owner" &&
				target.status === "active" &&
				(role !== "owner" || status !== "active")
			) {
				const owners = await client.query(
					"SELECT m.id FROM members m JOIN member_accounts a ON a.member_id=m.id WHERE m.organization_id=$1 AND m.role='owner' AND m.status='active' AND m.id<>$2",
					[this.organizationId, memberId],
				);

				if (!owners.rowCount)
					throw new AuthError("Keep at least one active owner.", 409);
			}

			const updated = await client.query<MemberRow>(
				"UPDATE members SET role=$3,status=$4,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *",
				[this.organizationId, memberId, role, status],
			);

			await this.revokeCredentials(client, memberId);
			await this.audit(
				client,
				`member:${actor.id}`,
				"account.membership_changed",
				memberId,
				{ role, status },
			);
			return memberFromRow(updated.rows[0]!);
		});
	}

	async invite(
		actor: Member,
		email: string,
		role: MemberRole,
	): Promise<{ token: string; invitation: AccountToken }> {
		return this.transaction(async (client) => {
			await this.lockOrganization(client);

			const manager = await this.requireManager(client, actor.id);

			if (
				manager.role !== "owner" &&
				(role === "owner" || role === "admin")
			)
				throw new AuthError(
					"Only an owner can invite administrators or owners.",
					403,
				);
			if (
				(
					await client.query(
						"SELECT 1 FROM member_accounts WHERE organization_id=$1 AND email=$2",
						[this.organizationId, email],
					)
				).rowCount
			)
				throw new AuthError(
					"An account already exists for that email.",
					409,
				);
			await client.query(
				"UPDATE account_tokens SET revoked_at=now() WHERE organization_id=$1 AND email=$2 AND purpose='invite' AND consumed_at IS NULL AND revoked_at IS NULL",
				[this.organizationId, email],
			);
			return this.issueToken(
				client,
				actor.id,
				"invite",
				email,
				role,
				null,
			);
		});
	}

	private async issueToken(
		client: PoolClient,
		actorId: string | null,
		purpose: "invite" | "reset",
		email: string,
		role: MemberRole,
		memberId: string | null,
	) {
		const token = randomBytes(32).toString("base64url");
		const seconds = purpose === "invite" ? 7 * 24 * 60 * 60 : 60 * 60;
		const { rows } = await client.query<TokenRow>(
			`INSERT INTO account_tokens(id,organization_id,token_hash,purpose,email,role,member_id,created_by,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+$9*interval '1 second') RETURNING *`,
			[
				randomUUID(),
				this.organizationId,
				hashToken(token),
				purpose,
				email,
				role,
				memberId,
				actorId,
				seconds,
			],
		);

		await this.audit(
			client,
			actorId ? `member:${actorId}` : "operator:recovery",
			`account.${purpose}_issued`,
			memberId ?? rows[0]!.id,
			{ role },
		);
		return { token, invitation: tokenFromRow(rows[0]!) };
	}

	async listInvitations(): Promise<AccountToken[]> {
		const { rows } = await this.pool.query<TokenRow>(
			"SELECT * FROM account_tokens WHERE organization_id=$1 AND purpose='invite' ORDER BY created_at DESC LIMIT 100",
			[this.organizationId],
		);

		return rows.map(tokenFromRow);
	}

	async revokeInvitation(actor: Member, id: string) {
		await this.transaction(async (client) => {
			await this.lockOrganization(client);

			const manager = await this.requireManager(client, actor.id);
			const { rows } = await client.query<TokenRow>(
				"SELECT * FROM account_tokens WHERE organization_id=$1 AND id=$2 AND purpose='invite' FOR UPDATE",
				[this.organizationId, id],
			);

			if (!rows[0]) throw new AuthError("Invitation not found.", 404);
			if (
				manager.role !== "owner" &&
				["owner", "admin"].includes(rows[0].role)
			)
				throw new AuthError(
					"Only an owner can revoke this invitation.",
					403,
				);
			await client.query(
				"UPDATE account_tokens SET revoked_at=now() WHERE id=$1",
				[id],
			);
			await this.audit(
				client,
				`member:${actor.id}`,
				"account.invite_revoked",
				id,
			);
		});
	}

	private async consume(
		client: PoolClient,
		token: string,
		purpose: "invite" | "reset",
	): Promise<TokenRow> {
		const { rows } = await client.query<TokenRow>(
			`UPDATE account_tokens SET consumed_at=now() WHERE token_hash=$1 AND organization_id=$2 AND purpose=$3
      AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING *`,
			[hashToken(token), this.organizationId, purpose],
		);

		if (!rows[0])
			throw new AuthError(
				"This link is invalid or expired. Ask an administrator for a new one.",
				400,
			);
		return rows[0];
	}

	async acceptInvitation(
		token: string,
		displayName: string,
		password: string,
	): Promise<SessionGrant> {
		const passwordHash = await hashPassword(password);

		return this.transaction(async (client) => {
			await this.lockOrganization(client);

			const invitation = await this.consume(client, token, "invite");
			const member = await this.createAccount(
				client,
				{ email: invitation.email, displayName },
				invitation.role,
				passwordHash,
			);

			await this.audit(
				client,
				`member:${member.id}`,
				"account.invite_accepted",
				member.id,
			);
			return this.grant(client, member);
		});
	}

	async issueReset(actor: Member, memberId: string) {
		return this.transaction(async (client) => {
			await this.lockOrganization(client);

			const manager = await this.requireManager(client, actor.id);
			const { rows } = await client.query<MemberRow>(
				"SELECT m.* FROM members m JOIN member_accounts a ON a.member_id=m.id WHERE m.id=$1 AND m.organization_id=$2 AND m.status='active' FOR UPDATE OF m",
				[memberId, this.organizationId],
			);
			const member = rows[0];

			if (!member) throw new AuthError("Active account not found.", 404);
			if (
				manager.role !== "owner" &&
				["owner", "admin"].includes(member.role)
			)
				throw new AuthError(
					"Only an owner can recover this account.",
					403,
				);
			await client.query(
				"UPDATE account_tokens SET revoked_at=now() WHERE member_id=$1 AND organization_id=$2 AND purpose='reset' AND consumed_at IS NULL",
				[memberId, this.organizationId],
			);
			return this.issueToken(
				client,
				actor.id,
				"reset",
				member.email!,
				member.role,
				member.id,
			);
		});
	}

	/** Operator-only CLI recovery. Never exposed as an unauthenticated HTTP route. */
	async operatorReset(email: string) {
		return this.transaction(async (client) => {
			await this.lockOrganization(client);

			const { rows } = await client.query<MemberRow>(
				"SELECT m.* FROM members m JOIN member_accounts a ON a.member_id=m.id WHERE a.email=$1 AND m.organization_id=$2 AND m.status='active' FOR UPDATE OF m",
				[email.toLowerCase(), this.organizationId],
			);

			if (!rows[0]) throw new AuthError("Active account not found.", 404);
			await this.revokeCredentials(client, rows[0].id);
			return this.issueToken(
				client,
				null,
				"reset",
				rows[0].email!,
				rows[0].role,
				rows[0].id,
			);
		});
	}

	async resetPassword(token: string, password: string): Promise<void> {
		const passwordHash = await hashPassword(password);

		await this.transaction(async (client) => {
			await this.lockOrganization(client);

			const reset = await this.consume(client, token, "reset");
			const member = await client.query(
				"SELECT id FROM members WHERE id=$1 AND organization_id=$2 AND status='active' FOR UPDATE",
				[reset.member_id, this.organizationId],
			);

			if (!member.rowCount)
				throw new AuthError("This account is unavailable.", 400);
			await client.query(
				"UPDATE member_accounts SET password_hash=$3,password_changed_at=now(),updated_at=now() WHERE member_id=$1 AND organization_id=$2",
				[reset.member_id, this.organizationId, passwordHash],
			);
			await this.revokeCredentials(client, reset.member_id!);
			await this.audit(
				client,
				`member:${reset.member_id}`,
				"account.password_reset",
				reset.member_id!,
			);
		});
	}
}
