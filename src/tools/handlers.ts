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

import { runAgent, type AgentContext, type ToolDispatcher } from "../agentLoop";
import { appendAudit } from "../audit";
import type { TokenBudget } from "../budget";
import {
	failRun,
	finishRun,
	startRun,
	type RunAgent,
} from "../runs";
import {
	getLibrarianSpec,
	getOracleSpec,
	getScoutSubagentSpec,
} from "../subagents";
import {
	createView,
	deleteView,
	listViews,
	queryView,
	retrieveView,
	updateView,
	type ViewType,
} from "../views";
import { getWorkspaceHomeIdsFromEnv } from "../workspaceHome";
import { getToolsForAgent, type AgentName } from "./registry";

function briefUrlFor(briefId: string): string {
	return `https://www.notion.so/${briefId.replace(/-/g, "")}`;
}

function agentDisplayName(name: ToolHandlerContext["agentName"]): string {
	if (name === "Forge" || name === "Scribe") return "Architect";
	return name;
}

async function auditIfExternal(
	ctx: ToolHandlerContext,
	op: string,
	pageId: string,
	detail?: string,
): Promise<void> {
	const scope = await ctx.scopeGuard.classifyTarget(pageId);
	if (scope !== "external") return;
	await appendAudit({
		notion: ctx.notion,
		pacer: ctx.pacer,
		agent: agentDisplayName(ctx.agentName),
		op,
		briefUrl: briefUrlFor(ctx.briefMetadata.id),
		targetPageId: pageId,
		status: "ok",
		detail,
	});
}
import {
	audio,
	bookmark,
	breadcrumb,
	bullet,
	callout,
	code,
	divider,
	embed,
	equation,
	file as fileBlock,
	heading2,
	heading3,
	image,
	linkToPage,
	mdToBlocks,
	numbered,
	paragraph,
	pdf,
	setBriefProperties,
	tableBlock,
	tableOfContents,
	todoBlock,
	toggle,
	video,
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
	agentName: "Architect" | "Scout" | "Librarian" | "Oracle" | "Forge" | "Scribe" | "Sentinel";
	/** Populated by setVerdict; read by orchestrator after agent finishes. */
	verdict?: { verdict: "approve" | "needs-revision"; summary: string };
	/** Populated by done(summary); read by parent after sub-agent finishes. */
	doneSummary?: string;
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
	| "bookmark"
	| "equation"
	| "embed"
	| "image"
	| "video"
	| "audio"
	| "pdf"
	| "file"
	| "link_to_page"
	| "table"
	| "breadcrumb"
	| "table_of_contents";

interface BlockShape {
	type: BlockShapeType;
	text?: string;
	checked?: boolean;
	language?: string;
	emoji?: string;
	color?: string;
	url?: string;
	caption?: string;
	file_upload_id?: string;
	target_page_id?: string;
	target_database_id?: string;
	rows?: string[][];
	has_column_header?: boolean;
	has_row_header?: boolean;
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
		case "equation":
			if (!b.text)
				throw new Error(
					"blockShapeToNotion: equation block requires `text` (LaTeX expression)",
				);
			return equation(b.text);
		case "embed":
			if (!b.url)
				throw new Error("blockShapeToNotion: embed block requires url");
			return embed(b.url);
		case "image":
			return image({
				url: b.url,
				file_upload_id: b.file_upload_id,
				caption: b.caption,
			});
		case "video":
			return video({
				url: b.url,
				file_upload_id: b.file_upload_id,
				caption: b.caption,
			});
		case "audio":
			return audio({
				url: b.url,
				file_upload_id: b.file_upload_id,
				caption: b.caption,
			});
		case "pdf":
			return pdf({
				url: b.url,
				file_upload_id: b.file_upload_id,
				caption: b.caption,
			});
		case "file":
			return fileBlock({
				url: b.url,
				file_upload_id: b.file_upload_id,
				caption: b.caption,
				name: b.text,
			});
		case "link_to_page":
			return linkToPage({
				page_id: b.target_page_id,
				database_id: b.target_database_id,
			});
		case "table":
			if (!b.rows || b.rows.length === 0)
				throw new Error(
					"blockShapeToNotion: table block requires non-empty `rows`",
				);
			return tableBlock({
				rows: b.rows,
				hasColumnHeader: b.has_column_header,
				hasRowHeader: b.has_row_header,
			});
		case "breadcrumb":
			return breadcrumb();
		case "table_of_contents":
			return tableOfContents();
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
		"equation",
		"embed",
		"image",
		"video",
		"audio",
		"pdf",
		"file",
		"link_to_page",
		"table",
		"breadcrumb",
		"table_of_contents",
	];
	if (!(allowed as readonly string[]).includes(t)) {
		throw new Error(`${name}.type "${t}" is not a supported block type`);
	}
	let rows: string[][] | undefined;
	if (r.rows !== undefined) {
		if (!Array.isArray(r.rows)) {
			throw new Error(`${name}.rows must be an array of arrays of strings`);
		}
		rows = r.rows.map((row, i) => {
			if (!Array.isArray(row)) {
				throw new Error(`${name}.rows[${i}] must be an array of strings`);
			}
			return row.map((cell, j) => asString(cell, `${name}.rows[${i}][${j}]`));
		});
	}
	return {
		type: t as BlockShapeType,
		text: asOptString(r.text, `${name}.text`),
		checked: typeof r.checked === "boolean" ? r.checked : undefined,
		language: asOptString(r.language, `${name}.language`),
		emoji: asOptString(r.emoji, `${name}.emoji`),
		color: asOptString(r.color, `${name}.color`),
		url: asOptString(r.url, `${name}.url`),
		caption: asOptString(r.caption, `${name}.caption`),
		file_upload_id: asOptString(r.file_upload_id, `${name}.file_upload_id`),
		target_page_id: asOptString(r.target_page_id, `${name}.target_page_id`),
		target_database_id: asOptString(
			r.target_database_id,
			`${name}.target_database_id`,
		),
		rows,
		has_column_header:
			typeof r.has_column_header === "boolean" ? r.has_column_header : undefined,
		has_row_header:
			typeof r.has_row_header === "boolean" ? r.has_row_header : undefined,
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

let cachedSubDispatcher: ToolDispatcher | undefined;
function subDispatcherSingleton(): ToolDispatcher {
	return (cachedSubDispatcher ??= new HivemindToolDispatcher());
}

function buildPropertyConfig(
	type: string,
	options: Array<{ name: string; color?: string }> | undefined,
	expression: string | undefined,
	relatedDataSourceId: string | undefined,
): Record<string, unknown> {
	switch (type) {
		case "title":
			return { type: "title", title: {} };
		case "rich_text":
			return { type: "rich_text", rich_text: {} };
		case "number":
			return { type: "number", number: { format: "number" } };
		case "select":
			return { type: "select", select: { options: options ?? [] } };
		case "multi_select":
			return {
				type: "multi_select",
				multi_select: { options: options ?? [] },
			};
		case "status":
			return { type: "status", status: { options: options ?? [] } };
		case "date":
			return { type: "date", date: {} };
		case "people":
			return { type: "people", people: {} };
		case "files":
			return { type: "files", files: {} };
		case "checkbox":
			return { type: "checkbox", checkbox: {} };
		case "url":
			return { type: "url", url: {} };
		case "email":
			return { type: "email", email: {} };
		case "phone_number":
			return { type: "phone_number", phone_number: {} };
		case "formula":
			if (!expression)
				throw new Error("formula property requires `expression`");
			return { type: "formula", formula: { expression } };
		case "relation":
			if (!relatedDataSourceId)
				throw new Error("relation property requires `related_data_source_id`");
			return {
				type: "relation",
				relation: {
					data_source_id: relatedDataSourceId,
					single_property: {},
				},
			};
		case "created_time":
			return { type: "created_time", created_time: {} };
		case "created_by":
			return { type: "created_by", created_by: {} };
		case "last_edited_time":
			return { type: "last_edited_time", last_edited_time: {} };
		case "last_edited_by":
			return { type: "last_edited_by", last_edited_by: {} };
		case "unique_id":
			return { type: "unique_id", unique_id: {} };
		case "verification":
			return { type: "verification", verification: {} };
		default:
			throw new Error(`buildPropertyConfig: unsupported type "${type}"`);
	}
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
		const dsId = ctx.projectIds.dbs.drafts.dsId;
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
		await auditIfExternal(ctx, "appendBlocks", pageId, `${blocks.length} blocks`);
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
		await auditIfExternal(ctx, "updateBlock", pageId, `block=${blockId}`);
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
		await auditIfExternal(ctx, "deleteBlock", pageId, `block=${blockId}`);
		await ctx.pacer.acquire();
		await ctx.notion.blocks.delete({ block_id: blockId });
		return { deleted: true };
	},

	async setPlanSection(input, ctx) {
		const r = asRecord(input);
		const section = asString(r.section, "section");
		const newBlocks = asBlockShapeArray(r.blocks, "blocks");
		const planPageId = ctx.projectIds.planPageId;
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
		await auditIfExternal(ctx, "createChildPage", parentId, `title=${title}`);
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

		const dsId = ctx.projectIds.dbs.drafts.dsId;
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

		const isRealDraft = draftId !== ctx.projectIds.projectRootId;
		if (isRealDraft) {
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
		}

		return { draft_id: draftId, iteration: iterationLabel, verdict };
	},

	async createSource(input, ctx) {
		const r = asRecord(input);
		const title = asString(r.title, "title");
		const url = asString(r.url, "url");
		const summary = asOptString(r.summary, "summary");

		const planPageId = ctx.projectIds.planPageId;
		await ctx.scopeGuard.assertAllowed(planPageId);
		const dsId = ctx.projectIds.dbs.sources.dsId;
		await ctx.pacer.acquire();
		const page = await ctx.notion.pages.create({
			parent: { type: "data_source_id", data_source_id: dsId },
			properties: {
				Name: { title: [{ type: "text", text: { content: title } }] },
				URL: { url },
				Summary: { rich_text: summary ? inlineRichText(summary) : [] },
				"Captured By": { select: { name: ctx.agentName } },
				"Captured At": { date: { start: new Date().toISOString() } },
			},
		});
		ctx.scopeGuard.registerCreated(page.id);

		const tail = summary ? ` — ${summary}` : "";
		const blocks: BlockObjectRequest[] = [
			bullet(`${title} (${url})${tail}  · captured by ${ctx.agentName}`),
		];
		await appendToPlanSectionHelper(ctx, planPageId, "Sources", blocks);
		return { ok: true, source_id: page.id };
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

		const planPageId = ctx.projectIds.planPageId;
		await ctx.scopeGuard.assertAllowed(planPageId);
		const dsId = ctx.projectIds.dbs.decisions.dsId;
		await ctx.pacer.acquire();
		const page = await ctx.notion.pages.create({
			parent: { type: "data_source_id", data_source_id: dsId },
			properties: {
				Name: { title: [{ type: "text", text: { content: title } }] },
				Choice: { rich_text: inlineRichText(choice) },
				Rationale: { rich_text: inlineRichText(rationale) },
				"Alternatives Considered": {
					rich_text: alternatives ? inlineRichText(alternatives.join("\n")) : [],
				},
				"Made By": { select: { name: ctx.agentName } },
				"Made At": { date: { start: new Date().toISOString() } },
			},
		});
		ctx.scopeGuard.registerCreated(page.id);

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
		return { ok: true, decision_id: page.id };
	},

	async createOpenQuestion(input, ctx) {
		const r = asRecord(input);
		const question = asString(r.question, "question");
		const whyItMatters = asOptString(r.why_it_matters, "why_it_matters");

		const planPageId = ctx.projectIds.planPageId;
		await ctx.scopeGuard.assertAllowed(planPageId);
		const dsId = ctx.projectIds.dbs.openQuestions.dsId;
		await ctx.pacer.acquire();
		const page = await ctx.notion.pages.create({
			parent: { type: "data_source_id", data_source_id: dsId },
			properties: {
				Name: { title: [{ type: "text", text: { content: question } }] },
				"Why It Matters": {
					rich_text: whyItMatters ? inlineRichText(whyItMatters) : [],
				},
				Status: { select: { name: "open" } },
				"Asked By": { select: { name: ctx.agentName } },
				"Asked At": { date: { start: new Date().toISOString() } },
			},
		});
		ctx.scopeGuard.registerCreated(page.id);

		const tail = whyItMatters ? ` — ${whyItMatters}` : "";
		const blocks: BlockObjectRequest[] = [
			bullet(`${question}${tail}  · asked by ${ctx.agentName}`),
		];
		await appendToPlanSectionHelper(ctx, planPageId, "Open Questions", blocks);
		return { ok: true, question_id: page.id };
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
			await auditIfExternal(ctx, "addComment", pageId, `text=${text.slice(0, 80)}`);
		} else if (typeof blockIdRaw === "string") {
			pageId = await walkBlockToPage(ctx.notion, ctx.pacer, blockIdRaw);
			await auditIfExternal(ctx, "addComment", pageId, `block=${blockIdRaw}`);
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

	async done(input, ctx) {
		const r = asRecord(input);
		const summary = asOptString(r.summary, "summary");
		if (summary) ctx.doneSummary = summary;
		return { ok: true, summary };
	},

	async delegateScout(input, ctx) {
		const r = asRecord(input);
		const query = asString(r.query, "query");
		const context = asOptString(r.context, "context");
		const spec = getScoutSubagentSpec();
		return runDelegation(ctx, "Scout", spec, query, context);
	},

	async delegateLibrarian(input, ctx) {
		const r = asRecord(input);
		const query = asString(r.query, "query");
		const context = asOptString(r.context, "context");
		const spec = getLibrarianSpec();
		return runDelegation(ctx, "Librarian", spec, query, context);
	},

	async delegateOracle(input, ctx) {
		const r = asRecord(input);
		const question = asString(r.question, "question");
		const context = asOptString(r.context, "context");
		const spec = getOracleSpec();
		const result = await runDelegation(ctx, "Oracle", spec, question, context);
		return {
			analysis: result.summary,
			tool_calls: result.tool_calls,
			turns: result.turns,
			tokens: result.tokens,
			duration_ms: result.duration_ms,
		};
	},

	async getWorkspaceHome(_input, _ctx) {
		const ids = getWorkspaceHomeIdsFromEnv();
		if (!ids) {
			return {
				configured: false,
				message:
					"Workspace home not configured. Admin must run `npx tsx scripts/provisionWorkspaceHome.ts` and push the resulting env vars.",
			};
		}
		return {
			configured: true,
			home_page_id: ids.homePageId,
			activity_db_id: ids.activityDbId,
			activity_ds_id: ids.activityDsId,
		};
	},

	async readPageMarkdown(input, ctx) {
		const r = asRecord(input);
		const pageId = asString(r.page_id, "page_id");
		const includeTranscript =
			typeof r.include_transcript === "boolean"
				? r.include_transcript
				: undefined;
		await ctx.pacer.acquire();
		const res = (await (ctx.notion.pages.retrieveMarkdown as unknown as (a: unknown) => Promise<{
			markdown?: string;
			results?: string;
			truncated?: boolean;
		}>)({
			page_id: pageId,
			include_transcript: includeTranscript,
		})) as { markdown?: string; results?: string; truncated?: boolean };
		return {
			markdown: res.markdown ?? res.results ?? "",
			truncated: res.truncated ?? false,
		};
	},

	async manageDatabase(input, ctx) {
		const r = asRecord(input);
		const op = asString(r.op, "op");
		await ctx.pacer.acquire();
		switch (op) {
			case "create": {
				const parentPageId = asString(r.parent_page_id, "parent_page_id");
				const title = asString(r.title, "title");
				const schema = r.schema as Record<string, unknown> | undefined;
				if (!schema || Object.keys(schema).length === 0) {
					throw new Error(
						"manageDatabase create: provide `schema` with at least one property",
					);
				}
				await auditIfExternal(ctx, "manageDatabase", parentPageId, `op=create title=${title}`);
				const res = await ctx.notion.databases.create({
					parent: { type: "page_id", page_id: parentPageId },
					title: [{ type: "text", text: { content: title } }],
					initial_data_source: { properties: schema as never },
				});
				if (!("data_sources" in res)) {
					throw new Error(
						"manageDatabase create: partial response (missing data_sources)",
					);
				}
				const primary = res.data_sources[0];
				return {
					database_id: res.id,
					data_source_id: primary?.id ?? null,
				};
			}
			case "update": {
				const databaseId = asString(r.database_id, "database_id");
				const title = asOptString(r.title, "title");
				if (!title) {
					throw new Error("manageDatabase update: provide title");
				}
				await ctx.notion.databases.update({
					database_id: databaseId,
					title: [{ type: "text", text: { content: title } }],
				});
				return { ok: true };
			}
			case "addProperty": {
				const dataSourceId = asString(r.data_source_id, "data_source_id");
				const propName = asString(r.property_name, "property_name");
				const propType = asString(r.property_type, "property_type");
				const options = Array.isArray(r.options)
					? r.options.map((o) => {
							const rec = asRecord(o);
							return {
								name: asString(rec.name, "options[].name"),
								color: asOptString(rec.color, "options[].color") as never,
							};
						})
					: undefined;
				const propConfig = buildPropertyConfig(
					propType,
					options,
					asOptString(r.expression, "expression"),
					asOptString(r.related_data_source_id, "related_data_source_id"),
				);
				await ctx.notion.dataSources.update({
					data_source_id: dataSourceId,
					properties: { [propName]: propConfig as never },
				});
				return { ok: true };
			}
			case "removeProperty": {
				const dataSourceId = asString(r.data_source_id, "data_source_id");
				const propName = asString(r.property_name, "property_name");
				await ctx.notion.dataSources.update({
					data_source_id: dataSourceId,
					properties: { [propName]: null as never },
				});
				return { ok: true };
			}
			case "listTemplates": {
				const dataSourceId = asString(r.data_source_id, "data_source_id");
				const res = (await (
					ctx.notion.dataSources as unknown as {
						templates: { list: (a: unknown) => Promise<{ results: Array<{ id: string; name?: string }> }> };
					}
				).templates.list({ data_source_id: dataSourceId })) as {
					results: Array<{ id: string; name?: string }>;
				};
				return {
					templates: res.results.map((t) => ({
						id: t.id,
						name: t.name ?? "",
					})),
				};
			}
			case "retrieve": {
				const databaseId = asString(r.database_id, "database_id");
				const res = await ctx.notion.databases.retrieve({
					database_id: databaseId,
				});
				return res;
			}
			default:
				throw new Error(`manageDatabase: unknown op "${op}"`);
		}
	},

	async createPageFromTemplate(input, ctx) {
		const r = asRecord(input);
		const dataSourceId = asString(r.data_source_id, "data_source_id");
		const templateId = asOptString(r.template_id, "template_id");
		const useDefault =
			typeof r.use_default === "boolean" ? r.use_default : false;
		const timezone = asOptString(r.timezone, "timezone");
		const properties = (r.properties as Record<string, unknown> | undefined) ?? {};
		let template:
			| { type: "default"; timezone?: string }
			| { type: "template_id"; template_id: string; timezone?: string };
		if (useDefault) {
			template = { type: "default", timezone };
		} else if (templateId) {
			template = { type: "template_id", template_id: templateId, timezone };
		} else {
			throw new Error(
				"createPageFromTemplate: provide either template_id or use_default=true",
			);
		}
		await ctx.pacer.acquire();
		const res = await ctx.notion.pages.create({
			parent: { type: "data_source_id", data_source_id: dataSourceId },
			properties: properties as never,
			template: template as never,
		});
		return { page_id: res.id };
	},

	async managePage(input, ctx) {
		const r = asRecord(input);
		const op = asString(r.op, "op");
		const pageId = asString(r.page_id, "page_id");
		await auditIfExternal(ctx, "managePage", pageId, `op=${op}`);
		await ctx.pacer.acquire();
		switch (op) {
			case "setIcon": {
				const emoji = asOptString(r.emoji, "emoji");
				const externalUrl = asOptString(r.external_url, "external_url");
				const fileUploadId = asOptString(r.file_upload_id, "file_upload_id");
				const iconName = asOptString(r.icon_name, "icon_name");
				const iconColor = asOptString(r.icon_color, "icon_color");
				let icon: Record<string, unknown> | null = null;
				if (emoji) {
					icon = { type: "emoji", emoji };
				} else if (externalUrl) {
					icon = { type: "external", external: { url: externalUrl } };
				} else if (fileUploadId) {
					icon = { type: "file_upload", file_upload: { id: fileUploadId } };
				} else if (iconName) {
					icon = {
						type: "icon",
						icon: { name: iconName, color: iconColor ?? "default" },
					};
				} else {
					throw new Error(
						"managePage setIcon: provide one of emoji / external_url / file_upload_id / icon_name",
					);
				}
				await ctx.notion.pages.update({
					page_id: pageId,
					icon: icon as never,
				});
				return { ok: true };
			}
			case "setCover": {
				const externalUrl = asOptString(r.external_url, "external_url");
				const fileUploadId = asOptString(r.file_upload_id, "file_upload_id");
				let cover: Record<string, unknown> | null = null;
				if (externalUrl) {
					cover = { type: "external", external: { url: externalUrl } };
				} else if (fileUploadId) {
					cover = { type: "file_upload", file_upload: { id: fileUploadId } };
				} else {
					throw new Error(
						"managePage setCover: provide external_url or file_upload_id",
					);
				}
				await ctx.notion.pages.update({
					page_id: pageId,
					cover: cover as never,
				});
				return { ok: true };
			}
			case "setTitle": {
				const title = asString(r.title, "title");
				await ctx.notion.pages.update({
					page_id: pageId,
					properties: {
						title: {
							title: [{ type: "text", text: { content: title } }],
						},
					},
				});
				return { ok: true };
			}
			case "move": {
				const newParentPageId = asOptString(
					r.new_parent_page_id,
					"new_parent_page_id",
				);
				const newParentDsId = asOptString(
					r.new_parent_data_source_id,
					"new_parent_data_source_id",
				);
				let parent: Record<string, unknown>;
				if (newParentPageId) {
					parent = { type: "page_id", page_id: newParentPageId };
				} else if (newParentDsId) {
					parent = { type: "data_source_id", data_source_id: newParentDsId };
				} else {
					throw new Error(
						"managePage move: provide new_parent_page_id or new_parent_data_source_id",
					);
				}
				await (
					ctx.notion.pages.move as unknown as (a: unknown) => Promise<unknown>
				)({
					page_id: pageId,
					parent,
				});
				return { ok: true };
			}
			case "trash": {
				await ctx.notion.pages.update({
					page_id: pageId,
					in_trash: true,
				});
				return { ok: true };
			}
			case "restore": {
				await ctx.notion.pages.update({
					page_id: pageId,
					in_trash: false,
				});
				return { ok: true };
			}
			default:
				throw new Error(`managePage: unknown op "${op}"`);
		}
	},

	async uploadFile(input, ctx) {
		const r = asRecord(input);
		const externalUrl = asString(r.external_url, "external_url");
		const filename = asOptString(r.filename, "filename");
		const contentType = asOptString(r.content_type, "content_type");
		await ctx.pacer.acquire();
		const res = (await (
			ctx.notion.fileUploads.create as unknown as (a: unknown) => Promise<{
				id: string;
				status?: string;
			}>
		)({
			mode: "external_url",
			external_url: externalUrl,
			filename,
			content_type: contentType,
		})) as { id: string; status?: string };
		return {
			file_upload_id: res.id,
			status: res.status ?? "pending",
		};
	},

	async manageView(input, ctx) {
		const r = asRecord(input);
		const op = asString(r.op, "op");
		await ctx.pacer.acquire();
		switch (op) {
			case "create": {
				const dataSourceId = asString(r.data_source_id, "data_source_id");
				const name = asString(r.name, "name");
				const type = asString(r.type, "type") as ViewType;
				const databaseId = asOptString(r.database_id, "database_id");
				return createView(ctx.notion, {
					database_id: databaseId,
					data_source_id: dataSourceId,
					name,
					type,
					filter: r.filter as Record<string, unknown> | undefined,
					sorts: r.sorts as Array<Record<string, unknown>> | undefined,
					quick_filters: r.quick_filters as
						| Record<string, unknown>
						| undefined,
					configuration: r.configuration as
						| Record<string, unknown>
						| undefined,
					position: r.position as Record<string, unknown> | undefined,
				});
			}
			case "update": {
				const viewId = asString(r.view_id, "view_id");
				return updateView(ctx.notion, {
					view_id: viewId,
					name: asOptString(r.name, "name"),
					filter: r.filter as Record<string, unknown> | undefined,
					sorts: r.sorts as Array<Record<string, unknown>> | undefined,
					quick_filters: r.quick_filters as
						| Record<string, unknown>
						| undefined,
					configuration: r.configuration as
						| Record<string, unknown>
						| undefined,
				});
			}
			case "list": {
				const databaseId = asOptString(r.database_id, "database_id");
				const dataSourceId = asOptString(r.data_source_id, "data_source_id");
				if (!databaseId && !dataSourceId) {
					throw new Error(
						"manageView list: provide either database_id or data_source_id",
					);
				}
				return {
					views: await listViews(ctx.notion, {
						database_id: databaseId,
						data_source_id: dataSourceId,
					}),
				};
			}
			case "retrieve": {
				const viewId = asString(r.view_id, "view_id");
				return retrieveView(ctx.notion, viewId);
			}
			case "delete": {
				const viewId = asString(r.view_id, "view_id");
				await deleteView(ctx.notion, viewId);
				return { ok: true };
			}
			case "addWidget": {
				const dashboardViewId = asString(r.dashboard_view_id, "dashboard_view_id");
				const dataSourceId = asString(r.data_source_id, "data_source_id");
				const name = asString(r.name, "name");
				const type = asString(r.type, "type") as ViewType;
				return createView(ctx.notion, {
					view_id: dashboardViewId,
					data_source_id: dataSourceId,
					name,
					type,
					filter: r.filter as Record<string, unknown> | undefined,
					sorts: r.sorts as Array<Record<string, unknown>> | undefined,
					configuration: r.configuration as
						| Record<string, unknown>
						| undefined,
					placement: r.placement as Record<string, unknown> | undefined,
				});
			}
			case "createLinkedDatabase": {
				const targetPageId = asString(r.target_page_id, "target_page_id");
				await auditIfExternal(
					ctx,
					"manageView",
					targetPageId,
					"op=createLinkedDatabase",
				);
				const dataSourceId = asString(r.data_source_id, "data_source_id");
				const name = asString(r.name, "name");
				const type = asString(r.type, "type") as ViewType;
				return createView(ctx.notion, {
					create_database: {
						parent: { type: "page_id", page_id: targetPageId },
					},
					data_source_id: dataSourceId,
					name,
					type,
					configuration: r.configuration as
						| Record<string, unknown>
						| undefined,
				});
			}
			case "query": {
				const viewId = asString(r.view_id, "view_id");
				const pageSize = asOptNumber(r.page_size, "page_size");
				const startCursor = asOptString(r.start_cursor, "start_cursor");
				return queryView(ctx.notion, {
					view_id: viewId,
					page_size: pageSize,
					start_cursor: startCursor,
				});
			}
			default:
				throw new Error(`manageView: unknown op "${op}"`);
		}
	},

	async writePageMarkdown(input, ctx) {
		const r = asRecord(input);
		const pageId = asString(r.page_id, "page_id");
		const mode = asString(r.mode, "mode");
		await auditIfExternal(ctx, "writePageMarkdown", pageId, `mode=${mode}`);
		await ctx.pacer.acquire();
		const allowDelete =
			typeof r.allow_deleting_content === "boolean"
				? r.allow_deleting_content
				: false;
		let body: Record<string, unknown>;
		switch (mode) {
			case "append": {
				const content = asString(r.content, "content");
				const after = asOptString(r.after, "after");
				body = {
					type: "insert_content",
					insert_content: { content, after },
				};
				break;
			}
			case "replace": {
				const content = asString(r.content, "content");
				body = {
					type: "replace_content",
					replace_content: {
						new_str: content,
						allow_deleting_content: allowDelete,
					},
				};
				break;
			}
			case "replace_range": {
				const content = asString(r.content, "content");
				const contentRange = asString(r.content_range, "content_range");
				body = {
					type: "replace_content_range",
					replace_content_range: {
						content,
						content_range: contentRange,
						allow_deleting_content: allowDelete,
					},
				};
				break;
			}
			case "update": {
				if (!Array.isArray(r.updates)) {
					throw new Error("writePageMarkdown: update mode requires `updates` array");
				}
				const updates = r.updates.map((u, i) => {
					const rec = asRecord(u);
					return {
						old_str: asString(rec.old_str, `updates[${i}].old_str`),
						new_str: asString(rec.new_str, `updates[${i}].new_str`),
						replace_all_matches:
							typeof rec.replace_all_matches === "boolean"
								? rec.replace_all_matches
								: undefined,
					};
				});
				body = {
					type: "update_content",
					update_content: {
						content_updates: updates,
						allow_deleting_content: allowDelete,
					},
				};
				break;
			}
			default:
				throw new Error(`writePageMarkdown: unknown mode "${mode}"`);
		}
		await (ctx.notion.pages.updateMarkdown as unknown as (a: unknown) => Promise<unknown>)(
			{
				page_id: pageId,
				...body,
			},
		);
		return { ok: true };
	},
};

interface DelegationResult {
	summary: string;
	tool_calls: number;
	turns: number;
	tokens: number;
	duration_ms: number;
}

const SUB_AGENT_EMOJI: Record<AgentName, string> = {
	Architect: "🧠",
	Scout: "🔍",
	Librarian: "📚",
	Oracle: "🔮",
	Forge: "🔨",
	Scribe: "✍️",
	Sentinel: "🛡️",
};

function formatTokensCompact(n: number): string {
	if (n < 1000) return String(n);
	return `${(n / 1000).toFixed(1)}k`;
}

function formatDurationCompact(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

async function runDelegation(
	parentCtx: ToolHandlerContext,
	subAgent: AgentName,
	spec: {
		model: string;
		systemPrompt: string;
		stepBudget: number;
		taskBudgetTokens: number;
		thinking?: { type: "enabled"; budget_tokens: number };
	},
	query: string,
	context: string | undefined,
): Promise<DelegationResult> {
	const subTools = getToolsForAgent(subAgent);

	const subCtx: ToolHandlerContext = {
		...parentCtx,
		agentName: subAgent,
		doneSummary: undefined,
		verdict: undefined,
	};

	const initialUserMessage = context
		? `Query: ${query}\n\nContext: ${context}`
		: `Query: ${query}`;

	const runsDsId = parentCtx.projectIds.dbs.runs?.dsId;
	const runAgentName = subAgent as RunAgent;
	const workspaceIds = getWorkspaceHomeIdsFromEnv();
	const tokensBefore = parentCtx.tokenBudget.usage;
	const tStart = Date.now();

	const runIds = runsDsId
		? await startRun({
				notion: parentCtx.notion,
				pacer: parentCtx.pacer,
				dsId: runsDsId,
				agent: runAgentName,
				label: `${SUB_AGENT_EMOJI[subAgent] ?? "•"} ${subAgent}: ${query.slice(0, 80)}${query.length > 80 ? "…" : ""}`,
				mirror: workspaceIds
					? {
							activityDsId: workspaceIds.activityDsId,
							briefUrl: briefUrlFor(parentCtx.briefMetadata.id),
							briefTitle: parentCtx.briefMetadata.title,
						}
					: undefined,
			}).catch((err: unknown) => {
				console.warn("[handlers] startRun failed:", err);
				return undefined;
			})
		: undefined;

	try {
		const result = await runAgent({
			systemPrompt: spec.systemPrompt,
			initialUserMessage,
			tools: subTools,
			dispatcher: subDispatcherSingleton(),
			ctx: subCtx,
			model: spec.model,
			stepBudget: spec.stepBudget,
			taskBudgetTokens: spec.taskBudgetTokens,
			thinking: spec.thinking,
		});

		const summary =
			(subCtx.doneSummary && subCtx.doneSummary.trim()) ||
			result.finalText.trim() ||
			`(${subAgent} returned no summary — see Sources for findings)`;
		const tokensDelta = parentCtx.tokenBudget.usage - tokensBefore;
		const durationMs = Date.now() - tStart;

		if (runIds) {
			await finishRun({
				notion: parentCtx.notion,
				pacer: parentCtx.pacer,
				runRowId: runIds.runRowId,
				activityRowId: runIds.activityRowId,
				durationMs,
				tokens: tokensDelta,
				toolCalls: result.toolCallsConsumed,
				summary,
				verdict: subCtx.verdict?.verdict,
			});
		}

		await logSubDelegation(parentCtx, {
			subAgent,
			query,
			summary,
			toolCalls: result.toolCallsConsumed,
			tokens: tokensDelta,
			durationMs,
		});

		return {
			summary,
			tool_calls: result.toolCallsConsumed,
			turns: result.turns,
			tokens: tokensDelta,
			duration_ms: durationMs,
		};
	} catch (err) {
		const tokensDelta = parentCtx.tokenBudget.usage - tokensBefore;
		const durationMs = Date.now() - tStart;
		if (runIds) {
			await failRun({
				notion: parentCtx.notion,
				pacer: parentCtx.pacer,
				runRowId: runIds.runRowId,
				activityRowId: runIds.activityRowId,
				durationMs,
				tokens: tokensDelta,
				errorMsg: err instanceof Error ? err.message : String(err),
			});
		}
		throw err;
	}
}

async function logSubDelegation(
	parentCtx: ToolHandlerContext,
	args: {
		subAgent: AgentName;
		query: string;
		summary: string;
		toolCalls: number;
		tokens: number;
		durationMs: number;
	},
): Promise<void> {
	const activityPageId = parentCtx.projectIds.activityPageId;
	if (!activityPageId) return;
	const emoji = SUB_AGENT_EMOJI[args.subAgent] ?? "•";
	const headline = `${emoji} ${args.subAgent} → "${args.query.slice(0, 80)}${args.query.length > 80 ? "…" : ""}" · ${args.toolCalls} tools · ${formatDurationCompact(args.durationMs)} · ${formatTokensCompact(args.tokens)} tokens`;
	const children: BlockObjectRequest[] = [paragraph(args.summary)];
	try {
		await parentCtx.pacer.acquire();
		await parentCtx.notion.blocks.children.append({
			block_id: activityPageId,
			children: [toggle(headline, children)],
		});
	} catch (err) {
		console.warn(
			`[handlers] logSubDelegation(${args.subAgent}) failed:`,
			err,
		);
	}
}

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
