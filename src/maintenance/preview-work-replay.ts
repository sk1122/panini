import { ProposalPolicy } from "../domain/policy.js";
import { TeamLedger } from "../domain/team-ledger.js";
import { JevWorkJudge } from "../reconciliation/jev-work-judge.js";
import { OpenAIWorkProseDrafter } from "../reconciliation/openai-work-drafter.js";
import { WorkSuggestionEngine } from "../reconciliation/work-suggestions.js";
import { MemoryLedgerStore } from "../store/memory.js";
import { PostgresLedgerStore } from "../store/postgres.js";
import { ExternalEvaluationLimiter, meteredExternalFetch } from "../intelligence/external-call-meter.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const reportPath = process.env.PANINI_LEGACY_PREVIEW_REPORT;
const reportRoot = path.resolve("artifacts/evidence-state");
if (!reportPath || !path.resolve(reportPath).startsWith(`${reportRoot}${path.sep}`)
  || !reportPath.endsWith(".json")) {
  throw new Error("Legacy model preview requires a private JSON report under artifacts/evidence-state.");
}
const limiter = new ExternalEvaluationLimiter({
  maxCalls: Number(process.env.PANINI_LEGACY_PREVIEW_MAX_CALLS),
  maxInputTokens: Number(process.env.PANINI_LEGACY_PREVIEW_MAX_INPUT_TOKENS),
  maxOutputTokens: Number(process.env.PANINI_LEGACY_PREVIEW_MAX_OUTPUT_TOKENS),
  maxWallSeconds: Number(process.env.PANINI_LEGACY_PREVIEW_MAX_WALL_SECONDS),
});

// A disposable rehearsal. The primary database is read only; all runs and
// proposals are written to memory and discarded on exit.
const allowed = (process.env.JEV_WORK_ALLOWED_VISIBILITIES ?? "").split(",").filter((visibility) =>
  visibility && (process.env.WORK_DRAFT_ALLOWED_VISIBILITIES ?? "").split(",").includes(visibility));
if (!process.env.DATABASE_URL || !process.env.CONTENT_ENCRYPTION_KEY || !process.env.OPENROUTER_API_KEY
  || !process.env.INTELLIGENCE_API_KEY || !process.env.INTELLIGENCE_MODEL || !allowed.length) {
  throw new Error("The live database and approved model scope must be configured.");
}
const live = new PostgresLedgerStore(process.env.DATABASE_URL, process.env.CONTENT_ENCRYPTION_KEY);
const memory = new MemoryLedgerStore();
let count = 0;
const idMap = new Map<string, string>();
for (const source of (await live.listSourceEvents(2_000)).reverse()) {
  const { id: _id, receivedAt: _receivedAt, ...input } = source;
  const added = await memory.appendSourceEvent(input);
  idMap.set(source.id, added.event.id);
  count++;
}
for (const prior of (await live.listInterpretationRuns(2_000)).filter((run) =>
  run.model === "jev-work-suggestion-v4" && run.state !== "running")) {
  const eventIds = prior.eventIds.map((id) => idMap.get(id)).filter((id): id is string => Boolean(id));
  if (!eventIds.length) continue;
  const replay = await memory.createInterpretationRun({ model: prior.model,
    inputHash: `prior:${prior.id}`, eventIds });
  await memory.completeInterpretationRun(replay.id, { outcome: "skipped" });
}
const ledger = new TeamLedger(memory, new ProposalPolicy({ mode: "manual_review",
  autoApproveNewTasks: false, autoApproveContext: false, requireReviewForTaskChanges: true }));
for (const project of await live.listProjects()) {
  if (project.outcome) await ledger.createProject({ name: project.name, outcome: project.outcome,
    aliases: project.aliases }, "user:preview");
}
const realJudge = new JevWorkJudge({ apiKey: process.env.OPENROUTER_API_KEY,
  allowedVisibilities: allowed,
  fetcher: meteredExternalFetch(memory, { provider: "openrouter", purpose: "work_judge", limiter }) });
const judge = {
  judge: async (bundle: Parameters<JevWorkJudge["judge"]>[0]) => {
    const answer = await realJudge.judge(bundle);
    console.log(JSON.stringify({ source: bundle.spans[0]?.provider,
      eventId: bundle.spans[0]?.eventId, candidateCount: bundle.candidates.length,
      kind: answer.kind.choice, kindConfidence: answer.kind.confidence,
      target: answer.target.choice, targetConfidence: answer.target.confidence,
      concrete: answer.concreteActionProbability, stage: answer.stage.choice }));
    return answer;
  },
  supportsDraft: async (...args: Parameters<JevWorkJudge["supportsDraft"]>) => {
    const support = await realJudge.supportsDraft(...args);
    console.log(JSON.stringify({ draftEvidenceCount: args[1].evidenceEventIds.length, support }));
    return support;
  },
  judgeProject: async (...args: Parameters<JevWorkJudge["judgeProject"]>) => {
    const result = await realJudge.judgeProject(...args);
    console.log(JSON.stringify({ projectDecision: result }));
    return result;
  },
};
const realDrafter = new OpenAIWorkProseDrafter({ apiKey: process.env.INTELLIGENCE_API_KEY,
  model: process.env.INTELLIGENCE_MODEL,
  ...(process.env.INTELLIGENCE_BASE_URL ? { baseUrl: process.env.INTELLIGENCE_BASE_URL } : {}),
  allowedVisibilities: allowed,
  fetcher: meteredExternalFetch(memory, { provider: "openai", purpose: "work_prose", limiter }) });
const drafter = {
  draft: async (...args: Parameters<OpenAIWorkProseDrafter["draft"]>) => {
    const result = await realDrafter.draft(...args);
    console.log(JSON.stringify({ kind: args[1].kind, draftLength: result.text.length }));
    return result;
  },
};
const engine = new WorkSuggestionEngine(memory, ledger, judge, drafter, allowed, true);
const requestedId = process.argv[2] && idMap.has(process.argv[2]) ? idMap.get(process.argv[2]) : null;
const reports = requestedId ? await engine.run([requestedId], 1)
  : await engine.run(undefined, Math.min(Number(process.argv[2] ?? 12), 40));
console.log(JSON.stringify({ copied: count, reports: reports.map(({ outcome }) => outcome),
  taskCount: (await memory.listTasks()).length,
  pendingProposalCount: (await memory.listProposals("pending")).length }));
await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
await writeFile(path.resolve(reportPath), `${JSON.stringify({ schemaVersion: 1,
  generatedAt: new Date().toISOString(), mode: "legacy_preview", copied: count,
  outcomeCounts: Object.fromEntries([...new Set(reports.map((item) => item.outcome))]
    .map((outcome) => [outcome, reports.filter((item) => item.outcome === outcome).length])),
  externalCalls: (await memory.listAuditEvents(10_000)).filter((event) =>
    event.action.startsWith("external_call.")),
  limits: limiter.snapshot(), costComplete: false }, null, 2)}\n`, { mode: 0o600 });
