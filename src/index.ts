import Anthropic from "@anthropic-ai/sdk";
import { isFullPage } from "@notionhq/client";
import { WebhookVerificationError, Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

import { handleBriefApproved, runChainForBrief } from "./chain";
import { getBriefContext } from "./notion";

const worker = new Worker();
export default worker;

const CHAIN_TRIGGER_STATUS = "Triaged";
const APPROVED_STATUS = "Done";

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

const PROCESSED_DELIVERY_IDS = new Set<string>();
const DEDUP_CACHE_MAX = 500;

function rememberDelivery(deliveryId: string): void {
	PROCESSED_DELIVERY_IDS.add(deliveryId);
	if (PROCESSED_DELIVERY_IDS.size > DEDUP_CACHE_MAX) {
		const keep = Array.from(PROCESSED_DELIVERY_IDS).slice(
			-Math.floor(DEDUP_CACHE_MAX / 2),
		);
		PROCESSED_DELIVERY_IDS.clear();
		for (const id of keep) PROCESSED_DELIVERY_IDS.add(id);
	}
}

worker.webhook("onBriefStatusChange", {
	title: "On Brief Status Change",
	description:
		"Hit by a Notion DB automation when a brief's Status changes. Verifies X-Hivemind-Secret, dedups by deliveryId, skips trashed pages and bot-authored edits (loop prevention). When status flips to 'Triaged', runs Scout then Forge and appends their outputs to the brief page; on chain failure the brief is set to 'Failed' with the trace appended.",
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

			if (PROCESSED_DELIVERY_IDS.has(event.deliveryId)) {
				console.log(
					"[onBriefStatusChange] skip duplicate delivery",
					event.deliveryId,
				);
				continue;
			}
			rememberDelivery(event.deliveryId);

			const body = (event.body ?? {}) as Record<string, unknown>;
			const pageId = extractPageId(body);
			if (!pageId) {
				console.warn(
					"[onBriefStatusChange] could not extract pageId from body:",
					JSON.stringify(body).slice(0, 500),
				);
				continue;
			}
			console.log(
				"[onBriefStatusChange] delivery",
				event.deliveryId,
				"page",
				pageId,
			);

			let page: Awaited<ReturnType<typeof notion.pages.retrieve>>;
			try {
				page = await notion.pages.retrieve({ page_id: pageId });
			} catch (err: unknown) {
				const code =
					err && typeof err === "object" && "code" in err
						? (err as { code?: string }).code
						: undefined;
				if (code === "object_not_found" || code === "validation_error") {
					console.log(
						"[onBriefStatusChange] page inaccessible (probably trashed):",
						pageId,
						code,
					);
					continue;
				}
				throw err;
			}

			if (!isFullPage(page)) {
				console.warn(
					"[onBriefStatusChange] partial page response, skipping:",
					pageId,
				);
				continue;
			}

			if (page.in_trash) {
				console.log("[onBriefStatusChange] trashed, skipping:", pageId);
				continue;
			}

			const botUserId = process.env.HIVEMIND_BOT_USER_ID;
			const brief = await getBriefContext(notion, page);
			console.log(
				"[onBriefStatusChange] page",
				pageId,
				"status=",
				brief.status,
				"title=",
				brief.title.slice(0, 80),
			);

			if (brief.status === APPROVED_STATUS) {
				await handleBriefApproved(notion, pageId);
				console.log("[onBriefStatusChange] approved", pageId);
				continue;
			}

			if (brief.status !== CHAIN_TRIGGER_STATUS) {
				console.log(
					"[onBriefStatusChange] status is not",
					CHAIN_TRIGGER_STATUS,
					"or",
					APPROVED_STATUS,
					"— no chain to run",
				);
				continue;
			}

			await runChainForBrief({ notion, brief, botUserId });
			console.log("[onBriefStatusChange] chain complete for", pageId);
		}
	},
});
