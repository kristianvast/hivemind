// Status/Owner use `select` not Notion's `status` type — `status` options are uneditable post-creation.

import type { Client } from "@notionhq/client";
import { isFullPage } from "@notionhq/client";
import type {
	BlockObjectRequest,
	PageObjectResponse,
} from "@notionhq/client";

export interface BriefContext {
	pageId: string;
	title: string;
	body: string;
	status: string | null;
}

function titleFromPage(page: PageObjectResponse): string {
	for (const value of Object.values(page.properties)) {
		if (value.type === "title") {
			return value.title.map((rt) => rt.plain_text).join("");
		}
	}
	return "";
}

function statusFromPage(page: PageObjectResponse): string | null {
	const prop = page.properties.Status;
	if (prop?.type === "select") return prop.select?.name ?? null;
	if (prop?.type === "status") return prop.status?.name ?? null;
	return null;
}

async function readPageBody(notion: Client, pageId: string): Promise<string> {
	const lines: string[] = [];
	let cursor: string | undefined;
	do {
		const res = await notion.blocks.children.list({
			block_id: pageId,
			start_cursor: cursor,
			page_size: 100,
		});
		for (const block of res.results) {
			if (!("type" in block)) continue;
			const stringified = stringifyBlock(block);
			if (stringified !== null) lines.push(stringified);
		}
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);
	return lines.join("\n").trim();
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
		default:
			return null;
	}
}

export async function getBriefContext(
	notion: Client,
	page: PageObjectResponse,
): Promise<BriefContext> {
	const title = titleFromPage(page);
	const body = await readPageBody(notion, page.id);
	return {
		pageId: page.id,
		title,
		body,
		status: statusFromPage(page),
	};
}

export { isFullPage };
export type { PageObjectResponse };

export interface PriorChainState {
	hasForge: boolean;
	previousArtifact: string;
	iteration: number;
	scoutNotes: string;
}

export async function readPriorChainState(
	notion: Client,
	pageId: string,
): Promise<PriorChainState> {
	let hasForge = false;
	let inForgeSection = false;
	let inScoutSection = false;
	let iteration = 0;
	const forgeBuffer: string[] = [];
	const scoutBuffer: string[] = [];

	let cursor: string | undefined;
	do {
		const res = await notion.blocks.children.list({
			block_id: pageId,
			start_cursor: cursor,
			page_size: 100,
		});
		for (const block of res.results) {
			if (!("type" in block)) continue;
			if (block.type === "heading_2") {
				const h = block.heading_2 as { rich_text: { plain_text: string }[] };
				const headingText = richTextToPlain(h.rich_text);
				if (/Forge/i.test(headingText)) {
					hasForge = true;
					inForgeSection = true;
					inScoutSection = false;
					iteration += 1;
					continue;
				}
				if (/Scout/i.test(headingText)) {
					inScoutSection = true;
					inForgeSection = false;
					continue;
				}
				inForgeSection = false;
				inScoutSection = false;
				continue;
			}
			const stringified = stringifyBlock(block);
			if (stringified === null) continue;
			if (inForgeSection) forgeBuffer.push(stringified);
			if (inScoutSection) scoutBuffer.push(stringified);
		}
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);

	return {
		hasForge,
		previousArtifact: forgeBuffer.join("\n").trim(),
		iteration,
		scoutNotes: scoutBuffer.join("\n").trim(),
	};
}

export async function listReviewerFeedback(
	notion: Client,
	pageId: string,
	botUserId: string | undefined,
): Promise<string> {
	const allComments: string[] = [];
	let cursor: string | undefined;
	do {
		const res = await notion.comments.list({
			block_id: pageId,
			start_cursor: cursor,
			page_size: 100,
		});
		for (const c of res.results) {
			if (botUserId && c.created_by.id === botUserId) continue;
			const text = c.rich_text.map((rt) => rt.plain_text).join("");
			if (text.trim().length > 0) allComments.push(text.trim());
		}
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);
	return allComments.join("\n\n---\n\n");
}

export type BriefStatus =
	| "Backlog"
	| "Triaged"
	| "In Progress"
	| "Needs Review"
	| "Done"
	| "Failed"
	| "Archived";

export type BriefOwner =
	| "Triage"
	| "Architect"
	| "Scout"
	| "Forge"
	| "Scribe"
	| "Sentinel";

export async function setBriefProperties(
	notion: Client,
	pageId: string,
	patch: { status?: BriefStatus; owner?: BriefOwner | null },
): Promise<void> {
	const properties: Record<
		string,
		{ select: { name: string } | null } | { select: { name: string } }
	> = {};
	if (patch.status !== undefined) {
		properties.Status = { select: { name: patch.status } };
	}
	if (patch.owner !== undefined) {
		properties.Owner =
			patch.owner === null ? { select: null } : { select: { name: patch.owner } };
	}
	if (Object.keys(properties).length === 0) return;
	await notion.pages.update({ page_id: pageId, properties });
}

export async function appendBlocks(
	notion: Client,
	pageId: string,
	blocks: BlockObjectRequest[],
): Promise<void> {
	if (blocks.length === 0) return;
	// Notion caps `children` array length per request at 100.
	for (let i = 0; i < blocks.length; i += 100) {
		await notion.blocks.children.append({
			block_id: pageId,
			children: blocks.slice(i, i + 100),
		});
	}
}

export async function postComment(
	notion: Client,
	pageId: string,
	text: string,
): Promise<void> {
	await notion.comments.create({
		parent: { page_id: pageId },
		rich_text: [{ type: "text", text: { content: text } }],
	});
}

const NOTION_RICH_TEXT_LIMIT = 1900;

function chunk(text: string, size = NOTION_RICH_TEXT_LIMIT): string[] {
	if (text.length <= size) return [text];
	const out: string[] = [];
	let i = 0;
	while (i < text.length) {
		let end = Math.min(i + size, text.length);
		if (end < text.length) {
			const lastSpace = text.lastIndexOf(" ", end);
			if (lastSpace > i + size / 2) end = lastSpace + 1;
		}
		out.push(text.slice(i, end));
		i = end;
	}
	return out;
}

function rt(content: string): { type: "text"; text: { content: string } }[] {
	if (content.length === 0) {
		return [{ type: "text", text: { content: "" } }];
	}
	return chunk(content).map((c) => ({ type: "text", text: { content: c } }));
}

export function heading2(text: string): BlockObjectRequest {
	return { type: "heading_2", heading_2: { rich_text: rt(text) } };
}

export function heading1(text: string): BlockObjectRequest {
	return { type: "heading_1", heading_1: { rich_text: rt(text) } };
}

export function heading3(text: string): BlockObjectRequest {
	return { type: "heading_3", heading_3: { rich_text: rt(text) } };
}

export function paragraph(text: string): BlockObjectRequest {
	return { type: "paragraph", paragraph: { rich_text: rt(text) } };
}

export function bullet(text: string): BlockObjectRequest {
	return {
		type: "bulleted_list_item",
		bulleted_list_item: { rich_text: rt(text) },
	};
}

export function numbered(text: string): BlockObjectRequest {
	return {
		type: "numbered_list_item",
		numbered_list_item: { rich_text: rt(text) },
	};
}

export function code(text: string, language = "plain text"): BlockObjectRequest {
	// Notion's `language` field is a strict enum at the type level; the SDK's
	// LanguageRequest is permissive at runtime but we still need the cast.
	return {
		type: "code",
		code: {
			rich_text: rt(text),
			language: language as never,
		},
	};
}

/**
 * Convert a small subset of markdown to Notion blocks. Designed for the
 * structured-but-simple output of Scout / Forge — not a full md parser.
 *
 * Supported:
 *   ## heading      → heading_2
 *   ### heading     → heading_3
 *   #### heading    → heading_3 (Notion has heading_4 but it's noisier)
 *   - item / * item → bulleted_list_item
 *   1. item         → numbered_list_item
 *   ```lang … ```   → code block
 *   (blank line)    → paragraph break
 *   anything else   → paragraph (consecutive lines joined with \n)
 */
export function mdToBlocks(md: string): BlockObjectRequest[] {
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	const out: BlockObjectRequest[] = [];
	let para: string[] = [];

	const flushPara = (): void => {
		if (para.length === 0) return;
		const text = para.join("\n").trim();
		if (text.length > 0) out.push(paragraph(text));
		para = [];
	};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const trimmed = line.trim();

		if (trimmed.startsWith("```")) {
			flushPara();
			const lang = trimmed.slice(3).trim() || "plain text";
			const buf: string[] = [];
			i += 1;
			while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
				buf.push(lines[i] ?? "");
				i += 1;
			}
			out.push(code(buf.join("\n"), lang));
			i += 1;
			continue;
		}

		if (trimmed.length === 0) {
			flushPara();
			i += 1;
			continue;
		}

		const h2 = /^##\s+(.*)$/.exec(trimmed);
		const h3 = /^###\s+(.*)$/.exec(trimmed);
		const h4 = /^####\s+(.*)$/.exec(trimmed);
		const h1 = /^#\s+(.*)$/.exec(trimmed);
		const bul = /^[-*]\s+(.*)$/.exec(trimmed);
		const num = /^\d+\.\s+(.*)$/.exec(trimmed);

		if (h2) {
			flushPara();
			out.push(heading2(h2[1] ?? ""));
		} else if (h3 || h4) {
			flushPara();
			out.push(heading3((h3 ?? h4)?.[1] ?? ""));
		} else if (h1) {
			flushPara();
			// Map # to heading_2 to avoid two clashing top-level "## Scout / ## Forge"
			// banners + a competing # from agent output.
			out.push(heading2(h1[1] ?? ""));
		} else if (bul) {
			flushPara();
			out.push(bullet(bul[1] ?? ""));
		} else if (num) {
			flushPara();
			out.push(numbered(num[1] ?? ""));
		} else {
			para.push(line);
		}
		i += 1;
	}

	flushPara();
	return out;
}

export function divider(): BlockObjectRequest {
	return { type: "divider", divider: {} };
}

export function callout(
	text: string,
	emoji?: string,
	color?: string,
	children?: BlockObjectRequest[],
): BlockObjectRequest {
	return {
		type: "callout",
		callout: {
			rich_text: rt(text),
			icon: emoji ? { type: "emoji", emoji: emoji as never } : undefined,
			color: (color ?? "default") as never,
			children: children as never,
		},
	};
}

export function tableOfContents(color = "gray"): BlockObjectRequest {
	return {
		type: "table_of_contents",
		table_of_contents: { color: color as never },
	};
}

export function columnList(
	columns: { widthRatio?: number; children: BlockObjectRequest[] }[],
): BlockObjectRequest {
	return {
		type: "column_list",
		column_list: {
			children: columns.map((column) => ({
				type: "column",
				column: {
					width_ratio: column.widthRatio,
					children: column.children,
				},
			})),
		} as never,
	};
}

export function toggle(
	text: string,
	children?: BlockObjectRequest[],
): BlockObjectRequest {
	return {
		type: "toggle",
		toggle: {
			rich_text: rt(text),
			children: (children ?? []) as never,
		},
	};
}

export function todoBlock(text: string, checked?: boolean): BlockObjectRequest {
	return {
		type: "to_do",
		to_do: {
			rich_text: rt(text),
			checked: checked ?? false,
		},
	};
}

export function bookmark(url: string): BlockObjectRequest {
	return {
		type: "bookmark",
		bookmark: { url },
	};
}

export function equation(expression: string): BlockObjectRequest {
	return {
		type: "equation",
		equation: { expression },
	};
}

export function embed(url: string): BlockObjectRequest {
	return {
		type: "embed",
		embed: { url },
	};
}

interface FileLike {
	url?: string;
	file_upload_id?: string;
	caption?: string;
}

function buildExternalOrUpload(
	source: FileLike,
):
	| { type: "external"; external: { url: string } }
	| { type: "file_upload"; file_upload: { id: string } } {
	if (source.url) {
		return { type: "external", external: { url: source.url } };
	}
	if (source.file_upload_id) {
		return {
			type: "file_upload",
			file_upload: { id: source.file_upload_id },
		};
	}
	throw new Error(
		"buildExternalOrUpload: either `url` or `file_upload_id` is required",
	);
}

export function image(source: FileLike): BlockObjectRequest {
	const inner = buildExternalOrUpload(source);
	return {
		type: "image",
		image: {
			...inner,
			caption: source.caption ? rt(source.caption) : undefined,
		} as never,
	};
}

export function video(source: FileLike): BlockObjectRequest {
	const inner = buildExternalOrUpload(source);
	return {
		type: "video",
		video: {
			...inner,
			caption: source.caption ? rt(source.caption) : undefined,
		} as never,
	};
}

export function audio(source: FileLike): BlockObjectRequest {
	const inner = buildExternalOrUpload(source);
	return {
		type: "audio",
		audio: {
			...inner,
			caption: source.caption ? rt(source.caption) : undefined,
		} as never,
	};
}

export function pdf(source: FileLike): BlockObjectRequest {
	const inner = buildExternalOrUpload(source);
	return {
		type: "pdf",
		pdf: {
			...inner,
			caption: source.caption ? rt(source.caption) : undefined,
		} as never,
	};
}

export function file(
	source: FileLike & { name?: string },
): BlockObjectRequest {
	const inner = buildExternalOrUpload(source);
	return {
		type: "file",
		file: {
			...inner,
			name: source.name,
			caption: source.caption ? rt(source.caption) : undefined,
		} as never,
	};
}

export function linkToPage(args: {
	page_id?: string;
	database_id?: string;
}): BlockObjectRequest {
	if (args.page_id) {
		return {
			type: "link_to_page",
			link_to_page: { type: "page_id", page_id: args.page_id },
		};
	}
	if (args.database_id) {
		return {
			type: "link_to_page",
			link_to_page: {
				type: "database_id",
				database_id: args.database_id,
			} as never,
		};
	}
	throw new Error("linkToPage: either page_id or database_id is required");
}

export function tableBlock(args: {
	rows: string[][];
	hasColumnHeader?: boolean;
	hasRowHeader?: boolean;
}): BlockObjectRequest {
	const width = args.rows[0]?.length ?? 0;
	if (width === 0) {
		throw new Error("tableBlock: rows must be non-empty");
	}
	if (args.rows.some((r) => r.length !== width)) {
		throw new Error("tableBlock: every row must have the same number of cells");
	}
	const rowBlocks: BlockObjectRequest[] = args.rows.map((row) => ({
		type: "table_row",
		table_row: {
			cells: row.map((cell) => rt(cell)),
		},
	}));
	return {
		type: "table",
		table: {
			table_width: width,
			has_column_header: args.hasColumnHeader ?? false,
			has_row_header: args.hasRowHeader ?? false,
			children: rowBlocks as never,
		},
	};
}

export function syncedBlock(args: {
	syncedFromBlockId?: string;
	children?: BlockObjectRequest[];
}): BlockObjectRequest {
	if (args.syncedFromBlockId) {
		return {
			type: "synced_block",
			synced_block: {
				synced_from: { block_id: args.syncedFromBlockId } as never,
			},
		};
	}
	return {
		type: "synced_block",
		synced_block: {
			synced_from: null,
			children: (args.children ?? []) as never,
		},
	};
}

export function breadcrumb(): BlockObjectRequest {
	return { type: "breadcrumb", breadcrumb: {} };
}

export async function reportChainFailure(
	notion: Client,
	pageId: string,
	stage: string,
	err: unknown,
): Promise<void> {
	const message = err instanceof Error ? err.message : String(err);
	const stack = err instanceof Error && err.stack ? err.stack : "";
	const trace = [stage, message, stack].filter((s) => s.length > 0).join("\n");

	try {
		await setBriefProperties(notion, pageId, { status: "Failed" });
	} catch (e) {
		// Swallow — we still want to post the comment with the original error.
		console.warn("[reportChainFailure] failed to set Status=Failed:", e);
	}

	try {
		await appendBlocks(notion, pageId, [
			heading3(`⚠️ Hivemind chain failed (${stage})`),
			code(trace.slice(0, 4000), "plain text"),
		]);
	} catch (e) {
		console.warn("[reportChainFailure] failed to append error blocks:", e);
		// Best-effort: try a comment instead.
		try {
			await postComment(notion, pageId, `Hivemind failed at ${stage}: ${message}`);
		} catch (commentErr) {
			console.warn("[reportChainFailure] also failed to post comment:", commentErr);
		}
	}
}
