import { afterEach, describe, expect, it, vi } from "vitest";
import { buildHttpServer } from "../src/http/server.js";
import { OutboxQueue } from "../src/outbox/runtime.js";
import { ReplayVerifier } from "../src/replay/verifier.js";
import { createPaniniCore } from "../src/runtime/core.js";

const previous = {
	retrievalProvider: process.env.RETRIEVAL_PROVIDER,
	openrouterApiKey: process.env.OPENROUTER_API_KEY,
	typesafeApiKey: process.env.TYPESAFE_API_KEY,
	jevWorkAllowedVisibilities: process.env.JEV_WORK_ALLOWED_VISIBILITIES,
	databaseUrl: process.env.DATABASE_URL,
	appAdminToken: process.env.APP_ADMIN_TOKEN,
};

afterEach(() => {
	for (const [key, value] of Object.entries({
		RETRIEVAL_PROVIDER: previous.retrievalProvider,
		OPENROUTER_API_KEY: previous.openrouterApiKey,
		TYPESAFE_API_KEY: previous.typesafeApiKey,
		JEV_WORK_ALLOWED_VISIBILITIES: previous.jevWorkAllowedVisibilities,
		DATABASE_URL: previous.databaseUrl,
		APP_ADMIN_TOKEN: previous.appAdminToken,
	})) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	vi.unstubAllGlobals();
});

describe("Jev main runtime wiring", () => {
	it("constructs the proposal-fit classifier from the normal Jev configuration", async () => {
		process.env.OPENROUTER_API_KEY = "test-only";
		delete process.env.TYPESAFE_API_KEY;
		process.env.JEV_WORK_ALLOWED_VISIBILITIES = "company";
		delete process.env.DATABASE_URL;

		const fetcher = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				const payload = JSON.parse(String(init?.body));

				expect(String(url)).toBe(
					"https://openrouter.ai/api/alpha/decisions",
				);
				expect(new Headers(init?.headers).get("authorization")).toBe(
					"Bearer test-only",
				);
				expect(payload).toMatchObject({
					model: "typesafe/jev-1.13",
					questions: { fit: { type: "choice" } },
				});
				return new Response(
					JSON.stringify({
						model: "typesafe/jev-1.13-20260917",
						answers: {
							fit: {
								type: "choice",
								choice: "fits",
								confidence: 0.93,
								probabilities: { fits: 0.93, invalid: 0.07 },
							},
						},
					}),
					{ status: 200 },
				);
			},
		);

		vi.stubGlobal("fetch", fetcher);

		const core = await createPaniniCore({ runMigrations: false });

		try {
			expect(core.proposalClassifier).not.toBeNull();

			const result = await core.proposalClassifier!.classify({
				proposal: {
					id: "00000000-0000-4000-8000-000000000001",
					clientEventId: "fit",
					taskId: null,
					baseVersion: null,
					kind: "task_create",
					state: "pending",
					changes: { title: "Verify Alpha" },
					rationale: "This is a concrete next step.",
					requestedBy: "agent:test",
					evidenceIds: [],
					createdAt: "2026-09-22T00:00:00.000Z",
					decidedAt: null,
					decidedBy: null,
					decisionNote: null,
				},
				tasks: [],
				context: {
					generatedAt: "2026-09-22T00:00:00.000Z",
					tree: [],
					facts: [],
					files: [],
					counts: {
						facts: 0,
						files: 0,
						folders: 0,
						accepted: 0,
						needsReview: 0,
						superseded: 0,
						outsideEffectiveInterval: 0,
					},
				},
				evidence: [],
			});

			expect(result).toEqual({
				decision: "fits",
				confidence: 0.93,
				fitProbability: 0.93,
				model: "typesafe/jev-1.13",
				reason: "The proposal fits the visible accepted work and context.",
			});
		} finally {
			await core.store.close();
		}
	});

	it("serves a Jev-ranked context pack through the real HTTP route", async () => {
		process.env.RETRIEVAL_PROVIDER = "jev";
		process.env.OPENROUTER_API_KEY = "test-only";
		delete process.env.TYPESAFE_API_KEY;
		process.env.APP_ADMIN_TOKEN = "test-admin";
		delete process.env.DATABASE_URL;

		const fetcher = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				const payload = JSON.parse(String(init?.body));

				expect(String(url)).toBe(
					"https://openrouter.ai/api/alpha/decisions",
				);
				expect(new Headers(init?.headers).get("authorization")).toBe(
					"Bearer test-only",
				);
				expect(payload.model).toBe("typesafe/jev-1.13");
				return new Response(
					JSON.stringify({
						model: "typesafe/jev-1.13-20260917",
						answers: { relevant: { type: "noul", noul: 0.91 } },
					}),
					{ status: 200 },
				);
			},
		);

		vi.stubGlobal("fetch", fetcher);

		const core = await createPaniniCore({ runMigrations: false });
		const app = await buildHttpServer({
			ledger: core.ledger,
			config: core.config,
			intelligence: core.intelligence,
			adjudicator: core.adjudicator,
			jobs: new OutboxQueue(core.store),
			replay: new ReplayVerifier(core.store),
		});

		try {
			await core.ledger.createContextEntry(
				{
					kind: "fact",
					path: "/decisions/edge",
					title: "Edge decision",
					factType: "decision",
					value: "Uncalibrated edges do not propagate belief.",
				},
				"user:reviewer",
			);

			const response = await app.inject({
				method: "GET",
				url: "/api/context/search?objective=edge&limit=10&characterBudget=30000",
				headers: { authorization: "Bearer test-admin" },
			});

			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				provider: "jev",
				manifest: {
					provider: "jev",
					rankingModel: "typesafe/jev-1.13",
				},
				entries: [{ path: "/decisions/edge" }],
			});
			expect(fetcher).toHaveBeenCalledTimes(1);
		} finally {
			await app.close();
			await core.store.close();
		}
	});
});
