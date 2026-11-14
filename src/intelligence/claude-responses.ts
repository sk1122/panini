import Anthropic from "@anthropic-ai/sdk";

/*
 * Lets the nightly run use Claude. The observation agent and work assessments
 * speak the OpenAI Responses format; this fetcher turns each `/responses`
 * request into a Claude Messages call (official SDK) and turns the reply back
 * into the Responses shape they already parse. Their tool loop, budgets and
 * call log stay unchanged.
 */

export const isClaudeModel = (model: string | null | undefined) =>
	Boolean(model?.startsWith("claude-"));

type Item = Record<string, any>;

/** Claude blocks the Responses shape has no slot for (thinking), kept verbatim. */
const CLAUDE_BLOCK = "claude_block";

function toMessages(input: Item[]): Anthropic.MessageParam[] {
	const messages: Anthropic.MessageParam[] = [];

	const push = (
		role: "user" | "assistant",
		block: Anthropic.ContentBlockParam,
	) => {
		const last = messages.at(-1);

		if (last?.role === role && Array.isArray(last.content))
			last.content.push(block);
		else messages.push({ role, content: [block] });
	};

	for (const item of input) {
		if (item.type === CLAUDE_BLOCK) push("assistant", item.block);
		else if (item.type === "function_call")
			push("assistant", {
				type: "tool_use",
				id: item.call_id,
				name: item.name,
				input: JSON.parse(item.arguments || "{}"),
			});
		else if (item.type === "function_call_output")
			push("user", {
				type: "tool_result",
				tool_use_id: item.call_id,
				content:
					typeof item.output === "string"
						? item.output
						: JSON.stringify(item.output),
			});
		else if (item.type === "message" || item.role) {
			const role = item.role === "assistant" ? "assistant" : "user";
			const parts =
				typeof item.content === "string"
					? [item.content]
					: (item.content ?? []).map((part: Item) => part.text ?? "");

			for (const text of parts)
				if (text) push(role, { type: "text", text });
		}
	}
	return messages;
}

/*
 * Claude's strict schemas reject bound keywords (minimum, maxLength, ...).
 * Panini validates every tool argument itself after the call, so dropping
 * them here loses no checking.
 */
const unsupported = new Set([
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
]);

function claudeSchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(claudeSchema);
	if (!node || typeof node !== "object") return node;
	return Object.fromEntries(
		Object.entries(node)
			.filter(([key]) => !unsupported.has(key))
			.map(([key, value]) => [
				key,
				// Property names are data, not keywords: keep them all.
				key === "properties"
					? Object.fromEntries(
							Object.entries(value as Item).map(
								([name, child]) => [name, claudeSchema(child)],
							),
						)
					: claudeSchema(value),
			]),
	);
}

function toRequest(body: Item): Anthropic.MessageCreateParamsNonStreaming {
	const format = body.text?.format;
	const tools: Anthropic.Tool[] | undefined = body.tools?.map(
		(tool: Item) => ({
			name: tool.name,
			description: tool.description,
			// Not strict: Panini's tools exceed Claude's strict-mode limit on
			// optional fields, and Panini validates every argument itself.
			input_schema: claudeSchema(tool.parameters),
		}),
	);

	return {
		model: body.model,
		// Thinking counts toward max_tokens, so leave room above the old cap.
		max_tokens: Math.max(16_000, (body.max_output_tokens ?? 0) * 2),
		system: body.instructions,
		messages: toMessages(body.input ?? []),
		cache_control: { type: "ephemeral" },
		output_config: {
			effort: body.reasoning?.effort ?? "medium",
			...(format?.type === "json_schema"
				? {
						format: {
							type: "json_schema",
							schema: claudeSchema(format.schema),
						},
					}
				: {}),
		},
		...(tools?.length
			? {
					tools,
					tool_choice: {
						type: "auto",
						disable_parallel_tool_use:
							body.parallel_tool_calls === false,
					},
				}
			: {}),
	} as Anthropic.MessageCreateParamsNonStreaming;
}

function toResponses(message: Anthropic.Message): Item {
	const output: Item[] = message.content.map((block) => {
		if (block.type === "text")
			return {
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: block.text }],
			};
		if (block.type === "tool_use")
			return {
				type: "function_call",
				call_id: block.id,
				name: block.name,
				arguments: JSON.stringify(block.input),
			};
		return { type: CLAUDE_BLOCK, block };
	});
	const usage = message.usage;
	const cached = usage.cache_read_input_tokens ?? 0;

	return {
		id: message.id,
		model: message.model,
		status: ["end_turn", "tool_use"].includes(message.stop_reason ?? "")
			? "completed"
			: "incomplete",
		stop_reason: message.stop_reason,
		output,
		usage: {
			input_tokens:
				usage.input_tokens +
				cached +
				(usage.cache_creation_input_tokens ?? 0),
			output_tokens: usage.output_tokens,
			input_tokens_details: { cached_tokens: cached },
		},
	};
}

/** A fetch that answers `/responses` requests with Claude. */
export function claudeFetcher(apiKey: string): typeof fetch {
	const client = new Anthropic({ apiKey });

	return async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);

		if (!url.endsWith("/responses"))
			throw new Error(`Claude adapter cannot serve ${url}`);

		try {
			const message = await client.messages.create(
				toRequest(JSON.parse(String(init?.body ?? "{}"))),
				{ signal: init?.signal ?? undefined },
			);

			return Response.json(toResponses(message));
		} catch (error) {
			if (error instanceof Anthropic.APIError)
				return Response.json(
					{ error: { type: error.name, message: error.message } },
					{ status: error.status ?? 502 },
				);
			throw error;
		}
	};
}
