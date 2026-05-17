# Hivemind Local Executor — "Anvil"

> Plan, not implementation. Three architectural decisions locked by the user; this is the **real-product path**, not the demo. Expect ~4–6 weeks of focused work for v1.

## Role

**Anvil** is the local daemon that gives Hivemind real-world hands: filesystem, shell, browser. The Notion Worker remains the brain (Core orchestrates, Scout researches, Sentinel reviews). Anvil is the body for briefs that require *building, running, and shipping* something — not just writing about it.

Inside Anvil, the LLM persona doing the thinking is still **Forge**, but this is **Forge-Local**: a fuller-tool Forge that can scaffold, install, build, serve, screenshot, commit, and push. The original in-Worker Forge (markdown artifacts) stays untouched in [src/agents.ts](file:///Users/kristian/projects/hivemind-notion/src/agents.ts) for writing-only briefs.

### What Anvil does (real-product spec)

1. Subscribes to a **Pusher channel** outbound from the user's machine.
2. Receives a brief notification from the Notion Worker (which publishes to Pusher when a brief gets `Owner=Forge-Local`).
3. Fetches the brief from Notion, claims it (`Owner=Forge-Local-Busy`).
4. Spawns an **E2B Firecracker microVM** — a fresh, ephemeral, real-VM-isolated Linux box.
5. Runs the **Forge-Local agent loop** inside that VM via `@anthropic-ai/sdk` `toolRunner` with `bash_20250124` + `text_editor_20250728` tools.
6. If the brief has no `Repo` value: scaffolds a new project, `gh repo create`s it under the configured GitHub account, pushes initial commit. If `Repo` is set: clones it, branches `hivemind/brief-<briefId>`, iterates.
7. Starts the dev server inside the VM, gets E2B's public-port URL.
8. Local Playwright MCP navigates to that URL, captures screenshot + console + network log.
9. Pushes the branch and opens a **GitHub PR** via Octokit.
10. Posts proof bundle to Notion (screenshot image block, build-log code block, PR URL, dev URL, commit SHA), sets `Status=Needs Review`.

### What Anvil is NOT (v1 anti-goals)

- Not a generic RCE platform — only Forge-Local-flagged briefs, only inside the VM.
- Not autonomous — executes briefs the Worker hands it; doesn't decide what to pick up.
- Not multi-tenant — one machine, one user, single-flight brief at a time.
- Not cross-platform — macOS host only in v1; the VM is Linux but the daemon is darwin-only.
- Not a deployment system — PR + screenshot is the deliverable. Merging the PR / deploying the site is a separate step the human owns.
- Not a custom MCP, not a custom relay, not a custom CLI framework.
- No inbound network on the user's machine. Anvil opens outbound websockets and outbound HTTPS only.

## Architecture

```
┌─────────────────────────────────────────┐   ┌──────────────────────────────────────┐
│ NOTION + CLOUD                          │   │ LOCAL MACHINE — Anvil daemon         │
│                                         │   │                                      │
│  Briefs DB                              │   │  ┌────────────────────────────┐      │
│   Owner: Forge-Local                    │   │  │ pusher-subscriber          │      │
│   Repo:  github.com/<u>/<r> or empty    │   │  │ outbound websocket only    │      │
│                                         │   │  └────────────┬───────────────┘      │
│            │                            │   │               │ brief.dispatched     │
│            │ DB automation webhook      │   │               ▼                      │
│            ▼                            │   │  ┌────────────────────────────┐      │
│  Worker (src/) — UNCHANGED for         │   │  │ brief-runner               │      │
│  text briefs. New code path:           │   │  │ - claim card               │      │
│  - onBriefStatusChange detects         │   │  │ - select run mode          │      │
│    Owner=Forge-Local                   │   │  │   (scaffold-new |          │      │
│  - publishes to Pusher channel         │   │  │    extend-existing)        │      │
│    "anvil-dispatch"                    │ ──┼──┤                            │      │
│                                         │   │  └────┬──────────────┬───────┘      │
│            ▲                            │   │       │              │              │
│            │ outbound HTTPS             │   │       ▼              ▼              │
│            │ - update card props        │   │  ┌──────────┐   ┌────────────────┐ │
│            │ - append blocks            │   │  │ E2B VM   │   │ playwright-mcp │ │
│            │ - post comments            │   │  │ (Firec-  │   │ stdio, in-proc │ │
│            │                            │   │  │  racker) │   │ headless chrm  │ │
│  ┌─────────────────────────────────┐   │   │  │          │   └────┬───────────┘ │
│  │ Pusher Channels                 │   │   │  │ - bash   │        │             │
│  │ - channel: anvil-dispatch       │ ◄─┼───┼──┤   tool   │        │             │
│  │ - publish from Worker (HTTPS)   │   │   │  │   loop   │        │ navigate    │
│  │ - subscribe from Anvil (WS)     │   │   │  │ - text   │        │ to E2B      │
│  └─────────────────────────────────┘   │   │  │   editor │        │ public URL  │
│                                         │   │  │ - git +  │        │             │
│  ┌─────────────────────────────────┐   │   │  │   gh CLI │        │             │
│  │ GitHub                          │ ◄─┼───┼──┤          │ ◄──────┘ screenshot  │
│  │ - PR per brief                  │   │   │  └─────┬────┘                       │
│  │ - SSH deploy key or fine-grained│   │   │        │                            │
│  │   PAT, Anvil-only scope         │   │   │        │ proof bundle               │
│  └─────────────────────────────────┘   │   │        ▼                            │
│                                         │   │  ┌────────────────────────────┐    │
│  Sentinel (existing) reviews            │   │  │ proof-uploader             │    │
│  screenshot via Claude vision           │   │  │ - upload PNG to Notion     │    │
│                                         │   │  │   Files API (or external)  │    │
└─────────────────────────────────────────┘   │  │ - PR url, commit sha, logs │    │
                                              │  └────────────────────────────┘    │
                                              └──────────────────────────────────────┘
```

Key invariant: **Anvil host never executes brief-derived shell**. Everything Forge-Local emits runs inside the E2B VM. The host process only runs (a) Anvil's own TypeScript, (b) Playwright Chromium (for screenshotting URLs only — no eval of brief code), (c) Octokit calls to GitHub. No `bash` from LLM output ever touches darwin.

## Decisions (locked by user)

| # | Decision | Choice | Implication |
|---|---|---|---|
| D1 | Trust boundary | **Full-access VM, no host access** | E2B Firecracker microVMs by default (cloud, 150ms boot, public-port URLs). Lima/OrbStack local VMs as offline fallback behind `SANDBOX_DRIVER=lima`. |
| D2 | Brief transport | **Outbound websocket via Pusher** | Worker publishes to Pusher channel on `Owner=Forge-Local`; Anvil subscribes outbound. Sub-second dispatch. Adds Pusher as a vendor dependency (free tier covers our volume). |
| D3 | Project lifecycle | **Persistent repo per project, GitHub PR per brief** | Adds GitHub auth (fine-grained PAT v1, SSH deploy key as upgrade), adds `Repo` brief property, adds branching/commit/push/PR flow. New brief on empty `Repo` → `gh repo create`. Existing repo → clone + branch. |
| D4 | Iteration loop | **One-shot (defaulted)** | Sentinel reviews screenshot, comments. Human approves PR (in GitHub) and brief (in Notion). No auto-rebuild loop in v1. |
| D5 | Proof contract | **Screenshot + console + URL + commit SHA + PR URL (defaulted)** | Posted to Notion as image block + code blocks + paragraph with URLs. |
| D6 | VM host | **E2B cloud default, Lima local fallback** | E2B costs ~$0.008 per 10-min brief; Lima is free but slower (~30s boot) and requires manual setup. Behind `SANDBOX_DRIVER` env. |
| D7 | Forge-Local model | **claude-sonnet-4-6 default; opus fallback on max-iter** | Sonnet handles tool loops cleanly at fraction of opus cost. |

Decisions left open for the user (non-blocking, can be revisited at implementation time):

- **D6.alt** — strictly-local VM (Lima) vs cloud VM (E2B). Default E2B because of public-port URLs (browser nav is trivial) and 150ms boot. **Override if you need fully offline operation.**
- **D2.alt** — managed Pusher vs self-hosted Cloudflare Worker + Durable Object as relay. Default Pusher. Switch to CF DO when scale outgrows Pusher's free tier or you want zero third-party deps.
- **D3.alt** — fine-grained GitHub PAT vs SSH deploy key. Default PAT (easier first-run). SSH key better for production (no expiry, per-repo scope).

## Stack

| Concern | Package | Version | Notes |
|---|---|---|---|
| Agent loop runtime | `@anthropic-ai/sdk` | `^0.96.0` | `client.beta.messages.toolRunner`, `max_iterations: 20` |
| Builder tools | `bash_20250124`, `text_editor_20250728` | n/a (Anthropic-native) | Model has built-in schema knowledge |
| Browser control | `@playwright/mcp` | `0.0.75` (PIN, pre-1.0) | `browser_take_screenshot` returns base64 inline; `browser_console_messages`; `browser_network_requests` |
| MCP host SDK | `@modelcontextprotocol/sdk` | `^1.29.0` | `StdioClientTransport` to spawn Playwright MCP in-process |
| **Sandbox / VM** | **`e2b`** | `^2.20.1` | Firecracker microVMs, TypeScript SDK, `sandbox.getHost(port)` returns public URL |
| Sandbox fallback | `lima` (CLI, not npm) | latest | Local Linux VMs on macOS, shell out via `child_process` |
| **Websocket transport** | **`pusher-js`** | `^8.4.0` | Anvil subscribes outbound; Worker publishes via `pusher` server SDK |
| Worker-side publish | `pusher` (server SDK) | `^5.2.0` | Worker imports this to publish dispatch events |
| **GitHub** | **`@octokit/rest`** | `^21.0.0` | `gh repo create` equivalent via API; PR creation |
| Git operations | `simple-git` | `^3.27.0` | Clone, branch, commit, push from Node |
| Notion client | `@notionhq/client` | (transitive) | Reuse Worker's client; Anvil holds its own NOTION_API_TOKEN |
| File upload to Notion | `@notionhq/client` `files.upload` | latest | Recent API; fallback = external URL via R2 |

### Things explicitly NOT in the stack

- `dockerode` — replaced by E2B; Docker containers don't satisfy "full VM isolation."
- `@anthropic-ai/claude-code` — CLI only, no programmatic TS API.
- `client.beta.agents` / `client.beta.sessions` — Anthropic-hosted cloud runtime, can't reach our VM/PR flow.
- `computer_20251124` — overkill for navigate+screenshot.
- API-side `mcp_servers[]` — requires publicly reachable URL; we run MCP client in-process instead.
- ngrok / cloudflared — Pusher replaces all tunneling needs.

## Repo layout

```
hivemind-notion/
├── src/                       (unchanged — Worker code)
│   └── index.ts               + new path: publish to Pusher when Owner=Forge-Local
├── anvil/                     (NEW)
│   ├── package.json           own deps: @anthropic-ai/sdk, e2b, pusher-js, @octokit/rest,
│   │                          simple-git, @playwright/mcp, @modelcontextprotocol/sdk,
│   │                          @notionhq/client
│   ├── tsconfig.json          strict TS, target ES2022, module NodeNext
│   ├── README.md              install + first-run + secrets bootstrap
│   ├── src/
│   │   ├── main.ts            entry, CLI commands: start | stop | status | nuke | setup | run-local
│   │   ├── config.ts          env loading, paths, version pins
│   │   ├── pusher-subscriber.ts  outbound WS to Pusher, reconnect, claim semantics
│   │   ├── brief.ts           snapshot brief from Notion, status writeback
│   │   ├── forge-local.ts     toolRunner loop, system prompt, tool dispatch into VM
│   │   ├── e2b-runtime.ts     spawn/teardown E2B VM, bash exec, file copy, dev server lifecycle
│   │   ├── lima-runtime.ts    fallback for SANDBOX_DRIVER=lima (M5 stretch)
│   │   ├── github.ts          octokit + simple-git: clone, branch, commit, push, PR open
│   │   ├── playwright-mcp.ts  stdio client + screenshot/console/network wrappers
│   │   ├── proof.ts           assemble proof bundle, upload to Notion
│   │   ├── audit.ts           append-only JSONL log: ~/.anvil/audit.jsonl
│   │   └── types.ts           Brief, Proof, RunMode, VmHandle
│   └── tests/                 (M5+) integration tests using a test Notion DB + test GitHub org
├── .sisyphus/archive/PLANNING-v1.md   (was root PLANNING.md; archived post-build — superseded by .agents/INSTRUCTIONS.md "Hivemind v2 — Anvil" section)
└── .env.example               new vars (see below)
```

### New env vars

```
# Anvil (local)
ANVIL_WORKDIR_ROOT=/Users/<u>/.anvil
SANDBOX_DRIVER=e2b              # or "lima"
FORGE_LOCAL_MODEL=claude-sonnet-4-6

# E2B
E2B_API_KEY=

# Pusher
PUSHER_KEY=
PUSHER_CLUSTER=
PUSHER_CHANNEL=anvil-dispatch

# GitHub
GITHUB_PAT=                     # fine-grained, scoped to the Hivemind org/account
GITHUB_DEFAULT_ORG=             # where to gh-repo-create new projects
```

Worker-side (`.env` for `ntn workers env push`):
```
PUSHER_KEY=
PUSHER_SECRET=                  # server SDK only, never in Anvil
PUSHER_APP_ID=
PUSHER_CLUSTER=
```

## Milestones

Each milestone has: **Build** (what to write), **QA runbook** (exact commands + expected outcomes), **Pass criteria** (concrete, observable).

---

### M0 — Walking skeleton (no LLM, no Notion, real VM, real GitHub)

End-to-end without intelligence. Anvil CLI runs against a hardcoded mini-brief.

**Build**
- `anvil/src/e2b-runtime.ts`: `spawnVm()`, `execInVm(cmd)`, `getPublicPortUrl(port)`, `teardownVm()`.
- `anvil/src/playwright-mcp.ts`: `spawnMcp()`, `navigate(url)`, `screenshot()`, `consoleMessages()`, `teardownMcp()`.
- `anvil/src/github.ts`: `createRepo(name)`, `clone(repo)`, `commitAndPush(repo, msg)`.
- `anvil/src/main.ts`: command `run-local --test-mode`.
- Hardcoded pre-baked Vite "hello world" template embedded in the binary.

**QA runbook**
```
# 1. Setup
cd anvil
bun install
cp .env.example .env       # fill: E2B_API_KEY, GITHUB_PAT, GITHUB_DEFAULT_ORG
npx playwright install chromium

# 2. Run
bun src/main.ts run-local --test-mode

# 3. Observe (live stdout)
# Expect, in order, within ~90s:
#   [e2b] vm spawning... ready in <Nms>
#   [e2b] copying scaffold... done
#   [e2b] exec: npm install... exit 0
#   [e2b] exec: npm run dev (backgrounded)... ready
#   [e2b] public url: https://<id>.e2b.app:3000
#   [playwright-mcp] spawning... ready
#   [playwright-mcp] navigate https://<id>.e2b.app:3000... ok
#   [playwright-mcp] screenshot... 12345 bytes
#   [github] creating repo <org>/anvil-m0-<timestamp>... done
#   [github] commit + push... done
#   [github] pr opened: https://github.com/<org>/anvil-m0-<ts>/pull/1
#   [done] proof saved to out/m0-test/proof.json

# 4. Verify artifacts
ls out/m0-test/proof.json          # must exist
ls out/m0-test/screenshot.png      # must exist, >5KB
jq . out/m0-test/proof.json
# expected keys: vmId, publicUrl, screenshotPath, consoleMessages, repoUrl, commitSha, prUrl

# 5. Verify GitHub state
open <prUrl>                       # PR exists, contains the Vite scaffold files
```

**Pass criteria**
- `out/m0-test/proof.json` exists with all 7 expected keys non-empty.
- `out/m0-test/screenshot.png` exists, > 5KB, renders the Vite default page.
- The GitHub PR URL opens, shows a real PR with the scaffolded files in the diff.
- E2B VM is torn down (verify in E2B dashboard — no lingering sandbox).
- Total wall time < 3 minutes.

**Fail criteria**
- Any step prints `[error]` or non-zero exit.
- Screenshot is blank (< 1KB) or shows an error page.
- PR creation fails (auth or repo-already-exists).
- VM lingers > 5 min after exit.

---

### M1 — Forge-Local agent loop (LLM, no Notion)

Replace hardcoded scaffold with LLM-driven `toolRunner`.

**Build**
- `anvil/src/forge-local.ts`:
  - `runForgeLocal(brief, vm, repoCtx)` → calls `client.beta.messages.toolRunner` with `bash_20250124` + `text_editor_20250728`.
  - System prompt: explicit constraints — work in `/workdir`, end when dev server is up on a known port, do NOT touch `/etc` or `~/.ssh`, prefer Vite or plain HTML, no DB.
  - `max_iterations: 20`. Tool dispatch: bash → `e2b-runtime.execInVm()`. text_editor → `e2b-runtime` file ops.
- `anvil/src/main.ts`: command `run-local --brief "<title>" --body "<body>"`.

**QA runbook**
```
# 1. Setup (same as M0)

# 2. Run with three representative briefs
bun src/main.ts run-local --brief "Coffee shop landing page" --body "Hero with a coffee image, three menu items, contact form."
bun src/main.ts run-local --brief "Todo list app" --body "Add, complete, delete. localStorage. No backend."
bun src/main.ts run-local --brief "Markdown previewer" --body "Two-column: textarea on left, rendered HTML on right."

# 3. For each, observe:
#   [forge-local] iteration 1/20: bash 'mkdir -p /workdir'... exit 0
#   [forge-local] iteration 2/20: text_editor create /workdir/package.json... done
#   ...
#   [forge-local] stop_reason: end_turn after N iterations
#   [done] proof saved to out/<briefId>/proof.json

# 4. Verify each brief
for d in out/*/; do
  jq -r '.briefTitle, .publicUrl, .prUrl' "$d/proof.json"
  test -s "$d/screenshot.png" && echo "  screenshot: OK ($(stat -f%z "$d/screenshot.png") bytes)" || echo "  screenshot: FAIL"
done
```

**Pass criteria**
- 3/3 briefs complete within 5 minutes each.
- Each produces a working PR with a buildable project (CI on the PR would pass — check by running `npm install && npm run build` on the PR branch locally).
- Each screenshot shows the requested feature visible (manually eyeball).
- No iteration loop hits `max_iterations: 20` (would indicate the LLM got stuck).

**Fail criteria**
- Any brief errors out before producing a proof.
- Screenshot is blank or shows console errors that the LLM should have caught.
- LLM emits commands that try to touch `/etc`, `/home/user/.ssh`, or anything outside `/workdir` (the VM allows it but the audit log must flag it).

---

### M2 — Browser proof bundle (formal proof contract)

Replace ad-hoc proof keys with the formal contract from D5.

**Build**
- `anvil/src/playwright-mcp.ts`:
  - Wait strategy: `browser_navigate` → wait for `networkidle` → wait for optional `data-ready` selector → 2s settle → screenshot.
  - Capture `browser_console_messages` filtered to `error` level + first 50 messages overall.
  - Capture `browser_network_requests` — failed requests only.
- `anvil/src/proof.ts`:
  - `assembleProof(briefId, vm, mcp, repoCtx)` returns typed `Proof` matching D5.
  - Persist to `out/<briefId>/proof.json` AND `out/<briefId>/screenshot.png`.
  - `Proof` schema: `briefTitle, vmId, publicUrl, screenshot: { path, sizeBytes }, consoleErrors: string[], failedNetworkRequests: { url, status }[], buildLogTail: string, repoUrl, branch, commitSha, prUrl`.

**QA runbook**
```
# 1. Re-run M1 briefs with M2 code
bun src/main.ts run-local --brief "Todo list app" --body "..."

# 2. Inspect proof
PROOF=$(ls -t out/ | head -n1)
cat out/$PROOF/proof.json | jq .

# 3. Schema check
jq -e '.briefTitle and .vmId and .publicUrl and .screenshot.path and .screenshot.sizeBytes >= 5000 and .repoUrl and .branch and .commitSha and .prUrl' out/$PROOF/proof.json
# exits 0 on success

# 4. Console error sanity
jq '.consoleErrors | length' out/$PROOF/proof.json
# expect 0 for the simple briefs; if >0, manually verify they're benign (favicon 404 etc.)

# 5. Screenshot quality
open out/$PROOF/screenshot.png
# manual: page renders, not blank, not skeleton, no error overlay
```

**Pass criteria**
- `jq -e ...` succeeds (schema complete).
- For the three M1 briefs: zero unexplained console errors.
- Screenshots show the page in its rendered, network-idle state (not first paint, not skeleton).

**Fail criteria**
- Schema missing any field.
- Screenshot taken before page rendered (visible by blank/skeleton state).
- `consoleErrors` contains real errors (uncaught exceptions, failed imports).

---

### M3 — Notion integration: Pusher dispatch + writeback

Wire Anvil to a real brief flow.

**Build**
- Worker-side (`src/index.ts`):
  - Add Pusher server SDK import.
  - In `onBriefStatusChange`, when `Owner === "Forge-Local" && Status === "Triaged"`: publish `{ briefId, title }` to `anvil-dispatch` channel. Continue with the rest of the existing flow (or short-circuit — see open question).
- Worker-side env: `PUSHER_KEY`, `PUSHER_SECRET`, `PUSHER_APP_ID`, `PUSHER_CLUSTER` pushed via `ntn workers env push`.
- Notion DB: add `Owner` option `Forge-Local` and `Forge-Local-Busy` (will be auto-created on first write via select-option behavior). Add `Repo` URL property. Add `PR URL` URL property.
- Anvil-side:
  - `pusher-subscriber.ts`: connect to channel, on `brief.dispatched` event → call brief-runner. Reconnect logic, single-flight guard.
  - `brief.ts`: fetch brief from Notion, claim (`Owner=Forge-Local-Busy`), on completion update properties + append blocks + post comment.
  - `proof.ts`: upload screenshot via `notion.files.upload` (or fall back to external URL). Append image block + code blocks + paragraph block with URLs.

**QA runbook**
```
# 1. Setup
# - In Notion, ensure Briefs DB has columns: Status (select), Owner (select), Repo (URL), PR URL (URL)
# - Worker: ntn workers env push (pushes Pusher secrets)
# - Worker: ntn workers deploy

# 2. Start Anvil
cd anvil && bun src/main.ts start
# Expect: [pusher] connecting... connected to channel anvil-dispatch
#         [anvil] ready, awaiting briefs

# 3. Seed a brief in Notion (manually, in browser)
# - Title: "Recipe blog landing page"
# - Body: "Featured recipe hero, latest 3 posts, newsletter signup."
# - Repo: (empty — will scaffold new)
# - Status: Triaged
# - Owner: Forge-Local

# 4. Observe Anvil within 5 seconds:
#   [pusher] received brief.dispatched id=<id>
#   [brief] claiming...
#   [brief] claimed, Owner=Forge-Local-Busy
#   [e2b] vm spawning...
#   [forge-local] iteration 1/20: ...
#   [github] gh repo create ...
#   [proof] uploading screenshot to Notion files API...
#   [brief] writeback complete, Status=Needs Review

# 5. Verify in Notion (within ~5 min)
# - Brief page has new heading "🔨 Forge-Local — proof"
# - Image block: screenshot visible
# - Code block: build log tail
# - Code block: console errors (or "none")
# - Paragraph: dev URL + repo URL + PR URL + commit SHA
# - Status: Needs Review
# - Owner: (cleared) or "Sentinel" (depending on Core's next move)

# 6. Verify VM cleanup
# - E2B dashboard: no sandbox older than 10 min for this account
# - ~/.anvil/audit.jsonl: append entries for this brief, status=success
```

**Pass criteria**
- Pickup latency from "Status=Triaged" in Notion to "[pusher] received" in Anvil stdout: **< 5 seconds**.
- End-to-end (brief seeded → Status=Needs Review): **< 5 minutes**.
- All Notion artifacts present (screenshot, logs, URLs).
- GitHub PR created and linked.
- VM torn down within 30s of completion.

**Fail criteria**
- Pickup latency > 30s.
- Any artifact missing or unreadable in Notion.
- Brief stuck in `Owner=Forge-Local-Busy` (claim not released).
- VM lingering after completion.

---

### M4 — GitHub lifecycle: scaffold-new vs extend-existing

Full repo lifecycle across multiple briefs.

**Build**
- `anvil/src/github.ts`:
  - `scaffoldNewRepo(name, org)` → `gh repo create` via Octokit, init local working dir, `simple-git` commit + push to `main`.
  - `extendExistingRepo(repoUrl, briefId)` → `simple-git` clone (with cached cache dir per repo), checkout `main`, create branch `hivemind/brief-<briefId>`, run Forge-Local on that branch, commit + push branch, open PR via Octokit.
- `anvil/src/brief.ts`:
  - Detect run mode: brief.repo empty → `scaffold-new`; brief.repo set → `extend-existing`.
  - After `scaffold-new`: write the new repo URL back to brief's `Repo` property.
- `anvil/src/forge-local.ts`:
  - Pass `repoCtx: { mode, repoUrl, branch }` to the agent's system prompt. In extend mode, prepend the working tree's existing files to the context (or instruct the LLM to `git ls-files` first).

**QA runbook**
```
# Test 1 — scaffold-new
# (Same as M3 with Repo=empty)
# Verify: brief.Repo is auto-populated with the new repo URL after completion.

# Test 2 — extend-existing
# Seed brief in Notion:
#   Title: "Add dark mode toggle"
#   Body: "Persist in localStorage, use prefers-color-scheme as default."
#   Repo: https://github.com/<org>/recipe-blog-landing-page  (created by Test 1)
#   Status: Triaged
#   Owner: Forge-Local

# Observe Anvil:
#   [brief] mode: extend-existing
#   [github] cloning https://github.com/<org>/recipe-blog-landing-page...
#   [github] branch hivemind/brief-<id> from main
#   [forge-local] iteration 1: ls /workdir... (LLM inspects existing files)
#   ...
#   [github] pr opened: ...

# Verify in GitHub:
# - PR is on the same repo as Test 1.
# - PR branch: hivemind/brief-<id>.
# - PR diff: only the dark-mode files, not a full re-scaffold.

# Test 3 — concurrent brief on same repo (negative test)
# Seed two briefs in quick succession with the same Repo. Expect:
# - Brief 1: pickup → run.
# - Brief 2: pickup blocked (single-flight) OR queued. Observe which.
# - Single-flight refusal acceptable in v1; queueing is v2.
```

**Pass criteria**
- Test 1: new repo created, URL written back to brief.Repo.
- Test 2: PR on existing repo, branch isolated, diff scoped to the new feature only (not a re-scaffold).
- Test 3: no race condition, no corrupted git state; either single-flight refusal with a clear "busy" message in Notion, or successful queueing.

**Fail criteria**
- New repo URL not written back to brief.
- Extend mode re-scaffolds the project instead of editing it.
- Two concurrent briefs corrupt the same repo (push conflicts, lost commits).

---

### M5 — Hardening + first-run UX

Production polish.

**Build**
- `anvil/src/audit.ts`: append-only `~/.anvil/audit.jsonl` — every tool call, every VM spawn/teardown, every GitHub action, every Notion write. Timestamp + brief ID + command + cwd + exit code + duration.
- `anvil/src/main.ts`:
  - `anvil setup`: interactive — checks E2B key, GitHub PAT, Pusher key, Notion token; installs Playwright Chromium; verifies VM spawn; writes initial `.env`.
  - `anvil status`: prints current brief (if any), websocket health, queue depth, last 5 completed briefs.
  - `anvil nuke`: kill all active VMs (via E2B API), kill all Playwright processes, clear `out/`.
  - `anvil stop`: graceful — finish current brief or mark it Failed (anvil-shutdown), then exit.
- Stale-claim sweep: on Anvil startup, query Notion for any cards with `Owner=Forge-Local-Busy` older than 30 min → revert to `Triaged`.
- Reconnect logic in pusher-subscriber: exponential backoff, max 5 retries, surface to status command.

**QA runbook**
```
# Test 1 — first-run wizard
rm .env
bun src/main.ts setup
# Expect: prompts for each secret, validates each, writes .env, installs chromium.
# Run: bun src/main.ts start  — should connect cleanly.

# Test 2 — graceful shutdown
# - bun src/main.ts start
# - Seed a brief, wait until [forge-local] starts.
# - Ctrl-C (SIGINT) the daemon.
# - Expect: [shutdown] cancelling brief... marked Failed (anvil-shutdown)
#           [shutdown] tearing down VM... done
#           [shutdown] exit 0
# - In Notion: brief Status=Failed, comment includes "anvil-shutdown".

# Test 3 — stale claim recovery
# - In Notion: manually set a brief Owner=Forge-Local-Busy, last_edited 1 hour ago.
# - bun src/main.ts start
# - Expect: [startup] found 1 stale claim, reverting to Triaged
# - Verify in Notion: that brief is back to Triaged.

# Test 4 — audit log
# Run a brief to completion.
tail -n 50 ~/.anvil/audit.jsonl | jq -s 'length, .[0], .[-1]'
# Expect: many entries, first = "vm.spawn", last = "brief.complete".
# Spot-check: each entry has timestamp, briefId, op, durationMs, exitCode.

# Test 5 — nuke
# Start Anvil, seed a brief, wait until VM up, then in another terminal:
bun src/main.ts nuke
# Expect: VM killed, daemon exits, ~/.anvil/audit.jsonl gets a "nuke" entry.
# E2B dashboard: no active sandboxes.

# Test 6 — 5 briefs back-to-back
# Seed 5 briefs (one at a time, wait for each to complete).
# After all 5:
ls -la out/                  # 5 dirs, each with proof.json + screenshot.png
ls ~/.anvil/audit.jsonl      # one file, growing
# E2B dashboard: 0 active sandboxes
ps aux | grep playwright     # 0 lingering processes
ps aux | grep chromium       # 0 lingering processes
```

**Pass criteria**
- Each Test 1–6 passes its specific expectations.
- After Test 6: 5 proof directories, audit log has entries for all 5, zero leftover VMs/processes.

**Fail criteria**
- Setup wizard accepts invalid keys without validation.
- Shutdown leaves VM running.
- Stale claim sweep misses or false-positives a real in-flight brief.
- Audit log has gaps or missing fields.
- Lingering VMs/processes after Test 6.

---

## Out of scope for v1 (v2+ backlog)

- Closed-loop iteration (Sentinel rejects → auto-rebuild).
- Concurrent briefs (queue, port allocation if multi-VM, parallel pickup).
- Multi-route screenshots beyond a brief-declared list.
- Lighthouse / axe / visual-regression.
- Linux / Windows / WSL host support.
- Self-hosted CF Worker + DO relay (Pusher is v1).
- SSH deploy key (PAT is v1).
- Local Lima VM driver (scaffolded but not first-class).
- Anvil's own LLM for "smart" routing decisions outside the brief loop.
- Anvil running on the Worker side (it's local-host only).

## Hidden gotchas to watch

- **Dev-server "ready" ≠ "page renders".** Vite/Next print "ready" before bundle is servable. M2's wait-for-networkidle + selector is non-negotiable.
- **`npm install` is arbitrary code execution** — but inside the VM, that's fine. Audit log captures it; host is untouched.
- **Notion `files.upload` API may need specific integration scopes.** First-run wizard must check and clearly error if missing. Fallback to external URL (R2/S3) only if absolutely necessary.
- **Playwright Chromium first download is ~250MB.** `anvil setup` must run `npx playwright install chromium` explicitly and show progress.
- **GitHub PAT bootstrap is the actual first-mile failure.** v1 = fine-grained PAT scoped to a single GitHub user/org. Document required scopes: `Contents: read/write`, `Pull requests: read/write`, `Metadata: read`.
- **Pusher message size limit is 10KB.** Don't send brief body in the dispatch event — only `{ briefId }`. Anvil fetches from Notion.
- **Pusher free tier: 200K messages/day, 100 concurrent connections.** Fine for v1. Track usage; switch to CF DO if exceeded.
- **`Owner=Forge-Local-Busy` rollback on crash.** M5 stale-claim sweep handles this on startup. Without it, a single crash strands the card forever.
- **E2B VMs cost money.** ~$0.008 per 10-min brief. Add a config-level `MAX_BRIEFS_PER_DAY` safety cap in M5.
- **GitHub auth scope creep.** If a PAT can `gh repo create` in your personal account, it can create in any org you have write access to. Use a dedicated bot user account if you don't want that blast radius.
- **Anvil's `NOTION_API_TOKEN` is broader than the Worker's** — Anvil writes images via Files API, which most integration tokens can't do by default. Verify and document the integration's capabilities checklist.
- **Webhook delivery is at-least-once.** If the Worker re-fires (which it can on Pusher reconnect), Anvil must dedupe by `briefId` against in-flight + recently-completed. M5 includes a 100-entry recent-completions LRU.

## Open questions (non-blocking, revisit during impl)

- **Does the Worker still fire its existing Scout/Forge text chain in parallel with Forge-Local?** Or does `Owner=Forge-Local` short-circuit Scout/Sentinel? Default: **short-circuit** — if a brief is explicitly Forge-Local, skip the text chain entirely; let Forge-Local's screenshot drive Sentinel's review.
- **Who decides a brief is Forge-Local?** v1 = the human assigns Owner manually. v2 = Core auto-classifies based on brief content ("does this need real code?").
- **Forge-Local model choice.** Sonnet 4.6 default, Opus 4.6 retry on max-iter. Revisit after M1 — if Sonnet fails on > 30% of briefs, promote Opus to default.
- **Notion image upload mechanism.** Files API v1; external URL via R2 fallback if scopes block it. Decide at M3 implementation time after verifying integration scopes.
