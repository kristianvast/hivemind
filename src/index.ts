import Anthropic from "@anthropic-ai/sdk";
import { WebhookVerificationError, Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

const briefsDb = worker.database("briefs", {
	type: "managed",
	initialTitle: "Briefs",
	primaryKeyProperty: "Name",
	schema: {
		properties: {
			Name: Schema.title(),
			Status: Schema.select([
				{ name: "Backlog", color: "default" },
				{ name: "Triaged", color: "yellow" },
				{ name: "In Progress", color: "blue" },
				{ name: "Needs Review", color: "purple" },
				{ name: "Done", color: "green" },
				{ name: "Failed", color: "red" },
				{ name: "Archived", color: "gray" },
			]),
			Owner: Schema.select([
				{ name: "Triage", color: "gray" },
				{ name: "Scout", color: "blue" },
				{ name: "Forge", color: "orange" },
				{ name: "Scribe", color: "green" },
				{ name: "Sentinel", color: "purple" },
			]),
		},
	},
});

worker.sync("briefsSeed", {
	database: briefsDb,
	mode: "incremental",
	schedule: "manual",
	execute: async () => ({ changes: [], hasMore: false }),
});

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

function extractPageId(body: Record<string, unknown>): string | undefined {
	const data = (body as { data?: Record<string, unknown> }).data;
	for (const candidate of [
		data?.id,
		data?.pageId,
		data?.page_id,
		(data as { page?: { id?: unknown } } | undefined)?.page?.id,
		(body as { pageId?: unknown }).pageId,
		(body as { page_id?: unknown }).page_id,
		(body as { page?: { id?: unknown } }).page?.id,
		(body as { id?: unknown }).id,
	]) {
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
	}
	return undefined;
}

worker.webhook("onBriefStatusChange", {
	title: "On Brief Status Change",
	description:
		"Hit by a Notion DB automation when a brief's Status changes. Verifies X-Hivemind-Secret, posts a 'Hivemind received' comment back to confirm the loop.",
	execute: async (events, { notion }) => {
		for (const event of events) {
			const expectedSecret = process.env.HIVEMIND_WEBHOOK_SECRET;
			const providedSecret =
				event.headers["x-hivemind-secret"] ??
				event.headers["X-Hivemind-Secret"];
			if (!expectedSecret) {
				throw new WebhookVerificationError(
					"HIVEMIND_WEBHOOK_SECRET not configured on the Worker.",
				);
			}
			if (providedSecret !== expectedSecret) {
				throw new WebhookVerificationError(
					"X-Hivemind-Secret header missing or does not match.",
				);
			}

			const body = (event.body ?? {}) as Record<string, unknown>;
			console.log(
				"[onBriefStatusChange] delivery",
				event.deliveryId,
				"body keys:",
				Object.keys(body),
			);

			const pageId = extractPageId(body);
			if (!pageId) {
				console.warn(
					"[onBriefStatusChange] could not extract pageId from body:",
					JSON.stringify(body).slice(0, 500),
				);
				continue;
			}

			await notion.comments.create({
				parent: { page_id: pageId },
				rich_text: [
					{
						type: "text",
						text: {
							content: "🐝 Hivemind received this brief.",
						},
					},
				],
			});

			console.log("[onBriefStatusChange] commented on page", pageId);
		}
	},
});
