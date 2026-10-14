import { describe, expect, it } from "vitest";
import type { SourceEventInput } from "../src/domain/types.js";
import { LedgerSourceDocumentLibrary, sourceDocumentSections } from "../src/retrieval/source-document-library.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

function documentEvent(markdown: string, suggestedPath = "/architecture/system.md"): SourceEventInput {
  return {
    provider: "notion",
    installationKey: "workspace",
    providerEventId: "architecture-v1",
    eventKind: "source.document.retrieved",
    occurredAt: "2026-09-16T08:00:00.000Z",
    fetchedAt: "2026-09-16T08:00:01.000Z",
    sourceRef: "notion:architecture",
    sourceUrl: "https://notion.example/architecture",
    contentHash: "architecture-hash",
    visibility: "company",
    payloadVersion: "test",
    payload: {
      document: {
        title: "System architecture",
        suggestedPath,
        markdown,
      },
    },
  };
}

describe("source document library", () => {
  it("creates deterministic section paths and line ranges", () => {
    const sections = sourceDocumentSections([
      "Preface.",
      "",
      "# Architecture",
      "System overview.",
      "## Ingress",
      "Webhook details.",
      "## Ingress",
      "Polling details.",
    ].join("\n"));

    expect(sections).toMatchObject([
      { id: "overview", heading: "Overview", startLine: 1, endLine: 2 },
      { id: "architecture", headingPath: ["Architecture"], startLine: 3, endLine: 8 },
      { id: "architecture-ingress", headingPath: ["Architecture", "Ingress"], startLine: 5, endLine: 6 },
      { id: "architecture-ingress-2", headingPath: ["Architecture", "Ingress"], startLine: 7, endLine: 8 },
    ]);
  });

  it("lists summaries, reads a selected section, and fails closed after revocation", async () => {
    const store = new MemoryLedgerStore();
    const event = (await store.appendSourceEvent(documentEvent([
      "# Architecture",
      "Overview.",
      "## Trust boundary",
      "Sources are evidence, not accepted state.",
      "## Retrieval",
      "Read only the required section.",
    ].join("\n"), "/sources/notion/system.md"))).event;
    const library = new LedgerSourceDocumentLibrary(store);

    const summaries = await library.list({ query: "trust boundary" });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      sourceEventId: event.id,
      sourcePath: "source://notion/system.md",
      matchedSectionIds: expect.arrayContaining(["architecture-trust-boundary"]),
    });

    const read = await library.read({ sourceEventId: event.id, sectionId: "architecture-trust-boundary" });
    expect(read.section?.heading).toBe("Trust boundary");
    expect(read.markdown).toContain("Sources are evidence");
    expect(read.markdown).not.toContain("Read only the required section");
    expect(read.authority[0]).toContain("untrusted source evidence");

    await store.revokeSourceEvent(event.id);
    await expect(library.read({ sourceEventId: event.id })).rejects.toThrow("no longer available");
    expect(await library.list()).toEqual([]);
  });

  it("lists and reads captured Slack messages as pinned untrusted evidence", async () => {
    const store = new MemoryLedgerStore();
    const event = (await store.appendSourceEvent({
      provider: "slack",
      installationKey: "workspace",
      providerEventId: "slack-message-1",
      eventKind: "message.explicitly_captured",
      occurredAt: "2026-09-16T08:00:00.000Z",
      fetchedAt: "2026-09-16T08:00:01.000Z",
      sourceRef: "slack:T1:C1:1789500000.1",
      sourceUrl: "https://slack.example/message",
      contentHash: "slack-message-hash",
      visibility: "slack:channel:C1",
      payloadVersion: "slack-reaction-capture-v1",
      payload: {
        channel: "C1",
        messageTs: "1789500000.1",
        messageUserDisplayName: "Mira",
        text: "Release is blocked until the production credential is rotated.",
      },
    })).event;
    const library = new LedgerSourceDocumentLibrary(store);
    const access = {
      kind: "agent" as const,
      organizationId: "00000000-0000-4000-8000-000000000001",
      memberId: "00000000-0000-4000-8000-000000000002",
      agentProfileId: "00000000-0000-4000-8000-000000000003",
      dataScope: { projects: [], contextPaths: ["/"], sourceVisibilities: ["slack:channel:C1"] },
    };

    expect(await library.list({ query: "production credential", access })).toEqual([
      expect.objectContaining({ sourceEventId: event.id, provider: "slack", visibility: "slack:channel:C1" }),
    ]);
    const read = await library.read({ sourceEventId: event.id, access });
    expect(read.markdown).toContain("Release is blocked");
    expect(read.markdown).toContain("Mira");
    expect(read.authority[0]).toContain("untrusted source evidence");
  });
});
