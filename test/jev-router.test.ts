import { describe, expect, it } from "vitest";
import type { SourceEvent } from "../src/domain/types.js";
import { JevObservationRouter } from "../src/intelligence/jev-router.js";

function event(id: string, visibility = "company"): SourceEvent {
  return {
    id,
    provider: "slack",
    installationKey: "test",
    providerEventId: id,
    eventKind: "message.observed",
    occurredAt: "2026-09-21T08:00:00.000Z",
    fetchedAt: "2026-09-21T08:00:01.000Z",
    receivedAt: "2026-09-21T08:00:02.000Z",
    sourceRef: `slack:${id}`,
    sourceUrl: null,
    contentHash: id,
    visibility,
    payloadVersion: "test",
    payload: { text: "Rina owns the launch task and the release policy changed." },
  };
}

describe("JevObservationRouter", () => {
  it("maps each approved observation to one routing choice", async () => {
    let request: Record<string, unknown> | null = null;
    const router = new JevObservationRouter({
      apiKey: "test-key",
      allowedVisibilities: ["company"],
      fetcher: (async (_url, init) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          answers: {
            observation_0: { type: "choice", choice: "both", confidence: 0.96 },
            observation_1: { type: "choice", choice: "neither", confidence: 0.82 },
          },
        }));
      }) as typeof fetch,
    });

    await expect(router.route([event("one"), event("two")])).resolves.toEqual([
      { eventId: "one", route: "both", confidence: 0.96 },
      { eventId: "two", route: "neither", confidence: 0.82 },
    ]);
    expect(request).toMatchObject({ model: "typesafe/jev-1.13" });
  });

  it("refuses observations outside the explicit external-model allowlist", async () => {
    const router = new JevObservationRouter({ apiKey: "test-key", allowedVisibilities: ["company"] });
    await expect(router.route([event("private", "private")])).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
