import Anthropic from "@anthropic-ai/sdk";
import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

worker.tool("notionWhoAmI", {
	title: "Notion Who Am I",
	description:
		"Smoke test that the Worker can talk to the Notion API via NOTION_API_TOKEN.",
	schema: j.object({}),
	execute: async (_input, { notion }) => {
		const me = await notion.users.me({});
		return {
			id: me.id,
			name: me.name,
			type: me.type,
			workspaceName:
				(me.type === "bot" && me.bot && "workspace_name" in me.bot
					? me.bot.workspace_name
					: null) ?? null,
		};
	},
});

worker.tool("pingClaude", {
	title: "Ping Claude",
	description:
		"Smoke test that the Worker runtime can reach api.anthropic.com and that ANTHROPIC_API_KEY is valid.",
	schema: j.object({
		prompt: j
			.string()
			.describe("A short user message to send to Claude.")
			.nullable(),
	}),
	execute: async (input) => {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) {
			throw new Error(
				"ANTHROPIC_API_KEY is not set. Add it to .env locally and run `ntn workers env push`.",
			);
		}

		const client = new Anthropic({ apiKey });
		const prompt = input.prompt ?? "Say 'hivemind online' and nothing else.";

		const response = await client.messages.create({
			model: "claude-haiku-4-5",
			max_tokens: 64,
			messages: [{ role: "user", content: prompt }],
		});

		const first = response.content[0];
		const text = first && first.type === "text" ? first.text : "(non-text)";

		return {
			model: response.model,
			stop_reason: response.stop_reason,
			text,
		};
	},
});
