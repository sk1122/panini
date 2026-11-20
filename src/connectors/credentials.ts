import { createHash } from "node:crypto";
import type pg from "pg";
import type { RuntimeConfig } from "../config.js";
import type { PayloadCipher } from "../security/payload-cipher.js";

/*
 * Connector credentials an admin adds from the Integrations page. They are
 * stored encrypted with the content key and applied to the runtime config at
 * startup, unless the server's environment already configures that connector.
 * When they change, the process restarts so the connector starts with them.
 */

export interface GithubStored {
	appId: number;
	appSlug: string;
	clientId: string;
	clientSecret: string;
	privateKey: string;
	webhookSecret: string;
	htmlUrl: string;
}

export interface SlackStored {
	botToken: string;
	appToken: string;
	channels: string[];
	team: string;
}

export interface NotionStored {
	token: string;
	workspace: string;
}

export interface StoredConnectors {
	github?: GithubStored;
	slack?: SlackStored;
	notion?: NotionStored;
}

export type ConnectorProvider = keyof StoredConnectors;

export const connectorProviders = ["github", "slack", "notion"] as const;

export class PostgresConnectorCredentials {
	constructor(
		private readonly pool: pg.Pool,
		private readonly organizationId: string,
		private readonly cipher: PayloadCipher,
	) {}

	async all(): Promise<StoredConnectors> {
		const rows = (
			await this.pool.query(
				"SELECT provider, envelope FROM connector_credentials WHERE organization_id=$1",
				[this.organizationId],
			)
		).rows;

		return Object.fromEntries(
			rows.map((row) => [
				row.provider,
				this.cipher.decrypt(row.envelope),
			]),
		) as StoredConnectors;
	}

	/** Changes whenever any credential is saved or removed. */
	async version(): Promise<string> {
		const rows = (
			await this.pool.query(
				"SELECT provider, updated_at FROM connector_credentials WHERE organization_id=$1 ORDER BY provider",
				[this.organizationId],
			)
		).rows;

		return createHash("sha256")
			.update(
				JSON.stringify(
					rows.map((row) => [row.provider, String(row.updated_at)]),
				),
			)
			.digest("hex");
	}

	async save<P extends ConnectorProvider>(
		provider: P,
		value: NonNullable<StoredConnectors[P]>,
		updatedBy: string,
	): Promise<void> {
		await this.pool.query(
			`INSERT INTO connector_credentials (organization_id,provider,envelope,updated_by,updated_at)
			 VALUES ($1,$2,$3,$4,now())
			 ON CONFLICT (organization_id,provider) DO UPDATE SET envelope=$3, updated_by=$4, updated_at=now()`,
			[
				this.organizationId,
				provider,
				JSON.stringify(
					this.cipher.encrypt(
						value as unknown as Parameters<
							PayloadCipher["encrypt"]
						>[0],
					),
				),
				updatedBy,
			],
		);
	}

	async remove(provider: ConnectorProvider): Promise<void> {
		await this.pool.query(
			"DELETE FROM connector_credentials WHERE organization_id=$1 AND provider=$2",
			[this.organizationId, provider],
		);
	}
}

/** Which connectors the server environment sets; stored ones never override these. */
export function environmentConnectors(config: RuntimeConfig) {
	return {
		github: Boolean(config.githubApp),
		slack: Boolean(config.slackAppToken || config.slackBotToken),
		notion: Boolean(config.notionToken),
	};
}

/** Puts stored credentials into the runtime config where the environment left a gap. */
export function applyStoredConnectors(
	config: RuntimeConfig,
	stored: StoredConnectors,
	baseUrl: string,
): void {
	const fromEnvironment = environmentConnectors(config);
	const mutable = config as {
		-readonly [K in keyof RuntimeConfig]: RuntimeConfig[K];
	};

	if (stored.github && !fromEnvironment.github) {
		mutable.githubApp = {
			appId: stored.github.appId,
			appSlug: stored.github.appSlug,
			clientId: stored.github.clientId,
			clientSecret: stored.github.clientSecret,
			privateKey: stored.github.privateKey,
			callbackUrl: `${baseUrl}/api/github/oauth/callback`,
		};
		mutable.githubWebhookSecret = stored.github.webhookSecret;
	}
	if (stored.slack && !fromEnvironment.slack) {
		mutable.slackBotToken = stored.slack.botToken;
		mutable.slackAppToken = stored.slack.appToken;
		// The admin chose these channels for Panini, so the nightly run may read them.
		mutable.jevWorkAllowedVisibilities = [
			...new Set([
				...(config.jevWorkAllowedVisibilities.length
					? config.jevWorkAllowedVisibilities
					: ["company"]),
				...stored.slack.channels.map(
					(channel) => `slack:channel:${channel}`,
				),
			]),
		];
		mutable.app = {
			...config.app,
			slack: {
				enabled: true,
				installationKey: config.app.slack?.installationKey ?? "default",
				channels: stored.slack.channels,
				// The nightly run reads every message in the chosen channels.
				captureMode: "all_messages",
				captureReactions: config.app.slack?.captureReactions ?? [
					"panini",
					"bookmark",
				],
			},
		};
	}
	if (stored.notion && !fromEnvironment.notion) {
		mutable.notionToken = stored.notion.token;
		mutable.app = {
			...mutable.app,
			notion: {
				...config.app.notion,
				enabled: true,
				sources: config.app.notion.sources.length
					? config.app.notion.sources
					: [
							{
								key: "workspace",
								kind: "workspace",
								ingestAs: "company_context",
								contextPath: "/notion",
								visibility: "company",
								statusMap: {},
							},
						],
			},
		};
	}
}

/** GitHub creates the app from this manifest and returns its credentials to Panini. */
export function githubAppManifest(baseUrl: string, companyName: string) {
	const publicHttps =
		baseUrl.startsWith("https://") &&
		!/\/\/(localhost|127\.0\.0\.1)/.test(baseUrl);
	const suffix = Math.random().toString(36).slice(2, 6);

	return {
		name: `Panini ${companyName}`.slice(0, 28).trim() + ` ${suffix}`,
		url: baseUrl,
		redirect_url: `${baseUrl}/api/integrations/github/created`,
		callback_urls: [`${baseUrl}/api/github/oauth/callback`],
		setup_url: `${baseUrl}/app/integrations`,
		public: false,
		default_permissions: {
			contents: "read",
			metadata: "read",
			pull_requests: "read",
			checks: "read",
			issues: "read",
		},
		// Webhooks need a public address; without one, Panini syncs on a timer.
		...(publicHttps
			? {
					hook_attributes: {
						url: `${baseUrl}/api/webhooks/github`,
						active: true,
					},
					default_events: [
						"push",
						"pull_request",
						"check_run",
						"issues",
					],
				}
			: { default_events: [] }),
	};
}

/** A Slack app in Socket Mode, so no public address is needed. */
export function slackAppManifest(companyName: string) {
	return {
		display_information: {
			name: "Panini",
			description: `Reads chosen ${companyName} channels so Panini can keep work and context up to date.`,
		},
		features: {
			bot_user: { display_name: "Panini", always_online: false },
		},
		oauth_config: {
			scopes: {
				bot: [
					"channels:history",
					"channels:read",
					"groups:history",
					"groups:read",
					"reactions:read",
					"users:read",
				],
			},
		},
		settings: {
			event_subscriptions: {
				bot_events: [
					"message.channels",
					"message.groups",
					"reaction_added",
				],
			},
			socket_mode_enabled: true,
			org_deploy_enabled: false,
			token_rotation_enabled: false,
		},
	};
}

type Check = { ok: true; label: string } | { ok: false; reason: string };

export async function checkSlack(
	botToken: string,
	appToken: string,
	fetcher: typeof fetch = fetch,
): Promise<Check> {
	if (!botToken.startsWith("xoxb-"))
		return { ok: false, reason: "The bot token starts with xoxb-." };
	if (!appToken.startsWith("xapp-"))
		return { ok: false, reason: "The app-level token starts with xapp-." };

	const auth = (await (
		await fetcher("https://slack.com/api/auth.test", {
			method: "POST",
			headers: { authorization: `Bearer ${botToken}` },
			signal: AbortSignal.timeout(15_000),
		})
	).json()) as { ok: boolean; team?: string; error?: string };

	if (!auth.ok)
		return {
			ok: false,
			reason: `Slack refused the bot token (${auth.error}).`,
		};

	const socket = (await (
		await fetcher("https://slack.com/api/apps.connections.open", {
			method: "POST",
			headers: { authorization: `Bearer ${appToken}` },
			signal: AbortSignal.timeout(15_000),
		})
	).json()) as { ok: boolean; error?: string };

	if (!socket.ok)
		return {
			ok: false,
			reason: `Slack refused the app-level token (${socket.error}). Give it the connections:write scope.`,
		};
	return { ok: true, label: auth.team ?? "Slack" };
}

export async function checkNotion(
	token: string,
	fetcher: typeof fetch = fetch,
): Promise<Check> {
	const response = await fetcher("https://api.notion.com/v1/users/me", {
		headers: {
			authorization: `Bearer ${token}`,
			"notion-version": "2022-06-28",
		},
		signal: AbortSignal.timeout(15_000),
	});

	if (!response.ok)
		return {
			ok: false,
			reason:
				response.status === 401
					? "Notion did not accept this token."
					: `Notion answered ${response.status}.`,
		};

	const me = (await response.json()) as {
		bot?: { workspace_name?: string };
	};

	return { ok: true, label: me.bot?.workspace_name ?? "Notion" };
}

/** Exchanges the one-time code GitHub returns after creating the app. */
export async function convertGithubManifest(
	code: string,
	fetcher: typeof fetch = fetch,
): Promise<GithubStored> {
	const response = await fetcher(
		`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
		{
			method: "POST",
			headers: { accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(20_000),
		},
	);

	if (!response.ok)
		throw new Error(`GitHub did not return the app (${response.status}).`);

	const app = (await response.json()) as {
		id: number;
		slug: string;
		client_id: string;
		client_secret: string;
		pem: string;
		webhook_secret: string | null;
		html_url: string;
	};

	return {
		appId: app.id,
		appSlug: app.slug,
		clientId: app.client_id,
		clientSecret: app.client_secret,
		privateKey: app.pem,
		webhookSecret:
			app.webhook_secret ??
			createHash("sha256").update(app.pem).digest("hex").slice(0, 40),
		htmlUrl: app.html_url,
	};
}
