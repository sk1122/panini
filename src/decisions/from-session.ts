import { z } from "zod";

/*
 * Decisions an agent made during a session, read from its conversation by the
 * workspace's model. The model is asked only for choices the agent made, and
 * whether the person asked for each one.
 */

const extracted = z.object({
	decisions: z.array(
		z.object({
			title: z.string(),
			statement: z.string(),
			reason: z.string(),
			alternatives: z.array(z.string()),
			askedByUser: z.boolean(),
			quote: z.string(),
			category: z.enum([
				"Approach",
				"Scope",
				"Dependency",
				"Tests",
				"Data",
				"Security",
				"Other",
			]),
		}),
	),
});

export type SessionDecision = z.infer<typeof extracted>["decisions"][number];

const instructions = `You read one coding-agent session and list the decisions the AGENT made.

A decision is a choice between real options that changes what gets built or how: picking a library or approach, changing or cutting scope, skipping or weakening a test or check, changing data or schema, working around a problem instead of fixing it, or doing something different from what was asked.

Not decisions: routine steps (reading files, running tests, formatting), facts the agent reported, questions it asked, and anything it only suggested but did not do.

For each decision:
- title: at most 10 words, starting with a verb in the past tense ("Used Redis for the retry queue").
- statement: one or two sentences saying what was chosen.
- reason: the agent's stated reason, or "" if it gave none.
- alternatives: options it considered and did not choose; [] if none were mentioned.
- askedByUser: true only if the person explicitly told the agent to do this. If the agent chose it on its own, false.
- quote: a short exact quote from the session that shows the decision.
- category: the closest one.

List at most 8, most important first. If there are none, return an empty list. Do not invent decisions.`;

export async function extractSessionDecisions(input: {
	transcript: string;
	model: string;
	apiKey: string;
	fetcher: typeof fetch;
	baseUrl?: string;
}): Promise<{
	decisions: SessionDecision[];
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
}> {
	const { $schema: _schema, ...schema } = z.toJSONSchema(extracted);
	const response = await input.fetcher(
		`${(input.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/responses`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${input.apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: input.model,
				store: false,
				instructions,
				input: [{ role: "user", content: input.transcript }],
				text: {
					format: {
						type: "json_schema",
						name: "session_decisions",
						strict: true,
						schema,
					},
				},
				reasoning: { effort: "low" },
				max_output_tokens: 3000,
			}),
			signal: AbortSignal.timeout(120_000),
		},
	);

	if (!response.ok)
		throw new Error(`Decision extraction provider HTTP ${response.status}`);

	const data = (await response.json()) as {
		output?: {
			type: string;
			content?: { type: string; text?: string }[];
		}[];
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			input_tokens_details?: { cached_tokens?: number };
		};
	};
	const text = (data.output ?? [])
		.filter((item) => item.type === "message")
		.flatMap((item) => item.content ?? [])
		.map((part) => part.text ?? "")
		.join("");

	return {
		decisions: extracted.parse(JSON.parse(text)).decisions.slice(0, 8),
		inputTokens: data.usage?.input_tokens ?? 0,
		cachedInputTokens: data.usage?.input_tokens_details?.cached_tokens ?? 0,
		outputTokens: data.usage?.output_tokens ?? 0,
	};
}
