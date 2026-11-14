import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import type pg from "pg";
import { DomainError } from "../domain/errors.js";

/*
 * MCP authorization (OAuth 2.1, spec 7.2): Panini is both the protected
 * resource (/mcp) and its own authorization server. Access tokens are short-lived,
 * signed and bound to the /mcp audience; refresh tokens are single-use and rotate.
 */

export const ACCESS_TOKEN_TTL_SECONDS = 3_600;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3_600_000;

export interface OAuthClient {
	clientId: string;
	clientName: string;
	redirectUris: string[];
}

export class PostgresOAuthStore {
	constructor(
		private readonly pool: pg.Pool,
		private readonly organizationId: string,
	) {}

	async registerClient(input: {
		clientName: string;
		redirectUris: string[];
	}): Promise<OAuthClient> {
		const clientId = `panini_client_${randomBytes(16).toString("base64url")}`;

		await this.pool.query(
			"INSERT INTO oauth_clients (client_id,organization_id,client_name,redirect_uris) VALUES ($1,$2,$3,$4)",
			[
				clientId,
				this.organizationId,
				input.clientName,
				input.redirectUris,
			],
		);
		return { clientId, ...input };
	}

	async getClient(clientId: string): Promise<OAuthClient | null> {
		const row = (
			await this.pool.query<{
				client_id: string;
				client_name: string;
				redirect_uris: string[];
			}>(
				"SELECT * FROM oauth_clients WHERE organization_id=$1 AND client_id=$2",
				[this.organizationId, clientId],
			)
		).rows[0];

		return row
			? {
					clientId: row.client_id,
					clientName: row.client_name,
					redirectUris: row.redirect_uris,
				}
			: null;
	}

	async issueRefreshToken(
		clientId: string,
		agentProfileId: string,
	): Promise<string> {
		const token = `prt_${randomBytes(32).toString("base64url")}`;

		await this.pool.query(
			"INSERT INTO oauth_refresh_tokens (token_hash,organization_id,client_id,agent_profile_id,expires_at) VALUES ($1,$2,$3,$4,$5)",
			[
				hashToken(token),
				this.organizationId,
				clientId,
				agentProfileId,
				new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
			],
		);
		return token;
	}

	/** Single use: a replayed refresh token fails. */
	async consumeRefreshToken(
		token: string,
		clientId: string,
	): Promise<string | null> {
		const row = (
			await this.pool.query<{ agent_profile_id: string }>(
				`UPDATE oauth_refresh_tokens SET used_at=now()
         WHERE organization_id=$1 AND token_hash=$2 AND client_id=$3 AND used_at IS NULL AND expires_at > now()
         RETURNING agent_profile_id`,
				[this.organizationId, hashToken(token), clientId],
			)
		).rows[0];

		return row?.agent_profile_id ?? null;
	}
}

export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Signs short-lived access tokens with a key derived from the content key. */
export class AccessTokenSigner {
	private readonly key: Buffer;

	constructor(secret: string) {
		this.key = createHmac("sha256", secret)
			.update("panini-mcp-oauth-access-v1")
			.digest();
	}

	issue(input: {
		agentProfileId: string;
		audience: string;
		ttlSeconds?: number;
	}): string {
		const body = Buffer.from(
			JSON.stringify({
				p: input.agentProfileId,
				a: input.audience,
				e:
					Math.floor(Date.now() / 1000) +
					(input.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS),
			}),
		).toString("base64url");

		return `pat_${body}.${this.sign(body)}`;
	}

	/** Returns the agent profile id when the token is genuine, unexpired and for this audience. */
	verify(token: string, audience: string): string | null {
		const match = /^pat_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);

		if (!match) return null;

		const expected = Buffer.from(this.sign(match[1]!));
		const given = Buffer.from(match[2]!);

		if (
			expected.length !== given.length ||
			!timingSafeEqual(expected, given)
		)
			return null;

		try {
			const claims = JSON.parse(
				Buffer.from(match[1]!, "base64url").toString("utf8"),
			) as { p?: string; a?: string; e?: number };

			if (
				typeof claims.p !== "string" ||
				claims.a !== audience ||
				typeof claims.e !== "number" ||
				claims.e <= Math.floor(Date.now() / 1000)
			)
				return null;
			return claims.p;
		} catch {
			return null;
		}
	}

	private sign(body: string): string {
		return createHmac("sha256", this.key).update(body).digest("base64url");
	}
}

export function verifyPkce(verifier: string, challenge: string): boolean {
	if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;

	const computed = Buffer.from(
		createHash("sha256").update(verifier).digest("base64url"),
	);
	const given = Buffer.from(challenge);

	return computed.length === given.length && timingSafeEqual(computed, given);
}

/** https anywhere; plain http only for loopback, as OAuth 2.1 native clients use. */
export function validRedirectUri(value: string): boolean {
	try {
		const url = new URL(value);

		if (url.hash) return false;
		if (url.protocol === "https:") return true;
		return (
			url.protocol === "http:" &&
			["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
		);
	} catch {
		return false;
	}
}

export function oauthError(
	error: string,
	description: string,
): DomainError & { oauth: { error: string; error_description: string } } {
	return Object.assign(new DomainError(description, "INVALID"), {
		oauth: { error, error_description: description },
	});
}
