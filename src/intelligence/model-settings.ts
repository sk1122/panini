import Anthropic from "@anthropic-ai/sdk";
import type pg from "pg";
import type { PayloadCipher } from "../security/payload-cipher.js";
import { isClaudeModel } from "./claude-responses.js";

/*
 * The model the nightly run uses, chosen by an admin in setup or Settings,
 * with the workspace's own API key. The key is stored encrypted with the
 * content key and is never returned to the browser; only its last 4
 * characters are.
 */

export const supportedModels = [
	{
		id: "claude-haiku-5-5",
		label: "Claude Haiku 5.5",
		provider: "Anthropic",
		note: "Recommended. Fast and low cost.",
	},
	{
		id: "claude-sonnet-5-5",
		label: "Claude Sonnet 5.5",
		provider: "Anthropic",
		note: "More careful, about 20 times the cost.",
	},
	{
		id: "gpt-6-luna",
		label: "GPT-6 Luna",
		provider: "OpenAI",
		note: "OpenAI key.",
	},
] as const;

export type SupportedModel = (typeof supportedModels)[number]["id"];

export const isSupportedModel = (model: string): model is SupportedModel =>
	supportedModels.some((item) => item.id === model);

export interface ModelSettings {
	model: SupportedModel;
	apiKey: string;
	keyHint: string;
	budgetId: string | null;
	updatedBy: string;
	updatedAt: string;
}

/** Asks the provider whether this key can use this model. Costs nothing. */
export async function checkModelKey(
	model: SupportedModel,
	apiKey: string,
	fetcher: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	try {
		if (isClaudeModel(model)) {
			await new Anthropic({ apiKey, fetch: fetcher }).models.retrieve(
				model,
			);
			return { ok: true };
		}

		const response = await fetcher(
			`https://api.openai.com/v1/models/${model}`,
			{
				headers: { authorization: `Bearer ${apiKey}` },
				signal: AbortSignal.timeout(15_000),
			},
		);

		return response.ok
			? { ok: true }
			: {
					ok: false,
					reason:
						response.status === 401
							? "The provider did not accept this key."
							: `The provider answered ${response.status}.`,
				};
	} catch (error) {
		if (error instanceof Anthropic.AuthenticationError)
			return {
				ok: false,
				reason: "The provider did not accept this key.",
			};
		if (error instanceof Anthropic.NotFoundError)
			return { ok: false, reason: "This key cannot use that model." };
		if (error instanceof Anthropic.APIError)
			return {
				ok: false,
				reason: `The provider answered ${error.status ?? "an error"}.`,
			};
		return { ok: false, reason: "Could not reach the provider." };
	}
}

export class PostgresModelSettings {
	constructor(
		private readonly pool: pg.Pool,
		private readonly organizationId: string,
		private readonly cipher: PayloadCipher,
	) {}

	async get(): Promise<ModelSettings | null> {
		const row = (
			await this.pool.query(
				"SELECT * FROM model_settings WHERE organization_id=$1",
				[this.organizationId],
			)
		).rows[0];

		if (!row || !isSupportedModel(row.model)) return null;
		return {
			model: row.model,
			apiKey: String(this.cipher.decrypt(row.api_key_envelope)),
			keyHint: row.key_hint,
			budgetId: row.budget_id,
			updatedBy: row.updated_by,
			updatedAt: new Date(row.updated_at).toISOString(),
		};
	}

	async save(input: {
		model: SupportedModel;
		apiKey: string;
		updatedBy: string;
	}): Promise<void> {
		await this.pool.query(
			`INSERT INTO model_settings (organization_id,model,api_key_envelope,key_hint,budget_id,updated_by,updated_at)
			 VALUES ($1,$2,$3,$4,NULL,$5,now())
			 ON CONFLICT (organization_id) DO UPDATE SET model=$2, api_key_envelope=$3, key_hint=$4, budget_id=NULL, updated_by=$5, updated_at=now()`,
			[
				this.organizationId,
				input.model,
				JSON.stringify(this.cipher.encrypt(input.apiKey)),
				input.apiKey.slice(-4),
				input.updatedBy,
			],
		);
	}

	async remove(): Promise<void> {
		await this.pool.query(
			"DELETE FROM model_settings WHERE organization_id=$1",
			[this.organizationId],
		);
	}

	async setBudget(budgetId: string): Promise<void> {
		await this.pool.query(
			"UPDATE model_settings SET budget_id=$2 WHERE organization_id=$1",
			[this.organizationId, budgetId],
		);
	}
}
