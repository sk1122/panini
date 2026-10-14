import { describe, expect, it } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import type { SourceDocumentSummary } from "../src/domain/types.js";
import { PostgresContextCompiler, renderContextPackMarkdown } from "../src/retrieval/context-compiler.js";
import type { SourceDocumentReader } from "../src/retrieval/source-document-library.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

function sourceSummary(index: number): SourceDocumentSummary {
  return {
    sourceEventId: `source-${index}`,
    provider: "notion",
    sourceRef: `notion:source-${index}`,
    sourceUrl: null,
    sourcePath: `source://notion/source-${index}`,
    title: `Architecture source ${index}`,
    suggestedPath: `/architecture/source-${index}.md`,
    contentHash: `hash-${index}`,
    occurredAt: "2026-09-18T00:00:00.000Z",
    fetchedAt: "2026-09-18T00:00:01.000Z",
    receivedAt: "2026-09-18T00:00:02.000Z",
    visibility: "company",
    characterCount: 30_000,
    sections: Array.from({ length: 40 }, (_, section) => ({
      id: `section-${section}`,
      heading: `Architecture source section ${section}`,
      headingPath: ["Architecture", `Source section ${section}`],
      level: 2,
      startLine: section * 20 + 1,
      endLine: section * 20 + 20,
      characterCount: 750,
      excerpt: "Source material ".repeat(12),
    })),
    matchedSectionIds: ["section-0", "section-1"],
    relatedContextEntryIds: [],
  };
}

describe("agent context pack budget", () => {
  it("prefers a concise accepted fact over an equally matching oversized file", async () => {
    const store = new MemoryLedgerStore();
    const ledger = new TeamLedger(store,
      new ProposalPolicy({ autoApproveNewTasks: true, autoApproveContext: true, requireReviewForTaskChanges: true }));
    await ledger.createContextEntry({
      kind: "file",
      path: "/architecture/edge-propagation.md",
      title: "Edge propagation architecture",
      body: "Edge propagation. " + "Large accepted architecture detail. ".repeat(500),
    }, "user:reviewer");
    const fact = await ledger.createContextEntry({
      kind: "fact",
      path: "/decisions/edge-propagation",
      title: "Edge propagation decision",
      factType: "decision",
      value: "An uncalibrated causal edge cannot propagate belief.",
    }, "user:reviewer");

    const pack = await ledger.retrieve({
      objective: "Check edge propagation",
      query: "edge propagation",
      characterBudget: 8_000,
    });
    expect(pack.entries[0]?.id).toBe(fact.id);
    expect(pack.citations[0]?.contentHash).toBe(fact.contentHash);
  });

  it("keeps accepted content, catalog pointers, and source pointers within 30k", async () => {
    const store = new MemoryLedgerStore();
    const sourceDocuments: SourceDocumentReader = {
      async list() { return Array.from({ length: 8 }, (_, index) => sourceSummary(index)); },
      async read() { throw new Error("not needed by this test"); },
    };
    const ledger = new TeamLedger(
      store,
      new ProposalPolicy({ autoApproveNewTasks: true, autoApproveContext: true, requireReviewForTaskChanges: true }),
      new PostgresContextCompiler(store, sourceDocuments),
      sourceDocuments,
    );
    for (let index = 0; index < 25; index += 1) {
      await ledger.createContextEntry({
        kind: "file",
        path: `/architecture/context-${index}.md`,
        title: `Architecture context ${index}`,
        body: `Accepted architecture detail ${index}. ` + "Evidence-linked design information. ".repeat(42),
      }, "user:reviewer");
    }

    const pack = await ledger.retrieve({
      objective: "Review accepted architecture before changing it",
      characterBudget: 30_000,
      includeSources: true,
    });
    expect(pack.entries.length).toBeGreaterThan(0);
    expect(pack.outline.reduce((count, section) => count + section.entries.length, 0)).toBeGreaterThan(0);
    expect(pack.sources.length).toBeGreaterThan(0);
    expect(pack.sources[0]!.sections.length).toBeLessThanOrEqual(2);
    expect(pack.guide.authority.some((rule) => rule.includes("Ready means assembled, not answered"))).toBe(true);
    expect(renderContextPackMarkdown(pack)).toContain("## Budgeted context catalog");
    expect(pack.citations.map((citation) => citation.entryId)).toEqual(pack.entries.map((entry) => entry.id));
    expect(JSON.stringify(pack).length).toBeLessThanOrEqual(30_000);
    expect(renderContextPackMarkdown(pack).length).toBeLessThanOrEqual(30_000);
  });

  it("does not present broad-query readiness as proof an unknown question is answered", async () => {
    const store = new MemoryLedgerStore();
    const ledger = new TeamLedger(store,
      new ProposalPolicy({ autoApproveNewTasks: true, autoApproveContext: true, requireReviewForTaskChanges: true }));
    await ledger.createContextEntry({
      kind: "fact",
      path: "/decisions/graph-core/edge-propagation",
      title: "Edge propagation decision",
      factType: "decision",
      value: "An uncalibrated causal edge cannot propagate belief.",
    }, "user:reviewer");

    const pack = await ledger.retrieve({ objective: "What is the Quasar payroll key rotation policy?" });
    expect(pack.status).toBe("ready");
    expect(pack.guide.authority.some((rule) => rule.includes("search or abstain"))).toBe(true);
    expect(renderContextPackMarkdown(pack)).toContain("Ready means assembled, not answered");
  });

  it("spends explicit-search budget on accepted detail before optional pointers", async () => {
    const store = new MemoryLedgerStore();
    const sourceDocuments: SourceDocumentReader = {
      async list() { return Array.from({ length: 8 }, (_, index) => sourceSummary(index)); },
      async read() { throw new Error("not needed by this test"); },
    };
    const ledger = new TeamLedger(
      store,
      new ProposalPolicy({ autoApproveNewTasks: true, autoApproveContext: true, requireReviewForTaskChanges: true }),
      new PostgresContextCompiler(store, sourceDocuments),
      sourceDocuments,
    );
    const contract = await ledger.createContextEntry({
      kind: "file", path: "/company/product-contract.md", title: "Accepted source text contract",
      body: "Source text is evidence, not accepted state. " + "Company memory contract detail. ".repeat(560),
    }, "user:reviewer");
    for (let index = 0; index < 20; index += 1) {
      await ledger.createContextEntry({
        kind: "fact", path: `/policies/catalog-${index}`, title: `Catalog ${index}`,
        factType: "policy", value: `Other accepted catalog fact ${index}.`,
      }, "user:reviewer");
    }
    const pack = await ledger.retrieve({
      objective: "What is the accepted source text contract?",
      query: "accepted source text contract",
      characterBudget: 30_000,
      includeSources: true,
    });
    expect(pack.entries.map((entry) => entry.id)).toContain(contract.id);
    expect(JSON.stringify(pack).length).toBeLessThanOrEqual(30_000);
    expect(renderContextPackMarkdown(pack).length).toBeLessThanOrEqual(30_000);
  });
});
