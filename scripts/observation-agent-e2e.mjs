import { verifyOntologyBrowser } from "./ontology-browser-e2e.mjs";
import { runWorkStateProbes } from "./ontology-state-probes.mjs";
// E2E failures: default routing starts old stages; manual-review startup gate;
// pending writes; collection-time provenance; unreadable accepted projection; duplicate restart.
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import pg from "pg";
import YAML from "yaml";
import { migrate } from "../dist/src/db/migrate.js";
import { PostgresLedgerStore } from "../dist/src/store/postgres.js";

const ontology = process.env.PANINI_TEST_ONTOLOGY === "1";
const root = path.resolve(import.meta.dirname, "..");
const baseUrl = process.env.PANINI_TEST_DATABASE_URL;
const contentKey = process.env.CONTENT_ENCRYPTION_KEY;

if (
	!baseUrl ||
	!contentKey ||
	!/^panini_e2e(?:_.*)?$/.test(new URL(baseUrl).pathname.slice(1))
) {
	throw new Error(
		"Set PANINI_TEST_DATABASE_URL to a disposable panini_e2e database and CONTENT_ENCRYPTION_KEY.",
	);
}

const suffix = randomBytes(5).toString("hex");
const database = `panini_e2e_process_${suffix}`;
const targetUrl = new URL(baseUrl);

targetUrl.pathname = `/${database}`;

const reportDir = path.join(root, "artifacts/observation-agent");
const reportPath = path.join(reportDir, `agent-process-e2e-${suffix}.json`);
const admin = new pg.Pool({ connectionString: baseUrl });
const startedAt = new Date().toISOString();
const processes = [];
let store;
let stub;
let report;
let stateProbeChecks = [];
let browserChecks = [];
let wireContractError = null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 20_000) {
	const stop = Date.now() + timeoutMs;
	let last;

	while (Date.now() < stop) {
		if (wireContractError) throw new Error(wireContractError);
		try {
			const result = await check();

			if (result) return result;
		} catch (error) {
			last = error;
		}
		await delay(100);
	}
	throw new Error(
		`${label} did not become ready${last ? `: ${last.message}` : ""}`,
	);
}

function start(file, env) {
	const child = spawn(process.execPath, [path.join(root, file)], {
		cwd: root,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";

	for (const stream of [child.stdout, child.stderr])
		stream.on("data", (chunk) => {
			output = `${output}${chunk.toString()}`.slice(-20_000);
		});

	const entry = {
		child,
		get output() {
			return output;
		},
	};

	processes.push(entry);
	return entry;
}

async function stop(entry) {
	if (entry.child.exitCode !== null) return;
	entry.child.kill("SIGTERM");
	await Promise.race([
		new Promise((resolve) => entry.child.once("exit", resolve)),
		delay(5_000).then(() => {
			entry.child.kill("SIGKILL");
		}),
	]);
}

try {
	await admin.query(`CREATE DATABASE ${database}`);
	await migrate(targetUrl.toString());
	store = new PostgresLedgerStore(
		targetUrl.toString(),
		contentKey,
		undefined,
		{ backfillLegacyContent: false },
	);

	const organization = await store.getOrganization();
	const budget = await store.createInferenceBudget({
		label: `agent-process-e2e-${suffix}`,
		maxCalls: ontology ? 64 : 12,
		maxInputTokens: 2_000_000,
		maxOutputTokens: 20_000,
		maxUsd: "1.00000000",
		deadline: new Date(Date.now() + 120_000).toISOString(),
		priceBasis: null,
	});
	const config = YAML.parse(
		await readFile(path.join(root, "config/panini.example.yaml"), "utf8"),
	);

	config.intelligence.enabled = true;
	config.policy.mode = "autonomous";
	config.intelligence.evidenceV2 = {
		pipelineVersion: `process-${suffix}`,
		policyVersion: "agent-process-e2e-v1",
		maxEvidenceExpansions: 0,
		maxEscalations: 0,
		workEmbeddingsEnabled: true,
	};

	const configPath = path.join(
		reportDir,
		`agent-process-config-${suffix}.yaml`,
	);

	await mkdir(reportDir, { recursive: true, mode: 0o700 });
	await writeFile(configPath, YAML.stringify(config), { mode: 0o600 });

	let calls = 0,
		embeddingCalls = 0,
		completionChecks = 0;

	stub = http.createServer(async (request, response) => {
		const chunks = [];

		for await (const chunk of request) chunks.push(chunk);

		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

		if (request.url === "/embeddings") {
			embeddingCalls++;
			if (body.model !== "voyageai/voyage-4") {
				response.writeHead(500);
				response.end("Wrong embedding model");
				return;
			}
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					model: "voyage-4",
					data: body.input.map((_, index) => ({
						index,
						embedding: Array.from({ length: 1024 }, (_, i) =>
							i === 0 ? 1 : 0,
						),
					})),
					usage: { prompt_tokens: 100 },
				}),
			);
			return;
		}
		if (body.text?.format?.name === "work_scope_definition") {
			const fields = body.text.format.schema?.properties;
			const requirement = fields?.requirements?.items?.properties;

			if (
				!fields?.boundaryClear ||
				!fields?.amendmentClaimed ||
				fields.identity ||
				!requirement?.quote ||
				!requirement?.requestSourceEventId ||
				!requirement?.sourcePointer
			) {
				wireContractError =
					"Scope definition request sent the wrong JSON schema";
				response.writeHead(400);
				response.end(
					"Scope definition request sent the wrong JSON schema",
				);
				return;
			}

			const context = JSON.parse(body.input[0].content);

			if (
				context.sources.some(
					(source) => source.payload?.unrelatedRetrievalFixture,
				)
			) {
				wireContractError =
					"Scope definition included unrelated retrieved history";
				console.error(wireContractError);
				response.writeHead(400);
				response.end(wireContractError);
				return;
			}

			if (context.boundary.title === "Source-backed scope fixture") {
				const pointerDescription =
					requirement.sourcePointer.description;

				if (
					!pointerDescription?.includes("payload root") ||
					!pointerDescription.includes("/text") ||
					!body.instructions.includes("payload root")
				) {
					wireContractError =
						"Scope pointer contract does not specify the payload root";
					response.writeHead(400);
					response.end(wireContractError);
					return;
				}
			}

			const descriptions = context.boundary.description.includes(
				"receiving service",
			)
				? ["Build exporter", "Deliver to receiving service"]
				: context.boundary.description.includes("bounded trial")
					? ["Run the bounded trial", "Report the trial result"]
					: ["Perform the fixture trial", "Capture the output"];
			const definition = {
				boundaryClear: true,
				amendmentClaimed: false,
				requirements: descriptions.map((description) => ({
					description,
					quote: context.boundary.description,
					requestSourceEventId: null,
					sourcePointer: null,
				})),
				explanation:
					"All requested fixture steps preserved before assessment",
			};

			if (context.boundary.title === "Source-backed scope fixture") {
				definition.requirements = [
					{
						description: "Run the trial and report its output",
						quote: "Run the trial and report its output.",
						requestSourceEventId: context.sources[0].id,
						sourcePointer: "/text",
					},
				];
			}

			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					id: "scope-stub",
					model: "gpt-6-luna",
					status: "completed",
					output: [
						{
							type: "message",
							role: "assistant",
							content: [
								{
									type: "output_text",
									text: JSON.stringify(definition),
								},
							],
						},
					],
					usage: {
						input_tokens: 100,
						output_tokens: 100,
						input_tokens_details: { cached_tokens: 0 },
					},
				}),
			);
			return;
		}

		if (body.text?.format?.name === "work_transition_assessment") {
			const fields = body.text.format.schema?.properties;
			const requirement = fields?.requirements?.items?.properties;

			if (
				!fields?.identity ||
				fields.boundaryClear ||
				!requirement?.performed ||
				!requirement?.assertionIds
			) {
				wireContractError =
					"Transition assessment request sent the wrong JSON schema";
				response.writeHead(400);
				response.end(
					"Transition assessment request sent the wrong JSON schema",
				);
				return;
			}

			const context = JSON.parse(body.input[0].content);

			if (
				context.sources.some(
					(source) => source.payload?.unrelatedRetrievalFixture,
				)
			) {
				wireContractError =
					"Transition assessment included unrelated retrieved history";
				console.error(wireContractError);
				response.writeHead(400);
				response.end(wireContractError);
				return;
			}

			if (
				context.policyVersion !== "work-ontology-v2" ||
				!context.scope.boundary.description ||
				!context.assertions.length
			)
				throw new Error(
					"State checker did not receive scope and evidence",
				);

			if (
				context.task.title === "Selected reference fixture" &&
				!context.sources.some(
					(source) =>
						source.payload?.selectedIdentityReferenceFixture,
				)
			) {
				wireContractError =
					"State checker lost explicitly selected identity history";
				console.error(wireContractError);
				response.writeHead(400);
				response.end(wireContractError);
				return;
			}
			if (
				context.task.title === "Large record fixture" &&
				context.assertions.length !== 101
			) {
				wireContractError =
					"State checker omitted known evidence above 100 assertions";
				console.error(wireContractError);
				response.writeHead(400);
				response.end(wireContractError);
				return;
			}
			if (context.task.title === "Legacy boundary fixture") {
				const item =
					body.text.format.schema.properties.requirements.items
						.properties;

				if (
					context.scope.requestSourceAvailable !== false ||
					!body.instructions.includes(
						"The first accepted boundary is the declared coordination scope",
					) ||
					JSON.stringify(item.assertionIds.items.enum) !==
						JSON.stringify(context.assertions.map((a) => a.id))
				) {
					wireContractError =
						"Legacy boundary assessment lacks fallback scope or exact evidence-ID constraints";
					console.error(wireContractError);
					response.writeHead(400);
					response.end(wireContractError);
					return;
				}
			}

			const assessment = {
				identity: "same_work",
				scopeComplete: true,
				statusSupported: true,
				resultSupported: true,
				requirements: context.requirements.map((step) => ({
					...step,
					performed: "yes",
					assertionIds: context.assertions
						.slice(0, 50)
						.map((item) => item.id),
					explanation:
						"Fixture requested work was reported performed",
				})),
				scopeAmendmentClaimed: false,
				omittedRequirements: [],
				missingOrConflictingEvidence: [],
				independentlyVerified: false,
				explanation:
					"Reported fixture completion, not independent verification",
			};

			if (context.task.title === "Unsupported scope review fixture") {
				assessment.statusSupported = false;
				assessment.scopeComplete = false;
				assessment.missingOrConflictingEvidence = [
					"Correction requires scope review",
				];
			}
			if (
				context.scope.boundary.description.includes("receiving service")
			) {
				assessment.requirements = assessment.requirements.map((step) =>
					step.description.toLowerCase().includes("deliver")
						? { ...step, performed: "no", assertionIds: [] }
						: step,
				);
				assessment.missingOrConflictingEvidence = [
					"Receiving-service delivery remains missing",
				];
				if (context.changes.status === "review") {
					assessment.requirements = assessment.requirements.slice(
						0,
						1,
					);
					assessment.missingOrConflictingEvidence = [];
				}
			}

			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					id: "state-check-stub",
					model: "gpt-6-luna",
					status: "completed",
					output: [
						{
							type: "message",
							role: "assistant",
							content: [
								{
									type: "output_text",
									text: JSON.stringify(assessment),
								},
							],
						},
					],
					usage: {
						input_tokens: 100,
						output_tokens: 100,
						input_tokens_details: { cached_tokens: 0 },
					},
				}),
			);
			return;
		}
		calls += 1;

		const lastUser = body.input
			.filter((item) => item.role === "user")
			.at(-1);
		const completion = JSON.parse(lastUser?.content ?? "null");

		if (completion?.kind === "observation_completion_check")
			completionChecks++;
		if (
			body.model !== "gpt-6-luna" ||
			body.reasoning?.effort !== "medium"
		) {
			response.writeHead(500);
			response.end("Wrong production model or reasoning effort");
			return;
		}

		const supportedFormats = new Set([
			"date-time",
			"time",
			"date",
			"duration",
			"email",
			"hostname",
			"ipv4",
			"ipv6",
			"uuid",
		]);

		const validateFormats = (node) => {
			if (!node || typeof node !== "object") return;
			if (node.format && !supportedFormats.has(node.format))
				throw new Error(
					`Provider rejects JSON Schema format: ${node.format}`,
				);
			for (const value of Object.values(node)) validateFormats(value);
		};

		validateFormats(body.tools);

		const tools = body.tools.map((tool) => tool.name);

		if (
			!tools.includes("create_task") ||
			!tools.includes("update_task") ||
			!tools.includes("search_context")
		) {
			response.writeHead(500);
			response.end("Observation tools missing");
			return;
		}

		const initial = JSON.parse(body.input[0].content);

		if (
			initial.observation.occurredAt !== "2026-08-22T00:00:00.000Z" ||
			"fetchedAt" in initial.observation
		) {
			response.writeHead(500);
			response.end("Original observation timestamp missing");
			return;
		}

		if (
			ontology &&
			![
				"record_work_evidence",
				"define_work_scope",
				"transition_work_state",
				"read_work_model",
			].every((tool) => tools.includes(tool))
		)
			throw new Error("Ontology tools missing");

		const steps = [
			["search_tasks", { query: suffix, limit: 10 }],
			[
				"create_task",
				{
					title: `Agent process task ${suffix}`,
					status: ontology ? "planned" : "done",
					description: ontology
						? "Complete the local process fixture trial and capture its output."
						: undefined,
					rationale: "Source completed the work",
				},
			],
			[
				"create_context",
				{
					path: `/process/${suffix}`,
					title: "Process fact",
					factType: "policy",
					value: "Accepted",
					rationale: "Source states policy",
				},
			],
		];

		if (ontology) {
			const outputs = body.input
				.filter((item) => item.type === "function_call_output")
				.map((item) => JSON.parse(item.output));
			const created = outputs.find(
				(item) =>
					item.id && item.title?.startsWith("Agent process task"),
			);
			const evidence = outputs.find((item) => item.entity && item.claim);
			const scope = outputs.find((item) => item.boundary && item.taskId);
			const record = {
				kind: "artifact",
				claimKind: "completion_report",
				name: "Trial output",
				externalRef: "https://example.test/results/1",
				revision: "abc123",
				environment: null,
				result: "succeeded",
				statement:
					"Source reports a successful trial output at revision abc123.",
				sourcePointer: "/text",
				quote: "Trial output https://example.test/results/1 revision abc123 succeeded.",
				taskId: created?.id ?? null,
				contractVersion: null,
				criterionIds: [],
				relationship: "references",
				relatedEntityId: null,
			};

			steps.push([
				"record_work_evidence",
				{ ...record, quote: "This quote is not in the source" },
			]);
			steps.push(["record_work_evidence", record]);
			steps.push(["record_work_evidence", record]);
			steps.push([
				"read_work_evidence",
				{ taskId: null, entityId: null, limit: 20 },
			]);
			steps.push([
				"define_work_scope",
				{ taskId: created?.id, expectedTaskVersion: created?.version },
			]);
			steps.push([
				"transition_work_state",
				{
					taskId: created?.id,
					expectedTaskVersion: created?.version,
					scopeId: scope?.id,
					status: "done",
					result: "succeeded",
					assertionIds: evidence ? [evidence.id] : [],
					rationale:
						"All requested fixture steps were performed and output captured",
				},
			]);
			steps.push(["read_work_model", { taskId: created?.id }]);
			if (calls === 5) {
				const outputs = body.input.filter(
					(item) => item.type === "function_call_output",
				);
				const rejected = JSON.parse(outputs.at(-1)?.output ?? "{}");

				if (!rejected.error)
					throw new Error("Invalid source quote was accepted");
			}
		}
		steps.push(["search_context", { query: "company policy", limit: 10 }]);

		const step = steps[calls - 1];

		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				id: `agent-stub-${calls}`,
				model: "gpt-6-luna",
				status: "completed",
				output: step
					? [
							{
								type: "function_call",
								name: step[0],
								call_id:
									ontology && calls === 6
										? "process-5"
										: `process-${calls}`,
								arguments: JSON.stringify(step[1]),
							},
						]
					: [
							{
								type: "message",
								content: [
									{
										type: "output_text",
										text: "Accepted task and context",
									},
								],
							},
						],
				usage: {
					input_tokens: 100,
					output_tokens: 20,
					input_tokens_details: { cached_tokens: 0 },
				},
			}),
		);
	});
	await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));

	const modelPort = stub.address().port;
	const port = 43000 + (Number.parseInt(suffix.slice(0, 3), 16) % 1000);
	const token = randomBytes(32).toString("hex");
	const env = {
		...process.env,
		PANINI_WORK_ONTOLOGY: ontology ? undefined : "0",
		DATABASE_URL: targetUrl.toString(),
		CONTENT_ENCRYPTION_KEY: contentKey,
		APP_CONFIG_PATH: configPath,
		APP_ADMIN_TOKEN: token,
		AUTO_MIGRATE: "false",
		HOST: "127.0.0.1",
		PORT: String(port),
		INTELLIGENCE_MODEL: "gpt-6-luna",
		INTELLIGENCE_API_KEY: "local-stub-no-egress",
		INTELLIGENCE_BASE_URL: `http://127.0.0.1:${modelPort}`,
		OPENROUTER_API_KEY: "local-stub-no-egress",
		OPENROUTER_EMBEDDING_ENDPOINT: `http://127.0.0.1:${modelPort}/embeddings`,
		JEV_WORK_ALLOWED_VISIBILITIES: "company",
		PANINI_EVIDENCE_V2_BUDGET_ID: budget.id,
		PANINI_EVIDENCE_V2_VERSION: `process-${suffix}`,
		OUTBOX_POLL_INTERVAL_MS: "100",
		LOG_LEVEL: "error",
	};
	const server = start("dist/src/main.js", env);
	const origin = `http://127.0.0.1:${port}`;

	await until(async () => {
		if (server.child.exitCode !== null)
			throw new Error(`server exited: ${server.output}`);

		const response = await fetch(`${origin}/health/ready`);

		return response.ok;
	}, "server");

	const password = `Test password ${randomUUID()}!`;

	const bootstrap = await fetch(`${origin}/api/auth/bootstrap`, {
		method: "POST",
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify({
			token,
			companyName: "Example Company",
			displayName: "Process Reviewer",
			email: `process-${suffix}@example.test`,
			password,
		}),
	});

	if (!bootstrap.ok)
		throw new Error(`bootstrap returned ${bootstrap.status}`);

	const worker = start("dist/src/worker.js", env);

	await delay(250);
	if (worker.child.exitCode !== null)
		throw new Error(`worker exited: ${worker.output}`);

	const eventId = randomUUID();
	const now = "2026-08-22T00:00:00.000Z";
	const posted = await fetch(`${origin}/api/evidence/events`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
			origin,
		},
		body: JSON.stringify({
			provider: "slack",
			installationKey: "T1",
			providerEventId: eventId,
			eventKind: "message.observed",
			occurredAt: now,
			fetchedAt: "2026-10-02T00:00:00.000Z",
			sourceRef: `slack:T1:C1:${eventId}`,
			sourceUrl: null,
			visibility: "company",
			payloadVersion: "test-v1",
			payload: {
				teamId: "T1",
				user: "U_REPORTER",
				channel: "C1",
				messageTs: eventId,
				text: "This is a local process E2E completed task and context fixture. Trial output https://example.test/results/1 revision abc123 succeeded. Exporter built. Receiving service is not wired. Bounded trial failed and its report was delivered. No repair was requested. Request: Run the trial and report its output. Correction: the previous report did not establish delivery.",
			},
		}),
	});

	if (posted.status !== 201)
		throw new Error(`source ingestion returned ${posted.status}`);

	const recorded = await posted.json();
	const sourceId = recorded.event?.id;

	if (!sourceId)
		throw new Error("ingestion did not return a durable source ID");

	const pool = new pg.Pool({ connectionString: targetUrl.toString() });

	try {
		await until(
			async () => {
				if (worker.child.exitCode !== null)
					throw new Error(`worker exited: ${worker.output}`);

				const row = (
					await pool.query(
						`SELECT state FROM observation_dispositions
        WHERE source_event_id=$1 AND pipeline_version=$2 ORDER BY attempt DESC LIMIT 1`,
						[sourceId, `process-${suffix}`],
					)
				).rows[0];

				return row?.state === "processed";
			},
			"durable processed observation",
			30_000,
		);

		const beforeRestart = calls;
		const savedCalls = Number(
			(
				await pool.query(
					`SELECT count(*)::text AS count FROM model_calls
      WHERE organization_id=$1 AND purpose='observe'`,
					[organization.id],
				)
			).rows[0]?.count,
		);

		// v26 adds one final completion check in the same observation conversation.
		if (
			beforeRestart !== (ontology ? 13 : 6) ||
			savedCalls !== (ontology ? 13 : 6) ||
			embeddingCalls !== 2 ||
			completionChecks !== 1
		) {
			throw new Error(
				`unexpected counts: model=${beforeRestart}, receipts=${savedCalls}, embeddings=${embeddingCalls}, checks=${completionChecks}`,
			);
		}
		await stop(worker);

		const restarted = start("dist/src/worker.js", env);

		await delay(1_000);
		if (restarted.child.exitCode !== null)
			throw new Error(`restarted worker exited: ${restarted.output}`);

		const afterRestart = calls;
		const acceptedRevisions = Number(
			(
				await pool.query(
					`SELECT count(*)::text AS count
      FROM task_revisions WHERE organization_id=$1`,
					[organization.id],
				)
			).rows[0]?.count,
		);

		if (
			afterRestart !== beforeRestart ||
			acceptedRevisions !== (ontology ? 2 : 1)
		) {
			throw new Error(
				"restart repeated the observation workflow or changed accepted state",
			);
		}

		const tasks = await store.listTasks();
		const task = tasks.find(
			(item) => item.title === `Agent process task ${suffix}`,
		);

		if (!task || task.status !== "done")
			throw new Error("Agent task write was not accepted");

		const revisions = await store.listTaskRevisions(task.id);

		if (
			Object.values(
				revisions[0].decisionMetadata.effectiveAtByField,
			).some((time) => time !== now)
		) {
			throw new Error("Agent accepted revision used detection time");
		}

		const taskResponse = await fetch(`${origin}/api/tasks/${task.id}`, {
			headers: { authorization: `Bearer ${token}` },
		});

		if (!taskResponse.ok)
			throw new Error("Accepted task was not readable through the API");

		if (ontology) {
			const read = await fetch(`${origin}/api/work-evidence`, {
				headers: { authorization: `Bearer ${token}` },
			});

			if (!read.ok) throw new Error("Work evidence API unavailable");

			const facts = await read.json();

			if (
				facts.length !== 1 ||
				facts[0].basis !== "source_reported" ||
				facts[0].entity.revision !== "abc123" ||
				facts[0].claim.body.assertedAt !== now
			)
				throw new Error(
					"Ontology assertion identity, basis or chronology mismatch",
				);

			const counts = (
				await pool.query(
					"SELECT (SELECT count(*) FROM work_entities)::int AS entities, (SELECT count(*) FROM work_assertions)::int AS assertions",
				)
			).rows[0];

			if (counts.entities !== 1 || counts.assertions !== 1)
				throw new Error(
					"Partial rejected writes or duplicate assertions",
				);

			await stop(restarted);

			const post = async (route, body) => {
				const response = await fetch(`${origin}${route}`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
						origin,
						"idempotency-key": randomUUID(),
					},
					body: JSON.stringify(body),
				});

				if (!response.ok)
					throw new Error(
						`Ontology review API failed: ${route} ${response.status} ${await response.text()}`,
					);
				return response.json();
			};

			const drafted = await post(
				`/api/tasks/${task.id}/outcome-contract-proposals`,
				{
					baseRevision: task.version,
					rationale: "Require independent review of handoff",
					evidenceIds: [sourceId],
					contract: {
						statement: "Complete handoff",
						scope: "Output and receiving service",
						exclusions: [],
						criteria: [
							{
								id: "receiving-service",
								description:
									"Review receiving-service delivery",
								required: true,
								evidenceRule: {
									kind: "manual_review",
									authorityPolicyId: null,
									artifactRefs: [],
									requiredCheckNames: [],
									requiredEnvironment: null,
									maxMutableAgeSeconds: 3600,
								},
							},
						],
					},
				},
			);
			let automaticContractRejected = false;

			try {
				await store.approveAndApplyProposal({
					proposalId: drafted.proposal.id,
					state: "auto_applied",
					decidedBy: "intelligence:fixture",
					decisionNote: null,
					auditAction: "fixture",
				});
			} catch {
				automaticContractRejected = true;
			}
			if (!automaticContractRejected)
				throw new Error("Model approved its own outcome contract");
			await post(`/api/proposals/${drafted.proposal.id}/approve`, {});

			const reviewedTask = (await store.listTasks()).find(
				(item) => item.id === task.id,
			);

			if (
				reviewedTask.status !== "in_progress" ||
				reviewedTask.result !== "unknown"
			)
				throw new Error("New approved scope reused old completion");

			const beforeGuard = (await store.listTasks()).find(
				(item) => item.id === task.id,
			);
			const bypass = await store.createProposal({
				clientEventId: randomUUID(),
				kind: "task_change",
				taskId: task.id,
				baseVersion: beforeGuard.version,
				changes: { status: "done" },
				rationale: "Source report must not bypass review",
				requestedBy: "observation-agent",
				evidenceIds: [sourceId],
			});
			let bypassRejected = false;

			try {
				await store.approveAndApplyProposal({
					proposalId: bypass.id,
					state: "auto_applied",
					decidedBy: "observation-agent",
					decisionNote: null,
					auditAction: "fixture",
					observationEventId: sourceId,
				});
			} catch {
				bypassRejected = true;
			}
			if (
				!bypassRejected ||
				(await store.listTasks()).find((item) => item.id === task.id)
					.version !== beforeGuard.version
			)
				throw new Error(
					"Source report bypassed approved completion requirements",
				);
			await store.decideProposal(bypass.id, {
				state: "rejected",
				decidedBy: "fixture",
				decisionNote: "Expected blocked completion",
				auditAction: "fixture",
			});

			const lease = (
				await pool.query(
					"SELECT d.*,r.id AS active_run FROM observation_dispositions d JOIN interpretation_runs r ON r.id=d.run_id WHERE d.source_event_id=$1",
					[sourceId],
				)
			).rows[0];
			const write = {
				key: `probe-${suffix}`,
				runId: lease.active_run,
				eventId: sourceId,
				leaseOwner: "expired-fixture-owner",
				allowedVisibilities: ["company"],
				evidence: {
					kind: "artifact",
					name: "Trial output",
					externalRef: "https://example.test/results/1",
					revision: "abc123",
					environment: null,
					result: "succeeded",
					statement: "Trial produced an output.",
					sourcePointer: "/text",
					quote: "Trial output https://example.test/results/1 revision abc123 succeeded.",
					taskId: task.id,
					contractVersion: null,
					criterionIds: [],
					relationship: "supports",
					relatedEntityId: null,
				},
			};
			let expiredRejected = false;

			try {
				await store.appendWorkEvidence(write);
			} catch {
				expiredRejected = true;
			}
			if (!expiredRejected)
				throw new Error("Expired worker stored work evidence");
			await pool.query(
				"UPDATE interpretation_runs SET state='running' WHERE id=$1",
				[lease.active_run],
			);
			await pool.query(
				"UPDATE observation_dispositions SET state='processing',lease_owner=$2,lease_until=now()+interval '1 minute' WHERE id=$1",
				[lease.id, write.leaseOwner],
			);
			for (const evidence of [
				{ ...write.evidence, revision: "wrong-revision" },
				{
					...write.evidence,
					claimKind: "correction",
					claimedCorrectionIds: [randomUUID()],
				},
				{
					...write.evidence,
					contractVersion: 99,
					criterionIds: ["unknown"],
				},
			]) {
				let rejected = false;

				try {
					await store.appendWorkEvidence({ ...write, evidence });
				} catch {
					rejected = true;
				}
				if (!rejected)
					throw new Error(
						"Invalid revision or contract support was accepted",
					);
			}

			const afterProbes = (
				await pool.query(
					"SELECT count(*)::int AS n FROM work_assertions",
				)
			).rows[0].n;

			if (afterProbes !== 1)
				throw new Error("Rejected work probes left partial assertions");
			// Failure cases written before the identity change: a shared report URL
			// merges distinct attempts, and a repeated receipt creates new evidence.
			// A speaker mapping proves identity only, never scope-change authority.
			if (facts[0].claim.body.speakerMemberId !== null)
				throw new Error("An unresolved reporter was assigned a member");

			const reporter = await store.reconcileMemberIdentity({
				provider: "slack",
				installationKey: "T1",
				externalId: "U_REPORTER",
				displayName: "Fixture reporter",
			});
			const attempts = [];

			for (const name of ["First trial", "Second trial"]) {
				const attemptWrite = {
					...write,
					key: `${write.key}-${name}`,
					evidence: { ...write.evidence, kind: "execution", name },
				};
				const first = await store.appendWorkEvidence(attemptWrite);
				const repeated = await store.appendWorkEvidence(attemptWrite);

				if (
					first.id !== repeated.id ||
					first.entity.id !== repeated.entity.id
				)
					throw new Error("Receipt retry changed assertion identity");
				if (
					!reporter.member ||
					first.claim.body.speakerMemberId !== reporter.member.id
				)
					throw new Error("Known source reporter was lost");
				if (first.authorityBasis !== "identity_only")
					throw new Error(
						"Reporter identity was treated as authority",
					);
				attempts.push(first);
			}
			if (attempts[0].entity.id === attempts[1].entity.id)
				throw new Error("A shared dashboard merged distinct attempts");

			const identityCounts = (
				await pool.query(
					"SELECT (SELECT count(*) FROM work_entities)::int AS entities, (SELECT count(*) FROM work_assertions)::int AS assertions",
				)
			).rows[0];

			if (
				identityCounts.entities !== 3 ||
				identityCounts.assertions !== 3
			)
				throw new Error(
					"Work identity or receipt deduplication failed",
				);

			stateProbeChecks = await runWorkStateProbes({
				store,
				pool,
				sourceId,
				runId: lease.active_run,
				owner: write.leaseOwner,
				budgetId: budget.id,
				modelOrigin: `http://127.0.0.1:${modelPort}`,
				post,
				initialTaskId: task.id,
				initialAssertionId: facts[0].id,
				origin,
				token,
			});

			if (process.env.PANINI_TEST_BROWSER === "1") {
				const broadTask = (await store.listTasks()).find(
					(item) => item.title === "Export and delivery",
				);

				if (!broadTask) throw new Error("Browser fixture task missing");
				if (process.env.PANINI_RECORD_DEMO === "1") {
					const member = (await store.listMembers()).find(
						(item) =>
							item.email === `process-${suffix}@example.test`,
					);

					if (!member) throw new Error("Demo owner missing");

					const enrolled = await post("/api/agents", {
						memberId: member.id,
						name: "Release demo agent",
						capabilities: ["work:read", "context:read"],
						dataScope: {
							projects: ["*"],
							contextPaths: ["/"],
							sourceVisibilities: ["company"],
						},
					});
					const contextRead = await fetch(`${origin}/mcp`, {
						method: "POST",
						headers: {
							authorization: `Bearer ${enrolled.secret}`,
							accept: "application/json, text/event-stream",
							"content-type": "application/json",
							"mcp-protocol-version": "2025-03-26",
						},
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: 1,
							method: "tools/call",
							params: {
								name: "context_get",
								arguments: {
									objective:
										"What remains for export and delivery?",
									taskIds: [broadTask.id],
								},
							},
						}),
					});

					if (!contextRead.ok)
						throw new Error("Demo MCP request failed");

					const payload = await contextRead.text();
					const mcpResult = JSON.parse(
						!payload.trimStart().startsWith("{")
							? payload
									.split("\n")
									.find((line) => line.startsWith("data:"))
									.slice(5)
							: payload,
					);

					if (
						mcpResult.result?.isError ||
						!mcpResult.result?.structuredContent?.pack?.tasks?.some(
							(item) => item.id === broadTask.id,
						)
					)
						throw new Error(
							"Demo MCP did not return the scoped task",
						);
					await mkdir(path.resolve(".panini/release/demo"), {
						recursive: true,
					});
					await writeFile(
						path.resolve(".panini/release/demo/mcp-proof.json"),
						JSON.stringify(
							{
								tool: "context_get",
								taskId: broadTask.id,
								acceptedPack:
									mcpResult.result.structuredContent.pack,
							},
							null,
							4,
						) + "\n",
					);
				}
				browserChecks = await verifyOntologyBrowser({
					origin,
					email: `process-${suffix}@example.test`,
					password,
					taskId: broadTask.id,
					output: reportDir,
					token,
				});
			}

			await pool.query(
				"UPDATE interpretation_runs SET state='completed' WHERE id=$1",
				[lease.active_run],
			);
			await pool.query(
				"UPDATE observation_dispositions SET state='processed',lease_owner=NULL,lease_until=NULL WHERE id=$1",
				[lease.id],
			);

			await pool.query(
				"UPDATE source_events SET visibility='restricted' WHERE id=$1",
				[sourceId],
			);
			if (
				(
					await store.readWorkEvidence({
						allowedVisibilities: ["company"],
						limit: 20,
					})
				).length !== 0
			)
				throw new Error("Restricted source leaked through ontology");
			if (
				(await store.readWorkScope(task.id, ["company"])) ||
				(await store.readWorkStateAssessments(task.id, ["company"]))
					.length
			)
				throw new Error("Restricted work scope or assessment leaked");
			await pool.query(
				"UPDATE source_events SET visibility='company',content_state='revoked' WHERE id=$1",
				[sourceId],
			);
			if (
				(
					await store.readWorkEvidence({
						allowedVisibilities: ["company"],
						limit: 20,
					})
				).length !== 0
			)
				throw new Error("Revoked source leaked through ontology");
			await pool.query(
				"UPDATE source_events SET content_state='active' WHERE id=$1",
				[sourceId],
			);
		}

		const contexts = await store.listContextEntries();

		if (contexts.length !== 1 || contexts[0].effectiveFrom !== now)
			throw new Error("Agent context time mismatch");

		const pending = (await store.listProposals()).filter((proposal) =>
			["pending", "escalated"].includes(proposal.state),
		);

		if (pending.length)
			throw new Error("Agent writes require human approval");

		const splitCalls = Number(
			(
				await pool.query(
					`SELECT count(*)::text AS count FROM model_calls WHERE organization_id=$1 AND purpose NOT IN ('observe','embed'${ontology ? " ,'verify'" : ""})`,
					[organization.id],
				)
			).rows[0].count,
		);

		if (splitCalls)
			throw new Error("Separate extraction or judgment stage ran");
		if (ontology) {
			await store.revokeSourceEvent(sourceId);

			const remaining = (
				await pool.query(
					"SELECT count(*)::int AS n FROM work_assertions WHERE body_envelope IS NOT NULL",
				)
			).rows[0].n;

			const stateRemaining = (
				await pool.query(
					"SELECT (SELECT count(*) FROM work_scopes WHERE body_envelope IS NOT NULL)::int AS scopes, (SELECT count(*) FROM work_state_assessments WHERE body_envelope IS NOT NULL)::int AS assessments",
				)
			).rows[0];

			if (stateRemaining.scopes !== 0 || stateRemaining.assessments !== 0)
				throw new Error(
					"Revocation retained private scope or assessment content",
				);
			if (remaining !== 0)
				throw new Error(
					"Revocation kept private work assertion content",
				);
		}
		report = {
			schemaVersion: 1,
			mode: ontology
				? "ontology_server_worker_process_e2e"
				: "separate_server_worker_process_e2e",
			stateProbeChecks,
			ontologyChecks: ontology
				? [
						"exact_quote",
						"atomic_rejection",
						"reported_not_verified",
						"native_time",
						"restart",
						"restricted_source",
						"revoked_source",
						"api_projection",
						"expired_lease",
						"revision_quote",
						"unknown_contract",
						"same_receipt_retry",
						"shared_dashboard_distinct_attempts",
						"source_reporter_identity_without_authority",
						"reviewed_contract",
						"model_self_approval_rejected",
						"completion_bypass_rejected",
						"scope_reopens_completion",
						"revocation_erases_content",
					]
				: [],
			startedAt,
			finishedAt: new Date().toISOString(),
			database,
			organizationId: organization.id,
			sourceEventId: sourceId,
			serverReady: true,
			workerRestarted: true,
			acceptedTaskReadableThroughApi: true,
			originalOccurredAt: now,
			pendingProposals: pending.length,
			splitStageCalls: splitCalls,
			disposition: "processed",
			modelCalls: savedCalls,
			modelCallsAfterRestart: afterRestart,
			acceptedObservationTaskRevisions: acceptedRevisions,
			acceptedTaskRevisions: Number(
				(
					await pool.query(
						"SELECT count(*)::int AS n FROM task_revisions",
					)
				).rows[0].n,
			),
			externalModelCalls: 0,
			model: "gpt-6-luna",
			reasoning: "medium",
			completionChecks,
			browserChecks,
			modelStubCalls: calls,
			embeddingStubCalls: embeddingCalls,
			embeddingModel: "voyageai/voyage-4",
			ok: true,
		};
		await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
			mode: 0o600,
		});
	} finally {
		await pool.end();
	}
	process.stdout.write(
		`${JSON.stringify({
			report: reportPath,
			database,
			disposition: report.disposition,
			modelStubCalls: calls,
			ok: true,
		})}\n`,
	);
} finally {
	await Promise.all(processes.map(stop));
	await new Promise((resolve) => (stub ? stub.close(resolve) : resolve()));
	await store?.close();
	await admin.end();
}
