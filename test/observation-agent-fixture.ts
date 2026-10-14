// Existing scripted provider fixtures cover their own tool paths. A completion
// check receives an explicit no-op response; the dedicated completion E2E and
// real-provider runs cover corrections made during that check.
import { ObservationAgent as ProductionObservationAgent } from "../src/intelligence/observation-agent.js";
export class ObservationAgent extends ProductionObservationAgent {
  readonly completionCheckRequests: unknown[];
  constructor(options: ConstructorParameters<typeof ProductionObservationAgent>[0]) {
    const checks: unknown[] = [], scripted = options.fetcher ?? fetch;
    super({ ...options, fetcher: async (input, init) => {
      const request = JSON.parse(String(init?.body));
      const lastUser = request.input?.filter((item: any) => item.role === "user").at(-1);
      let content: any;
      try { content = JSON.parse(lastUser?.content ?? "null"); } catch { content = null; }
      if (content?.kind === "observation_completion_check") {
        checks.push(request);
        return Response.json({ id: `fixture-completion-${checks.length}`, model: options.model,
          status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1 } });
      }
      return scripted(input, init);
    } });
    this.completionCheckRequests = checks;
  }
}
