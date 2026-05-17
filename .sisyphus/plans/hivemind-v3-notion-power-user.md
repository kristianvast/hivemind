# Hivemind v3 — Notion Power-User Agent

**Status:** PLAN (awaiting Momus review)
**Target:** Promote the Architect from "brief-subtree writer" to "Notion power-user" — an agent that can build databases, views, kanban boards, charts, and dashboards anywhere in the workspace, with first-class observability via a Runs database and workspace-level home page.
**Repo:** `/Users/kristian/projects/hivemind-notion`
**Branch policy:** Direct on `main`. Six-phase rollout (6–11); each phase independently shippable.
**Supersedes:** Extends `.sisyphus/plans/hivemind-v2-orchestrator.md` (v2 plan). v2 is complete through Phase 4; v3 picks up at Phase 6 (Phase 5 polish folded in along the way). v2 plan stays in place — v3 is additive.

---

## 1. Vision & User-Locked Decisions

In v2 the Architect produces a deliverable inside a per-brief subtree, with a chronological Activity log of toggle blocks for observability. The user wants more: the Architect should feel like Notion's own AI but better — building rich pages, kanban observability boards, dashboards with charts, anywhere in the workspace. The image the user shared (Notion AI's "Create custom agent / Analyze data / Create a chart / Filter and sort data" chrome) is the experience to match.

**User-locked decisions** (from the v3 design conversation):

| # | Decision | Implication |
|---|---|---|
| V1 | **Implement all six phases (6–11).** | Big-bang plan with sequential ship gates. Each phase independently revertable. |
| V2 | **Drop the project-subtree scope guard entirely.** Architect can write anywhere the integration has access. | Removes `scope.ts` enforcement. Adds **audit logging** for every write outside the brief's subtree (non-blocking, observability-only). Risk explicitly accepted by user. |
| V3 | **Status-flip triggers only.** No comment-driven Architect, no resume-on-comment. | Webhook routing stays minimal (Triaged / Done / Owner=Forge-Local). `comment.created` subscription deferred to v4+. |
| V4 | **Runs database** is the new observability primitive. One row per agent invocation. Kanban + Chart + Timeline views over it. | Replaces the toggle-block-only Activity page (Activity stays as detailed detail-on-click, but the kanban becomes the headline surface). |
| V5 | **Workspace Home page** (`🐝 Hivemind Workspace`) is created once and curated by the Architect. Linked DB views of Briefs + Runs; dashboard widgets for charts; agent-by-agent metrics. | New top-level Notion page. Bootstrapped by an admin script, then editable by the Architect like any other page. |
| V6 | **Markdown endpoints** (`retrieve-page-markdown` / `update-page-markdown`) replace `readPage` + `writeAnswer` block-by-block plumbing. | Big token savings: page round-trips drop from ~1500 → ~250 tokens for typical answer-shaped briefs. Block-level tools stay for surgical edits. |
| V7 | **Views API tools** expose all 10 view types (table, board, calendar, timeline, gallery, list, form, chart, map, dashboard) to the Architect via a single `manageView` discriminator tool. | Avoids ballooning the model's tool schema. Architect picks `op: "create" \| "update" \| "list" \| "delete" \| "createWidget" \| "createLinkedDatabaseView"`. |
| V8 | **Tool count discipline.** Maximum 30 tools on the Architect whitelist. Group rarely-used operations behind discriminator tools (`manageView`, `manageDatabase`, `managePage`). | Haiku 4.5 starts regressing past ~30 tools. v2 has 22 today; v3 must end ≤30. |

**Derived constraints** (locked by V1–V8):

- **V9.** The Workspace Home page ID lives in env (`HIVEMIND_WORKSPACE_HOME_ID`). The Architect reads it via a new `getWorkspaceHome` tool; the orchestrator does not provision it (admin script does, one-time).
- **V10.** Audit log: every Notion write outside the brief's subtree is appended as a row to a workspace-level `🪵 Audit` database. Includes: timestamp, agent, brief_id, operation, target_page_id, target_url, status (ok | error). Created lazily on first cross-subtree write.
- **V11.** Runs DB lives **inside** each brief's subtree (not workspace-level) for v3. Workspace-level linked views surface them on the Home page. This keeps the existing scope semantics and per-brief lifecycle.
- **V12.** Markdown read/write tools sit alongside block-level tools, not replacing them. Block-level tools handle: anchored writes (writeAnswer), surgical edits (updateBlock), structured data (tables, equations). Markdown handles: full-page reads, full-section rewrites.
- **V13.** File uploads available via single `uploadFile({ source, target })` tool. Internally handles the 3-step create/send/complete dance. Source: `{ url }` (fetch from URL) or `{ base64, name, mime }`. Target: `{ page_icon? | page_cover? | block_id? | files_property? }`.
- **V14.** No new sub-agents. Architect surface grows; Scout/Librarian/Oracle/Sentinel specs stay locked. (Sub-agents do not need view/dashboard tools — they're for research and review, not construction.)

---

## 2. Architecture Overview

### 2.1 Surface comparison

| Surface | v2 (today) | v3 (target) |
|---|---|---|
| Per-brief subtree | Plan + Drafts + Sources + Decisions + OpenQuestions + Activity | + **📊 Runs DB** (one row per agent invocation, with kanban/timeline/chart views) |
| Top of workspace | (nothing) | **🐝 Hivemind Workspace** home page: linked Briefs kanban, linked Runs dashboard (multi-widget), latest-approved gallery, throughput charts |
| Architect tools | 22 tools, all writes inside subtree | ≤30 tools, writes anywhere in workspace (audit-logged outside subtree) |
| Observability per agent run | Toggle block in Activity page | Row in Runs DB + toggle block in Activity (detail) + linked view on Workspace Home |
| Output blocks | 12 block types (paragraph/headings/lists/code/callout/toggle/divider/bookmark/quote/to_do) | + table, equation, synced_block, image, video, embed, file, tab, link_to_page, column_list, column, breadcrumb, table_of_contents |
| Page-meta writes | None (only via `appendBlocks` to root) | setIcon, setCover, setTitle, archive/restore, move |
| Database writes | Only INSERT pages into Drafts/Sources/Decisions/OpenQuestions | + createDatabase, updateSchema, addProperty (any DB), createView (any DB), createDashboardView, createLinkedDatabaseView |
| File handling | None | uploadFile (URL or base64 → Notion-hosted, attach to page/block/property) |
| Markdown | None | readPageMarkdown, writePageMarkdown |
| Scope guard | Enforced (project subtree only) | **Removed**. Audit log replaces the gate. |

### 2.2 Execution flow (changes from v2)

The webhook routing + chain lock + dedup + classification are **unchanged** from v2. What changes is the orchestrator's setup phase and the Architect's tool dispatch:

```
Webhook: Status=Triaged
  │
  ├─ Lock + classify + provision subtree (unchanged from v2)
  │
  ├─ NEW: Provision Runs DB inside the subtree (idempotent)
  │     ├─ Schema: Agent, Status, Started, Finished, Duration, Tokens, ToolCalls, Summary, Verdict, Brief (relation)
  │     ├─ Views: 📋 Kanban by Status, 🤖 Kanban by Agent, 🕐 Timeline, 📊 Chart (tokens by agent), 📊 Chart (duration by agent)
  │     └─ Linked view of this Runs DB pushed to the Workspace Home (if configured)
  │
  ├─ NEW: ScopeGuard is now an **audit logger**, not a gate.
  │     ├─ assertAllowed(pageId) — never throws; returns scope tier (in-subtree | workspace | unknown)
  │     ├─ Every write outside the subtree → append row to workspace-level 🪵 Audit DB
  │     └─ Workspace 🪵 Audit DB created lazily on first cross-subtree write (or by admin script up front)
  │
  ├─ Architect runs (Anthropic tool-use loop, 60 steps max)
  │     │  (Now with up to 30 tools incl. markdown, views, page-meta, files, database management)
  │     │
  │     ├─ NEW: Before each delegate* call, orchestrator INSERTS a Runs DB row with Status=running.
  │     ├─ NEW: On delegate* completion, orchestrator UPDATES the row with finished metadata.
  │     ├─ NEW: On delegate* error, orchestrator UPDATES the row with Status=failed + error msg.
  │     │
  │     └─ done({ summary })
  │
  ├─ Sentinel runs (unchanged from v2; Phase 3 migration to delegateSentinel deferred)
  │
  └─ Release lock, persist final state
```

### 2.3 Runs DB schema (canonical)

```typescript
{
	Name:        { type: "title" },               // "Architect turn 3" / "Scout: search auth patterns"
	Agent:       { type: "select", options: [Architect, Scout, Librarian, Oracle, Sentinel, Orchestrator] },
	Status:      { type: "status", options: [queued, running, done, failed] },
	Started:     { type: "date" },                // ISO8601 with time
	Finished:    { type: "date" },                // ISO8601 with time; null while running
	Duration:    { type: "number", format: "number" },  // milliseconds
	Tokens:      { type: "number", format: "number" },  // delta from token budget
	ToolCalls:   { type: "number", format: "number" },
	Summary:     { type: "rich_text" },           // 1-3 paragraphs from done({summary})
	Verdict:     { type: "select", options: [approve, needs-revision] },  // Sentinel only
	Brief:       { type: "relation", data_source_id: BRIEFS_DS_ID }  // links to the Briefs DB
}
```

### 2.4 Workspace Home layout

```
🐝 Hivemind Workspace                       (page, icon=bee, cover=unsplash)
├── (heading_1) Hivemind Command Center
├── (callout) "Live observability for every brief and every agent run."
├── (columns)
│   ├── (col 0.33) "Active briefs" — kanban view of Briefs DB grouped by Status, filtered Status!=Done/Failed/Archived
│   ├── (col 0.33) "Throughput this week" — chart view of Briefs DB, line, x=Created, y=count
│   └── (col 0.33) "Token spend by agent (7d)" — chart view of *all* Runs DBs combined, column, x=Agent, y=Tokens
├── (divider)
├── (heading_2) Recent runs
└── (linked view) Cross-brief Runs feed (linked-database view aggregating all per-brief Runs DBs — implementation note below)
```

**Implementation gotcha for cross-brief Runs aggregation:** Notion does not natively support a view "across multiple databases". Two options:
- **Option A** (simpler): One workspace-level `🪵 Runs` DB that all per-brief orchestrators write to. Loses per-brief lifecycle isolation but gives easy cross-brief views.
- **Option B** (per-brief Runs DB + linked views): Each brief has its own Runs DB; Workspace Home gets N linked-database blocks (one per brief). Lots of clutter on the home page.
- **Decision V11 picks per-brief Runs DBs** so cleanup-on-brief-archive is trivial. Cross-brief surfacing on the Home page uses a relation: every per-brief Runs row has a `Brief` relation, and we expose a "Latest 50 runs across briefs" view by **also writing every run to a workspace-level lightweight `🪵 Activity` DB** with just (Agent, Started, Finished, Tokens, Brief). The verbose row stays in the per-brief Runs DB; the workspace Activity DB carries summary metadata for cross-brief charts. (Double-write cost: 1 extra Notion API call per agent run, paced through the same Pacer. Acceptable.)

---

## 3. Tool Surface (v3)

### 3.1 Architect tools (≤30, grouped where sensible)

**Reused from v2** (15 tools, unchanged shapes):
- `searchWorkspace`, `readPage`, `readDataSource`
- `getBriefMetadata`, `getProjectIds`
- `readPlanSection`, `setPlanSection`, `appendToPlanSection`
- `writeAnswer`, `listDrafts`, `getDraft`, `getDraftBody`, `createDraft`, `updateDraftStatus`
- `createSource`, `createDecision`, `createOpenQuestion`
- `appendBlocks`, `updateBlock`, `deleteBlock`, `createChildPage`, `addComment`
- `delegateScout`, `delegateLibrarian`, `delegateOracle`
- `done`

(Some of these collapse if Phase 8's markdown tools eliminate them.)

**NEW Phase 6 — Runs observability** (orchestrator-internal, NOT exposed to Architect):
- `_startRun(agent, query?)` → returns runRowId
- `_finishRun(runRowId, { tokens, duration, toolCalls, summary, verdict? })`
- `_failRun(runRowId, { tokens, duration, errorMsg })`

These are private helpers, called by `runAgentStage` and `runDelegation`. The Architect does NOT see them — observability is automatic.

**NEW Phase 7 — Workspace Home**:
- `getWorkspaceHome()` → `{ home_page_id, audit_db_id?, runs_summary_db_id? }`  (NEW tool, single call)

The orchestrator also gains `provisionWorkspaceHome` (admin tool, called by `scripts/provisionWorkspaceHome.ts`).

**NEW Phase 8 — Markdown + rich blocks**:
- `readPageMarkdown({ page_id })` → `{ markdown: string, truncated: boolean }`
- `writePageMarkdown({ page_id, markdown, mode: "replace" | "append" })`
- Existing `appendBlocks` + `updateBlock` schemas extended to support new block types:
  - `equation` — `{ expression }`
  - `table` — `{ table_width, has_column_header, has_row_header, rows: BlockShape[] }`  (`rows` is array of `table_row` blocks)
  - `table_row` — `{ cells: string[][] }`  (each cell is a string[] of rich-text plain values for now)
  - `image`, `video`, `audio`, `pdf`, `file` — `{ source: { url } | { file_upload_id } }`
  - `synced_block` — `{ synced_from_block_id }`
  - `embed` — `{ url }`
  - `link_to_page` — `{ target_page_id }` or `{ target_database_id }`
  - `tab` — `{ tabs: [{ label, icon?, children: BlockShape[] }] }`
  - `breadcrumb`, `table_of_contents` — `{}`
  - `column_list` — `{ columns: [{ width_ratio?, children: BlockShape[] }] }`

**NEW Phase 9 — Views API** (one discriminator tool):
- `manageView({ op, ... })` where `op` is one of:
  - `create` — `{ database_id, data_source_id, name, type, filter?, sorts?, configuration?, position? }` → `{ view_id, url }`
  - `update` — `{ view_id, name?, filter?, sorts?, configuration? }` → `{ ok }`
  - `list` — `{ database_id? | data_source_id? }` → `{ views: [{id, name, type}] }`
  - `delete` — `{ view_id }` → `{ ok }`
  - `addWidget` — `{ dashboard_view_id, data_source_id, name, type, configuration?, placement? }` → `{ widget_view_id }`
  - `createLinkedDatabase` — `{ target_page_id, data_source_id, name, type, configuration? }` → `{ view_id, container_block_id }`
  - `query` — `{ view_id, page_size? }` → `{ pages: [{id, title}], next_cursor? }`

Single tool, eight ops. Schema is large but discoverable via op enum.

**NEW Phase 10 — Workspace-wide writes + file uploads**:
- `uploadFile({ source, target })` → `{ file_upload_id, attached: true }`
  - `source`: `{ url: string }` (fetch & upload) or `{ base64: string, filename: string, mime_type: string }`
  - `target`: `{ kind: "page_icon" | "page_cover" | "block_image" | "block_video" | "block_audio" | "block_file" | "block_pdf" | "property_files", id: string, property_name?: string }`
- `managePage({ op, ... })`:
  - `setIcon` — `{ page_id, icon: { emoji } | { external_url } | { custom_emoji_id } | { file_upload_id } }`
  - `setCover` — `{ page_id, cover: { external_url } | { file_upload_id } }`
  - `setTitle` — `{ page_id, title }`
  - `move` — `{ page_id, new_parent_page_id }`
  - `trash` / `restore` — `{ page_id }`

**NEW Phase 11 — Database management + templates**:
- `manageDatabase({ op, ... })`:
  - `create` — `{ parent_page_id, title, properties, default_view_type? }` → `{ database_id, data_source_id }`
  - `update` — `{ database_id, title? }`
  - `addProperty` — `{ data_source_id, name, type, options? }`
  - `removeProperty` — `{ data_source_id, name }`
  - `listTemplates` — `{ data_source_id }` → `{ templates: [{id, name}] }`
- `createPageFromTemplate({ data_source_id, template_id, properties? })` → `{ page_id }`

### 3.2 Tool count audit

| Tool | v2 | v3 | Notes |
|---|---|---|---|
| Read/navigate | 7 | 7 | unchanged |
| Plan section mgmt | 3 | 3 | unchanged |
| Drafts | 5 | 5 | unchanged |
| Block writes | 4 | 4 | extended `BLOCK_SHAPE` enum, same tool count |
| Brief signal | 3 | 3 | unchanged (setBriefStatus, setBriefOwner, addComment) |
| Delegation | 3 | 3 | unchanged |
| `done` | 1 | 1 | |
| **NEW: Workspace** | 0 | 1 | `getWorkspaceHome` |
| **NEW: Markdown** | 0 | 2 | `readPageMarkdown`, `writePageMarkdown` |
| **NEW: Views** | 0 | 1 | `manageView` (8 ops) |
| **NEW: Files** | 0 | 1 | `uploadFile` |
| **NEW: Page-meta** | 0 | 1 | `managePage` (5 ops) |
| **NEW: Database** | 0 | 2 | `manageDatabase` (5 ops), `createPageFromTemplate` |
| **TOTAL** | 26 | **34** | Just over the 30 budget — see V8. |

**Over budget by 4 during Phase 9–11.** This is intentional — 4 tools are scheduled for retirement in Phase 8.5 cleanup AFTER Phase 8 ships markdown endpoints. The retirement candidates and the savings (one per tool):

| Retire | Replacement | Saves |
|---|---|---|
| `writeAnswer` | `writePageMarkdown({ page_id: rootId, mode: "replace_section", section: "📄 Answer" })` | 1 |
| `updateBlock` | `writePageMarkdown` for prose; keep only if structural-block surgical edits show up | 1 |
| `deleteBlock` | `writePageMarkdown` replace-section semantics handles this; surgical delete rare | 1 |
| `appendBlocks` | `writePageMarkdown({ mode: "append" })` for prose; keep only if rich-block-only appends are common | 1 |

Phase 8.5 is a measurement-driven cleanup: read tool-call frequency from the new Runs DB (Phase 6 delivery), retire tools used <5% of the time AND covered by `writePageMarkdown`. **Hard cap: 30 tools on the final Architect whitelist.** If usage data shows we can't retire enough, the Phase 11 schema additions must be deferred or merged into existing discriminators.

---

## 4. Phasing

### Phase 6 — Runs database + automatic observability

**Goal:** Replace toggle-block-only Activity with a structured per-brief Runs DB. Every agent invocation becomes a queryable row.

**Deliverables:**
- New `src/runs.ts`: schema, write helpers (`startRun`, `finishRun`, `failRun`), idempotent provisioning.
- `provision.ts` extended to provision the Runs DB and create initial views (kanban-by-status, kanban-by-agent, timeline, chart-tokens-by-agent, chart-duration-by-agent).
- `orchestrator.ts` calls `startRun` before each `runAgentStage` invocation, `finishRun` after, `failRun` on error.
- `handlers.ts` `runDelegation` calls `startRun`/`finishRun` for every sub-agent invocation.
- `state.ts` `HivemindState` extended with `dsIds.runs: DbIds`.

**Tool changes:** None visible to Architect. Observability is automatic.

**Done when:**
- A representative brief end-to-end produces 1 Architect row + N delegate rows + 1 Sentinel row in the Runs DB.
- Kanban-by-Status view shows runs transitioning queued→running→done.
- Chart-tokens-by-agent renders a real chart on the brief's project root (as linked database view).

### Phase 7 — Workspace Home page + cross-brief observability

**Goal:** A workspace-level `🐝 Hivemind Workspace` page with linked DB kanban for Briefs and a dashboard view aggregating Runs.

**Deliverables:**
- `scripts/provisionWorkspaceHome.ts` admin script: creates the home page once, configures the linked Briefs kanban + Runs dashboard, writes the home page ID to env-suggested config.
- Lightweight workspace-level `🪵 Activity` DB (Agent, Started, Finished, Tokens, Brief, Status) for cross-brief aggregation (V11 decision).
- `runs.ts` updated to double-write: per-brief Runs DB (verbose) + workspace Activity DB (summary).
- `getWorkspaceHome` tool: Architect can fetch the home page ID + audit DB ID on demand.

**Tool changes:** +1 (`getWorkspaceHome`).

**Done when:**
- A fresh deploy + `npx tsx scripts/provisionWorkspaceHome.ts` produces a populated home page.
- A second brief running concurrently surfaces in the workspace Runs dashboard while the first is still in flight.
- A chart on the home page shows token consumption across both briefs.

### Phase 8 — Markdown endpoints + expanded BLOCK_SHAPE

**Goal:** Token-efficient page reads + writes. Richer block output (tab, equation, table, image, embed).

**Deliverables:**
- `notion.ts` helpers for new block types: `equation`, `tableBlock`, `imageBlock`, `videoBlock`, `embedBlock`, `synced_block`, `linkToPage`, `tabBlock`, `breadcrumb`.
- `tools/registry.ts` `BLOCK_SHAPE` enum extended with new block types. JSON schema for each.
- `tools/handlers.ts` `blockShapeToNotion` extended to translate new shapes to `BlockObjectRequest`.
- New tools `readPageMarkdown`, `writePageMarkdown` in `handlers.ts`. Use `notion.pages.retrieveMarkdown` / `notion.pages.updateMarkdown` SDK methods (confirmed available in 5.21.0 per SDK introspection).
- Architect system prompt updated: "use `readPageMarkdown` for full-page reads (cheaper); `appendBlocks`/`updateBlock` only for surgical edits."

**Tool changes:** +2 markdown tools. Block schema extended (no new tools).

**Done when:**
- `readPageMarkdown(briefId)` returns the brief in markdown form. Tokens-vs-`readPage` measured (target: ≥50% reduction).
- Architect's `writeAnswer`-equivalent path via `writePageMarkdown` produces equivalent output. Demonstrated on a writing-category brief.
- A new test brief produces an output with an equation block, a table, and an image — all via the extended block schema.

**Phase 8.5 — Cleanup:** After Phase 8 ships and bakes for a few runs, audit tool usage. Retire whichever of `writeAnswer` / `updateBlock` / `deleteBlock` / `appendBlocks` are redundant. Target ≤30 tools.

### Phase 9 — Views API exposure (`manageView`)

**Goal:** Architect can build kanban boards, charts, dashboards on demand for any database it sees.

**Deliverables:**
- `src/views.ts` — typed wrapper around `notion.views.create/retrieve/update/delete/list/queries`. Handles all 10 view types' configuration schemas.
- `tools/handlers.ts` `manageView` handler dispatching on `op`.
- `tools/registry.ts` `manageView` tool definition with discriminator schema.
- `provision.ts` cleanup: replace the half-implemented `notionViews` shim with the real `views.ts` import. Delete the `notionViews()` lookup function.

**Tool changes:** +1 (`manageView`).

**Done when:**
- A brief asking "build a kanban view of the Drafts DB grouped by Status" produces a working view via `manageView({ op: "create", type: "board", ... })`.
- A brief asking "show me a chart of tokens by agent" produces a chart view via `manageView({ op: "create", type: "chart", configuration: { ... } })`.
- A brief that needs cross-DB observability creates a dashboard view + 4 widgets via `manageView({ op: "create", type: "dashboard" })` + 4× `manageView({ op: "addWidget" })`.

### Phase 10 — Drop scope guard + workspace-wide writes + file uploads + page-meta

**Goal:** Architect can write anywhere in the workspace. Audit log captures every cross-subtree write.

**Deliverables:**
- `scope.ts` refactored: `ScopeGuard` no longer throws. New method `classifyTarget(pageId): "in-subtree" | "workspace" | "unknown"`. Existing call sites (`assertAllowed`) replaced with `classifyTarget` + audit append.
- New `src/audit.ts`: lazy-create workspace `🪵 Audit` DB; append rows with `(timestamp, agent, brief_id, op, target_page_id, target_url, status)`.
- New tools: `managePage` (5 ops), `uploadFile`.
- `tools/handlers.ts` write handlers extended to call `classifyTarget` + audit if outside subtree. Never blocks. Logs at console too.
- `tools/registry.ts` `managePage` + `uploadFile` tool definitions.

**Tool changes:** +2 (`managePage`, `uploadFile`).

**Done when:**
- A brief that asks "rename the parent Briefs database row's Title to add a checkmark emoji" succeeds (writes outside subtree, audit log captures it).
- The workspace `🪵 Audit` DB has rows for every cross-subtree write across the test runs.
- The old `ScopeViolation` exception path in `orchestrator.ts handleAgentError` is removed (now dead code), and a manual `ntn workers exec runOrchestrator --local <briefId>` on the cross-subtree smoke brief #5 produces an `ok` result + a fresh row in the Audit DB (no thrown error).

**Risk gate:** Before Phase 10 ships, manually review the `🪵 Audit` DB after a smoke run. If the Architect is writing to unexpected places, either tighten the system prompt or add an audit-only "warning" flag the orchestrator can react to. **Don't ship Phase 10 to production until a human has eyeballed three audit logs.**

### Phase 11 — Database creation + templates (`manageDatabase`, `createPageFromTemplate`)

**Goal:** Architect can spin up new structured artifacts on demand ("This brief needs a Risk Register database; let me create one and populate it").

**Deliverables:**
- `tools/handlers.ts` `manageDatabase` handler (5 ops: create, update, addProperty, removeProperty, listTemplates) and `createPageFromTemplate` handler.
- `tools/registry.ts` tool definitions.
- Architect system prompt: "Use `manageDatabase` when the brief's deliverable is itself a structured database (e.g., 'build a risk register', 'create an OKR tracker')."

**Tool changes:** +2 (`manageDatabase`, `createPageFromTemplate`).

**Done when:**
- A brief "Create a risk register for project X with 5 example rows" produces a real DB + 5 rows + a kanban view, all by the Architect itself.

### Phase 8.5 + final cleanup — tool count audit

**Goal:** Settle Architect whitelist at ≤30 tools.

**Tasks:**
- Measure tool-call frequency from real runs (read from Runs DB).
- Retire any tool used <5% of the time AND covered by a more general one.
- Document the final tool surface in AGENTS.md.

---

## 5. Module Inventory

| File | Disposition | Notes |
|---|---|---|
| `src/runs.ts` | **NEW** Phase 6 | Runs DB schema + write helpers |
| `src/views.ts` | **NEW** Phase 9 | Typed views API wrapper, configuration schemas per view type |
| `src/audit.ts` | **NEW** Phase 10 | Workspace audit log: lazy-create + append |
| `src/workspaceHome.ts` | **NEW** Phase 7 | Workspace Home page provisioning + getWorkspaceHome helper |
| `src/scope.ts` | **MODIFY** Phase 10 | ScopeGuard becomes a classifier, not a gate. Public API change. |
| `src/provision.ts` | **MODIFY** Phases 6, 9 | Provision Runs DB + initial views. Replace `notionViews` shim with `views.ts` import. |
| `src/orchestrator.ts` | **MODIFY** Phase 6 | Call startRun/finishRun/failRun around each runAgentStage. |
| `src/tools/handlers.ts` | **MODIFY** Phases 6,8,9,10,11 | Add startRun/finishRun/failRun wrappers; new handlers for markdown, views, files, page-meta, database mgmt; classifyTarget + audit on writes |
| `src/tools/registry.ts` | **MODIFY** Phases 8,9,10,11 | Extend BLOCK_SHAPE enum. New tool definitions for markdown, manageView, uploadFile, managePage, manageDatabase, createPageFromTemplate, getWorkspaceHome. Update Architect whitelist. |
| `src/notion.ts` | **MODIFY** Phase 8 | New block builders: equation, table, image, video, embed, synced_block, linkToPage, tab, breadcrumb |
| `src/architect.ts` | **MODIFY** Phases 8,9,10,11 | System prompt expansion: new tool list, scope rules, when to use markdown vs blocks, when to use manageView/manageDatabase |
| `src/state.ts` | **MODIFY** Phase 6 | `HivemindState.dsIds.runs?: DbIds`; `HivemindState.workspaceAuditDbId?: string` (Phase 10) |
| `scripts/provisionWorkspaceHome.ts` | **NEW** Phase 7 | Admin script — creates Home page + workspace Activity DB + audit DB |
| `scripts/inspectRuns.ts` | **NEW** Phase 6 | Admin script — pretty-prints recent Runs DB rows for a brief |
| `src/subagents.ts` | **NO CHANGE** | Sub-agents do NOT get the new tools. Architect-only surface. |
| `src/agentLoop.ts` | **NO CHANGE** | Generic; agent-shape agnostic. |
| `src/pacer.ts`, `src/budget.ts` | **NO CHANGE** | Reused. |
| `src/index.ts` | **MODIFY** Phase 7 | Add `provisionWorkspaceHome` admin tool. |
| `AGENTS.md` | **MODIFY** end of Phase 11 | Document the v3 surface, scope semantics change, audit DB. |

---

## 6. Updated Architect System Prompt (Phase 11 final form)

```
You are the Architect — the autonomous agent driving a brief from Triaged to Needs Review in the Hivemind multi-agent system. You operate as a Notion power-user with full workspace access.

# YOUR JOB
Read the brief, plan, produce a deliverable, then signal completion. A separate Sentinel agent reviews your work after you're done.

# YOUR WORKSPACE
You have THREE scopes for writes:

1. **Brief subtree** (DEFAULT, ALWAYS-OK): the project root page provisioned for this brief, plus everything under it — Plan, Drafts, Sources, Decisions, Open Questions, Activity, and Runs DBs. Write anything here freely.

2. **Hivemind Workspace home**: `getWorkspaceHome()` returns the IDs of the workspace-level Home page, Activity DB, and Audit DB. Write to the Home page when curating cross-brief dashboards. The orchestrator automatically writes to the Activity + Audit DBs.

3. **Anywhere else in the workspace**: writable but AUDIT-LOGGED. Every write outside the brief subtree appends a row to the Audit DB. Use this scope ONLY when the brief explicitly asks you to modify external pages (e.g., "update the team's roadmap page", "rename this database"). Do NOT spelunking-edit random user pages just because the brief mentions them.

# CHOOSE YOUR OUTPUT SHAPE — EARLY AND ONCE
Two output modes, mutually exclusive. Pick ONE in your first 2-3 tool calls.

## writeAnswer — inline prose answer on the project root
- Use for: explanations, summaries, advice, "what is X", "how does Y work", documentation, comparisons.
- How: `writePageMarkdown({ page_id: project_root_id, mode: "replace_section", section_marker: "📄 Answer", markdown })`. Or `writeAnswer({ body, sources })` (legacy v2 tool, still supported).

## createDraft — iterative artifact in the Drafts DB
- Use for: code, design specs, structured plans, technical documents — anything that benefits from versioned revisions.
- How: `createDraft({ summary, body, sources })` ONCE, then `updateDraftStatus(id, "in-review")`.

NEVER both. If unsure, prefer `writeAnswer` for brevity, `createDraft` for iterables.

# ADVANCED OUTPUT SHAPES (when the brief warrants)
You can also build:
- Rich pages with covers, icons, tabs, columns, equations, tables, images, embeds — use `appendBlocks` with the extended BLOCK_SHAPE enum.
- Kanban / Calendar / Timeline / Chart / Dashboard / Gallery views on any database — use `manageView({ op: "create", ... })`.
- New databases with custom schemas — use `manageDatabase({ op: "create", ... })`.
- File attachments (PDFs, images, diagrams) — use `uploadFile({ source, target })`.
- Page metadata (icon, cover, title, move, trash) — use `managePage({ op, ... })`.

# DELEGATION
Three delegation tools, each spawning a sub-agent in its own context. ~30-80k tokens each — be deliberate.

- `delegateScout({ query, context })` — workspace search (Notion pages + web).
- `delegateLibrarian({ query, context })` — external reference research.
- `delegateOracle({ question, context })` — deep analysis (extended thinking).

Rules:
- PLAN UPFRONT. Most briefs need 0-1 delegations total.
- ONE QUERY PER TOPIC. The sub-agent fans out internally; don't double-call.
- DO NOT RETRY a sub-agent because its first response was generic. Use captured Sources.

# OBSERVABILITY (AUTOMATIC)
Every agent invocation (yours and the sub-agents') is recorded automatically in the brief's Runs DB. Kanban views show real-time status. You don't write to Runs DB directly — the orchestrator does. Trust it.

# WORKFLOW
1. **Read the brief**: `getBriefMetadata` + `getProjectIds` (parallel).
2. **Survey existing context**: `readPlanSection(Context|Approach|Sources)` (parallel).
3. **Decide output shape**: writeAnswer or createDraft. Declare in Plan's Approach section.
4. **Research if needed**: 0-1 delegations typical.
5. **Plan**: `setPlanSection(Context)` + `setPlanSection(Approach)`.
6. **Record significant choices**: `createDecision` for architectural choices.
7. **Produce the deliverable**: ONE of writeAnswer / createDraft.
8. **Optional rich extras**: if the brief asks for a dashboard, kanban, chart, or new DB — use `manageView` / `manageDatabase` / `uploadFile` accordingly.
9. **Done**: `done({ summary })`.

# STYLE
- Terse, factual, source-anchored. NO hedging.
- Parallel tool use — batch independent calls.
- No fabrication. Refuse-and-done if the brief is unanswerable.

# RETRY MODE
If listDrafts shows a draft with Last Verdict="needs-revision", OR readPage shows a prior Sentinel review with needs-revision: this is a retry. Match the prior output shape, address the issues, produce the revised deliverable, done.

# DONE CONDITION
- Plan Context + Approach populated.
- Exactly one of: writeAnswer succeeded, OR createDraft + updateDraftStatus("in-review") succeeded.
- OR refuse-and-done: createOpenQuestion explaining blocker + done.

Target: 15-40 tool calls. Step budget: 60.
```

---

## 7. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Architect hallucinates a write to an arbitrary user page | Medium | High | (V2 user-accepted) Audit log captures every cross-subtree write; admin reviews after smoke runs (Phase 10 risk gate). System prompt explicitly says "do NOT spelunking-edit random pages". |
| Tool count >30 → Haiku 4.5 regression | Medium | High | (V8) Discriminator tools (`manageView`, `managePage`, `manageDatabase`). Phase 8.5 cleanup pass. Hard cap at 30. |
| Views API SDK shape drift | Low | Medium | `@notionhq/client@5.21.0` confirmed in `node_modules`. Pin in package.json if a breaking 5.x→6.x update lands during the build. |
| Cross-brief observability writes flood the Pacer | Medium | Medium | Workspace Activity DB write piggybacks on per-brief Runs write (same Pacer slot). Add a per-pacer batch flush if needed. |
| Runs DB grows unbounded across briefs | Low | Low | Per-brief Runs DB lives inside the brief subtree — archived with the brief. Workspace Activity DB is summary-only; soft-cap at 10k rows (drop oldest 1k batch when triggered). |
| Markdown endpoint round-trips lose fidelity (formatting, mentions, blocks the markdown converter doesn't support) | Medium | Medium | Keep block-level tools as fallback. Architect prompt: "use markdown for prose; use blocks for structured (tables, equations, embeds)". |
| File uploads hit 5 MiB free-workspace cap | Medium | Low | Surface the size limit error verbatim to the Architect; let it decide to use external URL instead. |
| Phase 10 ships before Phase 6 (out-of-order) | Low | High | Strict phase gate — Phase N+1 PR cannot merge until Phase N is deployed and green for ≥1 brief run. |
| Audit DB write fails (e.g., DB deleted by user) | Low | Medium | Audit failure → console.warn; never blocks the actual write. Audit DB is lazy-recreated on next cross-subtree write. |

---

## 8. Verification Plan

For each phase, **before claiming done**:

- `npm run check` clean.
- `ntn workers deploy` succeeds.
- `ntn workers exec runOrchestrator --local <briefId>` produces expected output for at least 2 test briefs (one writeAnswer-shape, one createDraft-shape).
- Confirm new artifacts (Runs DB rows, views, Workspace Home content, audit entries) render correctly in the Notion UI.
- Token budget per brief stays ≤ 400k (current chain limit).

**Phase-specific verifications:**

- **Phase 6**: A typical brief produces ≥6 Runs DB rows (1 Architect + 3 delegate + 1 Sentinel + 1 Orchestrator). Kanban view renders.
- **Phase 7**: After `provisionWorkspaceHome.ts`, the Home page exists with 3 columns + linked Briefs kanban + Runs dashboard. A second concurrent brief surfaces in real-time.
- **Phase 8**: Token-cost-per-brief measured: target ≥30% reduction on writeAnswer-shape briefs. New block types (equation, table, image, embed) render correctly.
- **Phase 9**: Each of 5 view types created and renders: board, calendar, timeline, chart, gallery. Dashboard view with 4 widgets renders.
- **Phase 10**: 3 cross-subtree writes audited. Audit DB row inspected. System prompt's "do NOT spelunking-edit" rule manually verified on a brief that mentions an external page.
- **Phase 11**: A "build me a risk register" brief produces a new DB + rows + kanban view, end to end.

**Smoke briefs** — a new `scripts/seedSmokeBriefs.ts` ships in Phase 6 (modeled on the existing `scripts/createTestBrief.ts` and `scripts/smokeV2.ts`) and seeds these 5 briefs into the Briefs DB:

- "Explain the difference between databases and data sources." (writeAnswer + markdown path — exercised from Phase 8)
- "Summarize all approved drafts in the Hivemind workspace." (workspace-wide read — exercised from Phase 10)
- "Build a kanban board of all open Briefs grouped by Category." (manageView — exercised from Phase 9)
- "Create a Risk Register database with 5 starter rows and a kanban view by Severity." (manageDatabase + manageView — exercised from Phase 11)
- "Update the Hivemind Workspace home page's chart to show the last 14 days of token spend." (cross-subtree write + audit — exercised from Phase 10)

Each phase runs the relevant subset via `ntn workers exec runOrchestrator --local <briefId>` (per `AGENTS.md`'s testing convention — no test runner is configured for this repo).

---

## 9. Out of Scope (deferred to v4+)

- **Comment-driven Architect** (V3) — user asks via Notion comment → webhook → Architect resumes. Defer to v4.
- **Multi-Architect parallelism** — one Architect per brief stays.
- **Sub-agent expansion** — Scout/Librarian/Oracle/Sentinel surfaces locked. No new sub-agents.
- **AI auto-fill** — not API-available.
- **Cross-workspace operations** — single-workspace bot stays.
- **Notion Forms** as a deliverable type — form views are creatable via API but the brief flow doesn't currently consume them. Architect can create form views via `manageView` but won't unprompted.

---

## 10. Open Questions for Momus

1. Is dropping the scope guard truly safe given V2 explicit acceptance? Should we still gate destructive ops (trash, delete, move) behind a separate flag even when reads/writes are workspace-wide?
2. Tool count audit: which v2 tools should we retire in Phase 8.5? Specifically, does `writeAnswer`-via-`writePageMarkdown` work cleanly, or do we keep `writeAnswer` as a thin convenience wrapper?
3. Workspace Activity DB sizing: 10k row soft-cap reasonable, or do we need a TTL-based prune from day 1?
4. Per-brief Runs DB views: which view types are MUST-HAVE for the headline "kanban for logs and tasks" ask? Recommendation: kanban-by-status (live), timeline (Gantt of the run), chart-tokens-by-agent (cost), gallery (one summary card per row). Skip calendar (low value for sub-minute runs), skip map (no geo data), skip form (no user data entry).
5. Should `manageView` be ONE tool with op-discriminator, or split into `createView`, `updateView`, `listViews`, `deleteView`, `addDashboardWidget`, `createLinkedDatabaseView`, `queryView` (7 tools)? Trade-off: one wider tool vs. many narrower. V8 says discriminator. Confirm.
6. Audit DB schema sufficient? Current proposal: (timestamp, agent, brief_id, op, target_page_id, target_url, status). Should we also capture the input payload for forensics, or is that PII-heavy?

---

## 11. Implementation Schedule

| Phase | Effort | Gate |
|---|---|---|
| 6 — Runs DB + observability | 1 session | A brief produces ≥6 rows + working kanban |
| 7 — Workspace Home + cross-brief dashboard | 1 session | Concurrent briefs visible on home page in real-time |
| 8 — Markdown + rich blocks | 1-2 sessions | ≥30% token reduction on writeAnswer briefs; equation/table/image work |
| 8.5 — Tool count cleanup | 0.5 session | Final whitelist ≤30 tools |
| 9 — Views API tools | 1 session | All 5 critical view types created via `manageView` |
| 10 — Scope drop + file uploads + page meta | 1-2 sessions | Cross-subtree writes audited; manual review gate passes |
| 11 — Database + templates | 1 session | A risk-register-build brief succeeds end-to-end |

Total: ~7 sessions. Shippable after each phase.

---

**End of v3 plan. Hand to Momus for review.**
