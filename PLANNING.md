# Hivemind

**Chief-of-Staff platform for Notion.** Multi-agent orchestrator on Workers + Custom Agents. Drop a brief in a Notion database, the right specialist agent picks it up, handoffs and approvals happen as comments. Notion is the hive, your AI agents are the swarm.

**Hackathon**: Notion Developer Platform Hackathon, May 16-17 2026, Notion HQ (20 Annie St, SF). Theme: **Workflow Relay**.

## Identity

- **Project**: Hivemind
- **Repo**: [github.com/kristianvas/hivemind](http://github.com/kristianvas/hivemind) (scaffolded Saturday 10:45 AM at venue, per New Work Only rule)
- **License**: MIT
- **Stack**: TypeScript strict + Bun + `@notionhq/workers` + Anthropic Claude (primary) + OpenAI GPT-5 (Switzerland angle)
- **Runtime**: Notion-hosted Workers (sandboxed TS). No custom UI, no shell, no npm at runtime, no subprocess. Notion is the entire surface.

## Cast

| Role | Name | Provider |
| --- | --- | --- |
| Orchestrator (Chief of Staff) | Core | Claude |
| Researcher | Scout | Claude |
| Writer | Scribe | Claude |
| Builder, coder | Forge | Claude |
| Reviewer, critic | Sentinel | GPT-5 |

## Surface (Notion-native, zero frontend code)

| Surface | Notion primitive |
| --- | --- |
| Briefs board | Database, kanban view grouped by Status |
| Agents gallery | Database, gallery view, icon thumbnails |
| Workflows | Database (recipes that chain agents) |
| Skills | Database (scoped MCP / tool bundles) |
| Activity feed | Database, list view sorted by date |
| Approve / Reject | Native button blocks → Worker webhook |
| Comments | Native (block + page level) |
| @ mentions | Native |
| Realtime sync, auth, billing, access control, mobile, offline | All native |

## Worker tools

- `intent.classify(brief)` — tag Category, Priority, required Skills. Hashes inputs to dedupe webhook storms.
- `category.route(brief)` — match Category to specialist agent.
- `orchestrator.advance(brief, oldStatus, newStatus)` — Core's hook on status change.
- `agent.invoke(agentName, brief, context)` — fan out to specialist.
- `hook.fire(event, payload)` — generic hook bus.
- `skill.load(skillName)` — fetch and bind a Skill bundle.
- `team.fan-out(briefIds, agentName)` — parallel dispatch (post-MVP).
- `approve.handle(briefId, decision, comment)` — process Approve button + comment.

## Categories (model routing)

- `visual-engineering` → claude-opus-4-7 / max — frontend, UI, design
- `ultrabrain` → gpt-5 / xhigh — hard logic, architecture
- `deep` → gpt-5 / medium — autonomous research + impl
- `quick` → claude-haiku — single-file, trivial
- `writing` → claude-opus-4-7 / high — docs, prose

## Loop (end-to-end)

1. Brief lands in Briefs DB (Backlog status).
2. Webhook fires → Worker validates (`last_edited_time` + content hash, dedupes noisy webhooks).
3. `intent.classify` tags Category, Priority, Skills. Status → Triaged.
4. Core (`category.route`) picks specialist, sets Assigned Agent, status → In Progress.
5. Specialist works, posts progress as block comments, drops artifacts as sub-pages.
6. When done, agent moves card to Needs Review and @ mentions human.
7. Human:
    - Approve button → Done. Orchestrator chains to next Workflow step if any.
    - Comment with edits → bounces to In Progress, agent retries with comment as new input.
    - Reject button → Archived with reason.
8. Failures: try/catch wraps every Worker call. On error: status → Failed, agent posts trace as comment, orchestrator retries 3x with backoff, then human is tagged.
9. Stuck cards: cron Worker scans for cards In Progress past timeout and escalates.

The card is always the truth. Open Notion mid-run, see exactly where the agent is.

## Repo layout

```
hivemind/
├── AGENTS.md            (this file, planning + ops truth)
├── README.md            (public-facing, install + demo)
├── LICENSE              (MIT)
├── package.json
├── tsconfig.json
├── bun.lockb
├── src/
│   ├── orchestrator/    Core logic, routing
│   ├── agents/          Scout, Scribe, Forge, Sentinel prompts + tools
│   ├── categories/      Model + config bundles
│   ├── intent-gate/     intent.classify Worker
│   ├── hooks/           status-change hooks
│   ├── skills/          Skill bundles
│   ├── team/            parallel fan-out (post-MVP)
│   ├── tools/           Worker tools registry
│   ├── notion/          Notion API wrappers, webhook validation, hash dedupe
│   ├── models/          Claude + GPT-5 clients (cross-vendor)
│   └── shared/          types, utils
├── template/            Notion template export (importable workspace)
└── docs/                architecture, setup, demo
```

## Conventions

- TS strict. No `any`, no `@ts-ignore`, no `@ts-expect-error`.
- Worker calls: every external call wrapped in try/catch. Return `{ ok: true, data }` or `{ ok: false, error }`.
- Hooks: pure functions `(brief, oldStatus, newStatus) => Promise<void>`. Side effects to Notion only.
- Idempotency: every Worker tool reads + writes `last_edited_time` + `_hash` property. Skip if hash unchanged.
- Errors: post as block comment on the card with trace. Status → Failed after 3 retries.
- Realtime: rely on Notion's native sync. No client polling.

## Don't-do (Workers runtime limits)

- No custom UI. Notion is the surface. No React, no blocks SDK, no custom views.
- No shell, no subprocess, no `npm install` at runtime.
- No long-running compute in-Worker. Call out to E2B / Modal / Anthropic code-exec over HTTPS.
- No [localhost](http://localhost). Workers run on Notion's infra.
- No assumption of External Agent API (waitlist, ask Notion staff Saturday to flip; build without it).

## Hackathon constraints

- **New Work Only**: repo scaffolded Saturday 10:45 AM at venue. This file is planning, not project code.
- **Open source**: MIT, public repo at submission.
- **Build window**: ~12.25 hours (Sat 10:45-8 PM + Sun 9-12).
- **Submission**: public repo + 1-min demo video (YouTube / Loom) + Cerebral Valley form by Sun 12 PM.
- **Pitch**: 3 min + 1-2 min Q&A (Round 1). Top 6 → 3 min + 2-3 min Q&A on stage.
- **Judges**: Anthropic (Xing, Zhao, Morris, Lee), Notion (Lovin, Pedersen, Bemis, Parikh, Schoening, Last), Vercel (Subbramanian, Qu), Conductor (Palmer), Eigen (Scherer), VCs (Vernal, Qiu, Bobosikova).
- **Judging weights**: Technical Demo 35, Implementation Difficulty 25, Creativity 25, Impact 15.

## Demo

**Pitch frame** (90 sec live + 1 min video):

> *"Hivemind is the Chief-of-Staff platform for Notion. Notion is the hive, your AI agents are the swarm. Drop a brief in. Core routes it. Scout researches, Scribe drafts, Forge builds, Sentinel reviews. You approve through comments. Workflow Relay theme."*
> 

**Live demo flow**:

1. Drop a real brief into Backlog ("Research X, draft a 1-pager").
2. Webhook fires, status auto-flips through Triaged → In Progress.
3. Scout posts progress comments live.
4. Card moves to Needs Review, @ mention fires.
5. Approve button → chain triggers, Scribe formats for publish.
6. Close on Activity feed showing the chain.

## Cut order (12.25h)

Keep top, cut bottom if behind:

1. Briefs DB + kanban view + status property *(never cut)*
2. Core, Scout, Forge *(never cut)*
3. Approve button + Worker webhook *(never cut)*
4. Comment-based review loop *(never cut)*
5. Scribe (could fold into Scout)
6. Sentinel (could fold into approve gate)
7. Workflows DB recipes (could demo with hard-coded chain)
8. Skills DB (could demo with inline tool config)
9. Team mode parallel fan-out
10. Extended hooks beyond status-change
11. Activity feed (could demo with single DB view)
12. Cross-vendor GPT-5 (Claude-only is fine for demo)

**Minimum viable**: Core + Scout + Forge, kanban, comments, approve button, hard-coded research → build chain.

## Setup (Friday night, planning only — NO repo yet)

1. `curl -fsSL https://ntn.dev | bash` — install `ntn` CLI.
2. `ntn login` — connect Notion account.
3. `ntn workers new test-throwaway` — generate hello-world Worker, deploy, confirm flow, delete. Not in `hivemind/`.
4. Read: [developers.notion.com/workers](http://developers.notion.com/workers), [developers.notion.com/cli](http://developers.notion.com/cli), makenotion/notion-cookbook on GitHub.
5. Apply: External Agent API waitlist, Agent SDK waitlist.
6. Watch: May 13 release livestream, Max Schoening on Lenny's.
7. Keep this [AGENTS.md](http://AGENTS.md) in `~/Projects/hivemind-prep/` (not in a `hivemind/` repo yet).

## Setup (Saturday 10:45 AM, kickoff)

1. `cd ~/Projects && mkdir hivemind && cd hivemind`
2. `git init`
3. `cp ~/Projects/hivemind-prep/AGENTS.md ./AGENTS.md`
4. `ntn workers new hivemind` — scaffold Worker.
5. `git add . && git commit -m "init"`
6. Ask Notion staff at venue to flip External Agent API + Agent SDK on workspace.
7. Build per cut order, top to bottom.

## Credits

- Built at Notion Developer Platform Hackathon, May 16-17 2026, by Kristian Vastveit (Agrointel AS).