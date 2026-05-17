import { Client, isFullDatabase, isFullPage } from "@notionhq/client";
import type { PageObjectResponse, UpdatePageParameters } from "@notionhq/client";

import { getConfig } from "./config.js";
import { log } from "./log.js";
import type { Brief } from "./types.js";

type PageProperties = PageObjectResponse["properties"];
type PageUpdateProperties = NonNullable<UpdatePageParameters["properties"]>;

let notionClient: Client | null = null;
let briefsDataSourceId: string | null = null;

export async function loadBrief(briefId: string): Promise<Brief> {
	const notion = getNotion();
	const page = await notion.pages.retrieve({ page_id: briefId });
	if (!isFullPage(page)) {
		throw new Error(`loadBrief: page ${briefId} returned partial response`);
	}

	const props = page.properties;
	const brief = {
		id: page.id,
		title: titleFromPage(page),
		body: richTextProperty(props.Body),
		status: selectProperty(props.Status),
		owner: selectProperty(props.Owner),
		category: selectProperty(props.Category),
		repoUrl: urlProperty(props.Repo),
		prUrl: urlProperty(props["PR URL"]),
		projectRootPageId: relationProperty(props["Project Root"]),
	};

	return brief as Brief;
}

export async function claimBriefBusy(
	briefId: string,
	prevStatus: string,
): Promise<boolean> {
	const notion = getNotion();
	const page = await retrieveFullPage(briefId);
	const currentStatus = selectProperty(page.properties.Status);
	const currentOwner = selectProperty(page.properties.Owner);
	if (currentStatus !== prevStatus || currentOwner !== "Forge-Local") {
		log.info("[brief] claim skipped", {
			briefId,
			currentStatus,
			currentOwner,
			prevStatus,
		});
		return false;
	}

	const nowIso = new Date().toISOString();
	const properties: PageUpdateProperties = {
		Owner: { select: { name: "Forge-Local-Busy" } },
	};
	const busyAtPatched = addBusyAtPatch(page.properties, properties, nowIso);

	await notion.pages.update({ page_id: briefId, properties });
	if (!busyAtPatched) {
		await postComment(
			briefId,
			`Forge-Local claimed this brief at ${nowIso}. Add a BusyAt date or number property for automatic stale-claim recovery.`,
		);
	}

	const after = await retrieveFullPage(briefId);
	return (
		selectProperty(after.properties.Owner) === "Forge-Local-Busy" &&
		selectProperty(after.properties.Status) === prevStatus
	);
}

export async function releaseBrief(
	briefId: string,
	opts: { status: string; owner: string },
): Promise<void> {
	const notion = getNotion();
	const properties: PageUpdateProperties = {
		Status: { select: { name: opts.status } },
		Owner:
			opts.owner.length > 0
				? { select: { name: opts.owner } }
				: { select: null },
	};
	await notion.pages.update({ page_id: briefId, properties });
}

export async function findStaleBusyBriefs(
	thresholdMs: number,
): Promise<Array<{ briefId: string }>> {
	const notion = getNotion();
	const dataSourceId = await getBriefsDataSourceId();
	const cutoff = Date.now() - thresholdMs;
	const stale: Array<{ briefId: string }> = [];
	let cursor: string | undefined;

	do {
		const res = await notion.dataSources.query({
			data_source_id: dataSourceId,
			filter: { property: "Owner", select: { equals: "Forge-Local-Busy" } },
			page_size: 100,
			start_cursor: cursor,
		});
		for (const result of res.results) {
			if (!("properties" in result)) continue;
			const busyAtMs = busyAtTimestampMs(result.properties as PageProperties);
			if (busyAtMs === null || busyAtMs < cutoff) {
				stale.push({ briefId: result.id });
			}
		}
		cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
	} while (cursor);

	return stale;
}

function getNotion(): Client {
	if (notionClient) return notionClient;
	const config = getConfig();
	notionClient = new Client({ auth: config.NOTION_API_TOKEN });
	return notionClient;
}

async function getBriefsDataSourceId(): Promise<string> {
	if (briefsDataSourceId) return briefsDataSourceId;
	const config = getConfig();
	const db = await getNotion().databases.retrieve({
		database_id: config.HIVEMIND_BRIEFS_DATABASE_ID,
	});
	if (!isFullDatabase(db)) {
		throw new Error("Briefs database retrieve returned partial response");
	}
	const primary = db.data_sources[0];
	if (!primary) {
		throw new Error("Briefs database has no data sources");
	}
	briefsDataSourceId = primary.id;
	return primary.id;
}

async function retrieveFullPage(briefId: string): Promise<PageObjectResponse> {
	const page = await getNotion().pages.retrieve({ page_id: briefId });
	if (!isFullPage(page)) {
		throw new Error(`Brief ${briefId} returned partial response`);
	}
	return page;
}

async function postComment(briefId: string, text: string): Promise<void> {
	await getNotion().comments.create({
		parent: { page_id: briefId },
		rich_text: [{ type: "text", text: { content: text } }],
	});
}

function titleFromPage(page: PageObjectResponse): string {
	for (const value of Object.values(page.properties) as PageProperty[]) {
		if (value.type === "title") {
			return value.title.map((rt) => rt.plain_text).join("");
		}
	}
	return "";
}

type PageProperty = PageObjectResponse["properties"][string];

function richTextProperty(prop: unknown): string {
	if (!prop || typeof prop !== "object") return "";
	const typed = prop as { type?: string; rich_text?: { plain_text: string }[] };
	if (typed.type !== "rich_text" || !typed.rich_text) return "";
	return typed.rich_text.map((rt) => rt.plain_text).join("");
}

function selectProperty(prop: unknown): string | null {
	if (!prop || typeof prop !== "object") return null;
	const typed = prop as {
		type?: string;
		select?: { name?: string } | null;
		status?: { name?: string } | null;
	};
	if (typed.type === "select") return typed.select?.name ?? null;
	if (typed.type === "status") return typed.status?.name ?? null;
	return null;
}

function urlProperty(prop: unknown): string | null {
	if (!prop || typeof prop !== "object") return null;
	const typed = prop as { type?: string; url?: string | null };
	if (typed.type !== "url") return null;
	return typed.url ?? null;
}

function relationProperty(prop: unknown): string | null {
	if (!prop || typeof prop !== "object") return null;
	const typed = prop as { type?: string; relation?: { id: string }[] };
	if (typed.type !== "relation" || !typed.relation) return null;
	const first = typed.relation[0];
	return first ? first.id : null;
}

function addBusyAtPatch(
	props: PageProperties,
	patch: PageUpdateProperties,
	nowIso: string,
): boolean {
	const busyAt = props.BusyAt;
	if (!busyAt || typeof busyAt !== "object" || !("type" in busyAt)) {
		return false;
	}
	if (busyAt.type === "date") {
		patch.BusyAt = { date: { start: nowIso } };
		return true;
	}
	if (busyAt.type === "number") {
		patch.BusyAt = { number: Date.now() };
		return true;
	}
	return false;
}

function busyAtTimestampMs(props: PageProperties): number | null {
	const busyAt = props.BusyAt;
	if (!busyAt || typeof busyAt !== "object" || !("type" in busyAt)) return null;
	if (busyAt.type === "number") {
		return typeof busyAt.number === "number" ? busyAt.number : null;
	}
	if (busyAt.type === "date") {
		const start = busyAt.date?.start;
		if (!start) return null;
		const parsed = Date.parse(start);
		return Number.isNaN(parsed) ? null : parsed;
	}
	return null;
}
