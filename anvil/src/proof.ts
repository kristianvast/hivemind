import { readFile } from "node:fs/promises";

import { Client } from "@notionhq/client";
import type { BlockObjectRequest, UpdatePageParameters } from "@notionhq/client";

import { getConfig } from "./config.js";
import { log } from "./log.js";
import type { Proof } from "./types.js";

type RichTextItem = { type: "text"; text: { content: string; link?: { url: string } | null } };
type PageUpdateProperties = NonNullable<UpdatePageParameters["properties"]>;

interface ProofRecord {
	devUrl?: string;
	publicUrl?: string;
	screenshotPath?: string;
	screenshot?: { path?: string };
	consoleErrors?: unknown;
	failedRequests?: unknown;
	failedNetworkRequests?: unknown;
	commitSha?: string;
	prUrl?: string;
	repoUrl?: string;
}

let notionClient: Client | null = null;

export async function writeProofToNotion(opts: {
	briefId: string;
	projectRootPageId: string | null;
	proof: Proof;
	summary: string;
}): Promise<void> {
	const config = getConfig();
	if (String(config.MOCK_MODE) === "true") {
		log.info("[MOCK] would upload proof", {
			briefId: opts.briefId,
			projectRootPageId: opts.projectRootPageId,
			summary: opts.summary,
		});
		return;
	}

	const proof = opts.proof as Proof & ProofRecord;
	const notion = getNotion();
	const devUrl = proof.devUrl ?? proof.publicUrl ?? "";
	const consoleErrors = normalizeStringList(proof.consoleErrors);
	const failedRequests = normalizeStringList(
		proof.failedRequests ?? proof.failedNetworkRequests,
	);
	const commitSha = proof.commitSha ?? "";
	const prUrl = proof.prUrl ?? "";
	const repoUrl = proof.repoUrl ?? "";

	if (opts.projectRootPageId) {
		const screenshotPath = proof.screenshotPath ?? proof.screenshot?.path;
		if (!screenshotPath) {
			throw new Error("writeProofToNotion: proof is missing screenshotPath");
		}
		const fileUploadId = await uploadScreenshot(notion, screenshotPath);
		await notion.blocks.children.append({
			block_id: opts.projectRootPageId,
			children: buildProofBlocks({
				fileUploadId,
				summary: opts.summary,
				consoleErrors,
				failedRequests,
				devUrl,
				commitSha,
				prUrl,
				repoUrl,
			}),
		});
	} else {
		log.warn("[proof] project root missing; skipping proof block append", {
			briefId: opts.briefId,
		});
	}

	const properties: PageUpdateProperties = {
		Repo: { url: repoUrl.length > 0 ? repoUrl : null },
		"PR URL": { url: prUrl.length > 0 ? prUrl : null },
		Status: { select: { name: "Done" } },
		Owner: { select: { name: "Forge-Local" } },
	};
	await notion.pages.update({ page_id: opts.briefId, properties });
}

function getNotion(): Client {
	if (notionClient) return notionClient;
	const config = getConfig();
	notionClient = new Client({ auth: config.NOTION_API_TOKEN });
	return notionClient;
}

async function uploadScreenshot(
	notion: Client,
	screenshotPath: string,
): Promise<string> {
	const data = await readFile(screenshotPath);
	const upload = await notion.fileUploads.create({
		filename: "proof.png",
		content_type: "image/png",
	});
	const fileBlob = new Blob([new Uint8Array(data)], { type: "image/png" });
	await notion.fileUploads.send({
		file_upload_id: upload.id,
		file: {
			filename: "proof.png",
			data: fileBlob,
		},
	});
	return upload.id;
}

function buildProofBlocks(args: {
	fileUploadId: string;
	summary: string;
	consoleErrors: string[];
	failedRequests: string[];
	devUrl: string;
	commitSha: string;
	prUrl: string;
	repoUrl: string;
}): BlockObjectRequest[] {
	return [
		heading2("Proof"),
		imageBlock(args.fileUploadId),
		quoteBlock(args.summary),
		dividerBlock(),
		codeBlock(
			args.consoleErrors.length > 0 ? args.consoleErrors.join("\n") : "(none)",
		),
		codeBlock(
			args.failedRequests.length > 0 ? args.failedRequests.join("\n") : "(none)",
		),
		paragraphLinks(args),
	];
}

function heading2(text: string): BlockObjectRequest {
	return {
		type: "heading_2",
		heading_2: { rich_text: richText(text) },
	};
}

function imageBlock(fileUploadId: string): BlockObjectRequest {
	return {
		type: "image",
		image: {
			type: "file_upload",
			file_upload: { id: fileUploadId },
		},
	} as unknown as BlockObjectRequest;
}

function quoteBlock(text: string): BlockObjectRequest {
	return {
		type: "quote",
		quote: { rich_text: richText(text) },
	};
}

function dividerBlock(): BlockObjectRequest {
	return { type: "divider", divider: {} };
}

function codeBlock(text: string): BlockObjectRequest {
	return {
		type: "code",
		code: {
			rich_text: richText(text),
			language: "plain text" as never,
		},
	};
}

function paragraphLinks(args: {
	devUrl: string;
	commitSha: string;
	prUrl: string;
	repoUrl: string;
}): BlockObjectRequest {
	const rich_text: RichTextItem[] = [];
	appendLabelAndLink(rich_text, "Dev URL", args.devUrl);
	appendPlain(rich_text, "\nCommit SHA: ");
	appendPlain(rich_text, args.commitSha.length > 0 ? args.commitSha : "(unknown)");
	appendLabelAndLink(rich_text, "\nPR URL", args.prUrl);
	appendLabelAndLink(rich_text, "\nRepo", args.repoUrl);
	return { type: "paragraph", paragraph: { rich_text } };
}

function appendLabelAndLink(
	items: RichTextItem[],
	label: string,
	url: string,
): void {
	appendPlain(items, `${label}: `);
	if (url.length === 0) {
		appendPlain(items, "(unknown)");
		return;
	}
	items.push({ type: "text", text: { content: url, link: { url } } });
}

function appendPlain(items: RichTextItem[], content: string): void {
	items.push({ type: "text", text: { content } });
}

function richText(text: string): RichTextItem[] {
	if (text.length === 0) return [{ type: "text", text: { content: "" } }];
	return chunk(text, 1900).map((content) => ({
		type: "text",
		text: { content },
	}));
}

function chunk(text: string, size: number): string[] {
	if (text.length <= size) return [text];
	const chunks: string[] = [];
	let offset = 0;
	while (offset < text.length) {
		chunks.push(text.slice(offset, offset + size));
		offset += size;
	}
	return chunks;
}

function normalizeStringList(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map((item) => {
			if (typeof item === "string") return item;
			const serialized = JSON.stringify(item);
			return serialized ?? String(item);
		});
	}
	if (typeof value === "string") return value.length > 0 ? [value] : [];
	if (value === undefined || value === null) return [];
	const serialized = JSON.stringify(value);
	return [serialized ?? String(value)];
}
