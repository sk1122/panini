import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresLedgerStore } from "../src/store/postgres.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { compileTaskPatch } from "../src/store/task-changes.js";
import { decideEvidenceApplication } from "../src/intelligence/decision-policy.js";
import { ReplayVerifier } from "../src/replay/verifier.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const { Pool } = pg;
const key = Buffer.alloc(32, 19).toString("base64");

describe("Evidence state in PostgreSQL", () => {
  let pool: pg.Pool;
  let store: PostgresLedgerStore;

  beforeAll(async () => {
    if (!databaseUrl || !databaseUrl.includes("panini_e2e")) {
      throw new Error("PANINI_TEST_DATABASE_URL must point to an isolated panini_e2e database");
    }
    pool = new Pool({ connectionString: databaseUrl });
    store = new PostgresLedgerStore(databaseUrl, key);
    const database = await pool.query<{ current_database: string }>("SELECT current_database()");
    expect(database.rows[0]?.current_database).toBe("panini_e2e");
  });

  afterAll(async () => {
    await store?.close();
    await pool?.end();
  });

  it("installs the durable claim, assessment, disposition, dependency, budget and cache tables", async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [["evidence_claims", "evidence_assessments", "observation_dispositions", "evidence_dependencies", "inference_budgets", "model_calls", "work_entity_embeddings"]],
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "evidence_assessments", "evidence_claims", "evidence_dependencies", "inference_budgets",
      "model_calls", "observation_dispositions", "work_entity_embeddings",
    ]);
  });

  it("resumes an interrupted legacy link backfill without duplicate or invented revisions", async () => {
    const organizationId = randomUUID();
    await pool.query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",
      [organizationId, `backfill-${organizationId}`, "Backfill E2E"]);
    const scoped = new PostgresLedgerStore(databaseUrl!, key, organizationId,
      { backfillLegacyContent: false });
    try {
      const ledger = new TeamLedger(scoped, new ProposalPolicy({ autoApproveNewTasks: false,
        autoApproveContext: false, requireReviewForTaskChanges: true }));
      const task = await ledger.createTask({ clientEventId: randomUUID(), title: "Legacy link owner",
        status: "backlog" }, "user:e2e");
      const linkIds = [randomUUID(), randomUUID()];
      for (const [index, id] of linkIds.entries()) {
        await pool.query(`INSERT INTO work_links
          (id,organization_id,task_id,target_task_id,target_ref,link_type)
          VALUES ($1,$2,$3,NULL,$4,'relates_to')`,
        [id, organizationId, task.id, `legacy:artifact:${index}`]);
      }
      const migration = readFileSync(fileURLToPath(new URL("../drizzle/0029_legacy_work_link_revisions.sql",
        import.meta.url)), "utf8");
      const backfill = migration.split("--> statement-breakpoint")[0]!;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(backfill);
        expect((await client.query<{ count: string }>(`SELECT count(*)::text AS count
          FROM work_link_revisions WHERE organization_id=$1`, [organizationId])).rows[0]?.count)
          .toBe("2");
        await client.query("ROLLBACK");
      } finally { client.release(); }
      const count = async () => (await pool.query<{ count: string }>(`SELECT count(*)::text AS count
        FROM work_link_revisions WHERE organization_id=$1`, [organizationId])).rows[0]?.count;
      expect(await count()).toBe("0");
      await pool.query(backfill);
      const first = (await pool.query<{ link_id: string; current: Record<string, unknown>;
        changed_by: string; proposal_id: string | null }>(`SELECT link_id,current,changed_by,proposal_id
          FROM work_link_revisions WHERE organization_id=$1 ORDER BY link_id`, [organizationId])).rows;
      await pool.query(backfill);
      const second = (await pool.query<{ link_id: string; current: Record<string, unknown>;
        changed_by: string; proposal_id: string | null }>(`SELECT link_id,current,changed_by,proposal_id
          FROM work_link_revisions WHERE organization_id=$1 ORDER BY link_id`, [organizationId])).rows;
      expect(await count()).toBe("2");
      expect(second).toEqual(first);
      expect(first.map((row) => row.link_id)).toEqual([...linkIds].sort());
      expect(first.every((row) => row.changed_by === "system:migration:legacy-link-snapshot"
        && row.proposal_id === null && row.current.taskId === task.id)).toBe(true);
    } finally { await scoped.close(); }
  });

  it("keeps duplicate deliveries separate from source versions and unrelated text", async () => {
    const marker = randomUUID();
    const sourceRef = `slack:T1:C1:${marker}`;
    const input = (providerEventId: string, eventKind: string, source: string, text: string) => ({
      provider: "slack",
      installationKey: "T1",
      providerEventId,
      eventKind,
      occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: source,
      sourceUrl: null,
      contentHash: "delivery-specific-hash",
      visibility: "slack:channel:C1",
      payloadVersion: "test-v1",
      payload: providerEventId.startsWith("socket-")
        ? { teamId: "T1", channel: "C1", messageTs: source.split(":").at(-1)!, text, captureReaction: "bookmark", capturedByUserId: "U2" }
        : { teamId: "T1", channel: "C1", messageTs: source.split(":").at(-1)!, text, threadTs: marker, messageUserDisplayName: "Ada" },
    });

    const first = await store.appendSourceEvent(input(`socket-${marker}`, "message.observed", sourceRef, "The retest finished; the repair remains open."));
    const duplicate = await store.appendSourceEvent(input(`history-${marker}`, "message.imported", sourceRef, "The retest finished; the repair remains open."));
    const edit = await store.appendSourceEvent(input(`edit-${marker}`, "message.edited", sourceRef, "The repair also finished."));
    const other = await store.appendSourceEvent(input(`other-${marker}`, "message.observed", `${sourceRef}:other`, "The retest finished; the repair remains open."));

    const rows = await pool.query<{
      id: string;
      canonical_object_key: string;
      source_version_key: string;
      origin_observation_key: string;
      semantic_content_hash: string;
    }>(
      "SELECT id, canonical_object_key, source_version_key, origin_observation_key, semantic_content_hash FROM source_events WHERE id = ANY($1::uuid[])",
      [[first.event.id, duplicate.event.id, edit.event.id, other.event.id]],
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    const a = byId.get(first.event.id)!;
    const b = byId.get(duplicate.event.id)!;
    const c = byId.get(edit.event.id)!;
    const d = byId.get(other.event.id)!;
    expect(a.canonical_object_key).toBe(b.canonical_object_key);
    expect(a.source_version_key).toBe(b.source_version_key);
    expect(a.origin_observation_key).toBe(b.origin_observation_key);
    expect(a.semantic_content_hash).toBe(b.semantic_content_hash);
    expect(c.canonical_object_key).toBe(a.canonical_object_key);
    expect(c.source_version_key).not.toBe(a.source_version_key);
    expect(d.canonical_object_key).not.toBe(a.canonical_object_key);
    expect(d.origin_observation_key).not.toBe(a.origin_observation_key);
  });

  it("versions a Notion document when its body changes but page metadata does not", async () => {
    const marker = randomUUID();
    const append = async (providerEventId: string, markdown: string) => (await store.appendSourceEvent({
      provider: "notion", installationKey: "default", providerEventId,
      eventKind: "source.document.retrieved", occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: "2026-10-01T01:00:01.000Z", sourceRef: `notion:page:${marker}`,
      sourceUrl: null, contentHash: providerEventId, visibility: "notion:page:test",
      payloadVersion: "test-v1", payload: { page: { id: marker, last_edited_time: "same" },
        blocks: [], document: { title: "Runbook", markdown } },
    })).event;
    const original = await append(`${marker}-one`, "The release is planned.");
    const duplicate = await append(`${marker}-duplicate`, "The release is planned.");
    const edit = await append(`${marker}-edit`, "The release is complete.");
    expect(original.observationIdentity?.originObservationKey)
      .toBe(duplicate.observationIdentity?.originObservationKey);
    expect(edit.observationIdentity?.canonicalObjectKey)
      .toBe(original.observationIdentity?.canonicalObjectKey);
    expect(edit.observationIdentity?.sourceVersionKey)
      .not.toBe(original.observationIdentity?.sourceVersionKey);
  });

  it("does not invent a new Notion version when only fetch metadata changes", async () => {
    const marker = randomUUID();
    const append = async (providerEventId: string, editedAt: string) => (await store.appendSourceEvent({
      provider: "notion", installationKey: "default", providerEventId,
      eventKind: "source.document.retrieved", occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: editedAt, sourceRef: `notion:page:${marker}`,
      sourceUrl: null, contentHash: providerEventId, visibility: "notion:page:test",
      payloadVersion: "test-v1", payload: { page: { id: marker, last_edited_time: editedAt,
        properties: { Status: "In progress" } }, blocks: [],
      document: { title: "Runbook", markdown: "The release is planned." } },
    })).event;
    const first = await append(`${marker}-one`, "2026-10-01T01:00:01.000Z");
    const second = await append(`${marker}-two`, "2026-10-01T02:00:01.000Z");
    expect(second.observationIdentity?.canonicalObjectKey)
      .toBe(first.observationIdentity?.canonicalObjectKey);
    expect(second.observationIdentity?.sourceVersionKey)
      .toBe(first.observationIdentity?.sourceVersionKey);
  });

  it("preserves unknown legacy outcome and changes only explicitly patched task fields", async () => {
    const ledger = new TeamLedger(store, new ProposalPolicy({
      autoApproveNewTasks: false,
      autoApproveContext: false,
      requireReviewForTaskChanges: true,
    }));
    const marker = randomUUID();
    const created = await ledger.createTask({
      clientEventId: `manual:e2e:${marker}`,
      title: `Repair pipeline ${marker}`,
      description: "Repair the complete pipeline.",
      status: "in_progress",
      priority: "high",
      owner: "Asha",
      project: "Panini",
      dueDate: null,
      dependencyRefs: ["blocked-by:upstream"],
    }, "user:e2e");
    expect(created.result ?? "unknown").toBe("unknown");
    expect(created.outcomeContract ?? null).toBeNull();
    const patch = compileTaskPatch([{ field: "description", op: "set", value: "Retest completed; repair remains open.", supportingClaimIds: [] }]);
    const proposal = await ledger.propose({
      taskId: created.id,
      baseRevision: created.version,
      changes: patch,
      rationale: "Narrow diagnostic update",
      requestedBy: "user:e2e",
      evidenceIds: [],
    });
    const updated = await ledger.approveProposal(proposal.id, "user:e2e", null);
    expect(updated).toMatchObject({
      id: created.id,
      status: "in_progress",
      owner: "Asha",
      priority: "high",
      dependencyRefs: ["blocked-by:upstream"],
      description: "Retest completed; repair remains open.",
    });
    expect(() => compileTaskPatch([{ field: "owner", op: "clear", supportingClaimIds: [] }, { field: "owner", op: "clear", supportingClaimIds: [] }])).toThrow();
  });

  it("rebuilds a no-citation manual decision from immutable revisions without losing its authority", async () => {
    const isolatedOrgId = randomUUID();
    await pool.query("INSERT INTO organizations (id,slug,name) VALUES ($1,$2,$3)",
      [isolatedOrgId, `manual-rebuild-${isolatedOrgId}`, "Manual rebuild E2E"]);
    const scopedStore = new PostgresLedgerStore(databaseUrl!, key, isolatedOrgId);
    try {
      const scopedLedger = new TeamLedger(scopedStore, new ProposalPolicy({
        autoApproveNewTasks: false, autoApproveContext: false, requireReviewForTaskChanges: true,
      }));
      const task = await scopedLedger.createTask({ clientEventId: randomUUID(),
        title: "Manual decision survives rebuild", status: "planned" }, "user:e2e");
      const revisionsBefore = await scopedStore.listTaskRevisions(task.id);
      expect(revisionsBefore).toHaveLength(1);
      expect(revisionsBefore[0]?.decisionMetadata).toMatchObject({ basis: "manual",
        sourceEventIdsByField: {} });
      const replay = new ReplayVerifier(scopedStore);
      expect((await replay.verify()).ok).toBe(true);
      const rebuilt = await replay.rebuild({ apply: true, actor: "operator:e2e" });
      expect(rebuilt).toMatchObject({ applied: true, eligible: true,
        before: { ok: true }, after: { ok: true } });
      expect(await scopedLedger.getTask(task.id)).toEqual(task);
      expect(await scopedStore.listTaskRevisions(task.id)).toEqual(revisionsBefore);
    } finally { await scopedStore.close(); }
  });

  it("stamps an accepted outcome contract with the real decision, not proposer supplied provenance", async () => {
    const ledger = new TeamLedger(store, new ProposalPolicy({
      autoApproveNewTasks: false, autoApproveContext: false, requireReviewForTaskChanges: true,
    }));
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: `contract-${marker}`,
      title: "Verify import repair", description: "Repair and verify the complete import flow.",
      status: "in_progress" }, "user:author");
    const draft = { version: 1, statement: "Complete import repair",
      scope: "Import flow from receipt to accepted state", exclusions: [],
      criteria: [{ id: "e2e", description: "A full import E2E passes", required: true,
        evidenceRule: { kind: "manual_review" as const, authorityPolicyId: null,
          artifactRefs: [], requiredCheckNames: [], requiredEnvironment: null,
          maxMutableAgeSeconds: 900 }, acceptedBy: "forged:actor", acceptedAt: "2020-01-01T00:00:00.000Z" }],
      provenance: { proposalId: randomUUID(), evidenceIds: [], actor: "forged:actor",
        acceptedAt: "2020-01-01T00:00:00.000Z" } };
    const proposal = await ledger.propose({ taskId: task.id, baseRevision: task.version,
      changes: { outcomeContract: draft }, rationale: "Explicit outcome contract",
      requestedBy: "user:author", evidenceIds: [] });
    const accepted = await ledger.approveProposal(proposal.id, "user:reviewer", "Reviewed contract");
    if (!("outcomeContract" in accepted)) throw new Error("Expected task revision");
    expect(accepted.outcomeContract).toMatchObject({ version: 1,
      provenance: { proposalId: proposal.id, actor: "user:reviewer",
        acceptedAt: expect.any(String) },
      criteria: [{ id: "e2e", acceptedBy: "user:reviewer",
        acceptedAt: expect.any(String) }] });
    expect(accepted.outcomeContract?.provenance.acceptedAt)
      .toBe(accepted.outcomeContract?.criteria[0]?.acceptedAt);
    expect((await store.getTask(task.id))?.outcomeContract).toEqual(accepted.outcomeContract);
    const amendment = await ledger.propose({ taskId: task.id, baseRevision: accepted.version,
      changes: { outcomeContract: { ...draft, version: 2,
        statement: "Complete and observe the import repair" } },
      rationale: "Clarify the outcome", requestedBy: "user:author", evidenceIds: [] });
    await expect(store.approveAndApplyProposal({ proposalId: amendment.id,
      state: "auto_applied", decidedBy: "policy:default", decisionNote: "auto",
      auditAction: "proposal.auto_applied" })).rejects.toThrow();
    const amended = await ledger.approveProposal(amendment.id, "user:reviewer", "Reviewed amendment");
    if (!("outcomeContract" in amended)) throw new Error("Expected amended task revision");
    expect(amended.outcomeContract?.version).toBe(2);
    expect(amended.outcomeContract?.provenance.proposalId).toBe(amendment.id);
    const stale = await ledger.propose({ taskId: task.id, baseRevision: amended.version,
      changes: { outcomeContract: { ...draft, version: 2 } },
      rationale: "Invalid repeated version", requestedBy: "user:author", evidenceIds: [] });
    await expect(ledger.approveProposal(stale.id, "user:reviewer", "Reviewed"))
      .rejects.toThrow();
  });

  it("does not reveal a private assessed proposal through the detail boundary", async () => {
    const ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
      autoApproveContext: false, requireReviewForTaskChanges: true }));
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: `${marker}-task`,
      title: "Private launch", project: "Alpha", status: "in_progress" }, "user:e2e");
    const source = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C-PRIVATE", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker,
        text: "Private launch report." },
    })).event;
    const proposal = await ledger.propose({ taskId: task.id, baseRevision: task.version,
      changes: { status: "review" }, rationale: "Private launch report",
      requestedBy: "user:e2e", evidenceIds: [source.id] });
    const organization = await store.getOrganization();
    await expect(ledger.proposalDetailForAccess(proposal.id, { kind: "member",
      organizationId: organization.id, memberId: randomUUID() })).rejects.toThrow();
    expect((await ledger.proposalDetailForAccess(proposal.id, { kind: "admin" })).proposal.id)
      .toBe(proposal.id);
  });

  it("saves a validated claim and input disposition once, then resumes after store restart", async () => {
    const marker = randomUUID();
    const text = "The retest finished; the repair remains open.";
    const event = (await store.appendSourceEvent({
      provider: "slack", installationKey: "T1", providerEventId: marker,
      eventKind: "message.observed", occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: "2026-10-01T01:00:01.000Z", sourceRef: `slack:T1:C1:${marker}`,
      sourceUrl: null, contentHash: marker, visibility: "slack:channel:C1",
      payloadVersion: "test-v1", payload: { teamId: "T1", channel: "C1", messageTs: marker, text },
    })).event;
    const lease = await store.claimObservation({
      eventId: event.id, pipelineVersion: "e2e-v2", workerId: "e2e-worker", leaseSeconds: 90,
      now: new Date().toISOString(),
    });
    expect(lease.kind).toBe("claimed");
    if (lease.kind !== "claimed") throw new Error("Expected claim lease");
    const duplicate = await store.claimObservation({
      eventId: event.id, pipelineVersion: "e2e-v2", workerId: "other-worker", leaseSeconds: 90,
      now: new Date().toISOString(),
    });
    expect(duplicate.kind).toBe("busy");
    const budget = await store.createInferenceBudget({
      label: `e2e-${marker}`, maxCalls: 1, maxInputTokens: 1000, maxOutputTokens: 500,
      maxUsd: null, deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null,
    });
    const run = await store.createV2Run({
      model: "fixture-only", inputHash: marker, eventIds: [event.id],
      pipelineVersion: "e2e-v2", promptVersion: "fixture-v1", policyVersion: "review-v1",
      configHash: marker, replayMode: "live", evaluationClock: "2026-10-01T01:00:02.000Z",
      knowledgeCutoff: null, budgetId: budget.id, manifest: { activeEventIds: [event.id] },
    });
    const claim = {
      schemaVersion: 1 as const, kind: "progress_report" as const,
      statement: "The retest finished, but repair is still open.", subjectRefs: [],
      speakerMemberId: null, assertedField: null, assertedValue: null,
      assertedAt: "2026-10-01T01:00:00.000Z", validFrom: null, validTo: null,
      temporalBasis: "relative_to_source" as const,
      spans: [{ eventId: event.id, originObservationKey: event.observationIdentity?.originObservationKey ?? "",
        sourceVersionKey: event.observationIdentity?.sourceVersionKey ?? "",
        locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
          endUtf16: 19, spanHash: createHash("sha256").update(text.slice(0, 19)).digest("hex") } }],
      derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [],
    };
    const input = {
      runId: run.id, episodeKey: marker, inputHash: marker, claims: [claim],
      dispositions: [{ dispositionId: lease.disposition.id, eventId: event.id,
        state: "extracted" as const, claimOrdinals: [0], reasonCode: null }],
      dependencies: [],
      expectedLeases: [{ dispositionId: lease.disposition.id, attempt: lease.disposition.attempt, owner: "e2e-worker" }],
    };
    await expect(store.saveExtraction({ ...input, claims: [{ ...claim, spans: [{
      ...claim.spans[0]!, locator: { ...claim.spans[0]!.locator, spanHash: "bad" },
    }] }] })).rejects.toThrow();
    const saved = await store.saveExtraction(input);
    expect(saved.claims).toHaveLength(1);
    expect(saved.dispositions[0]?.state).toBe("extracted");
    expect((await store.saveExtraction(input)).claims[0]?.id).toBe(saved.claims[0]?.id);
    await expect(store.saveExtraction({ ...input, inputHash: `${marker}-changed` })).rejects.toThrow();
    const reopened = new PostgresLedgerStore(databaseUrl!, key);
    try {
      expect((await reopened.getClaims([saved.claims[0]!.id]))[0]?.body.statement).toBe(claim.statement);
    } finally {
      await reopened.close();
    }
    const ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
      autoApproveContext: false, requireReviewForTaskChanges: true }));
    const task = await ledger.createTask({ clientEventId: `assessment-${marker}`,
      title: "Repair pipeline", description: "Implement the full repair", status: "in_progress" }, "user:e2e");
    const assessment = await store.saveAssessment({
      runId: run.id, assessmentKey: marker, targetType: "task", targetId: task.id,
      targetVersion: String(task.version), contractVersion: null,
      claimIds: [saved.claims[0]!.id], evidenceFingerprint: marker,
      permissionFingerprint: marker, policyVersion: "review-v1", modelVersion: "fixture-only",
      relationship: "part_of", disposition: "review_required", reasonCodes: ["partial_scope"],
      body: { schemaVersion: 1, kind: "task", relationship: "part_of", alternativeTargetIds: [],
        fields: [{ operation: { field: "status", op: "set", value: "done", supportingClaimIds: [saved.claims[0]!.id] },
          verdict: "insufficient", support: claim.spans, contradictions: [],
          effectiveAt: null, reasonCodes: ["partial_scope"] }], criteria: [],
        coverage: { complete: true, requiredResources: [], gaps: [], checkedAt: "2026-10-01T01:00:02.000Z" },
        rawScores: [], explanation: "The retest is part of the broader repair." },
    }, []);
    expect(decideEvidenceApplication({ task, assessment })).toMatchObject({
      disposition: "review_required", reasonCodes: expect.arrayContaining(["partial_scope"]),
    });
    expect((await store.getAssessment(assessment.id))?.body).toEqual(assessment.body);
    const { id: _forgedId, createdAt: _forgedAt, ...assessmentInput } = assessment;
    await expect(store.saveAssessment({ ...assessmentInput,
      assessmentKey: `${marker}-forged-criterion`,
      body: { ...assessment.body, criteria: [{ criterionId: "fake-check",
        verdict: "satisfied", verifiedBy: "deterministic_artifact",
        support: [{ ...claim.spans[0]!, eventId: randomUUID() }],
        checkedArtifactRefs: [], reasonCodes: [] }] },
    }, [])).rejects.toThrow();
    const resumedRun = await store.createV2Run({ model: "fixture-only", inputHash: `${marker}-resume`,
      eventIds: [event.id], pipelineVersion: "e2e-v2", promptVersion: "fixture-v1",
      policyVersion: "review-v1", configHash: marker, replayMode: "cached_reassess",
      evaluationClock: "2026-10-01T01:00:03.000Z", knowledgeCutoff: null,
      budgetId: budget.id, manifest: { reusedClaimIds: [saved.claims[0]!.id] } });
    const { id: _assessmentId, createdAt: _createdAt, ...sameAssessment } = assessment;
    expect((await store.saveAssessment({ ...sameAssessment, runId: resumedRun.id }, [])).id)
      .toBe(assessment.id);
    expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
    await expect(ledger.proposeAssessedTaskChange({ assessmentId: assessment.id,
      operations: [{ field: "status", op: "set", value: "done", supportingClaimIds: [saved.claims[0]!.id] }],
      rationale: "Proposed from the retest report", requestedBy: "intelligence:e2e" })).rejects.toThrow();
    expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
    const descriptionOperation = { field: "description" as const, op: "set" as const,
      value: "Retest finished; full repair remains open.", supportingClaimIds: [saved.claims[0]!.id] };
    const supported = await store.saveAssessment({
      runId: run.id, assessmentKey: `${marker}-description`, targetType: "task", targetId: task.id,
      targetVersion: String(task.version), contractVersion: null, claimIds: [saved.claims[0]!.id],
      evidenceFingerprint: `${marker}-description`, permissionFingerprint: marker,
      policyVersion: "review-v1", modelVersion: "fixture-only", relationship: "same_outcome",
      disposition: "eligible", reasonCodes: [],
      body: { schemaVersion: 1, kind: "task", relationship: "same_outcome", alternativeTargetIds: [],
        fields: [{ operation: descriptionOperation, verdict: "supported", support: claim.spans,
          contradictions: [], effectiveAt: "2026-10-01T01:00:00.000Z", reasonCodes: [] }],
        criteria: [], coverage: { complete: true, requiredResources: [], gaps: [],
          checkedAt: "2026-10-01T01:00:02.000Z" }, rawScores: [],
        explanation: "The reported retest is progress on the repair." },
    }, []);
    const supportedProposal = await ledger.proposeAssessedTaskChange({ assessmentId: supported.id,
      operations: [descriptionOperation], rationale: "Record partial progress", requestedBy: "intelligence:e2e" });
    const accepted = await ledger.approveProposal(supportedProposal.id, "user:e2e", "Reviewed progress");
    if (!("version" in accepted)) throw new Error("Expected task revision");
    expect(accepted).toMatchObject({ version: task.version + 1, status: "in_progress",
      description: descriptionOperation.value });
    expect((await ledger.proposeAssessedTaskChange({ assessmentId: supported.id,
      operations: [descriptionOperation], rationale: "Record partial progress", requestedBy: "intelligence:e2e" })).id)
      .toBe(supportedProposal.id);
    const repeated = await ledger.approveProposal(supportedProposal.id, "user:e2e", "repeat");
    expect("version" in repeated && repeated.version).toBe(accepted.version);
    const acceptedRevision = await store.getTaskRevisionByProposal(supportedProposal.id);
    expect(acceptedRevision?.decisionMetadata?.assessmentId).toBe(supported.id);
    const staleOperation = { ...descriptionOperation,
      value: "An earlier source-derived description that must not overwrite manual work." };
    const staleAssessment = await store.saveAssessment({
      runId: run.id, assessmentKey: `${marker}-stale-manual-race`, targetType: "task",
      targetId: task.id, targetVersion: String(accepted.version), contractVersion: null,
      claimIds: [saved.claims[0]!.id], evidenceFingerprint: `${marker}-stale-manual-race`,
      permissionFingerprint: marker, policyVersion: "review-v1", modelVersion: "fixture-only",
      relationship: "same_outcome", disposition: "eligible", reasonCodes: [],
      body: { schemaVersion: 1, kind: "task", relationship: "same_outcome",
        alternativeTargetIds: [], fields: [{ operation: staleOperation, verdict: "supported",
          support: claim.spans, contradictions: [], effectiveAt: claim.assertedAt,
          reasonCodes: [] }], criteria: [], coverage: { complete: true,
          requiredResources: [], gaps: [], checkedAt: "2026-10-01T01:00:02.000Z" },
        rawScores: [], explanation: "Older source interpretation." },
    }, []);
    const staleProposal = await ledger.proposeAssessedTaskChange({ assessmentId: staleAssessment.id,
      operations: [staleOperation], rationale: "Older source interpretation",
      requestedBy: "evidence-pipeline" });
    const manualProposal = await ledger.propose({ taskId: task.id,
      baseRevision: accepted.version, changes: { owner: "Reviewer" },
      rationale: "Manual assignment", requestedBy: "user:e2e", evidenceIds: [] });
    const manuallyChanged = await ledger.approveProposal(manualProposal.id, "user:e2e", "Assigned manually");
    expect("version" in manuallyChanged && manuallyChanged.version).toBe(accepted.version + 1);
    await expect(ledger.approveProposal(staleProposal.id, "user:e2e", "Approve old assessment"))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await ledger.approveProposal(manualProposal.id, "user:e2e", "Repeat acknowledgment");
    const effects = await pool.query<{ proposal_id: string; count: string }>(
      `SELECT payload->>'proposalId' AS proposal_id,count(*)::text AS count
         FROM outbox_jobs WHERE organization_id=$1 AND topic='projection.task.revised'
           AND payload->>'proposalId'=ANY($2::text[])
         GROUP BY payload->>'proposalId'`,
      [await store.getOrganization().then((org) => org.id), [manualProposal.id, staleProposal.id]]);
    expect(effects.rows).toEqual([{ proposal_id: manualProposal.id, count: "1" }]);
    await store.revokeSourceEvent(event.id);
    expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
  });

  it("does not mark a run complete when one active input lacks a disposition", async () => {
    const marker = randomUUID();
    const make = async (suffix: string) => (await store.appendSourceEvent({
      provider: "slack", installationKey: "T1", providerEventId: `${marker}-${suffix}`,
      eventKind: "message.observed", occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: "2026-10-01T01:00:01.000Z", sourceRef: `slack:T1:C1:${marker}-${suffix}`,
      sourceUrl: null, contentHash: `${marker}-${suffix}`, visibility: "slack:channel:C1",
      payloadVersion: "test-v1", payload: { teamId: "T1", channel: "C1", messageTs: `${marker}-${suffix}`, text: suffix },
    })).event;
    const first = await make("first");
    const second = await make("second");
    const lease = await store.claimObservation({ eventId: first.id, pipelineVersion: "missing-e2e-v2",
      workerId: "e2e-worker", leaseSeconds: 90, now: new Date().toISOString() });
    if (lease.kind !== "claimed") throw new Error("Expected claim lease");
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1, maxInputTokens: 100,
      maxOutputTokens: 100, maxUsd: null, deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "fixture-only", inputHash: marker,
      eventIds: [first.id, second.id], pipelineVersion: "missing-e2e-v2", promptVersion: "fixture-v1",
      policyVersion: "review-v1", configHash: marker, replayMode: "live",
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null, budgetId: budget.id,
      manifest: { activeEventIds: [first.id, second.id] } });
    await expect(store.saveExtraction({ runId: run.id, episodeKey: marker, inputHash: marker,
      claims: [], dispositions: [{ dispositionId: lease.disposition.id, eventId: first.id,
        state: "no_claim", claimOrdinals: [], reasonCode: "no_work" }], dependencies: [],
      expectedLeases: [{ dispositionId: lease.disposition.id, attempt: lease.disposition.attempt,
        owner: "e2e-worker" }],
    })).rejects.toThrow();
  });

  it("reserves a shared model-call budget once across concurrent workers", async () => {
    const marker = randomUUID();
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 100, maxOutputTokens: 50, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "fixture-only", inputHash: marker,
      eventIds: [], pipelineVersion: "budget-e2e-v2", promptVersion: "fixture-v1",
      policyVersion: "review-v1", configHash: marker, replayMode: "live",
      evaluationClock: "2026-10-01T01:00:00.000Z", knowledgeCutoff: null,
      budgetId: budget.id, manifest: { activeEventIds: [] } });
    const reservation = (logicalCallKey: string) => store.reserveModelCall({
      budgetId: budget.id, runId: run.id, purpose: "extract", logicalCallKey,
      attempt: 1, provider: "fixture", model: "fixture-only",
      requestHash: marker, request: { prompt: "synthetic" }, cacheKey: null,
      estimatedInputTokens: 60, estimatedOutputTokens: 20, estimatedUsd: null,
    });
    const results = await Promise.all([reservation(`${marker}-a`), reservation(`${marker}-b`)]);
    expect(results.map((result) => result.kind).sort()).toEqual(["exhausted", "reserved"]);
    const granted = results.find((result) => result.kind === "reserved");
    if (!granted || granted.kind !== "reserved") throw new Error("Missing granted reservation");
    expect((await reservation(granted.call.logicalCallKey)).kind).toBe("reserved");
    await store.markModelCallDispatched(granted.call.id, new Date().toISOString());
    const settled = await store.settleModelCall({ callId: granted.call.id, state: "succeeded",
      providerRequestId: null, resolvedModelVersion: "fixture-v1", inputTokens: 55,
      cachedInputTokens: 0, outputTokens: 18, embeddingItems: null,
      costUsd: null, costBasis: "unknown", errorCode: null,
      response: { claims: [] }, finishedAt: new Date().toISOString() });
    expect(settled.state).toBe("succeeded");
    const totals = await pool.query<{ spent_calls: string; reserved_calls: string }>(
      "SELECT spent_calls,reserved_calls FROM inference_budgets WHERE id=$1", [budget.id]);
    expect(Number(totals.rows[0]?.spent_calls)).toBe(1);
    expect(Number(totals.rows[0]?.reserved_calls)).toBe(0);
  });

  it("can conservatively reconcile one unknown provider call and reopen the same budget", async () => {
    const marker = randomUUID();
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 2,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: "0.01000000",
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "fixture-only", inputHash: marker,
      eventIds: [], pipelineVersion: "unknown-budget-e2e", promptVersion: "fixture-v1",
      policyVersion: "review-v1", configHash: marker, replayMode: "live",
      evaluationClock: "2026-10-01T01:00:00.000Z", knowledgeCutoff: null,
      budgetId: budget.id, manifest: {} });
    const reservation = await store.reserveModelCall({ budgetId: budget.id, runId: run.id,
      purpose: "extract", logicalCallKey: marker, attempt: 1, provider: "fixture",
      model: "fixture-only", requestHash: marker, request: { prompt: "synthetic" },
      cacheKey: null, estimatedInputTokens: 600, estimatedOutputTokens: 200,
      estimatedUsd: "0.00200000" });
    if (reservation.kind !== "reserved") throw new Error("Expected a reserved model call");
    await store.markModelCallDispatched(reservation.call.id, new Date().toISOString());
    await store.settleModelCall({ callId: reservation.call.id, state: "unknown",
      providerRequestId: null, resolvedModelVersion: null, inputTokens: null,
      cachedInputTokens: null, outputTokens: null, embeddingItems: null,
      costUsd: null, costBasis: "unknown", errorCode: "provider_http_400_unspecified",
      response: null, finishedAt: new Date().toISOString() });
    expect((await pool.query<{ state: string }>("SELECT state FROM inference_budgets WHERE id=$1",
      [budget.id])).rows[0]?.state).toBe("suspended");
    const reconciled = await store.reconcileUnknownModelCallAtReservedBound(reservation.call.id);
    expect(reconciled).toMatchObject({ state: "failed", costUsd: "0.00200000",
      costBasis: "estimated", errorCode: "provider_http_400_unspecified_reserved_bound" });
    expect((await store.reconcileUnknownModelCallAtReservedBound(reservation.call.id)).id)
      .toBe(reconciled.id);
    expect((await pool.query<{ state: string; reserved_calls: string; spent_calls: string;
      spent_usd: string }>("SELECT state,reserved_calls,spent_calls,spent_usd FROM inference_budgets WHERE id=$1",
      [budget.id])).rows[0]).toMatchObject({ state: "active", reserved_calls: "0",
      spent_calls: "1", spent_usd: "0.00200000" });
  });

  it("stops later paid dispatch when provider usage exceeds a reserved bound", async () => {
    const marker = randomUUID();
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 3,
      maxInputTokens: 100, maxOutputTokens: 100, maxUsd: "0.01000000",
      deadline: new Date(Date.now() + 60_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "fixture-only", inputHash: marker,
      eventIds: [], pipelineVersion: "overrun-e2e", promptVersion: "fixture-v1",
      policyVersion: "review-v1", configHash: marker, replayMode: "live",
      evaluationClock: new Date().toISOString(), knowledgeCutoff: null,
      budgetId: budget.id, manifest: {} });
    const reserve = (logicalCallKey: string) => store.reserveModelCall({
      budgetId: budget.id, runId: run.id, purpose: "extract", logicalCallKey,
      attempt: 1, provider: "fixture", model: "fixture-only", requestHash: logicalCallKey,
      request: { prompt: "synthetic" }, cacheKey: null,
      estimatedInputTokens: 10, estimatedOutputTokens: 10, estimatedUsd: "0.00100000",
    });
    const first = await reserve(`${marker}-first`);
    if (first.kind !== "reserved") throw new Error("Expected model-call reservation");
    await store.markModelCallDispatched(first.call.id, new Date().toISOString());
    await store.settleModelCall({ callId: first.call.id, state: "succeeded",
      providerRequestId: null, resolvedModelVersion: "fixture-v1",
      inputTokens: 101, cachedInputTokens: 0, outputTokens: 10,
      embeddingItems: null, costUsd: "0.01100000", costBasis: "estimated",
      errorCode: null, response: {}, finishedAt: new Date().toISOString() });
    expect((await store.getInferenceBudget(budget.id))?.state).toBe("exhausted");
    expect(await reserve(`${marker}-second`)).toMatchObject({ kind: "exhausted",
      reason: "budget_exhausted" });
  });

  it("rolls back an approval interrupted at outbox insertion and retries once", async () => {
    const isolatedOrgId = randomUUID();
    await pool.query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",
      [isolatedOrgId, `approval-recovery-${isolatedOrgId}`, "Approval recovery E2E"]);
    const isolated = new PostgresLedgerStore(databaseUrl!, key, isolatedOrgId);
    const ledger = new TeamLedger(isolated, new ProposalPolicy({ autoApproveNewTasks: false,
      autoApproveContext: false, requireReviewForTaskChanges: true }));
    const triggerSuffix = randomUUID().replaceAll("-", "");
    const triggerName = `fail_approval_${triggerSuffix}`;
    const functionName = `fail_approval_fn_${triggerSuffix}`;
    let triggerInstalled = false;
    try {
      const task = await ledger.createTask({ clientEventId: triggerSuffix,
        title: "Recover approval", description: "Pending work", status: "in_progress" }, "user:e2e");
      const proposal = await ledger.propose({ taskId: task.id, baseRevision: task.version,
        changes: { status: "blocked" }, rationale: "Explicit review decision",
        requestedBy: "user:e2e", evidenceIds: [] });
      const before = (await pool.query<{ id: string; version: number }>(
        "SELECT id,version FROM task_revisions WHERE organization_id=$1 AND task_id=$2 ORDER BY version",
        [isolatedOrgId, task.id])).rows;
      await pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.organization_id = '${isolatedOrgId}' AND NEW.topic = 'projection.task.revised'
            AND NEW.payload->>'proposalId' = '${proposal.id}' THEN
            RAISE EXCEPTION 'synthetic interruption before approval commit';
          END IF;
          RETURN NEW;
        END $$`);
      await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON outbox_jobs
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      triggerInstalled = true;
      await expect(ledger.approveProposal(proposal.id, "user:e2e", "Reviewer confirmed"))
        .rejects.toThrow("synthetic interruption");
      expect((await isolated.getProposal(proposal.id))?.state).toBe("pending");
      expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
      expect((await pool.query<{ id: string; version: number }>(
        "SELECT id,version FROM task_revisions WHERE organization_id=$1 AND task_id=$2 ORDER BY version",
        [isolatedOrgId, task.id])).rows).toEqual(before);
      await pool.query(`DROP TRIGGER ${triggerName} ON outbox_jobs`);
      triggerInstalled = false;
      const child = spawnSync(process.execPath, ["--import", "tsx",
        fileURLToPath(new URL("./helpers/evidence-approval-child.ts", import.meta.url)),
        isolatedOrgId, proposal.id], { cwd: process.cwd(), env: process.env,
        encoding: "utf8", timeout: 20_000 });
      if (child.signal !== "SIGKILL") throw new Error(`Approval child did not stop after commit: ${child.stderr}`);
      const resumed = new PostgresLedgerStore(databaseUrl!, key, isolatedOrgId);
      try {
        expect((await ledger.getTask(task.id))?.status).toBe("blocked");
        const revisionsAfter = await resumed.listTaskRevisions(task.id);
        expect(revisionsAfter).toHaveLength(before.length + 1);
        expect(revisionsAfter.slice(0, before.length).map((revision) => revision.id))
          .toEqual(before.map((revision) => revision.id));
        expect((await new ReplayVerifier(resumed).verify()).ok).toBe(true);
        const delivery = (await resumed.listOutboxJobs(30)).filter((job) =>
          job.topic === "projection.task.revised"
            && (job.payload as { proposalId?: string }).proposalId === proposal.id);
        expect(delivery).toHaveLength(1);
        expect(delivery[0]?.state).toBe("pending");
        const claimed = await resumed.claimOutboxJobs("restarted-worker", 20, 10);
        const target = claimed.find((job) => job.id === delivery[0]!.id);
        expect(target).toBeDefined();
        await resumed.completeOutboxJob(target!.id, "restarted-worker");
        expect((await resumed.listOutboxJobs(30)).find((job) => job.id === target!.id)?.state)
          .toBe("completed");
      } finally { await resumed.close(); }
      expect((await pool.query<{ id: string }>(
        "SELECT id FROM task_revisions WHERE organization_id=$1 AND task_id=$2",
        [isolatedOrgId, task.id])).rows).toHaveLength(before.length + 1);
      expect((await isolated.listOutboxJobs(30)).filter((job) =>
        job.topic === "projection.task.revised"
          && (job.payload as { proposalId?: string }).proposalId === proposal.id)).toHaveLength(1);
    } finally {
      if (triggerInstalled) await pool.query(`DROP TRIGGER ${triggerName} ON outbox_jobs`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      await isolated.close();
    }
  });
});
