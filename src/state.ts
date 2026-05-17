// Hivemind orchestrator state is persisted to a collapsed toggle on the brief
// page, not to a database property. We hit this once per webhook to dedup
// deliveries, once per provision step, and a handful of times per agent. The
// property-on-the-brief approach worked but Notion's page detail panel ignores
// per-view property visibility, so the raw state JSON dominated the human-
// facing UI. A toggle block hides cleanly behind a single collapsed line at
// the end of the brief — clickable for debugging, invisible by default.
//
// Layout on the brief page:
//   …user-authored brief content…
//   📁 {provisioned project link}
//   ▸ 🔒 Hivemind internal state (do not edit)
//       ```json
//       { …state… }
//       ```
//
// Concurrency: the chainRunning lock + sequential agent execution mean state
// writes for a single brief are serialized in practice. Still, on the very
// first write we walk the page; if two writers race we may create two toggle
// blocks. The reader picks the first match, so subsequent updates converge on
// one block while the orphan stays empty.

import type { Client } from "@notionhq/client";

import { code, toggle } from "./notion";

export interface DbIds {
	dbId: string;
	dsId: string;
}

export interface HivemindState {
	lastDeliveryId?: string;
	// Set when a webhook delivery acquires the in-flight chain lock; cleared
	// in chain.ts finally block. `startedAt` is an ISO8601 string; a lock
	// older than CHAIN_LOCK_TTL_MS (in index.ts) is treated as stale and
	// auto-released by the next delivery.
	chainRunning?: {
		startedAt: string;
		deliveryId: string;
	};
	// ISO8601 timestamp of the most recent chain-lock acquisition for this
	// brief. Unlike `chainRunning`, this is *not* cleared when the chain
	// finishes — it is consulted by `acquireChainLock` to coalesce duplicate
	// or rapidly-fired Triaged webhooks within CHAIN_COALESCE_MS. Legitimate
	// retries (Triaged → Needs Review → Triaged) happen on a human timescale
	// well past the coalesce window, so this only filters burst noise.
	lastChainStartedAt?: string;
	projectRootId?: string;
	planPageId?: string;
	activityPageId?: string;
	// ID of the "📄 Answer" heading block on the project root, used for the
	// "writing"/"quick" categories where the agent writes prose directly onto
	// the root page (no Drafts DB). Content is inserted *after* this anchor so
	// it lands above the Plan/Activity navigation child_page blocks. Absent
	// for categories that use the Drafts DB path. See provision.ts.
	answerAnchorBlockId?: string;
	// Drafts is omitted for "writing"/"quick" briefs; those answers live on the
	// project root. Sources/Decisions/Open Questions are lightweight evidence
	// databases for every brief that has a Plan page. Activity remains a
	// chronological page-based log. See provision.ts.
	dsIds?: {
		drafts?: DbIds;
		sources?: DbIds;
		decisions?: DbIds;
		openQuestions?: DbIds;
		runs?: DbIds;
	};
	tokensUsed?: number;
	budgetCircuitTripped?: boolean;
}

// Used to find the state toggle on the brief page. The "do not edit" suffix is
// a hint to the user — if they delete it anyway, the next write recreates it.
const STATE_TOGGLE_TITLE = "🔒 Hivemind internal state (do not edit)";
const STATE_CODE_LANGUAGE = "json";

// Caches the inner code-block ID per brief so subsequent writes within the
// same Workers isolate skip the block-walk. Stale entries (block deleted by a
// user) are detected on update and the search falls through.
const codeBlockIdCache = new Map<string, string>();

async function findStateCodeBlockId(
	notion: Client,
	briefId: string,
): Promise<string | null> {
	const cached = codeBlockIdCache.get(briefId);
	if (cached) return cached;

	let cursor: string | undefined;
	do {
		const res = await notion.blocks.children.list({
			block_id: briefId,
			start_cursor: cursor,
			page_size: 100,
		});
		for (const block of res.results) {
			if (!("type" in block)) continue;
			if (block.type !== "toggle") continue;
			const title = block.toggle.rich_text
				.map((rt) => rt.plain_text)
				.join("")
				.trim();
			if (title !== STATE_TOGGLE_TITLE) continue;

			const inner = await notion.blocks.children.list({
				block_id: block.id,
				page_size: 10,
			});
			for (const child of inner.results) {
				if (!("type" in child)) continue;
				if (child.type !== "code") continue;
				codeBlockIdCache.set(briefId, child.id);
				return child.id;
			}
		}
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);

	return null;
}

function readCodeBlockText(block: unknown): string {
	if (!block || typeof block !== "object") return "";
	const typed = block as { type?: string; code?: { rich_text?: { plain_text: string }[] } };
	if (typed.type !== "code" || !typed.code?.rich_text) return "";
	return typed.code.rich_text.map((rt) => rt.plain_text).join("");
}

export async function readHivemindState(
	notion: Client,
	briefId: string,
): Promise<HivemindState> {
	try {
		const codeBlockId = await findStateCodeBlockId(notion, briefId);
		if (!codeBlockId) return {};
		const block = await notion.blocks.retrieve({ block_id: codeBlockId });
		const raw = readCodeBlockText(block).trim();
		if (!raw) return {};
		return JSON.parse(raw) as HivemindState;
	} catch {
		return {};
	}
}

export async function writeHivemindState(
	notion: Client,
	briefId: string,
	state: HivemindState,
): Promise<void> {
	const serialized = JSON.stringify(state, null, 2);

	const codeBlockId = await findStateCodeBlockId(notion, briefId);
	if (codeBlockId) {
		try {
			await notion.blocks.update({
				block_id: codeBlockId,
				code: {
					rich_text: codeRichText(serialized),
					language: STATE_CODE_LANGUAGE as never,
				},
			});
			return;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			// Block was deleted out from under us (e.g. user nuked the toggle).
			// Fall through and recreate from scratch.
			if (!msg.includes("Could not find block") && !msg.includes("not found")) {
				throw err;
			}
			codeBlockIdCache.delete(briefId);
		}
	}

	const appended = await notion.blocks.children.append({
		block_id: briefId,
		children: [
			toggle(STATE_TOGGLE_TITLE, [code(serialized, STATE_CODE_LANGUAGE)]),
		],
	});

	// Cache the new code block's ID so the next write is a single-call update.
	const toggleBlock = appended.results[0];
	if (toggleBlock && "id" in toggleBlock) {
		try {
			const innerRes = await notion.blocks.children.list({
				block_id: toggleBlock.id,
				page_size: 5,
			});
			for (const child of innerRes.results) {
				if ("type" in child && child.type === "code") {
					codeBlockIdCache.set(briefId, child.id);
					break;
				}
			}
		} catch {
			// Non-fatal: next read will re-walk and re-cache.
		}
	}
}

export async function mergeHivemindState(
	notion: Client,
	briefId: string,
	patch: Partial<HivemindState>,
): Promise<HivemindState> {
	const current = await readHivemindState(notion, briefId);
	const merged: HivemindState = { ...current, ...patch };
	await writeHivemindState(notion, briefId, merged);
	return merged;
}

const RICH_TEXT_CHUNK = 1900;

function codeRichText(
	text: string,
): { type: "text"; text: { content: string } }[] {
	if (text.length === 0) {
		return [{ type: "text", text: { content: "" } }];
	}
	const chunks: string[] = [];
	let i = 0;
	while (i < text.length) {
		let end = Math.min(i + RICH_TEXT_CHUNK, text.length);
		if (end < text.length) {
			// Try not to split mid-token. Falling back to mid-string is fine —
			// it's JSON in a code block, not human prose.
			const lastNewline = text.lastIndexOf("\n", end);
			if (lastNewline > i + RICH_TEXT_CHUNK / 2) end = lastNewline + 1;
		}
		chunks.push(text.slice(i, end));
		i = end;
	}
	return chunks.map((c) => ({ type: "text", text: { content: c } }));
}
