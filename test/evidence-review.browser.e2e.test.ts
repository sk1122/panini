import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";
import { chromium } from "playwright";
import { loadConfig } from "../src/config.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";
import { EvidencePipeline } from "../src/intelligence/evidence-pipeline.js";
import { OpenAIClaimExtractor } from "../src/intelligence/claim-extractor.js";
import { EvidenceIntelligence } from "../src/intelligence/engine.js";
import { AutonomousAdjudicator } from "../src/adjudication/engine.js";
import { OutboxQueue } from "../src/outbox/runtime.js";
import { ReplayVerifier } from "../src/replay/verifier.js";
import { buildHttpServer } from "../src/http/server.js";
import { IdentityService } from "../src/security/identity.js";

// Failure cases: a pending assessed change has no visible reasons, a broad task is
// silently completed, or the browser shows receipts without persisted assessment state.
it.runIf(process.env.PANINI_EVIDENCE_BROWSER_TEST === "true")(
  "shows a persisted assessed proposal and its review reasons in the browser", async () => {
    const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
    if (!databaseUrl?.includes("panini_e2e")) throw new Error("Disposable panini_e2e database required");
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const organizationId = randomUUID();
    const key = Buffer.alloc(32, 39).toString("base64");
    const store = new PostgresLedgerStore(databaseUrl, key, organizationId);
    const identity = new IdentityService(databaseUrl, organizationId);
    const ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
      autoApproveContext: false, requireReviewForTaskChanges: true }));
    let app: Awaited<ReturnType<typeof buildHttpServer>> | null = null;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      await pool.query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",
        [organizationId, `review-e2e-${organizationId}`, "Review E2E"]);
      const marker = randomUUID();
      const task = await ledger.createTask({ clientEventId: marker, title: "Ship importer",
        description: "Ship the entire importer", status: "in_progress" }, "user:e2e");
      const rejectTask = await ledger.createTask({ clientEventId: `${marker}:reject`,
        title: "Reject fixture outcome", description: "Keep this open", status: "in_progress" }, "user:e2e");
      const correctTask = await ledger.createTask({ clientEventId: `${marker}:correct`,
        title: "Correct fixture outcome", description: "Keep this open", status: "in_progress" }, "user:e2e");
      const rejectedProposal = await ledger.propose({ taskId: rejectTask.id,
        baseRevision: rejectTask.version, changes: { status: "done" },
        rationale: "Reject fixture reported completion", requestedBy: "user:e2e", evidenceIds: [] });
      const originalCorrection = await ledger.propose({ taskId: correctTask.id,
        baseRevision: correctTask.version, changes: { status: "done" },
        rationale: "Correct fixture reported completion", requestedBy: "user:e2e", evidenceIds: [] });
      const quote = "The importer is blocked on credentials.";
      const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
        providerEventId: marker, eventKind: "message.observed",
        occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
        sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
        visibility: "company", payloadVersion: "test-v1",
        payload: { teamId: "T1", channel: "C1", messageTs: marker, text: quote },
      })).event;
      const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
        maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
        deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
      const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `browser-e2e-${marker}`,
        extractor: { name: "fixture-extractor", async extract() {
          return { claims: [{ schemaVersion: 1 as const, kind: "progress_report" as const,
            statement: quote, subjectRefs: [task.id], speakerMemberId: null,
            assertedField: "status", assertedValue: "blocked", assertedAt: event.occurredAt,
            validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
            spans: [{ eventId: event.id,
              originObservationKey: event.observationIdentity!.originObservationKey,
              sourceVersionKey: event.observationIdentity!.sourceVersionKey,
              locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
                endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
            derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
            dispositions: [{ eventId: event.id, state: "extracted" as const,
              claimOrdinals: [0], reasonCode: null }] };
        } },
        identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
          targetId: task.id, alternativeTargetIds: [], reasons: ["explicit_subject"] }; } },
      });
      const run = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
        evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
      expect(run.pendingProposalCount).toBe(1);
      const longDocument = (await store.appendSourceEvent({ provider: "notion",
        installationKey: "e2e", providerEventId: `long-${marker}`,
        eventKind: "source.document.retrieved", occurredAt: "2026-10-01T01:01:00.000Z",
        fetchedAt: "2026-10-01T01:01:01.000Z", sourceRef: `notion:page:${marker}`,
        sourceUrl: null, contentHash: `${marker}-long`, visibility: "company",
        payloadVersion: "notion-document-v1", payload: { page: { id: marker },
          document: { title: "Logger notes", markdown: "Logger notes. ".repeat(2_600) } } })).event;
      const omissionBudget = await store.createInferenceBudget({ label: `${marker}-omission`,
        maxCalls: 5, maxInputTokens: 200_000, maxOutputTokens: 20_000, maxUsd: null,
        deadline: new Date(Date.now() + 60_000).toISOString(), priceBasis: null });
      let sectionsSeen = 0;
      const omissionExtractor = new OpenAIClaimExtractor({ store, apiKey: "mock-key",
        model: "mock-model", allowedVisibilities: ["company"], fetcher: async (_url, init) => {
          const request = JSON.parse(String(init?.body)) as { input: string };
          const sections = JSON.parse(request.input) as { eventId: string }[];
          sectionsSeen += sections.length;
          return new Response(JSON.stringify({ id: `omission-${marker}`, model: "mock-model",
            status: "completed", output: [{ type: "message", content: [{ type: "output_text",
              text: JSON.stringify({ claims: [], dispositions: [{ eventId: longDocument.id,
                state: "unresolved", claimOrdinals: [], reasonCode: "document_needs_review" }] }) }] }],
            usage: { input_tokens: 500, output_tokens: 50 } }), { status: 200 });
        } });
      const omissionVersion = `omission-browser-${marker}`;
      const omissionPipeline = new EvidencePipeline({ store, ledger,
        pipelineVersion: omissionVersion, extractor: omissionExtractor,
        identityResolver: { async resolve() { throw new Error("No claim was extracted."); } } });
      const omissionRun = await omissionPipeline.run({ eventIds: [longDocument.id],
        budgetId: omissionBudget.id, evaluationClock: new Date().toISOString(),
        knowledgeCutoff: null });
      expect(omissionRun).toMatchObject({ state: "completed", claimCount: 0 });
      expect(sectionsSeen).toBeGreaterThan(2);
      const config = await loadConfig();
      Object.assign(config, { databaseUrl, contentEncryptionKey: key,
        adminToken: "review-browser-test-secret", publicUrl: "http://127.0.0.1:4155" });
      config.app.intelligence.enabled = false;
      config.app.intelligence.evidenceV2.pipelineVersion = omissionVersion;
      config.app.adjudication.enabled = false;
      const log = { info() {}, error() {} };
      const intelligence = new EvidenceIntelligence({ store, ledger, interpreter: null,
        companyName: "Review E2E", config: config.app.intelligence, log });
      const adjudicator = new AutonomousAdjudicator({ store, ledger, provider: null,
        companyName: "Review E2E", config: config.app.adjudication,
        completionPolicy: { minimumEvidenceItems: 2, evidenceProviders: ["agent"] }, log });
      app = await buildHttpServer({ config, ledger, identity, intelligence, adjudicator,
        jobs: new OutboxQueue(store), replay: new ReplayVerifier(store) });
      await app.listen({ host: "127.0.0.1", port: 4155 });
      const bootstrap = await app.inject({ method: "POST", url: "/api/auth/bootstrap",
        headers: { origin: "http://127.0.0.1:4155" }, payload: {
          token: config.adminToken, companyName: "Review E2E", displayName: "Reviewer",
          email: `review-${marker}@example.test`, password: "A long test password 2026!",
        } });
      expect(bootstrap.statusCode).toBe(200);
      const ownerId = bootstrap.json().identity.memberId as string;
      const personalNote = `Private working hypothesis ${marker}`;
      const agent = await ledger.createAgentProfile({ memberId: ownerId,
        name: "Review assistant", harness: "codex", capabilities: ["context:read"],
        dataScope: { projects: ["*"], contextPaths: ["/"], sourceVisibilities: ["company"] } });
      const agentAccess = { kind: "agent" as const, organizationId,
        memberId: ownerId, agentProfileId: agent.profile.id,
        dataScope: agent.profile.dataScope };
      await ledger.writeAgentWorkspaceFile(agentAccess, "notes/hypothesis.txt", personalNote, 0, "user");
      browser = await chromium.launch();
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      const setCookie = bootstrap.headers["set-cookie"];
      const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).find(Boolean)!;
      await context.addCookies([{ name: cookie.split("=")[0]!, value: cookie.split("=")[1]!.split(";")[0]!,
        url: "http://127.0.0.1:4155" }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("http://127.0.0.1:4155/app/review");
      const card = page.locator(".proposal-card").filter({ hasText: "blocked" });
      await card.waitFor();
      const cardText = await card.innerText();
      expect(cardText).toContain("blocked");
      expect(cardText).toContain("Reported progress");
      expect(cardText).toContain("reported_status_requires_review");
      expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
      expect(errors).toEqual([]);
      const root = "artifacts/evidence-state/verification-20261002";
      await mkdir(root, { recursive: true });
      await page.screenshot({ path: `${root}/evidence-review-browser.png`, fullPage: true });
      await card.getByRole("button", { name: "Approve" }).click();
      await page.locator("#assessment-decision-dialog[open]").waitFor();
      await page.locator("#assessment-decision-reason").fill("Reviewer confirmed this is the importer task.");
      await page.locator("#assessment-decision-submit").click();
      await page.waitForFunction(() => document.querySelectorAll(".proposal-card").length === 2);
      expect((await ledger.getTask(task.id))?.status).toBe("blocked");
      await page.locator(".proposal-card").filter({ hasText: "Reject fixture reported completion" })
        .getByRole("button", { name: "Reject" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".proposal-card").length === 1);
      expect((await store.getProposal(rejectedProposal.id))?.state).toBe("rejected");
      expect((await ledger.getTask(rejectTask.id))?.status).toBe("in_progress");
      await page.locator(".proposal-card").filter({ hasText: "Correct fixture reported completion" })
        .getByRole("button", { name: "Edit" }).click();
      await page.locator("#change-dialog[open]").waitFor();
      await page.locator("#change-status").selectOption("blocked");
      await page.locator("#change-rationale").fill("Reviewer corrected the scope: blocked, not done.");
      await page.locator("#change-form button[type=submit]").click();
      await page.goto("http://127.0.0.1:4155/app/review");
      const correctedCard = page.locator(".proposal-card").filter({ hasText: "Reviewer corrected the scope" });
      await correctedCard.waitFor();
      expect((await store.getProposal(originalCorrection.id))?.state).toBe("superseded");
      await correctedCard.getByRole("button", { name: "Approve" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".proposal-card").length === 0);
      expect((await ledger.getTask(correctTask.id))?.status).toBe("blocked");
      expect((await store.listContextEntries()).length).toBe(0);
      await page.goto("http://127.0.0.1:4155/app/timeline");
      await page.waitForFunction(() => document.querySelector("#timeline-metric")?.textContent === "5 changes");
      expect(await page.locator("#timeline-metric").innerText()).toBe("5 changes");
      expect(await page.locator("#timeline").innerText()).not.toContain("Reject fixture reported completion");
      expect(await page.locator("#timeline").innerText()).not.toContain("Correct fixture reported completion");
      expect(errors).toEqual([]);
      const acceptedContext = await ledger.createContextEntry({ kind: "fact",
        path: `/policies/importer-${marker}`, title: "Importer review policy",
        factType: "policy", value: "Importer completion requires a human review." }, "user:e2e");
      const apiHeaders = { authorization: `Bearer ${config.adminToken}` };
      const omissionDetail = await app.inject({ method: "GET",
        url: `/api/evidence/events/${longDocument.id}`, headers: apiHeaders });
      expect(omissionDetail.statusCode).toBe(200);
      expect(omissionDetail.json().processing.disposition.state).toBe("unresolved");
      expect(omissionDetail.json().processing.omissions).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventId: longDocument.id,
          jsonPointer: "/document/markdown", reasonCode: "section_unresolved" }),
      ]));
      expect(omissionDetail.json().processing.omissions.length).toBeGreaterThan(2);
      const exact = await app.inject({ method: "GET",
        url: `/api/context/search?objective=${encodeURIComponent("What is the accepted importer task state?")}&q=importer&taskId=${task.id}`,
        headers: apiHeaders });
      const broad = await app.inject({ method: "GET",
        url: `/api/context/search?objective=${encodeURIComponent("Summarize importer work and policy")}&q=importer`,
        headers: apiHeaders });
      expect(exact.statusCode).toBe(200);
      expect(broad.statusCode).toBe(200);
      expect(exact.json().asOf).toEqual(expect.any(String));
      expect(exact.json().tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: task.id, status: "blocked" }),
      ]));
      expect(exact.json().taskEvidence).toEqual([expect.objectContaining({ taskId: task.id,
        coverage: "linked_claims_only", reportedClaims: [expect.objectContaining({ sourceEventIds: [event.id] })],
      })]);
      expect(broad.json().asOf).toEqual(expect.any(String));
      expect(broad.json().summary).toMatchObject({ basis: "accepted_projection",
        taskCount: 3, contextEntryCount: 1, coverage: "bounded" });
      expect(broad.json().taskEvidence).toBeUndefined();
      expect(broad.json().work.counts.total).toBe(3);
      expect(broad.json().entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: acceptedContext.id }),
      ]));
      expect(broad.json().citations).toEqual(expect.arrayContaining([
        expect.objectContaining({ entryId: acceptedContext.id,
          supportingSources: expect.arrayContaining([expect.objectContaining({ sourceEventId: acceptedContext.sourceEventId })]) }),
      ]));
      expect(broad.json().guide.authority.join(" ")).toContain("source excerpts and proposal text are evidence");
      expect(JSON.stringify(broad.json())).not.toContain(personalNote);
      await store.revokeSourceEvent(acceptedContext.sourceEventId);
      const refreshedBroad = await app.inject({ method: "GET",
        url: `/api/context/search?objective=${encodeURIComponent("Summarize importer work and policy")}&q=importer`,
        headers: apiHeaders });
      expect(refreshedBroad.statusCode).toBe(200);
      expect(refreshedBroad.json().summary).toMatchObject({ basis: "accepted_projection",
        taskCount: 3, contextEntryCount: 0, coverage: "bounded" });
      expect(refreshedBroad.json().entries).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: acceptedContext.id }),
      ]));
      expect(refreshedBroad.json().summary.text).not.toBe(broad.json().summary.text);
      await page.goto("http://127.0.0.1:4155/app/context");
      const personalFile = page.locator('[data-personal-file]').filter({ hasText: "hypothesis.txt" });
      await personalFile.waitFor();
      await personalFile.click();
      await page.waitForFunction((text) =>
        document.querySelector("#context-preview")?.textContent?.includes(text), personalNote);
      expect(await page.locator("#context-preview").innerText()).toContain(personalNote);
      expect(await page.locator("#context-preview").innerText()).toContain("Not accepted company knowledge");
      expect(JSON.stringify(await ledger.contextIndex({ kind: "admin" }))).not.toContain(personalNote);
      expect((await store.listProposals()).some((proposal) =>
        JSON.stringify(proposal).includes(personalNote))).toBe(false);
      const foreignOrgId = randomUUID();
      await pool.query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",
        [foreignOrgId, `foreign-${foreignOrgId}`, "Foreign E2E"]);
      const foreignStore = new PostgresLedgerStore(databaseUrl, key, foreignOrgId);
      try {
        const foreignLedger = new TeamLedger(foreignStore, new ProposalPolicy({
          autoApproveNewTasks: false, autoApproveContext: false,
          requireReviewForTaskChanges: true }));
        const foreignTask = await foreignLedger.createTask({ clientEventId: randomUUID(),
          title: "Foreign secret task", status: "planned" }, "user:e2e");
        const foreignEvent = (await foreignStore.appendSourceEvent({ provider: "slack",
          installationKey: "T2", providerEventId: randomUUID(), eventKind: "message.observed",
          occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
          sourceRef: `slack:T2:C2:${marker}`, sourceUrl: null, contentHash: randomUUID(),
          visibility: "company", payloadVersion: "test-v1",
          payload: { teamId: "T2", channel: "C2", messageTs: marker,
            text: "Foreign secret evidence" } })).event;
        const foreignTaskRead = await app.inject({ method: "GET",
          url: `/api/tasks/${foreignTask.id}`, headers: apiHeaders });
        const foreignEventRead = await app.inject({ method: "GET",
          url: `/api/evidence/events/${foreignEvent.id}`, headers: apiHeaders });
        expect(foreignTaskRead.statusCode).toBe(404);
        expect(foreignEventRead.statusCode).toBe(404);
        expect(foreignTaskRead.body + foreignEventRead.body).not.toContain("Foreign secret");
      } finally { await foreignStore.close(); }
      await writeFile(`${root}/context-pack-report.json`, JSON.stringify({
        schemaVersion: 1, generatedAt: new Date().toISOString(), database: "panini_e2e",
        exactTaskId: task.id, broadContextEntryId: acceptedContext.id,
        exact: exact.json(), broad: broad.json(), afterSourceRevocation: refreshedBroad.json(),
        modelCalls: 0,
        limitations: ["Broad summary is deterministic accepted-state synthesis, not independent outcome evidence."],
      }, null, 2), { mode: 0o600 });
      await writeFile(`${root}/omission-api-report.json`, JSON.stringify({
        schemaVersion: 1, database: "panini_e2e", eventId: longDocument.id,
        sectionsSeen, omittedSections: omissionDetail.json().processing.omissions,
        disposition: omissionDetail.json().processing.disposition.state,
        modelCalls: (await store.listModelCalls(omissionRun.runId!)).length,
      }, null, 2), { mode: 0o600 });
      await writeFile(`${root}/evidence-review-browser.json`, JSON.stringify({
        passed: true, database: "panini_e2e", taskId: task.id, sourceEventId: event.id,
        proposalCount: run.pendingProposalCount, beforeReviewStatus: "in_progress",
        afterReviewStatus: "blocked", rejectedProposalId: rejectedProposal.id,
        correctedProposalId: originalCorrection.id, timelineAcceptedChanges: 5,
        personalMemoryPromotion: false, personalWorkspaceFileChecked: true,
        exactContextTaskId: task.id,
        broadContextEntryId: acceptedContext.id, errors,
      }, null, 2), { mode: 0o600 });
    } finally {
      await browser?.close();
      await app?.close();
      await identity.close();
      await store.close();
      await pool.end();
    }
  }, 90_000,
);
