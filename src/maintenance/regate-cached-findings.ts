import pg from "pg";
import { contentHash } from "../domain/content-hash.js";
import type { JsonValue } from "../domain/types.js";
import { interpretationOutputSchema } from "../intelligence/schema.js";
import { createPaniniCore } from "../runtime/core.js";

function argument(name: string): string | null {
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
}

const expectedDb = argument("expected-db");
const databaseUrl = process.env.DATABASE_URL;
if (!expectedDb?.startsWith("panini_shadow_regate_") || !databaseUrl
  || new URL(databaseUrl).pathname !== `/${expectedDb}`) {
  throw new Error("A matching panini_shadow_regate_ database is required.");
}
if (process.env.INTELLIGENCE_API_KEY || process.env.INTELLIGENCE_MODEL) {
  throw new Error("Cached re-gating must run without an OpenAI interpreter key or model.");
}
const onlyEvidence = argument("only-evidence");
if (onlyEvidence && !/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(onlyEvidence)) {
  throw new Error("--only-evidence must be a source-event UUID.");
}
const maxFindings = Number(argument("max-findings") ?? "160");
if (!Number.isSafeInteger(maxFindings) || maxFindings <= 0 || maxFindings > 200) {
  throw new Error("--max-findings must be between 1 and 200.");
}
const coverageAsOf = argument("coverage-as-of");
if (!coverageAsOf || !Number.isFinite(new Date(coverageAsOf).getTime())) {
  throw new Error("--coverage-as-of is required.");
}

const verifier = new pg.Client({ connectionString: databaseUrl });
try {
  await verifier.connect();
  const result = await verifier.query<{ db: string }>("SELECT current_database() AS db");
  if (result.rows[0]?.db !== expectedDb) throw new Error("Connected to the wrong database.");
} finally {
  await verifier.end();
}

const core = await createPaniniCore({ runMigrations: false, coverageAsOf });
let considered = 0;
let applied = 0;
let rejected = 0;
let abstained = 0;
try {
  const runs = await core.intelligence.listRuns(5_000);
  const previous = new Set(runs.filter((run) => run.state === "completed" && run.model === "cached-gate-v2")
    .flatMap((run) => {
      const output = run.output;
      if (!output || typeof output !== "object" || Array.isArray(output)) return [];
      const item = output as Record<string, JsonValue>;
      return typeof item.originalRunId === "string" && typeof item.findingIndex === "number"
        ? [`${item.originalRunId}:${item.findingIndex}`] : [];
    }));
  const originals = runs.filter((run) => run.state === "completed"
    && run.model.startsWith("openai-responses:")).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const run of originals) {
    if (considered >= maxFindings) break;
    const output = run.output;
    if (!output || typeof output !== "object" || Array.isArray(output)) continue;
    const item = output as Record<string, JsonValue>;
    const interpretation = interpretationOutputSchema.parse(item.interpretation);
    if (!Array.isArray(item.outcomes)) continue;
    for (const [index, finding] of interpretation.findings.entries()) {
      if (considered >= maxFindings) break;
      if (finding.kind !== "task_change" || !finding.evidenceEventIds.length
        || (onlyEvidence && !finding.evidenceEventIds.includes(onlyEvidence))) continue;
      const outcome = item.outcomes[index];
      if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)
        || outcome.state !== "rejected" || previous.has(`${run.id}:${index}`)) continue;
      const stored = await core.store.createInterpretationRun({
        inputHash: contentHash({ kind: "cached-gate-v2", originalRunId: run.id, findingIndex: index }),
        model: "cached-gate-v2", eventIds: finding.evidenceEventIds,
      });
      try {
        const result = await core.intelligence.rejudgeStoredFinding(run, index);
        await core.store.completeInterpretationRun(stored.id, JSON.parse(JSON.stringify({
          originalRunId: run.id, findingIndex: index, originalKind: finding.kind, outcome: result,
        })) as JsonValue);
        considered += 1;
        if (result.state === "applied") applied += 1;
        else if (result.state === "rejected") rejected += 1;
        else abstained += 1;
        console.log(JSON.stringify({ type: "cached_gate_result", run: considered,
          originalRunId: run.id, findingIndex: index, taskId: finding.taskId,
          state: result.state, reason: result.reason }));
      } catch (error) {
        await core.store.failInterpretationRun(stored.id, error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
  }
  console.log(JSON.stringify({ type: "cached_gate_complete", considered, applied, rejected,
    abstained, onlyEvidence, maxFindings, lunaCalls: 0 }));
} finally {
  await core.store.close();
}
