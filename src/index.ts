import Anthropic from "@anthropic-ai/sdk";
import { isFullPage } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client";
import { WebhookVerificationError, Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import * as Schema from "@notionhq/workers/schema";
import Pusher from "pusher";

import { acquireChainLock, releaseChainLock } from "./lock";
import { handleBriefApproved, runOrchestratorForBrief } from "./orchestrator";
import { ALL_CATEGORIES, classifyBrief, type Category } from "./classify";
import { getBriefContext } from "./notion";
import { provisionProject } from "./provision";
import { runTriagedRescuePass } from "./rescue";
import { mergeHivemindState, readHivemindState } from "./state";

const worker = new Worker();
export default worker;

const CHAIN_TRIGGER_STATUS = "Triaged";
const APPROVED_STATUS = "Done";
const FORGE_LOCAL_OWNER = "Forge-Local";
const FORGE_LOCAL_TRIGGER_STATUSES = new Set(["Triaged", "Provisioned"]);

let pusherClient: Pusher | null = null;
let pusherWarningLogged = false;

// Managed-database handle required by the Workers sync API. The rescue
// sync writes nothing to it — the orchestrator's real state lives in the
// 🔒 Hivemind internal state toggle on each brief page. We declare a
// single-property schema so the SDK is satisfied and the migration is
// effectively a no-op on every deploy.
const hivemindSystemDb = worker.database("hivemindSystem", {
	type: "managed",
	initialTitle: "Hivemind System",
	primaryKeyProperty: "Name",
	schema: {
		properties: {
			Name: Schema.title(),
		},
	},
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

worker.tool("classifyBrief", {
	title: "Classify Brief",
	description: "Admin/QA: classify a brief title+body into a Category via Haiku.",
	schema: j.object({
		title: j.string(),
		body: j.string().nullable(),
	}),
	execute: async (input) => {
		const category = await classifyBrief({
			title: input.title,
			body: input.body ?? undefined,
		});
		return { category };
	},
});

worker.tool("provisionProject", {
	title: "Provision Project Subtree",
	description:
		"Admin/QA: provision the Notion project subtree for a brief (idempotent). Layout depends on category — writing/quick get an inline answer page (no Drafts DB); others get the full Plan/Drafts/Activity layout. If category is omitted, it's read from the brief's Category property (defaults to 'deep').",
	schema: j.object({
		briefId: j.string(),
		category: j.string().nullable(),
	}),
	execute: async ({ briefId, category }, { notion }) => {
		const page = await notion.pages.retrieve({ page_id: briefId });
		if (!isFullPage(page)) {
			throw new Error(`Brief ${briefId} returned partial response`);
		}
		const title = extractTitle(page);
		const resolved = resolveCategoryArg(category) ?? extractCategory(page) ?? "deep";
		const ids = await provisionProject(notion, briefId, title, resolved);
		return JSON.parse(JSON.stringify(ids));
	},
});

worker.tool("debugState", {
	title: "Debug Hivemind State",
	description: "Admin/QA: read and pretty-print the Hivemind State JSON for a brief.",
	schema: j.object({
		briefId: j.string(),
	}),
	execute: async ({ briefId }, { notion }) => {
		const state = await readHivemindState(notion, briefId);
		return JSON.parse(JSON.stringify(state));
	},
});

worker.tool("runOrchestrator", {
	title: "Run Orchestrator (Admin)",
	description:
		"Admin/QA: invoke the v2 orchestrator directly on a brief, bypassing the webhook (no secret verification, no chain lock, no dedup). Use for local end-to-end testing via `ntn workers exec runOrchestrator --local`. Returns the brief's Status after the run.",
	schema: j.object({
		briefId: j.string(),
	}),
	execute: async ({ briefId }, { notion }) => {
		const page = await notion.pages.retrieve({ page_id: briefId });
		if (!isFullPage(page)) {
			throw new Error(`Brief ${briefId} returned partial response`);
		}
		const brief = await getBriefContext(notion, page);
		await runOrchestratorForBrief({ notion, brief, botUserId: undefined });
		const after = await notion.pages.retrieve({ page_id: briefId });
		const finalStatus =
			isFullPage(after) &&
			after.properties.Status?.type === "select" &&
			after.properties.Status.select
				? after.properties.Status.select.name
				: null;
		return { briefId, finalStatus };
	},
});

function extractTitle(page: PageObjectResponse): string {
	for (const value of Object.values(page.properties)) {
		if (value.type === "title") {
			return value.title.map((rt) => rt.plain_text).join("");
		}
	}
	return "";
}

function extractOwner(page: PageObjectResponse): string | null {
	const owner = page.properties.Owner;
	if (owner?.type !== "select") return null;
	return owner.select?.name ?? null;
}

function extractCategory(page: PageObjectResponse): Category | null {
	const cat = page.properties.Category;
	if (cat?.type !== "select") return null;
	const name = cat.select?.name;
	if (!name) return null;
	return ALL_CATEGORIES.includes(name as Category) ? (name as Category) : null;
}

function resolveCategoryArg(arg: string | null | undefined): Category | null {
	if (!arg) return null;
	return ALL_CATEGORIES.includes(arg as Category) ? (arg as Category) : null;
}

async function pusherPublish(briefId: string): Promise<void> {
	const appId = process.env.PUSHER_APP_ID;
	const key = process.env.PUSHER_KEY;
	const secret = process.env.PUSHER_SECRET;
	const cluster = process.env.PUSHER_CLUSTER;
	if (!appId || !key || !secret || !cluster) {
		if (!pusherWarningLogged) {
			console.warn(
				"[pusherPublish] PUSHER_APP_ID/PUSHER_KEY/PUSHER_SECRET/PUSHER_CLUSTER not fully configured; skipping Anvil dispatch publish.",
			);
			pusherWarningLogged = true;
		}
		return;
	}

	try {
		if (!pusherClient) {
			pusherClient = new Pusher({
				appId,
				key,
				secret,
				cluster,
				useTLS: true,
			});
		}
		await pusherClient.trigger(
			process.env.PUSHER_CHANNEL ?? "anvil-dispatch",
			"brief.dispatched",
			{ briefId },
		);
	} catch (err) {
		console.warn("[pusherPublish] failed to publish Anvil dispatch:", err);
	}
}

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
		"Hit by a Notion DB automation when a brief's Status changes. Verifies X-Hivemind-Secret, dedups by deliveryId via Hivemind State, skips trashed pages and bot-authored edits (loop prevention). When status flips to 'Triaged', runs Scout then Forge and appends their outputs to the brief page; on chain failure the brief is set to 'Failed' with the trace appended.",
	execute: async (events, { notion }) => {
		for (const event of events) {
			// 1. Verify secret
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

			// 2. Extract pageId
			const body = (event.body ?? {}) as Record<string, unknown>;
			const pageId = extractPageId(body);
			if (!pageId) {
				console.warn(
					"[onBriefStatusChange] could not extract pageId from body:",
					JSON.stringify(body).slice(0, 500),
				);
				continue;
			}

			// 3. Dedup via state
			const prior = await readHivemindState(notion, pageId);
			if (prior.lastDeliveryId === event.deliveryId) {
				console.log(
					"[onBriefStatusChange] skip duplicate delivery",
					event.deliveryId,
				);
				continue;
			}

			console.log(
				"[onBriefStatusChange] delivery",
				event.deliveryId,
				"page",
				pageId,
			);

			// 4. Retrieve page, filter trash + partial
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
			const editorId = page.last_edited_by?.id;
			if (botUserId && editorId === botUserId) {
				console.log(
					"[onBriefStatusChange] bot-authored edit, skipping:",
					pageId,
					"editor=",
					editorId,
				);
				await mergeHivemindState(notion, pageId, {
					lastDeliveryId: event.deliveryId,
				});
				continue;
			}

			const brief = await getBriefContext(notion, page);
			const owner = extractOwner(page);
			console.log(
				"[onBriefStatusChange] page",
				pageId,
				"status=",
				brief.status,
				"owner=",
				owner,
				"title=",
				brief.title.slice(0, 80),
			);

			// 6. Route by status
			if (
				owner === FORGE_LOCAL_OWNER &&
				brief.status !== null &&
				FORGE_LOCAL_TRIGGER_STATUSES.has(brief.status)
			) {
				await pusherPublish(pageId);
				console.log("[onBriefStatusChange] dispatched Forge-Local", pageId);
				await mergeHivemindState(notion, pageId, { lastDeliveryId: event.deliveryId });
			} else if (brief.status === APPROVED_STATUS) {
				await handleBriefApproved(notion, pageId);
				console.log("[onBriefStatusChange] approved", pageId);
				await mergeHivemindState(notion, pageId, { lastDeliveryId: event.deliveryId });
			} else if (brief.status === CHAIN_TRIGGER_STATUS) {
				const acquired = await acquireChainLock({
					notion,
					pageId,
					deliveryId: event.deliveryId,
				});
				if (!acquired) {
					await mergeHivemindState(notion, pageId, { lastDeliveryId: event.deliveryId });
					continue;
				}
				try {
					const result = await runOrchestratorForBrief({ notion, brief, botUserId });
					if (result.ok) {
						console.log("[onBriefStatusChange] orchestrator complete for", pageId);
					} else {
						console.error(
							"[onBriefStatusChange] orchestrator failed for",
							pageId,
							"stage=",
							result.stage,
							"error=",
							result.error,
						);
					}
				} finally {
					await releaseChainLock({ notion, pageId });
					await mergeHivemindState(notion, pageId, {
						lastDeliveryId: event.deliveryId,
					});
				}
			} else {
				console.log(
					"[onBriefStatusChange] status is not",
					CHAIN_TRIGGER_STATUS,
					"or",
					APPROVED_STATUS,
					"— no chain to run",
				);
				await mergeHivemindState(notion, pageId, { lastDeliveryId: event.deliveryId });
			}
		}
	},
});

// triagedRescue — scheduled backstop for `onBriefStatusChange`. The webhook
// is the primary trigger but shares a per-capability delivery budget; a
// burst (e.g. a mis-scoped Notion automation firing on every property
// change) can exhaust that budget and lock the webhook out for ~30 min.
// This sync runs on its OWN per-capability budget every 2 minutes, queries
// the Briefs DS for Status=Triaged, acquires the same chain lock as the
// webhook, and dispatches the orchestrator on whatever the webhook missed.
// See AGENTS.md §"Rate-limit defenses for onBriefStatusChange".
worker.sync("triagedRescue", {
	database: hivemindSystemDb,
	mode: "incremental",
	schedule: "2m",
	execute: async (_state, { notion }) => {
		const dataSourceId = process.env.HIVEMIND_BRIEFS_DATA_SOURCE_ID;
		if (!dataSourceId) {
			console.warn(
				"[triagedRescue] HIVEMIND_BRIEFS_DATA_SOURCE_ID not set; skipping pass.",
			);
			return { changes: [], hasMore: false };
		}
		const botUserId = process.env.HIVEMIND_BOT_USER_ID;
		await runTriagedRescuePass({ notion, dataSourceId, botUserId });
		return { changes: [], hasMore: false };
	},
});

worker.tool("runRescueSweep", {
	title: "Run Rescue Sweep (Admin)",
	description:
		"Admin/QA: manually invoke the `triagedRescue` sweep right now. Returns the same counts the scheduled sync logs (scanned/acquired/processed/skipped/errors). Useful for testing without waiting for the next 2-minute tick.",
	schema: j.object({}),
	execute: async (_input, { notion }) => {
		const dataSourceId = process.env.HIVEMIND_BRIEFS_DATA_SOURCE_ID;
		if (!dataSourceId) {
			throw new Error(
				"HIVEMIND_BRIEFS_DATA_SOURCE_ID is not set. Add it to .env locally and run `ntn workers env push`.",
			);
		}
		const botUserId = process.env.HIVEMIND_BOT_USER_ID;
		const result = await runTriagedRescuePass({ notion, dataSourceId, botUserId });
		return JSON.parse(JSON.stringify(result));
	},
});
