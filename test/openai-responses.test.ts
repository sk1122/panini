import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIResponsesInterpreter } from "../src/intelligence/openai-responses.js";
import { OpenAIResponsesAdjudicator } from "../src/adjudication/openai-responses.js";
import { interpretationJsonSchemaFor } from "../src/intelligence/schema.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAIResponsesInterpreter", () => {
  it("constrains citations, task IDs, and owners to the supplied input", () => {
    const schema = interpretationJsonSchemaFor({
      evidenceEventIds: ["00000000-0000-4000-8000-000000000020"],
      taskIds: ["00000000-0000-4000-8000-000000000021"],
      activeMemberNames: ["Rina"],
    });
    const properties = schema.properties.findings.items.properties;
    expect(properties.evidenceEventIds).toMatchObject({
      maxItems: 1,
      items: { enum: ["00000000-0000-4000-8000-000000000020"] },
    });
    expect(properties.taskId.enum).toEqual(["00000000-0000-4000-8000-000000000021", null]);
    expect(properties.owner.enum).toEqual(["Rina", null]);
  });

  it("uses strict, non-stored structured output and validates the response", async () => {
    const output = {
      summary: "No supported work-state change.",
      findings: [{
        kind: "abstain", taskId: null, title: null, description: null, status: null, priority: null,
        owner: null, project: null, projectId: null, projectOutcome: null, dueDate: null, dependencyRefs: [], contextPath: null,
        contextTitle: null, contextBody: null, contextFactType: null, contextFactValue: null,
        rationale: "The event is only activity.", confidence: 0.9,
        evidenceEventIds: [], caveats: ["No delivery evidence."],
      }],
    };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(output) }] }],
      usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 400 }, output_tokens: 180 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const interpreter = new OpenAIResponsesInterpreter({ apiKey: "test-key", model: "test-model" });

    await expect(interpreter.interpret({ companyName: "Example", members: [], tasks: [], context: [], events: [] })).resolves.toEqual({
      ...output,
      findings: output.findings.map((finding) => ({ ...finding,
        duplicateOfTaskId: null, projectStatus: null })),
      usage: { inputTokens: 1200, cachedInputTokens: 400, outputTokens: 180 },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: "test-model", store: false, text: { format: { type: "json_schema", strict: true } } });
    expect(body.instructions).toContain("consider both work and durable company information");
    expect(body.instructions).toContain("matches an existing Task or Project");
    expect(body.instructions).toContain("primary Mermaid or ASCII architecture diagram");
    expect(body.instructions).toContain("remaining work, not completion");
    expect(body.instructions).toContain("do not require a special Markdown template");
    expect(body.instructions).toContain("exact active member displayName");
  });
});

describe("OpenAIResponsesAdjudicator", () => {
  it("uses strict, non-stored structured output and preserves the supplied proposal IDs", async () => {
    const proposalId = "11111111-1111-4111-8111-111111111111";
    const output = { decisions: [{
      proposalId,
      action: "reject",
      confidence: 0.91,
      rationale: "The evidence does not support the requested change.",
      temporalBasis: "The claim predates the current accepted revision.",
      historicalBasis: ["Accepted revision 2 is supported by later evidence."],
    }] };
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify(output) }] }],
      usage: { input_tokens: 800, input_tokens_details: { cached_tokens: 200 }, output_tokens: 120 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const adjudicator = new OpenAIResponsesAdjudicator({ apiKey: "test-key", model: "test-model" });

    await expect(adjudicator.adjudicate({
      companyName: "Example",
      adjudicatedAt: "2026-09-16T00:00:00.000Z",
      evidence: [],
      cases: [{
        proposal: {
          id: proposalId, kind: "task_change", taskId: proposalId, baseVersion: 1,
          changes: { status: "blocked" }, rationale: "Blocked.", requestedBy: "agent:test",
          evidenceIds: [], createdAt: "2026-09-16T00:00:00.000Z",
        },
        targetKey: `task:${proposalId}`,
        staleBase: false,
        currentTarget: null,
        acceptedHistory: [],
        relatedProposals: [],
        candidateEvidenceOccurredAt: { earliest: null, latest: null },
        currentEvidenceOccurredAt: null,
      }],
    })).resolves.toEqual({
      ...output,
      usage: { inputTokens: 800, cachedInputTokens: 200, outputTokens: 120 },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: "test-model", store: false, text: { format: { type: "json_schema", strict: true } } });
  });
});
