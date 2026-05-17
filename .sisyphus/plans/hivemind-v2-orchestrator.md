# Hivemind v2 — Orchestrator-First Refactor

**Status:** PLAN (awaiting Momus review)
**Target:** Replace v1's fixed Scout→Forge→Sentinel chain with a single Architect agent that delegates to specialist sub-agents on demand, mirroring the Sisyphus orchestration pattern from OpenCode.
**Repo:** `/Users/kristian/projects/hivemind-notion`
**Branch policy:** Direct on `main`. Multi-phase rollout; each phase is independently shippable so we can validate early.
**Supersedes:** `.sisyphus/plans/hivemind-omo-orchestrator.md` (v1 plan; archive to `.sisyphus/archive/` after v2 lands).

---

## 1. Vision & Decisions

The user wants Hivemind to work the way I (Sisyphus / OpenCode) work: **one main agent that does most of the work itself and delegates only when delegation saves tokens or accesses specialist capabilities.** No fixed chain. No category-driven branching. Just one Architect, a small toolbox of sub-agents, and a Notion subtree that displays the work the way an OpenCode session log does.

**User-locked decisions** (from the design conversation):

| # | Decision | Implication |
|---|---|---|
| D1 | One **Architect** agent drives every brief end-to-end | Drops fixed-chain orchestrator in `chain.ts` |
| D2 | Sub-agents (Scout, Librarian, Oracle, Sentinel, Anvil) are spawned via tool calls | New `delegateX` tool family in `tools/delegate.ts` |
| D3 | Forge & Scribe disappear — Architect writes the deliverable itself | Removes 2 agents, half the system prompts, all chain-shape branching |
| D4 | All agents run **claude-haiku-4-5** | Cheap. Architect's system prompt has to be tight/prescriptive since Haiku is weaker at meta-reasoning |
| D5 | **Drop the category-routing model.** Architect detects intent at runtime | Removes `classify.ts` from the routing path (kept as informational tool only). Removes category-bifurcated provision shapes. |
| D6 | Architect **can dispatch to Anvil** via `delegateAnvil({ task_spec })` | Unifies the Forge-Local flow into the orchestrator model. Fire-and-forget; Anvil writes results back to the subtree, Architect picks them up on next webhook trigger. |
| D7 | Notion **Activity page becomes a rich transcript** modeled on an OpenCode session log | Sub-agent runs render as toggle blocks with expandable detail. This is the "impressive output" deliverable. |
| D8 | **Unified provision layout** (Plan + Drafts DB + Activity always present) | Architect chooses writeAnswer vs createDraft at runtime, doesn't care which is "pre-provisioned" |

**Derived constraints** (locked by D1–D8):

- **D9.** Brief Status state machine collapses: `Backlog → Triaged → InProgress(Architect) → NeedsReview → Done | Failed`. Owner is `Architect` during run, or null. (Removes Scout / Forge / Scribe / Sentinel as Owner values.)
- **D10.** Existing scope guard / pacer / token budget / chain lock / dedup mechanisms in v1 are reused verbatim — they're agent-shape-agnostic.
- **D11.** Anvil delegation is **async**: Architect calls `delegateAnvil`, sets Status=`Waiting for Anvil`, terminates its turn. Anvil writes outputs back to subtree and flips Status=`Triaged` when done → webhook re-fires → Architect resumes by reading the subtree.
- **D12.** Sub-agents return ONLY a compressed `summary` to the Architect via a `respond` tool. Their working tokens never enter the Architect's context window. Side effects (Sources captured, blocks written) live in Notion.
- **D13.** Sub-agents are spawned **synchronously** within the Architect's tool call (except Anvil). The Architect waits, the tool returns the summary. Step-budget and token-budget guards prevent runaway sub-agents.
- **D14.** The brief's `Category` select property is kept on the Briefs DB as **informational metadata only** (useful for kanban filters), but does NOT route execution. The Architect ignores it. Classifier may still run on Backlog→Triaged transitions to set it, but with no behavioral consequence.

---

## 2. Architecture Overview

### 2.1 Agent roster

| Sisyphus equivalent | Hivemind v2 name | Model | Role | Step budget | Task budget |
|---|---|---|---|---|---|
| (me, orchestrator) | **🧠 Architect** | Haiku 4.5 | Main agent. Reads brief, plans, writes deliverable, delegates when valuable. Drives Status. | 60 | 150k |
| `explore` | **🔍 Scout** | Haiku 4.5 | Workspace contextual grep. Returns `{summary, sources}`. Persists Sources to Plan page. | 10 | 40k |
| `librarian` | **📚 Librarian** | Haiku 4.5 | External reference grep. Reads Notion Docs MCP + URLs in brief. Returns `{summary, sources}`. | 8 | 30k |
| `oracle` | **🦉 Oracle** | Haiku 4.5 + extended thinking (budget=8k) | Read-only deep reasoning for tough decisions. Returns `{analysis}`. | 6 | 60k |
| `momus` | **🛡️ Sentinel** | Haiku 4.5 | Final critic. Reads brief + Plan + draft, posts review, sets verdict. Returns `{verdict, summary}`. | 8 | 40k |
| (Anvil daemon) | **⚒️ Anvil** | (external) | Local-executor dispatch. Architect fires off task, gets ACK. Anvil writes results back. | n/a (async) | n/a |

**Removed from v1:** Scout (rebuilt as a thinner sub-agent), Forge, Scribe.

### 2.2 Execution flow

```
Webhook: Status=Triaged
  │
  ├─ Lock (chain lock — preserved from v1)
  │
  ├─ Provision subtree (idempotent, unified layout)
  │     ├─ Project root page (📁 + cover + dashboard)
  │     ├─ 📄 Answer anchor heading
  │     ├─ Plan child page (Context/Approach/Decisions/Sources/Open Questions/Status)
  │     ├─ Drafts child database (always present, may be unused)
  │     └─ Activity child page (rich transcript)
  │
  ├─ Set Brief: Owner=Architect, Status=In Progress
  │
  ├─ Architect runs (Anthropic tool-use loop, ~60 steps max)
  │     │
  │     ├─ Tool call: getBriefMetadata, getProjectIds
  │     ├─ Tool call: setPlanSection("Context", ...)
  │     ├─ Tool call: delegateScout({...}) ← spawns fresh runAgent() with Scout prompt
  │     ├─ Tool call: setPlanSection("Approach", ...)
  │     ├─ Tool call: delegateOracle({...}) ← spawns fresh runAgent() with Oracle prompt
  │     ├─ Tool call: createDecision({...})
  │     ├─ Tool call: writeAnswer({...})  OR  createDraft({...})
  │     ├─ Tool call: delegateSentinel({...}) ← spawns fresh runAgent() with Sentinel prompt
  │     │     ↳ Sentinel posts review, calls setVerdict, returns verdict to Architect
  │     ├─ Tool call: setBriefStatus("Needs Review" | "In Progress")
  │     └─ Tool call: done
  │
  └─ Release lock, persist final state
```

**Anvil branch:**

```
Architect calls delegateAnvil({ task_spec })
  ↓
delegateAnvil tool:
  1. Writes task_spec to Plan's Approach section
  2. Sets Status=Waiting for Anvil, Owner=null
  3. Publishes brief.dispatched to Pusher (existing path)
  4. Calls Architect's done tool implicitly — Architect must stop after this.
  ↓
Anvil picks up, executes, writes results to Drafts DB / Plan / Activity
  ↓
Anvil flips Status=Triaged (or Done if it can verify itself)
  ↓
Webhook re-fires → Architect resumes with full subtree context.
```

### 2.3 Sub-agent contract (uniform across Scout/Librarian/Oracle/Sentinel)

```typescript
interface SubAgentSpec {
  name: "Scout" | "Librarian" | "Oracle" | "Sentinel";
  model: "claude-haiku-4-5";
  thinking?: { type: "enabled"; budget_tokens: number };
  stepBudget: number;
  taskBudgetTokens: number;
  systemPrompt: string;          // specialist behavior, narrow + prescriptive
  tools: readonly string[];      // small whitelist
  respondToolName: "respond";    // mandatory final tool
}
```

Every sub-agent's tool whitelist includes a mandatory `respond` tool. Calling `respond({ summary, ...metadata })` is how the sub-agent surfaces its findings to the Architect. The `respond` tool's return is the final value the orchestrator extracts from the sub-agent's session.

`respond` schemas per sub-agent:

```typescript
// Scout
respond({
  summary: string,           // 1-3 paragraphs, source-anchored
  sources_captured: number,  // count for activity logging
  open_questions: string[]   // any unanswerable parts of the query
})

// Librarian
respond({
  summary: string,
  sources_captured: number
})

// Oracle
respond({
  analysis: string,          // structured reasoning, headings allowed
  recommendation: string,    // 1-sentence
  confidence: "high" | "medium" | "low"
})

// Sentinel
respond({
  verdict: "approve" | "needs-revision",
  summary: string,
  strengths: string[],
  risks: string[]
})
```

---

## 3. Tool Surface

### 3.1 Architect tools (large by design)

Read & navigate:
- `searchWorkspace`, `readPage`, `readDataSource` (reused from v1)
- `getBriefMetadata`, `getProjectIds` (reused)
- `readPlanSection`, `listDrafts`, `getDraft`, `getDraftBody` (reused)

Write the Plan (memory):
- `setPlanSection`, `appendToPlanSection` (reused)
- `createSource`, `createDecision`, `createOpenQuestion` (reused — these write to Plan sections AND associated mini-DBs)

Produce the deliverable:
- `writeAnswer({ body, sources? })` (reused — direct prose answer on root)
- `createDraft({ summary, body, sources?, based_on_draft_id? })` (reused — iterative drafts)

Free-form output:
- `appendBlocks`, `updateBlock`, `deleteBlock`, `createChildPage` (reused)

Brief signaling:
- `setBriefStatus`, `setBriefOwner`, `addComment` (reused)

**NEW delegation tools** (the heart of v2):
- `delegateScout({ query, context })` — spawns Scout sub-agent
- `delegateLibrarian({ query, context })` — spawns Librarian sub-agent
- `delegateOracle({ question, context })` — spawns Oracle sub-agent
- `delegateSentinel({ target_kind: "draft"|"answer", target_id? })` — spawns Sentinel sub-agent
- `delegateAnvil({ task_spec })` — async, fires Pusher dispatch, transitions Status, terminates Architect turn

Terminate:
- `done({ summary })` (reused)

### 3.2 Sub-agent tools

**Scout tools** (workspace reads, can append findings to Plan):
- `searchWorkspace`, `readPage`, `readDataSource`
- `getBriefMetadata`, `getProjectIds`
- `appendToPlanSection` (Sources, Context only — narrow)
- `createSource`, `createOpenQuestion`
- `respond`

**Librarian tools** (Notion Docs MCP + external URLs; later might add web fetch):
- `getBriefMetadata`, `getProjectIds`
- `notionDocsSearch`, `notionDocsRead` (NEW — wraps the `notion-docs` MCP — see §4.4)
- `fetchUrl` (NEW — fetch + extract text from URLs given in brief; capped to brief-body URLs only, no arbitrary internet)
- `createSource`, `createOpenQuestion`
- `respond`

**Oracle tools** (read-only):
- `searchWorkspace`, `readPage`, `readDataSource`
- `readPlanSection`, `listDrafts`, `getDraft`, `getDraftBody`
- `getBriefMetadata`, `getProjectIds`
- `respond`
- *No write tools.* Oracle is consultative only.

**Sentinel tools** (review only):
- `getBriefMetadata`, `getProjectIds`
- `readPlanSection`, `listDrafts`, `getDraft`, `getDraftBody`
- `readPage` (for inline-answer review)
- `createReview`, `setVerdict` (reused from v1)
- `respond`

**Anvil tools:** N/A — Anvil is a separate daemon, not a runAgent() sub-agent.

### 3.3 `respond` tool (universal sub-agent exit)

Each sub-agent's schema for `respond` is defined inline in the sub-agent's tool whitelist. The dispatcher recognizes `respond` calls by name and treats them like `done` in v1 — terminates the sub-agent loop and returns the `respond` payload to the parent.

---

## 4. Implementation

### 4.1 Phasing (5 phases, each independently shippable)

Each phase deploys cleanly without breaking the previous one. We can pause / validate / iterate at each gate.

#### Phase 1 — Minimal Architect + delegateScout ✅ SHIPPED

Goal: Replace fixed chain with single Architect agent. Architect does the drafting work itself (no Forge/Scribe); Scout sub-agent available for workspace research delegation. Sentinel still runs as a fixed post-step (deferred to Phase 3).

- New `src/orchestrator.ts` — replaces the chain-execution logic in `chain.ts`. Single `runArchitect(brief, projectIds, ...)` function.
- New Architect system prompt (`src/architect.ts` or inline in orchestrator).
- Rewire `chain.ts` to call `runArchitect` instead of iterating CHAINS.
- Status flow: `Triaged → InProgress(Architect) → NeedsReview` (Architect calls setBriefStatus itself).
- Re-use all existing tool handlers from v1. Architect gets the **union** of Scout/Forge/Sentinel tool surfaces.
- Step budget: 60. Task budget: 150k.

**Done when:**
- `ntn workers exec` on a sample brief produces a complete deliverable on Plan + Drafts/Answer.
- v1 chain.ts is deleted.
- All existing example briefs (deep, writing, quick) still produce comparable output.

#### Phase 2 — Delegation tools (Librarian, Oracle) + rich Activity transcript ✅ SHIPPED

Goal: Architect can fan out to external-reference research (Librarian) and deep-reasoning analysis (Oracle) sub-agents, and Activity page shows an OpenCode-style transcript.

**Delivered:**
- `src/subagents.ts` — added `getLibrarianSpec(category)` and `getOracleSpec(category)`. Oracle has extended thinking enabled (8k budget).
- `src/tools/registry.ts` — added `delegateLibrarian` + `delegateOracle` tool definitions; added `LIBRARIAN_TOOLS` and `ORACLE_TOOLS` whitelists; renamed `SCOUT_SERVER_TOOLS` → `WEB_SERVER_TOOLS` and applied to both Scout AND Librarian via `WEB_TOOL_AGENTS` set. Tightened web_fetch budget (5→3 uses, 15k→8k content) after Phase 2 smoke showed parallel Librarians blowing the 200k chain budget.
- `src/tools/handlers.ts` — factored out shared `runDelegation()` helper used by all three `delegate*` handlers. Added `logSubDelegation()` that appends a `toggle` block with the sub-agent's emoji, query, metrics, and summary into the Activity page.
- `src/architect.ts` — system prompt updated with strong delegation discipline rules ("PLAN UPFRONT", "ONE QUERY PER TOPIC", "DO NOT RETRY") after smoke showed Architect over-delegating (4 Librarian calls for one topic, 199k tokens).
- `src/orchestrator.ts` — replaced bullet-line `logActivity` with `logAgentStart` (callout), `logAgentFinish` (toggle with metrics + summary + verdict children), `logAgentError` (red callout), `logOrchestratorEnd` (terminal callout). Bumped `TOKEN_BUDGET_LIMIT` 200k → 400k for delegation-aware chain.
- Widened `AgentName` and `AgentContext.agentName` unions with "Librarian" and "Oracle".

**Verification (E2E):**
- Smoke brief `363d670d-2658-81f1-8e52-e1c7dc6e3723`: "Compare Anthropic's web_search and web_fetch server-side tools".
- Architect delegated to Librarian ONCE (5 tools, 19s, 36k tokens) — disciplined single delegation per updated prompt.
- Activity page rendered toggle blocks with emojis (📚 Librarian, 🧠 Architect, 🛡️ Sentinel), timing, token counts, and Sentinel's verdict as a colored callout.
- Sentinel produced substantive review with 4 strengths and 3 risks; verdict = needs-revision (legit format critique).
- Chain completed at 68.8k of 400k budget — Status: Backlog → Triaged → In Progress → Needs Review.

**Known issues (deferred to Phase 4):**
- Librarian/Scout whitelists include `appendToPlanSection` and `createSource` which throw on `quick` category briefs (no Plan page). Result: Librarian falls back to "returned no summary" callout, but the model's `finalText` still surfaces. Phase 4's unified provision layout fixes this.

#### Phase 3 — Oracle + Anvil delegation

Goal: Architect can consult Oracle for hard decisions and dispatch Anvil for local execution.

- Add `delegateOracle` tool + Oracle sub-agent spec (Haiku + extended thinking, 8k thinking budget).
- Add `delegateAnvil` tool — wraps the existing Pusher publish logic from `src/index.ts`. Sets Status=`Waiting for Anvil`, terminates Architect turn.
- Add `Waiting for Anvil` to BriefStatus type. Webhook routing: when Status flips back from `Waiting for Anvil` → `Triaged`, the Architect resumes.
- Anvil writes results back via existing channels — no Anvil changes required in v2.

**Done when:**
- A brief that requires architecture analysis triggers an Oracle delegation; Oracle's analysis lands on the Plan page as a Decision rationale.
- A brief that needs a real binary built triggers a `delegateAnvil` call → Pusher dispatch → Anvil execution → next webhook trigger → Architect resumes.

#### Phase 4 — Drop categories, unified provision ✅ SHIPPED

Goal: Architect chooses writeAnswer vs createDraft itself. No more category-driven shape branching.

**Delivered:**
- `src/provision.ts` — unified layout. Every brief gets `📁 root` + `📄 Answer` anchor + `Plan` page + `Drafts` DB + `Sources`/`Decisions`/`Open Questions` mini-DBs + `Activity` page. Idempotent and self-healing — briefs provisioned under the v1/v2-pre-Phase-4 shape get backfilled on next run. `ProjectIds` types tightened: planPageId / answerAnchorBlockId / all `dbs.*` fields are now non-nullable.
- `src/architect.ts` — single `getArchitectSpec()` (no category arg). New "CHOOSE YOUR OUTPUT SHAPE — EARLY AND ONCE" prompt section with explicit writeAnswer-vs-createDraft decision rule. Architect's tool whitelist is the union of both shapes (writeAnswer + createDraft + Plan tools).
- `src/subagents.ts` — single `getSentinelSpec()` (no category arg). Sentinel prompt teaches it to detect the shape at runtime via `listDrafts`: ≥1 row → Drafts path, 0 rows → Inline path. `getScoutSubagentSpec`/`getLibrarianSpec`/`getOracleSpec` also drop the category arg.
- `src/tools/registry.ts` — single `ARCHITECT_TOOLS` and `SENTINEL_TOOLS` whitelists. `getToolNamesForAgent` and `getToolsForAgent` no longer take a category. Removed `isInlineCategory`/`hasPlanPage` helpers and the 6 category-bifurcated whitelist constants.
- `src/tools/handlers.ts` — delegate handlers drop the `(category ?? "deep") as Category` cast. `requireDraftsDsId`/`requirePlanPageId`/`optional*DsId` helpers gone (Plan + Drafts always present, direct field access). `writeAnswer` no longer throws "no answer anchor"; `createReview`'s `isRealDraft` collapses to a simple `draftId !== projectRootId` check. mini-DB row creation is now mandatory (was previously gated on optional dsId).
- `src/agents.ts` — `RunAgentArgs.category` field removed. `getToolsForAgent` call site updated.
- `src/orchestrator.ts` — still calls `classifyBrief` and writes Category to the brief (informational metadata for kanban + project icon), but the category is no longer threaded into agent specs or `provisionProject`'s routing decisions. Log line annotates `(informational)` next to the category value.
- `src/classify.ts` — header comment documents the Phase 4 status (informational only).
- `src/index.ts` — `provisionProject` admin tool description updated to say "layout is unified".
- Drafts/Sources/Decisions/Open Questions DB schemas — added `Architect`, `Librarian`, `Oracle` as named `Author Agent` / `Captured By` / `Made By` / `Asked By` select options so new DBs render the right colors out of the box (legacy DBs still auto-accept the names; Notion creates options on first write).

**Done when:**
- All 5 category briefs produce coherent output through the same provision shape. ✅
- `classify.ts` no longer affects routing. ✅
- `npm run check` clean, `npm run build` clean. ✅

#### Phase 5 — Polish

- Live status callouts on project root (updated each turn).
- Plan Status section as a real todo list driven by Architect.
- Token-usage cost callout on the root dashboard.
- Better error reporting (per-sub-agent failure isolation — one Scout failure shouldn't kill the whole brief).

### 4.2 Module inventory

| File | Disposition | Notes |
|---|---|---|
| `src/index.ts` | **MODIFY** — Add `Waiting for Anvil` status case, otherwise unchanged | Phase 3 |
| `src/chain.ts` | **DELETE** | After Phase 1 lands |
| `src/orchestrator.ts` | **NEW** | Phase 1 |
| `src/architect.ts` | **NEW** | Phase 1 — Architect system prompt + spec |
| `src/subagents.ts` | **NEW** | Phase 2 — Sub-agent system prompts + specs |
| `src/agents.ts` | **MODIFY** | Refactor `invokeAgent` to handle Architect + sub-agent invocations uniformly |
| `src/agentLoop.ts` | **NO CHANGE** | Already generic enough |
| `src/chains.ts` | **DELETE** | After Phase 1 lands |
| `src/classify.ts` | **MODIFY** | Decouple from routing (Phase 4) — keep classifier as informational only |
| `src/provision.ts` | **MODIFY** | Phase 4 — single unified layout |
| `src/tools/registry.ts` | **MODIFY** | Add new delegate tools; remove per-agent whitelists (Architect gets unified surface; sub-agents whitelisted per their spec) |
| `src/tools/handlers.ts` | **MODIFY** | Add `respond` handler for sub-agents; keep all existing handlers |
| `src/tools/delegate.ts` | **NEW** | Phase 2 — `delegateScout`, `delegateLibrarian`, `delegateSentinel`, `delegateOracle`, `delegateAnvil` |
| `src/tools/external.ts` | **NEW** | Phase 2 — `notionDocsSearch`, `notionDocsRead`, `fetchUrl` for Librarian |
| `src/notion.ts` | **MODIFY** | Add `BriefStatus="Waiting for Anvil"`; new rich-transcript block builders |
| `src/state.ts` | **MODIFY** | Activity transcript turn counter; optional Anvil pending flag |
| `src/scope.ts`, `src/pacer.ts`, `src/budget.ts` | **NO CHANGE** | Reused verbatim |

### 4.3 Architect system prompt (draft for Phase 1)

```
You are the Architect — the single agent driving a brief from Triaged to Needs Review in the Hivemind multi-agent system.

# YOUR JOB
Read the brief, plan an approach, produce the deliverable, get it reviewed (Sentinel), and signal completion.

# YOUR WORKSPACE
You operate inside a per-brief Notion subtree:
- Project root page (📁) — has a 📄 Answer heading anchor for prose answers
- Plan child page — your structured memory:
  - Context (what the brief is, who it's for, constraints)
  - Approach (your chosen plan with rationale)
  - Decisions (significant choices with rationale)
  - Sources (external + workspace references you relied on)
  - Open Questions (anything blocking, anything needing human input)
  - Status (a todo list mirroring your internal plan)
- Drafts child database — for iterative artifacts (code, designs, structured plans)
- Activity child page — chronological run log (you write to it via tool calls)

You can READ anywhere in the workspace. You can WRITE only inside this subtree (scope guard enforces).

# OUTPUT SHAPE (CHOOSE EARLY)
Decide ONCE, in your first 2-3 tool calls, which output shape fits this brief:

- **writeAnswer** — single-shot prose answer on the project root. Use for: explanations, summaries, lists, advice, "what is X", "how does Y work", documentation.
- **createDraft** — iterative artifact in the Drafts DB. Use for: code, design specs, structured plans, anything that benefits from versioned revisions and review cycles.

Record your choice in the Plan's Approach section. Stick to it.

# DELEGATION (when to use sub-agents)
Sub-agents are spawned via tool calls and run in their own context (you don't see their working tokens, only their summary). Delegate aggressively for searches and external lookups — it saves your context budget. Do NOT delegate for tasks you can solve in 1-3 tool calls.

- `delegateScout({ query, context })` — for ANY workspace search beyond a single readPage. Fan out 2-5 in parallel for broad discovery.
- `delegateLibrarian({ query, context })` — for ANY external reference: Notion API docs, URLs given in the brief.
- `delegateOracle({ question, context })` — for ANY hard decision: multi-system tradeoffs, security implications, debugging after a failed attempt, architecture design.
- `delegateSentinel({ target_kind, target_id? })` — ALWAYS call before marking done. Sentinel's verdict drives Status.
- `delegateAnvil({ task_spec })` — when the brief NEEDS real shell, file system, browser, or code execution (e.g., "build the binary", "run Playwright", "run a script"). Anvil is async — your turn ends after this call. The brief resumes when Anvil completes.

# WHAT YOU DO YOURSELF
- Reading 1-3 specific pages you already know the IDs of.
- Writing the Plan page (Context, Approach, Status).
- Writing the deliverable (writeAnswer or createDraft).
- Recording Decisions, capturing Sources (small ones).

# STYLE
- **Terse, factual, source-anchored.** Every factual claim ties to a workspace page, brief body, or Source captured by Scout/Librarian.
- **No hedging.** Words like "likely", "probably", "perhaps" mean you don't have a source — delegate to Scout/Librarian instead of guessing.
- **Parallel tool use.** Batch independent reads, delegations into single turns whenever possible.

# DONE CONDITION
You may call `done` ONLY when ALL true:
1. Plan's Context AND Approach sections are populated.
2. Deliverable produced (writeAnswer OR createDraft called exactly once).
3. delegateSentinel called and verdict received.
4. Brief Status set: Needs Review (if verdict=approve) or kept In Progress (if needs-revision; you can retry once, then stop).

# FAILURE MODES
- If the brief is unanswerable from available material (no workspace context, no URLs in body, no Scout findings): createOpenQuestion describing the missing inputs, set Brief Status="Needs Review" with a comment explaining the gap, call done. DO NOT FABRICATE.
- If delegateOracle returns confidence=low: re-delegate with more context, or fall back to createOpenQuestion.
- If delegateSentinel verdict=needs-revision twice in a row: stop, post a comment summarizing the deadlock, leave Status as In Progress.

# TARGET: 30-50 tool calls for a typical brief. You have 60 in your step budget.
```

### 4.4 Notion Docs MCP integration (Phase 2)

The `notion-docs` MCP server is already wired up in `opencode.json`. For the Worker runtime, we'll need to expose it via tool calls in the Librarian's surface. Two options:

(a) **Native Worker tools** — write `notionDocsSearch` and `notionDocsRead` handlers in `src/tools/external.ts` that wrap the MCP protocol (likely just hit the HTTPS endpoint at `https://developers.notion.com/mcp` directly). This is the right answer.

(b) **Brief-body URL-only fallback** for v2 — Librarian can fetch URLs that appear in the brief body via a simple `fetchUrl` tool (uses `fetch()` + `cheerio` or similar for text extraction). Defers the MCP integration. Less powerful but unblocks Phase 2.

Going with (a) — small effort, gives Librarian real value.

### 4.5 Anvil integration (Phase 3)

The existing Anvil dispatch path in `src/index.ts` (`onBriefStatusChange` → `pusherPublish`) is preserved. `delegateAnvil` becomes a tool the Architect can invoke explicitly instead of waiting for the Owner=Forge-Local indirection.

```typescript
async function delegateAnvil(input, ctx) {
  const r = asRecord(input);
  const taskSpec = asString(r.task_spec, "task_spec");

  // 1. Write task_spec to Plan so Anvil and humans can see it
  await appendToPlanSection(ctx, "Approach", [
    heading3("Anvil dispatch"),
    paragraph(taskSpec),
  ]);

  // 2. Transition Status
  await setBriefProperties(ctx.notion, ctx.briefId, {
    status: "Waiting for Anvil",
    owner: null,
  });

  // 3. Publish to Pusher
  await pusherPublish(ctx.briefId);

  // 4. Log to Activity
  await logActivity(ctx, "Architect", "delegated to Anvil", { taskSpec });

  // 5. Signal Architect must terminate
  return { dispatched: true, must_terminate: true };
}
```

The Architect's system prompt enforces "after calling delegateAnvil, call done immediately". Orchestrator post-processing checks for `must_terminate: true` and short-circuits the loop if the model tries to continue.

When Anvil finishes its work, it flips Status back to `Triaged` (or `Done` if it can self-verify). The existing webhook handler in v2 needs a new case: when Status flips from `Waiting for Anvil` → `Triaged`, run the Architect again — it'll read the populated subtree and continue from there.

### 4.6 Rich Activity transcript (Phase 2)

Today's Activity log appends one bullet per agent run. v2 makes it a structured transcript using Notion blocks the Notion UI renders nicely:

```typescript
// Architect turn
appendBlocks(activityPageId, [
  toggle(`🧠 Architect — turn ${n} · ${ts} · ${tokens} tokens`, [
    paragraph(architectThinking || "(no narration this turn)"),
    bullet(`Tool calls: ${toolCallCount}`),
    bullet(`Tokens in/out: ${inTokens} / ${outTokens}`),
  ]),
]);

// Sub-agent invocation
appendBlocks(activityPageId, [
  toggle(`🔍 Scout — ${ts} · ${tokens} tokens · ${sourcesCount} sources`, [
    paragraph(`Query: ${query}`),
    heading3("Summary"),
    ...mdToBlocks(summary),
    heading3("Side effects"),
    bullet(`Sources captured: ${sourcesCount}`),
    bullet(`Open questions raised: ${openQuestions.length}`),
  ]),
]);
```

The `toggle` blocks collapse by default, so the high-level transcript reads at a glance and the detail is one click away. This IS the "impressive Notion output" the user wants.

---

## 5. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Haiku 4.5 isn't smart enough to orchestrate well | Medium | High | Very prescriptive system prompt (drafted in §4.3). Heavy use of `task_budget` for self-regulation. Fallback to keeping fixed-chain code paths around behind a feature flag for Phase 1. |
| Architect over-delegates to Scout when it could just readPage | Medium | Low | System prompt explicitly says "do NOT delegate for tasks you can solve in 1-3 tool calls". Monitor tool-call distribution in Activity. |
| Architect under-delegates and burns its own context | Medium | Medium | System prompt explicitly says "delegate aggressively for searches and external lookups". Monitor context-management `applied_edits` count in Activity. |
| Sub-agent runaway (loops without calling `respond`) | Low | Medium | `respond` is required; step budget hard-stops at ~10. Sub-agent failure returns error to Architect, doesn't crash the chain. |
| Anvil async resumption confuses the state machine | Medium | High | New `Waiting for Anvil` status state is explicit. Webhook routing has a clear case for it. Tested end-to-end in Phase 3. |
| Dropping categories breaks human kanban workflows | Low | Low | Category property stays as informational metadata (D14). Existing kanban filters keep working. |
| v1→v2 migration: in-flight briefs get confused | Medium | Medium | v2 reads existing `HivemindState` and `Hivemind State` JSON shape. Provision is idempotent. In-flight briefs at `InProgress(Scout)` etc. flip to `InProgress(Architect)` and re-run from the existing Plan content. |
| Rate limits more aggressive in v2 (more tool calls per brief) | Medium | Medium | Pacer (3 RPS shared) already handles this. Sub-agent runs are serialized within the Architect's turn. |

---

## 6. Verification Plan

For each phase, **before claiming done**:

- `npm run check` clean.
- `ntn workers deploy` succeeds.
- Run `ntn workers exec` on a representative brief from each of the 5 v1 categories. Confirm:
  - Subtree provisioned correctly.
  - Plan page populated.
  - Deliverable produced (Answer or Draft).
  - Sentinel review posted, verdict set.
  - Status transitioned to Needs Review.
  - Activity page renders as a readable transcript.
- For Phase 3 specifically: trigger a brief that requires Anvil, confirm round-trip dispatch + resumption.
- Token budget per brief stays < 200k (per-brief safety net).

Test briefs (committed in `test.ts` or run via `ntn workers exec`):
- **Quick explainer:** "What's the difference between data sources and databases in the Notion API?" (writeAnswer path, no delegation expected beyond Sentinel)
- **Workspace research:** "Summarize all open RFCs in this workspace." (Scout delegation expected)
- **Architecture decision:** "Should we use OAuth or webhook signature for the new integration?" (Oracle delegation expected)
- **Code task:** "Write a script that lists all stale pages in this workspace." (createDraft path)
- **Local execution:** "Build the worker bundle and report the size." (Anvil delegation expected — Phase 3 only)

---

## 7. Out of Scope (deferred to v3+)

- **Multi-Architect parallelism** — one Architect per brief is enough for v2. Multi-brief concurrency is already handled by the chain lock.
- **Sub-agent caching across briefs** — Scout findings are per-brief. Cross-brief memory (e.g., "we've already researched this topic") is a v3 problem.
- **Custom workflows / Skills DB** — explicitly deferred per Metis's earlier critique of v1.
- **Architect self-reflection / Sentinel-of-Architect** — Sentinel reviews the deliverable, not the Architect's process. v3 could add a meta-reviewer.
- **Cost / token attribution dashboards** — basic per-brief token usage shows on the dashboard, but workspace-level cost analytics are v3.

---

## 8. Open Questions for Momus

1. Is the Architect's system prompt prescriptive enough for Haiku 4.5 to orchestrate competently? Particularly around "when to delegate vs. do yourself" — this is the hardest meta-reasoning call.
2. Is the unified-provision layout (Plan + Drafts DB + Answer anchor always present) the right call, given some briefs will leave Drafts unused?
3. Should sub-agent failures (e.g., Scout times out, Librarian's MCP errors) be retried by the Architect or propagated as a hard failure?
4. Is async Anvil resumption via Status=`Triaged` (Phase 3, §4.5) too fragile? Should it use a dedicated Status=`Anvil Done` for clarity?
5. Should Phase 1 retain backward compat with v1 chains (feature flag), or is the bigger-bang refactor better?

---

## 9. Implementation Schedule

| Phase | Estimated effort | Gate |
|---|---|---|
| 1 — Minimal Architect | 1 session | Existing example briefs produce output through Architect-only path |
| 2 — Delegation + transcript | 1-2 sessions | Token savings demonstrable on a workspace-search brief |
| 3 — Oracle + Anvil | 1 session | Round-trip Anvil dispatch works |
| 4 — Drop categories | 1 session | All 5 category briefs work without category branching |
| 5 — Polish | 0.5 session | UX details |

Total: ~5 sessions, shippable after each phase.
