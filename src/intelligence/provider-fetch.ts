/** Undici reports this timeout before its connection context can write a request.
 * Pinned evidence: nodejs/undici v7.16.0, lib/core/connect.js and lib/dispatcher/client.js.
 * Socket, response, HTTP and usage failures can have an unknown outcome and are not retried.
 */
export async function fetchProvider(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], fetcher: typeof fetch = fetch): Promise<Response> {
  const replayable = (typeof input === "string" || input instanceof URL)
    && (init?.body == null || typeof init.body === "string");
  for (let attempt = 1; ; attempt++) {
    try { return await fetcher(input, init); }
    catch (error) {
      const cause = error instanceof Error ? error.cause : null;
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : null;
      if (!replayable || init?.signal?.aborted || code !== "UND_ERR_CONNECT_TIMEOUT" || attempt >= 3) throw error;
      // No endpoint, credentials, request text or provider response enters the log.
      console.warn(JSON.stringify({ event: "provider_connection_retry", undeliveredAttempt: attempt, reason: "UND_ERR_CONNECT_TIMEOUT" }));
    }
  }
}
