# Hivemind — Full OMO Orchestrator Refactor

**Status:** PLAN (awaiting Momus review)
**Target:** Replace the markdown-returning v0 chain with a workspace-centric, tool-using-agent orchestrator
**Repo:** /Users/kristian/projects/hivemind-notion
**Branch policy:** Direct on main (matches existing project workflow)

---

## 1. Vision & Scope

The user wants agents that "have special accessibility to all of the notion workspace they are in" — meaning agents that can **read workspace-wide** and **write within a per-brief project subtree** using the full Notion API (pages, databases, blocks, comments, mentions, search, file uploads, etc.).

This refactor delivers the OMO orchestrator pattern adapted to Notion:
- Brief = task
- Category = routing key (selects model + agent chain)
- Project subtree = agent's working environment (Plan page + 6 child DBs)
- Tool-using Claude loops = agent execution model
- Status transitions = state machine

**Hardcoded in v0** (lifted to Notion DBs in v1): toolsets, agent chains, category models. This is intentional per Metis's critique — runtime-toggleable Skills/Workflows DBs are config-without-a-system; build the engine first.

---

## 2. Locked Architectural Decisions

| # | Decision | Source / Rationale |
|---|---|---|
| 1 | Per-brief project subtree under brief page (not workspace-wide writes) | Bounded blast radius. Easy rollback (archive subtree). |
| 2 | Read scope: workspace-wide (`notion.search`, any page bot can see). Write scope: subtree only via scope guard. | Per Metis #1: "agents have accessibility to all workspace" implies broad reads, scoped writes. |
| 3 | Provisioning order: Backlog→Triaged → Classify → Provision → Agent chain | Classify is cheap; uniform DB shape across categories in v0 means provision order doesn't matter, but classify-first is more defensible if we vary shape in v1. |
| 4 | All agents are Claude tool-use loops (Anthropic SDK 0.39.0, hand-rolled loop). Drop OpenAI Sentinel. | Per Metis: two loop impls = maintenance tax. Anthropic models for everything. |
| 5 | Step = tool call (not turn). Per-agent budgets: Scout 8, Forge 15, Sentinel 5, Scribe 15. | Per Metis: Anthropic Cookbook convention. |
| 6 | Per-category agent chains as TypeScript data, not branches | `quick: [Forge, Sentinel]`, `writing: [Scout, Scribe, Sentinel]`, `deep: [Scout, Forge, Sentinel]`, `ultrabrain: [Scout, Forge, Sentinel]` (extended thinking models), `visual-engineering: [Scout, Forge, Sentinel]` (Opus). Default for unclassified: `[Scout, Forge, Sentinel]`. |
| 7 | Per-category model selection | `quick→haiku`, `writing→opus`, `deep→sonnet`, `ultrabrain→opus + extended thinking`, `visual-engineering→opus`. Sentinel always uses sonnet (review model). |
| 8 | New `Category` select prop on Briefs DB | Options: `visual-engineering, ultrabrain, deep, quick, writing`. Editable by human (overrides classification). |
| 9 | Internal state in single `Hivemind State` rich-text JSON property on Briefs DB | Per Metis #13: `_lastDeliveryId` and `Project Root Page ID` packed as JSON. Single property to hide in UI. |
| 10 | Scope guard: cached ancestor walk ∪ session-local allowed-set | Cache walks per (page_id, projectRootId). Allowed-set extended on every successful create_*_page / create_db_row. Without session set, agent cannot write to pages it just created. |
| 11 | Sentinel verdict via structured `set_verdict({ verdict, summary })` tool, not markdown parse | Per Metis #17. Verdict ∈ {`approve`, `needs-revision`}. |
| 12 | DBs created via REST API (Notion-Version 2025-09-03) so human-editable | `worker.database()` produces schema-owned-by-worker (UI-readonly) per `seedBriefs.ts` comment. Trust the comment unless empirically disproved. |
| 13 | Dedup: `_lastDeliveryId` in Hivemind State JSON. Accept idempotent re-runs (no atomic lock for v0). | Cost of a lock DB outweighs the risk window of the rare race. |
| 14 | Activity DB: one row per **agent invocation**, not per tool call. Step detail nested as toggle blocks inside row's page body. | Per Metis #12: write amplification. |
| 15 | Plan page: structured sections with section-targeted tools (`set_plan_section(name, blocks)`, `append_to_plan_section(name, block)`) | Predictable shape vs chronological mess. Sections: `Context`, `Approach`, `Open Questions`, `Status`. |
| 16 | Per-brief token budget: 200k tokens total across all agents. Circuit-break + post comment on overrun. | Cost guardrail per Metis. |
| 17 | Migration policy for v0 briefs: auto-provision on next trigger if `Project Root Page ID` absent. Old-format retry detection via heading regex remains as fallback ONLY when Drafts DB query returns empty. | Both paths coexist briefly; remove regex path after v0 briefs drained. |
| 18 | `handleBriefApproved` post-refactor: keep approval comment + finalize Activity row. No Workflows DB invocation. | Workflows are v1. |
| 19 | Skills DB / Workflows DB: NOT BUILT in v0. Toolsets and chains are TypeScript constants. | Per Metis: defer toggle-config until toggleability is a real need. |
| 20 | Notion-Version literal: only changed in `seedBriefs.ts:25` (2022-06-28 → 2025-09-03). SDK uses 2025-09-03 by default. | Per Metis verification + my own grep. |
| 21 | Two-pass provisioning explicit: Phase 1 create bare DBs (no relations). Phase 2 PATCH relation properties. | Cross-DB chicken-and-egg. |
| 22 | Provisioning idempotency: write `Project Root Page ID` to Brief AFTER root page success; child DBs idempotently created by name lookup on retry. | Per Metis #9. Partial failure recovers gracefully. |
| 23 | Rate pacer: single shared pacer across all Notion API calls in webhook handler. Use `worker.pacer()` if available, else hand-roll. | 3 RPS shared budget. |
| 24 | Bot loop prevention preserved: `HIVEMIND_BOT_USER_ID` filters bot-authored comments out of reviewer feedback. | Existing v0 mechanism, still correct. |

---

## 3. Module Inventory (new + refactored)

### New modules

| File | Responsibility |
|---|---|
| `src/scope.ts` | Scope guard with ancestor cache + session-local allowed-set. Exports `ScopeGuard` class with `assertAllowed(pageId): Promise<void>` and `registerCreated(pageId): void`. |
| `src/tools/registry.ts` | Defines all `Tool` shapes (Anthropic SDK `Tool` type) + per-agent whitelists. Each tool: name, description, input_schema. |
| `src/tools/handlers.ts` | Tool dispatcher: maps tool name → handler function. Each handler takes `(input, ctx: AgentContext)` and returns JSON-serializable result. |
| `src/provision.ts` | `provisionProject(notion, briefId, briefTitle): Promise<ProjectIds>`. Phase 1 (root page + Plan page + 6 bare DBs). Phase 2 (relation PATCHes). Idempotent. |
| `src/agentLoop.ts` | Generic `runAgent({ systemPrompt, brief, ctx, tools, stepBudget, model, thinking? }): Promise<AgentResult>`. Hand-rolled Anthropic tool-use loop. |
| `src/classify.ts` | `classifyBrief(brief): Promise<Category>`. Haiku call returning one of 5 categories. |
| `src/state.ts` | `readHivemindState(notion, pageId): Promise<HivemindState>` and `writeHivemindState(notion, pageId, state): Promise<void>`. JSON-in-rich-text helpers. |
| `src/chains.ts` | Category→chain table. `getChainForCategory(category): AgentSpec[]`. `AgentSpec = { name, model, stepBudget, thinking?, tools }`. |
| `src/pacer.ts` | Shared rate pacer. Wraps Notion calls in 3 RPS budget. |
| `src/budget.ts` | Per-brief token budget tracker. `TokenBudget` class. Hard fail at 200k total. |

### Refactored modules

| File | Changes |
|---|---|
| `src/index.ts` | Replace in-memory dedup Set with `state.ts`. Add admin tool capabilities for `triggerClassify`, `triggerProvision`, `repairBrief`. Keep `notionWhoAmI`, `pingClaude`. |
| `src/chain.ts` | Rewrite as orchestrator: classify → provision → execute chain. Retry detection via Drafts DB query (fallback to v0 heading regex if no drafts found). Preserves stage-tagged error reporting. |
| `src/agents.ts` | Delete markdown-returning code. Each agent (Scout/Forge/Scribe/Sentinel) is now: system prompt + `runAgent()` invocation with category-specific config. |
| `src/notion.ts` | Keep `mdToBlocks`, `appendBlocks`, block builders (heading2 etc.), `postComment`, `setBriefProperties`, error fallback helpers. **Improve `mdToBlocks` to split on whitespace not mid-word** (Metis #18). Add new builders: toggle, callout, divider, image_url, bookmark, mention helpers. |

### Scripts

| File | Changes |
|---|---|
| `scripts/seedBriefs.ts` | Bump Notion-Version to 2025-09-03. New body shape: `initial_data_source.properties`. Add `Category` select prop and `Hivemind State` rich-text prop. Idempotent re-run (check for existing DB by name). |

### Config / Docs

| File | Changes |
|---|---|
| `.env.example` | Document existing keys. Note: no new env vars needed (toolsets/chains hardcoded). |
| `PLANNING.md` | Update architecture section with workspace-centric model. New diagram. |
| `AGENTS.md` (= `.agents/INSTRUCTIONS.md`) | Add section on tool-using-agent conventions. Add Notion-Version 2025-09-03 reminder. |
| `test.ts` | `npx tsx test.ts` exec-based suite. One case per agent + provision + classify + scope guard. |

---

## 4. Tool Registry

All tools follow Anthropic `Tool` shape. Names are lowerCamelCase. Strict schemas (`additionalProperties: false`). Every tool's handler returns a JSON-stringified result body.

### Read tools (read scope: workspace-wide)

| Tool | Input | Output |
|---|---|---|
| `searchWorkspace` | `{ query: string, page_size?: number ≤ 100 }` | Array of `{ id, title, type, parent }` |
| `readPage` | `{ page_id: string }` | `{ id, title, properties, blocks: [string per block] }` (stringified body) |
| `readDataSource` | `{ data_source_id: string, filter?: object, page_size?: number ≤ 100, start_cursor?: string }` | `{ rows: [{ id, properties }], next_cursor?: string }` |
| `getBriefMetadata` | `{}` (uses current brief) | `{ id, title, body, status, category, project_root_id }` |
| `getProjectIds` | `{}` (uses current project) | `{ project_root_id, plan_page_id, dbs: { drafts: { db_id, ds_id }, ... } }` |
| `readPlanSection` | `{ section: "Context"\|"Approach"\|"Open Questions"\|"Status" }` | `{ blocks: [string per block] }` |
| `listDrafts` | `{}` | `[{ id, iteration, status, summary, created_at }]` |
| `getDraft` | `{ draft_id }` | `{ id, iteration, status, body, sources, author_agent }` |
| `listReviews` | `{ draft_id?: string }` | `[{ id, draft_id, verdict, summary }]` |

### Write tools (write scope: subtree only — guarded)

| Tool | Input | Output |
|---|---|---|
| `appendBlocks` | `{ page_id, blocks: BlockShape[] }` | `{ block_ids: string[] }` |
| `updateBlock` | `{ block_id, type, content }` | `{ updated: true }` |
| `deleteBlock` | `{ block_id }` | `{ deleted: true }` |
| `setPlanSection` | `{ section, blocks: BlockShape[] }` | replaces section body — `{ section, block_count }` |
| `appendToPlanSection` | `{ section, blocks: BlockShape[] }` | `{ block_count }` |
| `createChildPage` | `{ parent_id, title, blocks?: BlockShape[] }` | `{ page_id }` |
| `createDraft` | `{ summary, body: string (markdown), sources?: string[] (URLs), based_on_draft_id?: string }` | `{ draft_id, iteration }` |
| `updateDraftStatus` | `{ draft_id, status: "draft"\|"in-review"\|"needs-revision"\|"approved" }` | `{ updated: true }` |
| `createReview` | `{ draft_id, verdict: "approve"\|"needs-revision", strengths: string[], risks: string[], summary: string }` | `{ review_id }` |
| `createSource` | `{ title, url, summary?: string, citations?: string[] }` | `{ source_id }` |
| `createDecision` | `{ title, choice, rationale, alternatives_considered?: string[] }` | `{ decision_id }` |
| `createOpenQuestion` | `{ question, why_it_matters?: string }` | `{ question_id }` |
| `addComment` | `{ target: { page_id }\|{ block_id }, text }` | `{ comment_id }` |
| `setBriefStatus` | `{ status: "In Progress"\|"Needs Review"\|"Failed" }` | `{ updated: true }` |
| `setBriefOwner` | `{ owner: "Scout"\|"Forge"\|"Scribe"\|"Sentinel"\|null }` | `{ updated: true }` |
| `setVerdict` (**Sentinel-only**) | `{ verdict: "approve"\|"needs-revision", summary }` | `{ verdict_set: true }` — drives Status transition |

### Control tools

| Tool | Input | Output |
|---|---|---|
| `done` | `{ summary?: string }` | Terminates loop. Equivalent to `stop_reason: "end_turn"` but explicit. |

### Per-agent whitelists

| Agent | Allowed tools |
|---|---|
| **Scout** | searchWorkspace, readPage, readDataSource, getBriefMetadata, getProjectIds, setPlanSection, appendToPlanSection, createSource, createOpenQuestion, addComment, done |
| **Forge** | searchWorkspace, readPage, readDataSource, getBriefMetadata, getProjectIds, readPlanSection, listDrafts, getDraft, listReviews, createDraft, updateDraftStatus, createDecision, createOpenQuestion, addComment, done |
| **Scribe** | (same as Forge — different system prompt, writes longer-form drafts) |
| **Sentinel** | searchWorkspace, readPage, readDataSource, getBriefMetadata, getProjectIds, readPlanSection, listDrafts, getDraft, createReview, **setVerdict**, addComment, done |

### Block shape (subset for v0 — covers 80% of real use)

`BlockShape` is a discriminated union:
- `{ type: "paragraph", text: string }`
- `{ type: "heading_2"|"heading_3", text: string }`
- `{ type: "bulleted_list_item"|"numbered_list_item"|"to_do", text: string, checked?: boolean }`
- `{ type: "quote", text: string }`
- `{ type: "code", text: string, language?: string }`
- `{ type: "callout", text: string, emoji?: string, color?: string }`
- `{ type: "toggle", text: string, children?: BlockShape[] }`
- `{ type: "divider" }`
- `{ type: "bookmark", url: string }`
- `{ type: "mention_page", page_id: string }` (returns paragraph with page mention)
- `{ type: "mention_user", user_id: string }` (returns paragraph with user mention)

Conversion to Notion block JSON in `src/notion.ts` builder helpers.

---

## 5. Per-DB Schemas

All DBs created in **Phase 1** with NO relation properties. Relations added in **Phase 2** (`dataSources.update` PATCH).

### Drafts

| Property | Type | Notes |
|---|---|---|
| `Name` | title | Auto: `"Draft N — {summary first 60 chars}"` |
| `Iteration` | number | 1, 2, 3, ... |
| `Status` | select | options: `draft, in-review, needs-revision, approved` |
| `Author Agent` | select | options: `Forge, Scribe` |
| `Summary` | rich_text | One-paragraph summary |
| `Sources` | url (NOT relation — keep simple) | First source URL |
| `Based On Draft` | (added Phase 2) relation → Drafts | Same-DB self-relation for retry chains |
| `Body` | (page body, not property) | Full draft text as page content |

### Reviews

| Property | Type | Notes |
|---|---|---|
| `Name` | title | Auto: `"Review of Draft {iteration} — {verdict}"` |
| `Verdict` | select | options: `approve, needs-revision` |
| `Draft` | (Phase 2) relation → Drafts | dual_property, synced as `Reviews` on Drafts |
| `Reviewer` | select | options: `Sentinel` |
| `Strengths` | rich_text | Bullet list as concatenated text |
| `Risks` | rich_text | Bullet list as concatenated text |
| `Summary` | rich_text | One-paragraph summary |

### Decisions

| Property | Type | Notes |
|---|---|---|
| `Name` | title | The decision in one sentence |
| `Choice` | rich_text | What was decided |
| `Rationale` | rich_text | Why |
| `Alternatives Considered` | rich_text | Bullet list as concatenated text |
| `Made By Agent` | select | options: `Scout, Forge, Scribe, Sentinel, Human` |
| `Made At` | date | Timestamp |

### Sources

| Property | Type | Notes |
|---|---|---|
| `Name` | title | Source title |
| `URL` | url | |
| `Summary` | rich_text | 1-3 sentences |
| `Captured By` | select | options: `Scout, Forge, Scribe, Sentinel` |

### Open Questions

| Property | Type | Notes |
|---|---|---|
| `Name` | title | The question |
| `Why It Matters` | rich_text | |
| `Status` | select | options: `open, answered` |
| `Answer` | rich_text | |
| `Asked By` | select | options: `Scout, Forge, Scribe, Sentinel` |

### Activity

| Property | Type | Notes |
|---|---|---|
| `Name` | title | Auto: `"{Agent} — {timestamp}"` |
| `Agent` | select | options: `Scout, Forge, Scribe, Sentinel, Orchestrator` |
| `Action` | select | options: `start, finish, error, verdict` |
| `Step Count` | number | Tool calls consumed |
| `Tokens In` | number | |
| `Tokens Out` | number | |
| `Duration Ms` | number | |
| `When` | date | Timestamp |
| (page body) | toggle blocks per step with `{step N: tool_name → result_preview}` |

### Briefs DB (updates to existing)

Add to existing Briefs DB:
- `Category` — select: `visual-engineering, ultrabrain, deep, quick, writing`
- `Hivemind State` — rich_text (single hidden-via-view JSON blob storing `{ lastDeliveryId, projectRootId, planPageId, dsIds: { drafts, reviews, decisions, sources, openQuestions, activity }, budget: { tokensUsed } }`)

Status options unchanged: `Backlog, Triaged, In Progress, Needs Review, Done, Failed, Archived`
Owner options unchanged: `Triage, Scout, Forge, Scribe, Sentinel`

---

## 6. Agent Chain Configuration

```ts
// src/chains.ts
export type AgentName = "Scout" | "Forge" | "Scribe" | "Sentinel";

export interface AgentSpec {
  name: AgentName;
  model: string;
  thinking?: { budget_tokens: number };
  stepBudget: number;
  systemPrompt: string;
  toolNames: string[];
}

export const CHAINS: Record<Category, AgentName[]> = {
  "quick":               ["Forge", "Sentinel"],
  "writing":             ["Scout", "Scribe", "Sentinel"],
  "deep":                ["Scout", "Forge", "Sentinel"],
  "ultrabrain":          ["Scout", "Forge", "Sentinel"],
  "visual-engineering":  ["Scout", "Forge", "Sentinel"],
};

export const AGENT_CONFIG: Record<Category, Partial<Record<AgentName, AgentSpec>>> = {
  // Per-category model & step-budget overrides
};

// Defaults per agent
const DEFAULTS: Record<AgentName, Omit<AgentSpec, "model" | "thinking">> = {
  Scout:    { name: "Scout",    stepBudget: 8,  systemPrompt: SCOUT_SYSTEM,    toolNames: SCOUT_TOOLS },
  Forge:    { name: "Forge",    stepBudget: 15, systemPrompt: FORGE_SYSTEM,    toolNames: FORGE_TOOLS },
  Scribe:   { name: "Scribe",   stepBudget: 15, systemPrompt: SCRIBE_SYSTEM,   toolNames: SCRIBE_TOOLS },
  Sentinel: { name: "Sentinel", stepBudget: 5,  systemPrompt: SENTINEL_SYSTEM, toolNames: SENTINEL_TOOLS },
};

// Model selection
const MODELS: Record<Category, Record<AgentName, string>> = {
  "quick":              { Scout: HAIKU, Forge: HAIKU,  Scribe: HAIKU,  Sentinel: SONNET },
  "writing":            { Scout: SONNET, Forge: OPUS,   Scribe: OPUS,   Sentinel: SONNET },
  "deep":               { Scout: SONNET, Forge: SONNET, Scribe: SONNET, Sentinel: SONNET },
  "ultrabrain":         { Scout: SONNET, Forge: OPUS,   Scribe: OPUS,   Sentinel: SONNET }, // + extended thinking
  "visual-engineering": { Scout: SONNET, Forge: OPUS,   Scribe: OPUS,   Sentinel: SONNET },
};

const HAIKU  = "claude-haiku-4-5";
const SONNET = "claude-sonnet-4-5";
const OPUS   = "claude-opus-4-7";
```

`ultrabrain` enables `thinking: { type: "enabled", budget_tokens: 8000 }` for Forge and Sentinel.

---

## 7. State Machine

```
                  Backlog
                     │ (human moves card)
                     ▼
                  Triaged ────────────────────┐
                     │                        │ (bounce-back from Needs Review)
                     ▼                        │
              (classify → provision)          │
                     │                        │
                     ▼                        │
               In Progress ◄──────────────────┘
              (Owner cycles: Scout → Forge/Scribe → Sentinel)
                     │
                     │ Sentinel calls setVerdict
                     │
            ┌────────┴────────┐
   verdict=approve         verdict=needs-revision
            │                     │
            ▼                     ▼
       Needs Review        Needs Review
            │                     │ (human bounces back to Triaged)
            │ (human approves)
            ▼
          Done ──→ handleBriefApproved: approval comment + Activity finalize
```

Failures: any catch in chain → `setBriefStatus("Failed")` + error blocks + comment fallback (preserved from v0).

---

## 8. Provisioning Flow

```ts
// src/provision.ts pseudocode

async function provisionProject(notion, briefId, briefTitle): Promise<ProjectIds> {
  // 0. Idempotency check
  const state = await readHivemindState(notion, briefId);
  if (state.projectRootId) {
    return await rehydrateProjectIds(notion, briefId, state);
  }

  // 1. Create root page under brief
  const rootPage = await notion.pages.create({
    parent: { type: "page_id", page_id: briefId },
    properties: {
      title: { title: [{ type: "text", text: { content: `📁 ${briefTitle}` } }] },
    },
  });

  // PERSIST projectRootId immediately so partial failure can recover
  await writeHivemindState(notion, briefId, { ...state, projectRootId: rootPage.id });

  // 2. Create Plan child page with structured sections
  const planPage = await notion.pages.create({
    parent: { type: "page_id", page_id: rootPage.id },
    properties: { title: { title: [{ type: "text", text: { content: "Plan" } }] } },
    children: [
      heading2("Context"),    paragraph("_Pending Scout output_"),
      heading2("Approach"),   paragraph("_Pending Scout output_"),
      heading2("Open Questions"), paragraph("_Pending agents_"),
      heading2("Status"),     paragraph("_Pending orchestrator_"),
    ],
  });

  // 3. Phase 1: Create all 6 DBs with NO relations
  // Use notion.request({method:"post", path:"databases", body: {parent, title, is_inline, initial_data_source: {properties}}})
  // Body shape per 2025-09-03: properties live under initial_data_source.properties
  const dsIds = {};
  for (const def of DB_DEFINITIONS) {
    // Check idempotently: list root children, skip if DB with this name exists
    const existing = await findExistingDbByName(notion, rootPage.id, def.name);
    if (existing) {
      dsIds[def.key] = existing;
      continue;
    }
    const res = await notion.databases.create({...});
    dsIds[def.key] = { dbId: res.id, dsId: res.data_sources[0].id };
  }

  // 4. Phase 2: PATCH relation properties
  // Drafts.Based On Draft → Drafts (self-relation)
  // Reviews.Draft → Drafts (dual_property, synced as Reviews on Drafts)
  await notion.dataSources.update({
    data_source_id: dsIds.drafts.dsId,
    properties: {
      "Based On Draft": { relation: { data_source_id: dsIds.drafts.dsId, single_property: {} } },
    },
  });
  await notion.dataSources.update({
    data_source_id: dsIds.reviews.dsId,
    properties: {
      "Draft": { relation: { data_source_id: dsIds.drafts.dsId, dual_property: { synced_property_name: "Reviews" } } },
    },
  });

  // 5. Persist all IDs to Hivemind State
  await writeHivemindState(notion, briefId, {
    projectRootId: rootPage.id,
    planPageId: planPage.id,
    dsIds,
    ...state,
  });

  return { projectRootId: rootPage.id, planPageId: planPage.id, dsIds };
}
```

---

## 9. Scope Guard Design

```ts
// src/scope.ts pseudocode

export class ScopeGuard {
  private readonly ancestorCache = new Map<string, Set<string>>(); // pageId → ancestor IDs
  private readonly sessionAllowed = new Set<string>(); // pages this loop created

  constructor(private readonly notion: Client, private readonly projectRootId: string) {
    this.sessionAllowed.add(projectRootId);
  }

  /** Mark a page as safe to write to (call after agent successfully creates it). */
  registerCreated(pageId: string): void {
    this.sessionAllowed.add(pageId);
  }

  /** Throws if pageId is NOT in projectRoot ancestry. Cached. */
  async assertAllowed(pageId: string): Promise<void> {
    if (this.sessionAllowed.has(pageId)) return;

    let ancestors = this.ancestorCache.get(pageId);
    if (!ancestors) {
      ancestors = await this.walkAncestors(pageId);
      this.ancestorCache.set(pageId, ancestors);
    }

    if (!ancestors.has(this.projectRootId)) {
      throw new ScopeViolation(`Page ${pageId} is not within project ${this.projectRootId}`);
    }
    this.sessionAllowed.add(pageId);
  }

  private async walkAncestors(pageId: string): Promise<Set<string>> {
    const out = new Set<string>();
    let current: string | undefined = pageId;
    while (current) {
      out.add(current);
      const page = await this.notion.pages.retrieve({ page_id: current });
      const parent = (page as any).parent;
      if (parent?.type === "page_id") current = parent.page_id;
      else if (parent?.type === "data_source_id") {
        // walk via data source's database, then its parent
        const ds = await this.notion.dataSources.retrieve({ data_source_id: parent.data_source_id });
        current = (ds as any).parent?.page_id;
      }
      else current = undefined;
    }
    return out;
  }
}
```

**Wrap every WRITE handler in `handlers.ts` with `await guard.assertAllowed(targetPageId)` before executing.** Reads bypass the guard.

---

## 10. Implementation Waves (Parallel Task Graph)

### Wave 1 — Independent foundations (PARALLEL)

| Task | Files | Category | Skills | Verification |
|---|---|---|---|---|
| **W1.1 — Scope guard** | `src/scope.ts` | quick | [] | Verification: `npx tsc --noEmit` (exit 0); `grep -E "registerCreated\|assertAllowed" src/scope.ts` shows both methods; `grep -E "^export" src/scope.ts` shows ScopeGuard, ScopeViolation exported. Full integration test in W4. |
| **W1.2 — State JSON helpers** | `src/state.ts` | quick | [] | Verification: `npx tsc --noEmit` (exit 0); `grep -E "readHivemindState\|writeHivemindState" src/state.ts` shows both functions exported. Round-trip test in W4. |
| **W1.3 — Rate pacer** | `src/pacer.ts` | quick | [] | Verification: `npx tsc --noEmit` (exit 0); `grep "class.*Pacer\|export.*pacer" src/pacer.ts` shows Pacer class exported. Timing test in W4. |
| **W1.4 — Token budget** | `src/budget.ts` | quick | [] | Verification: `npx tsc --noEmit` (exit 0); `grep -E "class.*Budget\|BudgetExceeded" src/budget.ts` shows TokenBudget class and BudgetExceeded error exported. |
| **W1.5 — Provisioner** | `src/provision.ts` | unspecified-high | [] | Verification: `npx tsc --noEmit` (exit 0); `grep "notion.dataSources.update" src/provision.ts` shows ≥2 calls (Phase 2 relations); `grep "notion.databases.create" src/provision.ts` shows ≥6 calls in loop; `grep "findExistingDbByName\|scanRootChildren" src/provision.ts` shows idempotency helper. Full end-to-end test in W4.4. |
| **W1.6 — Block builders + mdToBlocks improvement** | `src/notion.ts` (additions only) | quick | [] | Verification: `npx tsc --noEmit` (exit 0); `grep "mdToBlocks\|splitOnWhitespace" src/notion.ts` shows improved splitter; `grep -E "^export.*heading2\|^export.*toggle\|^export.*callout" src/notion.ts` shows new builders exported. |
| **W1.7 — Tool registry shapes** | `src/tools/registry.ts` | quick | [] | Verification: `npx tsc --noEmit` (exit 0); `grep "export.*Tool\|export.*SCOUT_TOOLS\|export.*FORGE_TOOLS" src/tools/registry.ts` shows all tool definitions and whitelists exported. |
| **W1.8 — Classifier** | `src/classify.ts` | quick | [] | Verification: `npx tsc --noEmit` (exit 0); `grep "export.*classifyBrief\|function classifyBrief" src/classify.ts` shows function exported; `grep "writing\|quick\|deep" src/classify.ts` shows category constants. |
| **W1.9 — Agent loop primitive** | `src/agentLoop.ts` | ultrabrain | [] | Verification: `npx tsc --noEmit` (exit 0); `grep "tool_results.*single user message\|in ONE user message" src/agentLoop.ts` shows parallel invariant documented; `grep "BudgetExceeded\|stop_reason" src/agentLoop.ts` shows error handling and stop_reason cases (end_turn, max_tokens, tool_use). |

### Wave 2 — Integration (DEPENDS ON W1.5–W1.9)

| Task | Files | Category | Skills | Verification |
|---|---|---|---|---|
| **W2.1 — Tool handlers** | `src/tools/handlers.ts` | unspecified-high | [] | Verification: `npx tsc --noEmit` (exit 0); `grep "export.*dispatch\|export.*handler" src/tools/handlers.ts` shows dispatcher exported; `grep "guard.assertAllowed" src/tools/handlers.ts` shows scope guard called on all write handlers. |
| **W2.2 — Agent system prompts + chain spec** | `src/chains.ts`, `src/agents.ts` (rewrite) | writing | [] | Verification: `npx tsc --noEmit` (exit 0); `grep "SCOUT_SYSTEM\|FORGE_SYSTEM\|SCRIBE_SYSTEM\|SENTINEL_SYSTEM" src/chains.ts` shows all 4 prompts defined; `grep "CHAINS\|AGENT_CONFIG" src/chains.ts` shows chain table and config exported. |
| **W2.3 — Chain orchestrator refactor** | `src/chain.ts` (rewrite) | unspecified-high | [] | Verification: `npx tsc --noEmit` (exit 0); `grep "classify\|provision\|runAgent" src/chain.ts` shows orchestrator flow; `grep "setBriefStatus\|setBriefOwner" src/chain.ts` shows status/owner transitions; `grep "catch.*Failed\|error.*comment" src/chain.ts` shows error fallback. |
| **W2.4 — Webhook handler refactor + admin tools** | `src/index.ts` (touch only dedup + new admin tools) | unspecified-high | [] | Verification: `npx tsc --noEmit` (exit 0); `grep "readHivemindState\|writeHivemindState" src/index.ts` shows state.ts integration; `grep "worker.tool.*classifyBrief\|worker.tool.*provisionProject\|worker.tool.*debugState" src/index.ts` shows 3 new admin tools registered. |

### Wave 3 — Setup + Docs (PARALLEL, depends only on Wave 2 schemas being final)

| Task | Files | Category | Skills | Verification |
|---|---|---|---|---|
| **W3.1 — seedBriefs.ts bump** | `scripts/seedBriefs.ts` | quick | [] | Verification: `npx tsc --noEmit` (exit 0); `grep "2025-09-03" scripts/seedBriefs.ts` shows Notion-Version updated; `grep "Category\|Hivemind State" scripts/seedBriefs.ts` shows new properties in schema. |
| **W3.2 — PLANNING.md update** | `PLANNING.md` | writing | [] | Verification: `grep -E "workspace-centric\|tool-using\|scope guard" PLANNING.md` shows new architecture sections; file is readable and well-formed. |
| **W3.3 — AGENTS.md / CLAUDE.md** | `AGENTS.md`, `CLAUDE.md` | writing | [] | Verification: `grep -E "tool-using-agent\|2025-09-03\|data_source_id" AGENTS.md` shows new sections; files are readable. |
| **W3.4 — test.ts (exec-based test suite)** | `test.ts` (new) | quick | [] | Verification: `npx tsc --noEmit` (exit 0); `grep "ntn workers exec" test.ts` shows exec commands for all 4 test cases. Test cases: (1) notionWhoAmI: `ntn workers exec notionWhoAmI --local -d '{}'` → output.id is UUID; (2) pingClaude: `ntn workers exec pingClaude --local -d '{"prompt":"respond with exactly: hivemind"}'` → output.text contains "hivemind"; (3) classifyBrief: `ntn workers exec classifyBrief --local -d '{"title":"Write a blog post about useEffect"}'` → output.category === "writing"; (4) provisionProject: `ntn workers exec provisionProject --local -d '{"briefId":"<TEST_BRIEF_ID_FROM_ENV>"}'` → output.projectRootId is UUID, output.dbs.drafts.dsId is UUID. Script exits 0 on all passes. |

### Wave 4 — End-to-end Verification (SEQUENTIAL)

| Task | Verification |
|---|---|
| **W4.1 — `npm run check`** | Verification: `npm run check` exits 0, no type errors. |
| **W4.2 — Run seedBriefs.ts** | Verification: `npx tsx scripts/seedBriefs.ts` exits 0; Briefs DB has Category select property with 5 options; Briefs DB has Hivemind State rich_text property. |
| **W4.3 — `ntn workers deploy`** | Verification: `ntn workers deploy` exits 0; worker deployed successfully. |
| **W4.4 — Manual QA (full chain)** | Steps: (1) Create new brief in Briefs DB: title="Write a 200-word post explaining what TypeScript is", Category=(leave blank). (2) Set Status → Triaged. (3) Wait 30s or watch `ntn workers runs logs --watch`. (4) Assert: Category auto-populated to "writing". (5) Assert: 📁 Project subtree appears under brief. (6) Assert: Project subtree contains Plan page + 6 DBs (Drafts, Reviews, Decisions, Sources, Open Questions, Activity). (7) Assert: Plan page Context + Approach sections populated by Scout. (8) Assert: Drafts DB has 1 row, status="in-review". (9) Assert: Reviews DB has 1 row, verdict="approve" or "needs-revision". (10) Assert: Activity DB has 3 rows (Scout, Scribe, Sentinel). (11) Assert: Brief status is now "Needs Review". |
| **W4.5 — Manual QA (bounce-back)** | Steps: (1) From W4.4 brief, if verdict was "needs-revision", manually set Status → Triaged. (2) Wait 30s. (3) Assert: chain re-runs, Drafts DB query detects in-progress draft, new iteration created. (4) Assert: Reviews DB gets new row with updated verdict. |
| **W4.6 — Manual QA (budget circuit-breaker)** | Steps: (1) Create a new brief with extremely long title (>5000 chars) to trigger token budget. (2) Set Status → Triaged. (3) Wait 30s. (4) Assert: Brief marked "Failed". (5) Assert: Comment posted on brief with "budget exceeded" message. |
| **W4.7 — Manual QA (scope violation)** | Steps: (1) Manually create a test page OUTSIDE the project subtree. (2) Inject a synthetic agent input that tries to write to that page. (3) Assert: ScopeViolation thrown. (4) Assert: Brief marked "Failed" with error comment. |
| **W4.8 — Migration test (existing v0 brief)** | Steps: (1) Pick any existing brief in Briefs DB (one from v0 with Forge headings). (2) Move it back to Triaged. (3) Assert: new orchestrator detects missing Project Root, provisions subtree fresh. (4) Assert: existing brief body is preserved (not wiped). (5) Assert: chain runs cleanly. |

---

## 11. Risks + Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Sandbox timeout kills chain mid-run | Medium | High (brief stuck In Progress) | Verify Vercel plan tier with user; if Hobby (45min) we're fine; if 5min default, need state-machine split. **Action: ask user before deploy.** |
| Implementer uses `database_id` instead of `data_source_id` | High | High (silent breaks under 2025-09-03) | Plan explicitly enumerates the 3 surfaces. QA includes `rg "database_id" src/` review with allow-list. |
| Parallel tool_results split into multiple user messages | Medium | High (parallel calling degrades) | Agent loop unit test asserts single-message batching. |
| Scope guard ancestor walks blow rate limit | Medium | Medium | Ancestor cache (one walk per page per session) + session allowed-set keeps RPS bounded. |
| Two simultaneous webhooks for same brief race on dedup | Low | Low (idempotent re-runs are tolerable) | Accept. Document. Add lock in v1 if seen. |
| `worker.database()` is no longer UI-readonly in v0.4.0 | Low | Low | Verify with a 1-minute spike before deploy; if changed, we've lost typed schemas but gained nothing else critical. **Action: small verification spike before W3.1.** |
| Anthropic API returns `stop_reason: "max_tokens"` with truncated `tool_use` | Medium | High (loop crashes) | Agent loop handles `max_tokens` explicitly: errors out cleanly, posts diagnostic comment. |
| `mdToBlocks` whitespace-split regression on long content | Medium | Medium | Improved splitter must have unit test covering 2500-char paragraph. |
| Activity DB write amplification (still ~4 rows per brief × 4 agents × many briefs) | Low | Low | Single row per agent invocation. Step detail in toggle blocks. Acceptable. |
| Cost overrun (Opus + Sonnet + Haiku × ~20 turns) | Medium | Medium ($ pain) | 200k token budget circuit-breaker hard-fails brief with comment. |
| Migration: in-flight v0 briefs hit new code | Low | Low | Heuristic: if no `Project Root Page ID`, treat as fresh and provision. Old heading-regex retry as fallback if Drafts DB query returns empty. |

---

## 12. Out of Scope (v1)

Explicit non-goals for this PR:

- Skills DB (toolset toggleable from Notion)
- Workflows DB (brief→brief chaining as data)
- Per-category DB shape variation (uniform 6 DBs for all categories in v0)
- File upload tool
- Page templates / `dataSources.listTemplates`
- Multi-select Category (hybrid briefs)
- Atomic Brief Lock (real concurrency lock vs idempotent re-runs)
- Auto-archive of completed project subtrees
- `repairBrief` admin tool (deferred to first time we need it)
- Cross-vendor agents (all on Anthropic for now)
- Inline rich-text mentions inside tool inputs (LLM-emitted page mentions require schema work — defer)
- Extended thinking for `ultrabrain` (note: kept in spec but may defer if Anthropic SDK 0.39.0 doesn't expose `thinking` param — verify in W1.9)

---

## 13. Open Questions for User (BEFORE EXECUTION)

These are NOT blocking — defaults locked above — but the user should confirm:

1. **Vercel plan tier?** (Affects sandbox timeout: Hobby 45min, Pro/Enterprise 5h, default 5min.) Plan assumes ≥5min budget. If user is on the Hobby tier, we're fine. If on stricter, we may need state-machine split — but only if we observe timeouts in practice.
2. **OK with hardcoded toolsets / chains for v0?** (Skills DB + Workflows DB deferred to v1.)
3. **OK with dropping OpenAI Sentinel?** (All agents on Anthropic. Removes OPENAI_API_KEY dependency.)
4. **OK with no atomic dedup lock?** (Idempotent re-runs accepted as the design.)
5. **New admin tool capabilities for test/QA:** Plan W2.4 must add three new `worker.tool()` capabilities to `src/index.ts`: `classifyBrief` (wraps `classify.ts`), `provisionProject` (wraps `provision.ts`), `debugState` (read + pretty-print Hivemind State for a brief). These are used by `test.ts` for smoke testing and by humans for debugging. Confirm OK to add these.

Default: proceed with these answers as "yes" unless user objects.
