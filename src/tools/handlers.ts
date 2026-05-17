// Security contract: every write handler calls
// `ctx.scopeGuard.assertAllowed(targetPageId)` before mutating, every
// Notion API call awaits `ctx.pacer.acquire()` first, and every page
// creation calls `ctx.scopeGuard.registerCreated(newId)`. Violations of
// any of these invariants are security bugs.

import type { Client } from "@notionhq/client";
import { isFullDataSource, isFullPage } from "@notionhq/client";
import type {
	BlockObjectRequest,
	CreatePageParameters,
	PageObjectResponse,
	UpdateBlockParameters,
} from "@notionhq/client";

import type { AgentContext, ToolDispatcher } from "../agentLoop";
import type { TokenBudget } from "../budget";
import {
	bookmark,
	bullet,
	callout,
	code,
	divider,
	heading2,
	heading3,
	mdToBlocks,
	numbered,
	paragraph,
	setBriefProperties,
	todoBlock,
	toggle,
} from "../notion";
import type { BriefOwner, BriefStatus } from "../notion";
import type { Pacer } from "../pacer";
import type { ProjectIds } from "../provision";
import type { ScopeGuard } from "../scope";

export interface BriefMetadata {
	id: string;
	title: string;
	body: string;
	status: string | null;
	category: string | null;
}

export interface ToolHandlerContext extends AgentContext {
	notion: Client;
	briefId: string;
	briefMetadata: BriefMetadata;
	projectIds: ProjectIds;
	scopeGuard: ScopeGuard;
	pacer: Pacer;
	tokenBudget: TokenBudget;
	agentName: "Scout" | "Forge" | "Scribe" | "Sentinel";
	/** Populated by setVerdict; read by orchestrator after agent finishes. */
	verdict?: { verdict: "approve" | "needs-revision"; summary: string };
}

type BlockShapeType =
	| "paragraph"
	| "heading_2"
	| "heading_3"
	| "bulleted_list_item"
	| "numbered_list_item"
	| "to_do"
	| "quote"
	| "code"
	| "callout"
	| "toggle"
	| "divider"
	| "bookmark";

interface BlockShape {
	type: BlockShapeType;
	text?: string;
	checked?: boolean;
	language?: string;
	emoji?: string;
	color?: string;
	url?: string;
}

function inlineRichText(
	text: string,
): { type: "text"; text: { content: string } }[] {
	return [{ type: "text", text: { content: text } }];
}

function blockShapeToNotion(b: BlockShape): BlockObjectRequest {
	const text = b.text ?? "";
	switch (b.type) {
		case "paragraph":
			return paragraph(text);
		case "heading_2":
			return heading2(text);
		case "heading_3":
			return heading3(text);
		case "bulleted_list_item":
			return bullet(text);
		case "numbered_list_item":
			return numbered(text);
		case "to_do":
			return todoBlock(text, b.checked);
		case "quote":
			return { type: "quote", quote: { rich_text: inlineRichText(text) } };
		case "code":
			return code(text, b.language);
		case "callout":
			return callout(text, b.emoji, b.color);
		case "toggle":
			return toggle(text);
		case "divider":
			return divider();
		case "bookmark":
			if (!b.url)
				throw new Error("blockShapeToNotion: bookmark block requires url");
			return bookmark(b.url);
		default: {
			const exhaustive: never = b.type;
			throw new Error(
				`blockShapeToNotion: unknown block type ${exhaustive as string}`,
			);
		}
	}
}

function blockShapesToNotion(blocks: BlockShape[]): BlockObjectRequest[] {
	return blocks.map(blockShapeToNotion);
}

/**
 * Translate a BlockObjectRequest produced by `blockShapeToNotion` into
 * `UpdateBlockParameters` for `notion.blocks.update`. The SDK's update body
 * shape differs from create (no `type` discriminator at top level, no
 * children) so we have to switch on the block kind.
 */
function notionBlockToUpdateParams(
	notionBlock: BlockObjectRequest,
	blockId: string,
): UpdateBlockParameters {
	switch (notionBlock.type) {
		case "paragraph":
			return { block_id: blockId, paragraph: notionBlock.paragraph };
		case "heading_1":
			return { block_id: blockId, heading_1: notionBlock.heading_1 };
		case "heading_2":
			return { block_id: blockId, heading_2: notionBlock.heading_2 };
		case "heading_3":
			return { block_id: blockId, heading_3: notionBlock.heading_3 };
		case "bulleted_list_item":
			return {
				block_id: blockId,
				bulleted_list_item: notionBlock.bulleted_list_item,
			};
		case "numbered_list_item":
			return {
				block_id: blockId,
				numbered_list_item: notionBlock.numbered_list_item,
			};
		case "to_do":
			return { block_id: blockId, to_do: notionBlock.to_do };
		case "quote":
			return { block_id: blockId, quote: notionBlock.quote };
		case "code":
			return { block_id: blockId, code: notionBlock.code };
		case "callout":
			return { block_id: blockId, callout: notionBlock.callout };
		case "toggle":
			// notion.ts's toggle helper attaches a `children` array; strip it for
			// update since `notion.blocks.update` rejects children mutations.
			return {
				block_id: blockId,
				toggle: { rich_text: notionBlock.toggle.rich_text },
			};
		case "divider":
			return { block_id: blockId, divider: notionBlock.divider };
		case "bookmark":
			return { block_id: blockId, bookmark: notionBlock.bookmark };
		default:
			throw new Error(
				`updateBlock: unsupported block type ${(notionBlock as { type: string }).type}`,
			);
	}
}

function asRecord(x: unknown): Record<string, unknown> {
	if (!x || typeof x !== "object" || Array.isArray(x)) {
		throw new Error(`Expected object input, got ${typeof x}`);
	}
	return x as Record<string, unknown>;
}

function asString(x: unknown, name: string): string {
	if (typeof x !== "string") throw new Error(`${name} must be a string`);
	return x;
}

function asOptString(x: unknown, name: string): string | undefined {
	if (x === undefined || x === null) return undefined;
	return asString(x, name);
}

function asNumber(x: unknown, name: string): number {
	if (typeof x !== "number") throw new Error(`${name} must be a number`);
	return x;
}

function asOptNumber(x: unknown, name: string): number | undefined {
	if (x === undefined || x === null) return undefined;
	return asNumber(x, name);
}

function asStringArray(x: unknown, name: string): string[] {
	if (!Array.isArray(x)) throw new Error(`${name} must be an array`);
	return x.map((item, i) => asString(item, `${name}[${i}]`));
}

function asOptStringArray(x: unknown, name: string): string[] | undefined {
	if (x === undefined || x === null) return undefined;
	return asStringArray(x, name);
}

function asBlockShape(x: unknown, name: string): BlockShape {
	const r = asRecord(x);
	const t = asString(r.type, `${name}.type`);
	const allowed: readonly BlockShapeType[] = [
		"paragraph",
		"heading_2",
		"heading_3",
		"bulleted_list_item",
		"numbered_list_item",
		"to_do",
		"quote",
		"code",
		"callout",
		"toggle",
		"divider",
		"bookmark",
	];
	if (!(allowed as readonly string[]).includes(t)) {
		throw new Error(`${name}.type "${t}" is not a supported block type`);
	}
	return {
		type: t as BlockShapeType,
		text: asOptString(r.text, `${name}.text`),
		checked: typeof r.checked === "boolean" ? r.checked : undefined,
		language: asOptString(r.language, `${name}.language`),
		emoji: asOptString(r.emoji, `${name}.emoji`),
		color: asOptString(r.color, `${name}.color`),
		url: asOptString(r.url, `${name}.url`),
	};
}

function asBlockShapeArray(x: unknown, name: string): BlockShape[] {
	if (!Array.isArray(x)) throw new Error(`${name} must be an array`);
	return x.map((item, i) => asBlockShape(item, `${name}[${i}]`));
}

function extractNumber(prop: unknown): number | null {
	if (!prop || typeof prop !== "object") return null;
	const p = prop as { type?: string; number?: number | null };
	if (p.type === "number" && typeof p.number === "number") return p.number;
	return null;
}

function extractSelect(prop: unknown): string | null {
	if (!prop || typeof prop !== "object") return null;
	const p = prop as { type?: string; select?: { name: string } | null };
	if (p.type === "select" && p.select) return p.select.name;
	return null;
}

function extractRichText(prop: unknown): string | null {
	if (!prop || typeof prop !== "object") return null;
	const p = prop as {
		type?: string;
		rich_text?: { plain_text: string }[];
	};
	if (p.type === "rich_text" && p.rich_text) {
		return p.rich_text.map((rt) => rt.plain_text).join("");
	}
	return null;
}

function extractURL(prop: unknown): string | null {
	if (!prop || typeof prop !== "object") return null;
	const p = prop as { type?: string; url?: string | null };
	if (p.type === "url" && typeof p.url === "string") return p.url;
	return null;
}

function pickTitleProperty(
	properties: Record<string, unknown>,
): string | null {
	for (const value of Object.values(properties)) {
		if (
			value &&
			typeof value === "object" &&
			(value as { type?: string }).type === "title"
		) {
			const t = value as { title?: { plain_text: string }[] };
			return (t.title ?? []).map((rt) => rt.plain_text).join("");
		}
	}
	return null;
}

/**
 * Project the small, summary-shaped fields most useful to the model
 * (status / select / number / rich_text snippets / URLs). Drops bulky
 * properties (relations, rollups, formulas, files, full block trees)
 * that would balloon tool-result payloads.
 */
function pickCommonProperties(
	properties: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(properties)) {
		if (!value || typeof value !== "object") continue;
		const p = value as { type?: string } & Record<string, unknown>;
		switch (p.type) {
			case "select": {
				const sel = (p as { select?: { name?: string } | null }).select;
				if (sel?.name) out[key] = sel.name;
				break;
			}
			case "status": {
				const st = (p as { status?: { name?: string } | null }).status;
				if (st?.name) out[key] = st.name;
				break;
			}
			case "number": {
				const n = (p as { number?: number | null }).number;
				if (typeof n === "number") out[key] = n;
				break;
			}
			case "rich_text": {
				const txt = extractRichText(p);
				if (txt && txt.length <= 200) out[key] = txt;
				else if (txt) out[key] = `${txt.slice(0, 200)}…`;
				break;
			}
			case "url": {
				const url = (p as { url?: string | null }).url;
				if (url) out[key] = url;
				break;
			}
			case "date": {
				const d = (p as { date?: { start?: string } | null }).date;
				if (d?.start) out[key] = d.start;
				break;
			}
			case "checkbox": {
				const c = (p as { checkbox?: boolean }).checkbox;
				if (typeof c === "boolean") out[key] = c;
				break;
			}
			default:
				break;
		}
	}
	return out;
}

interface ListedBlock {
	id: string;
	block: { type: string } & Record<string, unknown>;
}

const STRUCTURAL_TRAVERSAL_CAP = 1000;
const DISPLAY_BLOCK_CAP = 100;

async function listAllBlocks(
	notion: Client,
	pacer: Pacer,
	pageId: string,
	maxBlocks: number = STRUCTURAL_TRAVERSAL_CAP,
): Promise<ListedBlock[]> {
	const all: ListedBlock[] = [];
	let cursor: string | undefined;
	do {
		await pacer.acquire();
		const res = await notion.blocks.children.list({
			block_id: pageId,
			start_cursor: cursor,
			page_size: 100,
		});
		for (const b of res.results) {
			if ("type" in b) {
				all.push({
					id: b.id,
					block: b as unknown as { type: string } & Record<string, unknown>,
				});
				if (all.length >= maxBlocks) return all;
			}
		}
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);
	return all;
}

async function appendToPlanSectionHelper(
	ctx: ToolHandlerContext,
	planPageId: string,
	section: string,
	blocks: BlockObjectRequest[],
): Promise<void> {
	if (blocks.length === 0) return;

	const all = await listAllBlocks(ctx.notion, ctx.pacer, planPageId);
	let sectionHeadingId: string | null = null;
	let insertAfterId: string | null = null;
	let inSection = false;
	for (const { id, block } of all) {
		if (block.type === "heading_2") {
			const h = block.heading_2 as { rich_text: { plain_text: string }[] };
			const heading = richTextToPlain(h.rich_text);
			if (heading === section) {
				sectionHeadingId = id;
				insertAfterId = id;
				inSection = true;
				continue;
			}
			if (inSection) break;
		}
		if (inSection) insertAfterId = id;
	}

	if (!sectionHeadingId) {
		throw new Error(
			`appendToPlanSection: section "${section}" not found on Plan page`,
		);
	}

	await ctx.pacer.acquire();
	await ctx.notion.blocks.children.append({
		block_id: planPageId,
		children: blocks,
		after: insertAfterId ?? sectionHeadingId,
	});
}

function richTextToPlain(
	rt: ReadonlyArray<{ plain_text: string }> | undefined,
): string {
	return (rt ?? []).map((item) => item.plain_text).join("");
}

function stringifyBlock(
	block: { type: string } & Record<string, unknown>,
): string | null {
	switch (block.type) {
		case "paragraph": {
			const p = block.paragraph as { rich_text: { plain_text: string }[] };
			return richTextToPlain(p.rich_text);
		}
		case "heading_1": {
			const h = block.heading_1 as { rich_text: { plain_text: string }[] };
			return `# ${richTextToPlain(h.rich_text)}`;
		}
		case "heading_2": {
			const h = block.heading_2 as { rich_text: { plain_text: string }[] };
			return `## ${richTextToPlain(h.rich_text)}`;
		}
		case "heading_3": {
			const h = block.heading_3 as { rich_text: { plain_text: string }[] };
			return `### ${richTextToPlain(h.rich_text)}`;
		}
		case "bulleted_list_item": {
			const b = block.bulleted_list_item as {
				rich_text: { plain_text: string }[];
			};
			return `- ${richTextToPlain(b.rich_text)}`;
		}
		case "numbered_list_item": {
			const n = block.numbered_list_item as {
				rich_text: { plain_text: string }[];
			};
			return `1. ${richTextToPlain(n.rich_text)}`;
		}
		case "to_do": {
			const t = block.to_do as {
				rich_text: { plain_text: string }[];
				checked: boolean;
			};
			return `${t.checked ? "[x]" : "[ ]"} ${richTextToPlain(t.rich_text)}`;
		}
		case "quote": {
			const q = block.quote as { rich_text: { plain_text: string }[] };
			return `> ${richTextToPlain(q.rich_text)}`;
		}
		case "code": {
			const c = block.code as {
				rich_text: { plain_text: string }[];
				language?: string;
			};
			return `\`\`\`${c.language ?? ""}\n${richTextToPlain(c.rich_text)}\n\`\`\``;
		}
		case "callout": {
			const c = block.callout as { rich_text: { plain_text: string }[] };
			return `📢 ${richTextToPlain(c.rich_text)}`;
		}
		case "toggle": {
			const t = block.toggle as { rich_text: { plain_text: string }[] };
			return `▸ ${richTextToPlain(t.rich_text)}`;
		}
		case "divider":
			return "---";
		case "bookmark": {
			const bm = block.bookmark as { url?: string };
			return `[bookmark] ${bm.url ?? ""}`;
		}
		default:
			return null;
	}
}

function titleFromPage(page: PageObjectResponse): string {
	for (const value of Object.values(page.properties)) {
		if (value.type === "title") {
			return value.title.map((rt) => rt.plain_text).join("");
		}
	}
	return "";
}

/**
 * Walk a block's parent chain up to the page that contains it. Used by
 * updateBlock / deleteBlock / addComment(block_id) so the scope guard can
 * verify the containing page is in-subtree.
 */
async function walkBlockToPage(
	notion: Client,
	pacer: Pacer,
	blockId: string,
): Promise<string> {
	let currentId = blockId;
	for (let i = 0; i < 16; i += 1) {
		await pacer.acquire();
		const block = await notion.blocks.retrieve({ block_id: currentId });
		if (!("parent" in block)) {
			throw new Error(`walkBlockToPage: partial response for ${blockId}`);
		}
		const parent = block.parent;
		if (parent.type === "page_id") return parent.page_id;
		if (parent.type === "block_id") {
			currentId = parent.block_id;
			continue;
		}
		throw new Error(
			`walkBlockToPage: cannot resolve page for block ${blockId} (parent.type=${parent.type})`,
		);
	}
	throw new Error(`walkBlockToPage: parent chain too deep for block ${blockId}`);
}

type Handler = (input: unknown, ctx: ToolHandlerContext) => Promise<unknown>;

function requireDraftsDsId(ctx: ToolHandlerContext, toolName: string): string {
	const id = ctx.projectIds.dbs.drafts?.dsId;
	if (!id) {
		throw new Error(
			`${toolName}: this brief was provisioned without a Drafts database (category=${ctx.briefMetadata.category}). Use writeAnswer for the answer.`,
		);
	}
	return id;
}

function requirePlanPageId(ctx: ToolHandlerContext, toolName: string): string {
	const id = ctx.projectIds.planPageId;
	if (!id) {
		throw new Error(
			`${toolName}: this brief (category=${ctx.briefMetadata.category}) was provisioned without a Plan page.`,
		);
	}
	return id;
}

function outputTypeForCategory(category: string | null): string {
	switch (category) {
		case "writing":
			return "writing";
		case "visual-engineering":
			return "design";
		case "deep":
		case "ultrabrain":
			return "analysis";
		default:
			return "implementation";
	}
}

const HANDLERS: Record<string, Handler> = {
	async searchWorkspace(input, ctx) {
		const r = asRecord(input);
		const query = asString(r.query, "query");
		const pageSize = asOptNumber(r.page_size, "page_size") ?? 5;
		await ctx.pacer.acquire();
		const res = await ctx.notion.search({ query, page_size: pageSize });
		return res.results.map((item) => {
			if (isFullPage(item)) {
				return {
					id: item.id,
					title: titleFromPage(item),
					type: "page" as const,
				};
			}
			if (isFullDataSource(item)) {
				return {
					id: item.id,
					title: item.title.map((rt) => rt.plain_text).join(""),
					type: "data_source" as const,
				};
			}
			return {
				id: item.id,
				title: "",
				type: item.object === "data_source" ? "data_source" : "page",
			};
		});
	},

	async readPage(input, ctx) {
		const r = asRecord(input);
		const pageId = asString(r.page_id, "page_id");
		await ctx.pacer.acquire();
		const page = await ctx.notion.pages.retrieve({ page_id: pageId });
		if (!isFullPage(page)) {
			throw new Error(`readPage: partial response for ${pageId}`);
		}
		const allBlocks = await listAllBlocks(ctx.notion, ctx.pacer, pageId);
		const blocks = allBlocks
			.map((b) => stringifyBlock(b.block))
			.filter((s): s is string => s !== null);
		const truncated = blocks.length > DISPLAY_BLOCK_CAP;
		return {
			id: page.id,
			title: titleFromPage(page),
			blocks: blocks.slice(0, DISPLAY_BLOCK_CAP),
			...(truncated && {
				truncated: true,
				total_blocks: blocks.length,
			}),
		};
	},

	async readDataSource(input, ctx) {
		const r = asRecord(input);
		const dsId = asString(r.data_source_id, "data_source_id");
		const pageSize = asOptNumber(r.page_size, "page_size") ?? 20;
		const startCursor = asOptString(r.start_cursor, "start_cursor");
		await ctx.pacer.acquire();
		const res = await ctx.notion.dataSources.query({
			data_source_id: dsId,
			page_size: pageSize,
			start_cursor: startCursor,
		});
		return {
			rows: res.results.map((item) => {
				if (!("properties" in item)) return { id: item.id };
				return {
					id: item.id,
					title: pickTitleProperty(item.properties),
					...pickCommonProperties(item.properties),
				};
			}),
			next_cursor: res.has_more ? res.next_cursor : null,
		};
	},

	async getBriefMetadata(_input, ctx) {
		return {
			...ctx.briefMetadata,
			project_root_id: ctx.projectIds.projectRootId,
		};
	},

	async getProjectIds(_input, ctx) {
		return ctx.projectIds;
	},

	async readPlanSection(input, ctx) {
		const r = asRecord(input);
		const section = asString(r.section, "section");
		const planPageId = ctx.projectIds.planPageId;
		if (!planPageId) {
			throw new Error(
				`readPlanSection: this brief (category=${ctx.briefMetadata.category}) was provisioned without a Plan page. No sections to read.`,
			);
		}
		const blocks = await listAllBlocks(ctx.notion, ctx.pacer, planPageId);
		const out: string[] = [];
		let inSection = false;
		for (const { block } of blocks) {
			if (block.type === "heading_2") {
				const h = block.heading_2 as { rich_text: { plain_text: string }[] };
				const heading = richTextToPlain(h.rich_text);
				if (heading === section) {
					inSection = true;
					continue;
				}
				if (inSection) break;
			}
			if (inSection) {
				const str = stringifyBlock(block);
				if (str !== null) out.push(str);
			}
		}
		const truncated = out.length > DISPLAY_BLOCK_CAP;
		return {
			blocks: out.slice(0, DISPLAY_BLOCK_CAP),
			...(truncated && {
				truncated: true,
				total_blocks: out.length,
			}),
		};
	},

	async listDrafts(_input, ctx) {
		const dsId = requireDraftsDsId(ctx, "listDrafts");
		await ctx.pacer.acquire();
		const res = await ctx.notion.dataSources.query({
			data_source_id: dsId,
			sorts: [{ property: "Iteration", direction: "descending" }],
			page_size: 20,
		});
		return res.results.map((item) => {
			if (!("properties" in item)) return { id: item.id };
			const props = item.properties;
			const summary = extractRichText(props.Summary);
			return {
				id: item.id,
				iteration: extractNumber(props.Iteration),
				status: extractSelect(props.Status),
				last_verdict: extractSelect(props["Last Verdict"]),
				risk_level: extractSelect(props["Risk Level"]),
				quality_score: extractNumber(props["Quality Score"]),
				review_count: extractNumber(props["Review Count"]),
				output_type: extractSelect(props["Output Type"]),
				summary:
					summary && summary.length > 200
						? `${summary.slice(0, 200)}…`
						: summary,
			};
		});
	},

	async getDraftBody(input, ctx) {
		const r = asRecord(input);
		const draftId = asString(r.draft_id, "draft_id");
		await ctx.pacer.acquire();
		const allBlocks = await listAllBlocks(ctx.notion, ctx.pacer, draftId);
		const blocks = allBlocks
			.map((b) => stringifyBlock(b.block))
			.filter((s): s is string => s !== null);
		const truncated = blocks.length > DISPLAY_BLOCK_CAP;
		return {
			id: draftId,
			body: blocks.slice(0, DISPLAY_BLOCK_CAP).join("\n"),
			...(truncated && {
				truncated: true,
				total_blocks: blocks.length,
			}),
		};
	},

	async getDraft(input, ctx) {
		const r = asRecord(input);
		const draftId = asString(r.draft_id, "draft_id");
		await ctx.pacer.acquire();
		const page = await ctx.notion.pages.retrieve({ page_id: draftId });
		if (!isFullPage(page)) {
			throw new Error(`getDraft: partial response for ${draftId}`);
		}
		const blocks = await listAllBlocks(ctx.notion, ctx.pacer, draftId);
		return {
			id: page.id,
			iteration: extractNumber(page.properties.Iteration),
			status: extractSelect(page.properties.Status),
			summary: extractRichText(page.properties.Summary),
			sources: extractURL(page.properties.Sources),
			author_agent: extractSelect(page.properties["Author Agent"]),
			last_verdict: extractSelect(page.properties["Last Verdict"]),
			risk_level: extractSelect(page.properties["Risk Level"]),
			quality_score: extractNumber(page.properties["Quality Score"]),
			review_count: extractNumber(page.properties["Review Count"]),
			output_type: extractSelect(page.properties["Output Type"]),
			body: blocks
				.map((b) => stringifyBlock(b.block))
				.filter((s): s is string => s !== null)
				.join("\n"),
		};
	},

	async appendBlocks(input, ctx) {
		const r = asRecord(input);
		const pageId = asString(r.page_id, "page_id");
		const blocks = asBlockShapeArray(r.blocks, "blocks");
		await ctx.scopeGuard.assertAllowed(pageId);
		await ctx.pacer.acquire();
		const res = await ctx.notion.blocks.children.append({
			block_id: pageId,
			children: blockShapesToNotion(blocks),
		});
		return { block_ids: res.results.map((b) => b.id) };
	},

	async updateBlock(input, ctx) {
		const r = asRecord(input);
		const blockId = asString(r.block_id, "block_id");
		const block = asBlockShape(r.block, "block");
		const pageId = await walkBlockToPage(ctx.notion, ctx.pacer, blockId);
		await ctx.scopeGuard.assertAllowed(pageId);
		await ctx.pacer.acquire();
		const notionBlock = blockShapeToNotion(block);
		await ctx.notion.blocks.update(
			notionBlockToUpdateParams(notionBlock, blockId),
		);
		return { updated: true };
	},

	async deleteBlock(input, ctx) {
		const r = asRecord(input);
		const blockId = asString(r.block_id, "block_id");
		const pageId = await walkBlockToPage(ctx.notion, ctx.pacer, blockId);
		await ctx.scopeGuard.assertAllowed(pageId);
		await ctx.pacer.acquire();
		await ctx.notion.blocks.delete({ block_id: blockId });
		return { deleted: true };
	},

	async setPlanSection(input, ctx) {
		const r = asRecord(input);
		const section = asString(r.section, "section");
		const newBlocks = asBlockShapeArray(r.blocks, "blocks");
		const planPageId = ctx.projectIds.planPageId;
		if (!planPageId) {
			throw new Error(
				`setPlanSection: this brief (category=${ctx.briefMetadata.category}) was provisioned without a Plan page.`,
			);
		}
		await ctx.scopeGuard.assertAllowed(planPageId);

		const all = await listAllBlocks(ctx.notion, ctx.pacer, planPageId);
		let sectionHeadingId: string | null = null;
		const toDelete: string[] = [];
		let inSection = false;
		for (const { id, block } of all) {
			if (block.type === "heading_2") {
				const h = block.heading_2 as { rich_text: { plain_text: string }[] };
				const heading = richTextToPlain(h.rich_text);
				if (heading === section) {
					sectionHeadingId = id;
					inSection = true;
					continue;
				}
				if (inSection) break;
			}
			if (inSection) toDelete.push(id);
		}

		if (!sectionHeadingId) {
			throw new Error(
				`setPlanSection: section "${section}" not found on Plan page`,
			);
		}

		for (const blockId of toDelete) {
			await ctx.pacer.acquire();
			await ctx.notion.blocks.delete({ block_id: blockId });
		}

		if (newBlocks.length > 0) {
			await ctx.pacer.acquire();
			await ctx.notion.blocks.children.append({
				block_id: planPageId,
				children: blockShapesToNotion(newBlocks),
				after: sectionHeadingId,
			});
		}

		return { section, block_count: newBlocks.length };
	},

	async appendToPlanSection(input, ctx) {
		const r = asRecord(input);
		const section = asString(r.section, "section");
		const newBlocks = asBlockShapeArray(r.blocks, "blocks");
		const planPageId = ctx.projectIds.planPageId;
		if (!planPageId) {
			throw new Error(
				`appendToPlanSection: this brief (category=${ctx.briefMetadata.category}) was provisioned without a Plan page.`,
			);
		}
		await ctx.scopeGuard.assertAllowed(planPageId);

		const all = await listAllBlocks(ctx.notion, ctx.pacer, planPageId);
		let sectionHeadingId: string | null = null;
		let insertAfterId: string | null = null;
		let inSection = false;
		for (const { id, block } of all) {
			if (block.type === "heading_2") {
				const h = block.heading_2 as { rich_text: { plain_text: string }[] };
				const heading = richTextToPlain(h.rich_text);
				if (heading === section) {
					sectionHeadingId = id;
					insertAfterId = id;
					inSection = true;
					continue;
				}
				if (inSection) break;
			}
			if (inSection) insertAfterId = id;
		}

		if (!sectionHeadingId) {
			throw new Error(
				`appendToPlanSection: section "${section}" not found on Plan page`,
			);
		}

		if (newBlocks.length > 0) {
			await ctx.pacer.acquire();
			await ctx.notion.blocks.children.append({
				block_id: planPageId,
				children: blockShapesToNotion(newBlocks),
				after: insertAfterId ?? sectionHeadingId,
			});
		}

		return { block_count: newBlocks.length };
	},

	async createChildPage(input, ctx) {
		const r = asRecord(input);
		const parentId = asString(r.parent_id, "parent_id");
		const title = asString(r.title, "title");
		const blocks =
			r.blocks !== undefined ? asBlockShapeArray(r.blocks, "blocks") : [];
		await ctx.scopeGuard.assertAllowed(parentId);
		await ctx.pacer.acquire();
		const properties: CreatePageParameters["properties"] = {
			title: { title: [{ type: "text", text: { content: title } }] },
		};
		const res = await ctx.notion.pages.create({
			parent: { type: "page_id", page_id: parentId },
			properties,
			children: blocks.length > 0 ? blockShapesToNotion(blocks) : undefined,
		});
		ctx.scopeGuard.registerCreated(res.id);
		return { page_id: res.id };
	},

	async writeAnswer(input, ctx) {
		const r = asRecord(input);
		const body = asString(r.body, "body");
		const sources = asOptStringArray(r.sources, "sources");

		const rootId = ctx.projectIds.projectRootId;
		const anchorId = ctx.projectIds.answerAnchorBlockId;
		if (!anchorId) {
			throw new Error(
				"writeAnswer: project has no answer anchor — this brief was provisioned with the Drafts DB path. Use createDraft instead.",
			);
		}
		await ctx.scopeGuard.assertAllowed(rootId);

		const existing = await listAllBlocks(ctx.notion, ctx.pacer, rootId);
		const anchorIdx = existing.findIndex((b) => b.id === anchorId);
		if (anchorIdx < 0) {
			throw new Error(
				`writeAnswer: anchor block ${anchorId} not found on root ${rootId}`,
			);
		}
		const navStartIdx = existing.findIndex(
			(b, i) =>
				i > anchorIdx &&
				(b.block.type === "child_page" || b.block.type === "child_database"),
		);
		const lastIdx = navStartIdx < 0 ? existing.length : navStartIdx;
		const stale = existing.slice(anchorIdx + 1, lastIdx);
		for (const { id } of stale) {
			await ctx.pacer.acquire();
			await ctx.notion.blocks.delete({ block_id: id });
		}

		const blocks: BlockObjectRequest[] = mdToBlocks(body);
		if (sources && sources.length > 0) {
			blocks.push(heading3("Sources"));
			for (const url of sources) blocks.push(bullet(url));
		}
		if (blocks.length === 0) {
			return { written: true, block_count: 0 };
		}

		let after = anchorId;
		let inserted = 0;
		for (let i = 0; i < blocks.length; i += 100) {
			const slice = blocks.slice(i, i + 100);
			await ctx.pacer.acquire();
			const res = await ctx.notion.blocks.children.append({
				block_id: rootId,
				children: slice,
				after,
			});
			inserted += res.results.length;
			const lastResult = res.results[res.results.length - 1];
			if (lastResult && "id" in lastResult) after = lastResult.id;
		}
		return { written: true, block_count: inserted };
	},

	async createDraft(input, ctx) {
		const r = asRecord(input);
		const summary = asString(r.summary, "summary");
		const body = asString(r.body, "body");
		const sources = asOptStringArray(r.sources, "sources");
		const basedOnDraftId = asOptString(
			r.based_on_draft_id,
			"based_on_draft_id",
		);

		const dsId = requireDraftsDsId(ctx, "createDraft");
		await ctx.pacer.acquire();
		const topRes = await ctx.notion.dataSources.query({
			data_source_id: dsId,
			sorts: [{ property: "Iteration", direction: "descending" }],
			page_size: 1,
		});
		let nextIter = 1;
		const top = topRes.results[0];
		if (top && "properties" in top) {
			const n = extractNumber(top.properties.Iteration);
			if (typeof n === "number") nextIter = n + 1;
		}

		const author: "Forge" | "Scribe" =
			ctx.agentName === "Scribe" ? "Scribe" : "Forge";

		const properties: CreatePageParameters["properties"] = {
			Name: {
				title: [
					{
						type: "text",
						text: {
							content: `Draft ${nextIter} — ${summary.slice(0, 60)}`,
						},
					},
				],
			},
			Iteration: { number: nextIter },
			Status: { select: { name: "draft" } },
			"Author Agent": { select: { name: author } },
			Summary: { rich_text: inlineRichText(summary) },
			"Review Count": { number: 0 },
			"Output Type": {
				select: { name: outputTypeForCategory(ctx.briefMetadata.category) },
			},
		};
		if (sources && sources[0]) {
			properties.Sources = { url: sources[0] };
		}
		if (basedOnDraftId) {
			properties["Based On Draft"] = { relation: [{ id: basedOnDraftId }] };
		}

		await ctx.pacer.acquire();
		const res = await ctx.notion.pages.create({
			parent: {
				type: "data_source_id",
				data_source_id: dsId,
			},
			properties,
			children: mdToBlocks(body),
		});
		ctx.scopeGuard.registerCreated(res.id);
		return { draft_id: res.id, iteration: nextIter };
	},

	async updateDraftStatus(input, ctx) {
		const r = asRecord(input);
		const draftId = asString(r.draft_id, "draft_id");
		const status = asString(r.status, "status");
		await ctx.scopeGuard.assertAllowed(draftId);
		await ctx.pacer.acquire();
		await ctx.notion.pages.update({
			page_id: draftId,
			properties: {
				Status: { select: { name: status } },
			},
		});
		return { updated: true };
	},

	async createReview(input, ctx) {
		const r = asRecord(input);
		const draftId = asString(r.draft_id, "draft_id");
		const verdict = asString(r.verdict, "verdict");
		const strengths = asStringArray(r.strengths, "strengths");
		const risks = asStringArray(r.risks, "risks");
		const summary = asString(r.summary, "summary");

		await ctx.scopeGuard.assertAllowed(draftId);

		let iterationLabel = draftId.slice(0, 8);
		await ctx.pacer.acquire();
		const draft = await ctx.notion.pages.retrieve({ page_id: draftId });
		if (isFullPage(draft)) {
			const n = extractNumber(draft.properties.Iteration);
			if (typeof n === "number") iterationLabel = String(n);
		}

		const blocks: BlockObjectRequest[] = [
			divider(),
			heading2(`Review by Sentinel — ${verdict}`),
			paragraph(summary),
		];
		if (strengths.length > 0) {
			blocks.push(heading3("Strengths"));
			for (const s of strengths) blocks.push(bullet(s));
		}
		if (risks.length > 0) {
			blocks.push(heading3("Risks"));
			for (const r of risks) blocks.push(bullet(r));
		}

		await ctx.pacer.acquire();
		await ctx.notion.blocks.children.append({
			block_id: draftId,
			children: blocks,
		});

		await ctx.pacer.acquire();
		const reviewCount = isFullPage(draft)
			? (extractNumber(draft.properties["Review Count"]) ?? 0) + 1
			: 1;
		const qualityScore = verdict === "approve" ? 100 : Math.max(40, 85 - risks.length * 10);
		const riskLevel = verdict === "approve"
			? risks.length > 1
				? "medium"
				: "low"
			: risks.length > 2
				? "high"
				: "medium";
		const properties: CreatePageParameters["properties"] = {
			"Last Verdict": { select: { name: verdict } },
			"Review Count": { number: reviewCount },
			"Quality Score": { number: qualityScore },
			"Risk Level": { select: { name: riskLevel } },
		};
		if (verdict === "approve") {
			properties["Approved At"] = { date: { start: new Date().toISOString() } };
		}

		await ctx.notion.pages.update({
			page_id: draftId,
			properties,
		});

		return { draft_id: draftId, iteration: iterationLabel, verdict };
	},

	async createSource(input, ctx) {
		const r = asRecord(input);
		const title = asString(r.title, "title");
		const url = asString(r.url, "url");
		const summary = asOptString(r.summary, "summary");

		const planPageId = requirePlanPageId(ctx, "createSource");
		await ctx.scopeGuard.assertAllowed(planPageId);

		const tail = summary ? ` — ${summary}` : "";
		const blocks: BlockObjectRequest[] = [
			bullet(`${title} (${url})${tail}  · captured by ${ctx.agentName}`),
		];
		await appendToPlanSectionHelper(ctx, planPageId, "Sources", blocks);
		return { ok: true };
	},

	async createDecision(input, ctx) {
		const r = asRecord(input);
		const title = asString(r.title, "title");
		const choice = asString(r.choice, "choice");
		const rationale = asString(r.rationale, "rationale");
		const alternatives = asOptStringArray(
			r.alternatives_considered,
			"alternatives_considered",
		);

		const planPageId = requirePlanPageId(ctx, "createDecision");
		await ctx.scopeGuard.assertAllowed(planPageId);

		const blocks: BlockObjectRequest[] = [
			heading3(`${title} — ${ctx.agentName}, ${new Date().toISOString()}`),
			paragraph(`Choice: ${choice}`),
			paragraph(`Rationale: ${rationale}`),
		];
		if (alternatives && alternatives.length > 0) {
			blocks.push(paragraph("Alternatives considered:"));
			for (const a of alternatives) blocks.push(bullet(a));
		}
		await appendToPlanSectionHelper(ctx, planPageId, "Decisions", blocks);
		return { ok: true };
	},

	async createOpenQuestion(input, ctx) {
		const r = asRecord(input);
		const question = asString(r.question, "question");
		const whyItMatters = asOptString(r.why_it_matters, "why_it_matters");

		const planPageId = requirePlanPageId(ctx, "createOpenQuestion");
		await ctx.scopeGuard.assertAllowed(planPageId);

		const tail = whyItMatters ? ` — ${whyItMatters}` : "";
		const blocks: BlockObjectRequest[] = [
			bullet(`${question}${tail}  · asked by ${ctx.agentName}`),
		];
		await appendToPlanSectionHelper(ctx, planPageId, "Open Questions", blocks);
		return { ok: true };
	},

	async addComment(input, ctx) {
		const r = asRecord(input);
		const target = asRecord(r.target);
		const text = asString(r.text, "text");

		let pageId: string;
		const pageIdRaw = target.page_id;
		const blockIdRaw = target.block_id;
		if (typeof pageIdRaw === "string") {
			pageId = pageIdRaw;
			await ctx.scopeGuard.assertAllowed(pageId);
		} else if (typeof blockIdRaw === "string") {
			pageId = await walkBlockToPage(ctx.notion, ctx.pacer, blockIdRaw);
			await ctx.scopeGuard.assertAllowed(pageId);
		} else {
			throw new Error("addComment: target must have page_id or block_id");
		}

		await ctx.pacer.acquire();
		const res = await ctx.notion.comments.create({
			parent: { page_id: pageId },
			rich_text: inlineRichText(text),
		});
		return { comment_id: res.id };
	},

	async setBriefStatus(input, ctx) {
		const r = asRecord(input);
		const status = asString(r.status, "status");
		await ctx.pacer.acquire();
		await setBriefProperties(ctx.notion, ctx.briefId, {
			status: status as BriefStatus,
		});
		return { updated: true };
	},

	async setBriefOwner(input, ctx) {
		const r = asRecord(input);
		const ownerRaw = r.owner;
		let owner: BriefOwner | null;
		if (ownerRaw === null) {
			owner = null;
		} else {
			owner = asString(ownerRaw, "owner") as BriefOwner;
		}
		await ctx.pacer.acquire();
		await setBriefProperties(ctx.notion, ctx.briefId, { owner });
		return { updated: true };
	},

	async setVerdict(input, ctx) {
		const r = asRecord(input);
		const verdictRaw = asString(r.verdict, "verdict");
		if (verdictRaw !== "approve" && verdictRaw !== "needs-revision") {
			throw new Error(
				`setVerdict: verdict must be "approve" or "needs-revision", got "${verdictRaw}"`,
			);
		}
		const summary = asString(r.summary, "summary");
		ctx.verdict = { verdict: verdictRaw, summary };
		if (verdictRaw === "approve") {
			await ctx.pacer.acquire();
			await setBriefProperties(ctx.notion, ctx.briefId, {
				status: "Needs Review",
			});
		}
		// `needs-revision` intentionally leaves Status as "In Progress" so the
		// orchestrator can drive the bounce-back.
		return { verdict_set: true };
	},

	async done(input, _ctx) {
		const r = asRecord(input);
		const summary = asOptString(r.summary, "summary");
		return { ok: true, summary };
	},
};

class HivemindToolDispatcher implements ToolDispatcher {
	async dispatch(
		name: string,
		input: unknown,
		ctx: AgentContext,
	): Promise<unknown> {
		const handler = HANDLERS[name];
		if (!handler) throw new Error(`Unknown tool: ${name}`);
		return handler(input, ctx as ToolHandlerContext);
	}
}

export function createDispatcher(): ToolDispatcher {
	return new HivemindToolDispatcher();
}
