// Minimal wrapper around the Notion Views API. Phase 6 uses this for the
// initial Runs DB views (board / timeline / chart). Phase 9 will extend it
// with update / list / delete / dashboard widgets + the `manageView` tool
// dispatcher, but the surface here stays focused on view creation.
//
// SDK reference: @notionhq/client@5.21.0 exposes `notion.views.{create,
// retrieve, update, delete, list}` plus `notion.views.queries.{create,
// get, delete}`. See `developers.notion.com/guides/data-apis/working-with-views`
// for the full configuration schema per view type.
//
// We intentionally keep the typings loose at the input boundary: the SDK's
// `CreateViewParameters` is a wide discriminated union and getting the
// per-view-type configurations right at compile time would mean re-implementing
// half the API surface in TS. Pass-through to the SDK and let the API validate.

import type { Client } from "@notionhq/client";

export type ViewType =
	| "table"
	| "board"
	| "calendar"
	| "timeline"
	| "gallery"
	| "list"
	| "form"
	| "chart"
	| "map"
	| "dashboard";

export interface ViewRef {
	id: string;
	url: string | null;
}

export interface CreateViewArgs {
	/** Container for top-level views on an existing database. */
	database_id?: string;
	/** Add this view as a widget inside an existing dashboard view. */
	view_id?: string;
	/** Create a new linked-database block on a page and add this view to it. */
	create_database?: {
		parent: { type: "page_id"; page_id: string };
		position?: { type: "after_block"; block_id: string };
	};
	/** Required for non-dashboard views: which data source the view is over. */
	data_source_id?: string;
	name: string;
	type: ViewType;
	filter?: Record<string, unknown>;
	sorts?: Array<Record<string, unknown>>;
	quick_filters?: Record<string, unknown>;
	configuration?: Record<string, unknown>;
	position?: Record<string, unknown>;
	placement?: Record<string, unknown>;
}

/**
 * Create a view. Returns the new view's id + url.
 *
 * Errors are surfaced verbatim — callers should wrap in try/catch if a
 * failed view is non-fatal (e.g. provisioning initial DB views shouldn't
 * block the brief from running).
 */
export async function createView(
	notion: Client,
	args: CreateViewArgs,
): Promise<ViewRef> {
	// Cast: @notionhq/client's CreateViewParameters is a deep discriminated
	// union. We accept the wider Record-shaped input and rely on the API to
	// reject invalid configurations.
	const res = (await (notion.views.create as unknown as (a: unknown) => Promise<{
		id: string;
		url: string | null;
	}>)(args)) as { id: string; url: string | null };
	return { id: res.id, url: res.url };
}

export async function listViews(
	notion: Client,
	args: { database_id?: string; data_source_id?: string },
): Promise<ViewRef[]> {
	const res = (await (notion.views.list as unknown as (a: unknown) => Promise<{
		results: { id: string }[];
	}>)(args)) as { results: { id: string }[] };
	return res.results.map((r) => ({ id: r.id, url: null }));
}

export async function retrieveView(
	notion: Client,
	viewId: string,
): Promise<{
	id: string;
	name: string;
	type: string;
	url: string | null;
}> {
	const res = (await (notion.views.retrieve as unknown as (a: unknown) => Promise<{
		id: string;
		name?: string;
		type?: string;
		url?: string | null;
	}>)({ view_id: viewId })) as {
		id: string;
		name?: string;
		type?: string;
		url?: string | null;
	};
	return {
		id: res.id,
		name: res.name ?? "",
		type: res.type ?? "",
		url: res.url ?? null,
	};
}

export async function deleteView(notion: Client, viewId: string): Promise<void> {
	await (notion.views.delete as unknown as (a: unknown) => Promise<unknown>)({
		view_id: viewId,
	});
}

export interface UpdateViewArgs {
	view_id: string;
	name?: string;
	filter?: Record<string, unknown>;
	sorts?: Array<Record<string, unknown>>;
	quick_filters?: Record<string, unknown>;
	configuration?: Record<string, unknown>;
}

export async function updateView(
	notion: Client,
	args: UpdateViewArgs,
): Promise<ViewRef> {
	const res = (await (notion.views.update as unknown as (a: unknown) => Promise<{
		id: string;
		url: string | null;
	}>)(args)) as { id: string; url: string | null };
	return { id: res.id, url: res.url };
}

export async function queryView(
	notion: Client,
	args: { view_id: string; page_size?: number; start_cursor?: string },
): Promise<{
	results: Array<{ id: string }>;
	next_cursor: string | null;
	has_more: boolean;
}> {
	const queries = (notion.views as unknown as {
		queries: {
			create: (a: unknown) => Promise<{ query_id: string }>;
			get: (a: unknown) => Promise<{
				results: Array<{ id: string }>;
				next_cursor: string | null;
				has_more: boolean;
			}>;
		};
	}).queries;
	const created = await queries.create({ view_id: args.view_id });
	const res = await queries.get({
		view_id: args.view_id,
		query_id: created.query_id,
		page_size: args.page_size,
		start_cursor: args.start_cursor,
	});
	return res;
}
