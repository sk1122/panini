import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { contentHash } from "../domain/content-hash.js";
import type { SourceEvent, Task } from "../domain/types.js";
import { PostgresLedgerStore } from "../store/postgres.js";

const databaseUrl = process.env.DATABASE_URL;
const contentKey = process.env.CONTENT_ENCRYPTION_KEY;
const databaseName = process.env.PANINI_REPLAY_DATABASE;
const candidatePath = process.env.PANINI_GOLD_REVIEW_CANDIDATES;
const outputPath = process.env.PANINI_GOLD_REVIEW_PACKET;
if (!databaseUrl || !contentKey || !databaseName
  || !/^panini_replay_[a-z0-9_]+$/.test(databaseName) || !candidatePath || !outputPath) {
  throw new Error("An isolated replay database, source packet, and output are required.");
}
const root = path.resolve("artifacts/evidence-state");
const checkedPath = (value: string) => {
  const file = path.resolve(value);
  if (!file.startsWith(`${root}${path.sep}`) || !file.endsWith(".json")) {
    throw new Error("Gold review files must be JSON under artifacts/evidence-state.");
  }
  return file;
};
const sourceFile = checkedPath(candidatePath);
const outputFile = checkedPath(outputPath);
if (sourceFile === outputFile) throw new Error("The review packet cannot overwrite its source.");
const sourcePacket = JSON.parse(await readFile(sourceFile, "utf8")) as {
  database: string; organizationId: string; cases: { taskId: string }[];
};
if (sourcePacket.database !== databaseName || !sourcePacket.organizationId
  || !Array.isArray(sourcePacket.cases)) {
  throw new Error("The audited source packet does not match the isolated database.");
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const store = new PostgresLedgerStore(databaseUrl, contentKey);
const rank = <T extends { id: string }>(items: T[]) => [...items].sort((left, right) =>
  contentHash(left.id).localeCompare(contentHash(right.id)));
const receipt = (event: SourceEvent) => {
  const serialized = JSON.stringify(event.payload);
  return { id: event.id, provider: event.provider, installationKey: event.installationKey,
    eventKind: event.eventKind, sourceRef: event.sourceRef, sourceUrl: event.sourceUrl,
    visibility: event.visibility, occurredAt: event.occurredAt, receivedAt: event.receivedAt,
    originObservationKey: event.observationIdentity?.originObservationKey ?? null,
    sourceVersionKey: event.observationIdentity?.sourceVersionKey ?? null,
    payloadHash: contentHash(event.payload), payload: serialized.length <= 16_000
      ? event.payload : null, payloadPreview: serialized.length > 16_000
      ? serialized.slice(0, 4_000) : null,
    omittedPayloadCharacters: Math.max(0, serialized.length - 4_000) };
};
try {
  const actual = (await pool.query<{ current_database: string }>("SELECT current_database()"))
    .rows[0]?.current_database;
  const organization = await store.getOrganization();
  if (actual !== databaseName || organization.id !== sourcePacket.organizationId) {
    throw new Error("Gold review database or organization assertion failed.");
  }
  const tasks = await store.listTasks();
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const auditedIds = [...new Set(sourcePacket.cases.map((item) => item.taskId))];
  if (auditedIds.some((id) => !taskById.has(id))) {
    throw new Error("An audited task is missing from the isolated replay.");
  }
  const ordinary = tasks.filter((task) => !auditedIds.includes(task.id));
  const selected = new Map<string, { task: Task; categories: string[] }>();
  const include = (task: Task, category: string) => {
    const previous = selected.get(task.id);
    if (previous) previous.categories.push(category);
    else selected.set(task.id, { task, categories: [category] });
  };
  for (const id of auditedIds) include(taskById.get(id)!, "audited_failure_candidate");
  for (const task of rank(ordinary.filter((item) => item.status === "done")).slice(0, 6)) {
    include(task, "ordinary_accepted_done_candidate");
  }
  for (const task of rank(ordinary.filter((item) => item.status !== "done")).slice(0, 6)) {
    include(task, "ordinary_open_candidate");
  }
  const corrections = tasks.filter((task) => task.version > 1 && !auditedIds.includes(task.id));
  for (const task of rank(corrections).slice(0, 4)) include(task, "accepted_revision_candidate");

  const taskCases = [] as unknown[];
  for (const { task, categories } of selected.values()) {
    const [revisions, proposals, assessments] = await Promise.all([
      store.listTaskRevisions(task.id), store.listTaskProposals(task.id),
      store.listAssessmentsForTask(task.id, 30),
    ]);
    const claimIds = [...new Set(assessments.flatMap((item) => item.claimIds))];
    const claims = claimIds.length ? await store.getClaims(claimIds) : [];
    const sourceIds = [...new Set([
      ...proposals.flatMap((item) => item.evidenceIds),
      ...claims.flatMap((item) => item.body.spans.map((span) => span.eventId)),
      ...revisions.flatMap((item) => Object.values(
        item.decisionMetadata?.sourceEventIdsByField ?? {}).flat()),
    ])].sort();
    const sourceEvents = await store.getSourceEvents(sourceIds);
    const currentIds = new Set(await store.currentSourceEventIds(sourceIds));
    taskCases.push({ id: `task:${task.id}`, categories, taskId: task.id,
      acceptedCurrent: { title: task.title, description: task.description,
        status: task.status, result: task.result ?? null, version: task.version,
        outcomeContract: task.outcomeContract ?? null },
      acceptedHistory: revisions.map((item) => ({ version: item.version,
        appliedAt: item.appliedAt, appliedBy: item.appliedBy,
        previousStatus: item.previous?.status ?? null, currentStatus: item.current.status,
        previousResult: item.previous?.result ?? null, currentResult: item.current.result ?? null,
        sourceEventIdsByField: item.decisionMetadata?.sourceEventIdsByField ?? {} })),
      claimCandidates: claims.map((item) => ({ id: item.id, kind: item.body.kind,
        statement: item.body.statement, assertedAt: item.body.assertedAt,
        assertedField: item.body.assertedField, assertedValue: item.body.assertedValue,
        sourceEventIds: item.body.spans.map((span) => span.eventId) })),
      systemAssessmentsAreNotLabels: assessments.map((item) => ({ id: item.id,
        relationship: item.relationship, disposition: item.disposition,
        reasonCodes: item.reasonCodes, claimIds: item.claimIds })),
      sourceReceipts: sourceEvents.map((item) => ({ ...receipt(item),
        currentlyUsable: currentIds.has(item.id) })),
      unavailableSourceEventIds: sourceIds.filter((id) =>
        !sourceEvents.some((item) => item.id === id)),
      requestedAdjudication: ["target_identity_and_scope", "expected_claims",
        "expected_transition_or_abstention", "supporting_source_ids",
        "temporal_cutoff", "ambiguity_and_rationale"] });
  }

  const noClaimRows = (await pool.query<{ source_event_id: string }>(
    `SELECT source_event_id FROM (
       SELECT DISTINCT ON (source_event_id) source_event_id,state
         FROM observation_dispositions WHERE organization_id=$1
        ORDER BY source_event_id,attempt DESC,created_at DESC
     ) latest WHERE state='no_claim'`, [organization.id],
  )).rows;
  const noClaimIds = rank(noClaimRows.map((row) => ({ id: row.source_event_id })))
    .map((row) => row.id);
  const currentNoClaim = new Set(await store.currentSourceEventIds(noClaimIds));
  const noActionEvents = (await store.getSourceEvents(noClaimIds.filter((id) =>
    currentNoClaim.has(id)))).sort((left, right) =>
    contentHash(left.id).localeCompare(contentHash(right.id))).slice(0, 8);
  const noActionCases = noActionEvents.map((event) => ({ id: `no_action:${event.id}`,
    category: "ordinary_no_claim_candidate", sourceReceipts: [receipt(event)],
    systemNoClaimIsNotALabel: true,
    requestedAdjudication: ["expected_claim_or_no_action", "target_identity_and_scope",
      "temporal_cutoff", "ambiguity_and_rationale"] }));

  const duplicateRows = (await pool.query<{ origin_observation_key: string; ids: string[] }>(
    `SELECT origin_observation_key,array_agg(id ORDER BY received_at,id) AS ids
       FROM source_events WHERE organization_id=$1 AND content_state='active'
         AND origin_observation_key IS NOT NULL
      GROUP BY origin_observation_key HAVING count(*)>1
      ORDER BY md5(origin_observation_key) LIMIT 4`, [organization.id],
  )).rows;
  const duplicateCases = [] as unknown[];
  for (const group of duplicateRows) {
    const events = await store.getSourceEvents(group.ids.slice(0, 4));
    duplicateCases.push({ id: `duplicate:${contentHash(group.origin_observation_key)}`,
      category: "duplicate_origin_candidate", sourceReceipts: events.map(receipt),
      requestedAdjudication: ["same_claim_or_distinct_versions", "expected_transition_or_abstention",
        "temporal_cutoff", "ambiguity_and_rationale"] });
  }

  const usedSourceIds = new Set<string>([
    ...taskCases.flatMap((item) => (item as { sourceReceipts: { id: string }[] })
      .sourceReceipts.map((event) => event.id)),
    ...noActionEvents.map((event) => event.id),
    ...duplicateCases.flatMap((item) => (item as { sourceReceipts: { id: string }[] })
      .sourceReceipts.map((event) => event.id)),
  ]);
  const claimCases = [] as unknown[];
  for (const kind of ["request", "completion_report"] as const) {
    const rows = (await pool.query<{ id: string }>(
      `SELECT id FROM evidence_claims WHERE organization_id=$1 AND content_state='active'
         AND kind=$2 ORDER BY md5(id::text) LIMIT 200`, [organization.id, kind],
    )).rows;
    const claims = await store.getClaims(rows.map((row) => row.id));
    let selectedCount = 0;
    for (const claim of claims) {
      if (selectedCount >= 6) break;
      const ids = [...new Set(claim.body.spans.map((span) => span.eventId))];
      if (!ids.length || ids.some((id) => usedSourceIds.has(id))) continue;
      const [events, current] = await Promise.all([
        store.getSourceEvents(ids), store.currentSourceEventIds(ids),
      ]);
      if (events.length !== ids.length || current.length !== ids.length) continue;
      ids.forEach((id) => usedSourceIds.add(id));
      selectedCount += 1;
      claimCases.push({ id: `claim:${claim.id}`,
        category: kind === "request" ? "ordinary_request_candidate"
          : "ordinary_completion_report_candidate",
        claimCandidate: { id: claim.id, kind, statement: claim.body.statement,
          assertedAt: claim.body.assertedAt, assertedField: claim.body.assertedField,
          assertedValue: claim.body.assertedValue, subjectRefs: claim.body.subjectRefs },
        sourceReceipts: events.map(receipt),
        systemClaimIsNotALabel: true,
        requestedAdjudication: ["expected_claim_or_no_action", "target_identity_and_scope",
          "expected_transition_or_abstention", "temporal_cutoff", "ambiguity_and_rationale"] });
    }
  }

  type ReviewCase = { id: string; taskId?: string; sourceReceipts: ReturnType<typeof receipt>[] };
  const allCases = [...taskCases, ...noActionCases, ...duplicateCases, ...claimCases] as ReviewCase[];
  const parent = allCases.map((_, index) => index);
  const rootOf = (index: number): number => {
    while (parent[index] !== index) index = parent[index]!;
    return index;
  };
  const tokenOwner = new Map<string, number>();
  for (const [index, item] of allCases.entries()) {
    const tokens = item.taskId ? [`task:${item.taskId}`] : [];
    for (const source of item.sourceReceipts) {
      tokens.push(`source:${source.id}`);
      if (source.originObservationKey) tokens.push(`origin:${source.originObservationKey}`);
      tokens.push(`ref:${source.provider}:${source.installationKey}:${source.sourceRef}`);
      const payload = source.payload && typeof source.payload === "object"
        && !Array.isArray(source.payload) ? source.payload as Record<string, unknown> : null;
      if (source.provider === "slack" && typeof payload?.channel === "string") {
        const thread = payload.thread_ts ?? payload.threadTs ?? payload.ts;
        if (typeof thread === "string") tokens.push(`slack-thread:${payload.channel}:${thread}`);
      }
      const pull = source.provider === "github"
        ? source.sourceUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/) : null;
      if (pull) tokens.push(`github-pull:${pull[1]}:${pull[2]}`);
    }
    for (const token of tokens) {
      const owner = tokenOwner.get(token);
      if (owner === undefined) tokenOwner.set(token, index);
      else parent[rootOf(index)] = rootOf(owner);
    }
  }
  const clusterMembers = new Map<number, string[]>();
  for (const [index, item] of allCases.entries()) {
    const rootIndex = rootOf(index);
    clusterMembers.set(rootIndex, [...(clusterMembers.get(rootIndex) ?? []), item.id]);
  }
  const clusteredCases = allCases.map((item, index) => ({ ...item,
    reviewClusterId: contentHash(clusterMembers.get(rootOf(index))!.sort()) }));
  const packet = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    database: databaseName, organizationId: organization.id,
    sourcePacketHash: contentHash(sourcePacket), heldoutFrozen: false, confirmedLabels: 0,
    selection: { audited: auditedIds.length, taskCases: taskCases.length,
      noActionCases: noActionCases.length, duplicateCases: duplicateCases.length,
      ordinaryClaimCases: claimCases.length,
      reviewClusters: clusterMembers.size,
      ordinaryTaskSampling: "SHA-256 order of task ID within accepted done and open strata",
      noClaimSampling: "SHA-256 order of current no-claim source ID" },
    warning: "Accepted board state, model assessments, and no-claim dispositions are review context, not gold labels.",
    cases: clusteredCases };
  const templatePath = path.join(path.dirname(outputFile), "labels-template.json");
  if (templatePath === outputFile) throw new Error("The packet output cannot be the label template.");
  const template = { schemaVersion: 1, packetCasesHash: contentHash(packet.cases),
    instruction: "Review the source receipts before labeling. Set a cutoff after the receipts used, keep each cluster in one split, and place holdout after development in time. Record outcome scope and supporting receipt IDs for a confirmed change. Board state and model claims are not truth labels.",
    cases: clusteredCases.map((item) => ({ id: item.id, clusterId: item.reviewClusterId,
      sourceEventIds: item.sourceReceipts.map((event) => event.id),
      suggestedCutoff: item.sourceReceipts.reduce((latest, event) =>
        event.receivedAt > latest ? event.receivedAt : latest, ""),
      cutoff: null, split: null,
      targetTaskId: item.taskId ?? null, reviewer: null, rationale: null,
      adjudication: null, ambiguityStatus: null, expectedRelationship: null,
      expectedClaim: null, expectedScope: null, expectedTransition: null,
      supportingSourceEventIds: [] as string[] })) };
  let existingTemplate: { packetCasesHash?: unknown } | null = null;
  try { existingTemplate = JSON.parse(await readFile(templatePath, "utf8")) as { packetCasesHash?: unknown }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existingTemplate && existingTemplate.packetCasesHash !== template.packetCasesHash) {
    throw new Error("Existing reviewer labels belong to another packet; choose a new output directory.");
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(packet, null, 2), { mode: 0o600 });
  await rename(temporary, outputFile);
  if (!existingTemplate) {
    await writeFile(templatePath, JSON.stringify(template, null, 2), { mode: 0o600, flag: "wx" });
  }
  console.log(JSON.stringify({ packet: outputFile, cases: packet.cases.length,
    labelsTemplate: templatePath, confirmedLabels: 0,
    heldoutFrozen: false, hash: contentHash(packet.cases) }));
} finally {
  await store.close();
  await pool.end();
}
