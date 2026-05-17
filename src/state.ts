import type { Client } from "@notionhq/client";

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
	};
	tokensUsed?: number;
	budgetCircuitTripped?: boolean;
}

const STATE_PROP = "Hivemind State";
const CHUNK_SIZE = 1900;

function chunkText(text: string): string[] {
	if (text.length <= CHUNK_SIZE) return [text];
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		let end = Math.min(i + CHUNK_SIZE, text.length);
		if (end < text.length) {
			const lastSpace = text.lastIndexOf(" ", end);
			if (lastSpace > i + CHUNK_SIZE / 2) end = lastSpace + 1;
		}
		out.push(text.slice(i, end));
		i = end;
	}
	return out;
}

export async function readHivemindState(
	notion: Client,
	briefId: string,
): Promise<HivemindState> {
	try {
		const page = await notion.pages.retrieve({ page_id: briefId });
		const props = (page as { properties: Record<string, unknown> }).properties;
		const prop = props[STATE_PROP];
		if (!prop || typeof prop !== "object") return {};
		const typed = prop as { type: string; rich_text?: { plain_text: string }[] };
		if (typed.type !== "rich_text" || !typed.rich_text) return {};
		const raw = typed.rich_text.map((rt) => rt.plain_text).join("");
		if (!raw.trim()) return {};
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
	const serialized = JSON.stringify(state);
	const chunks = chunkText(serialized);
	const richText = chunks.map((c) => ({
		type: "text" as const,
		text: { content: c },
	}));
	await notion.pages.update({
		page_id: briefId,
		properties: {
			[STATE_PROP]: { rich_text: richText },
		},
	});
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
