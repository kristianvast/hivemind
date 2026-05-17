# Anvil — Hivemind's local executor

Anvil is a long-running Node.js daemon you run on **your own Mac**. It gives
the Hivemind orchestrator (the Notion Worker in `../src/`) a pair of hands:
a Linux VM with a real shell, a real filesystem, real outbound network, a
real Playwright browser, and a real GitHub remote.

Anvil has two VM backends, selected by `SANDBOX_DRIVER`:

- **`lima` (default)** — a [Lima](https://lima-vm.io) VM running on your Mac.
  Free, local, persistent. The dev server is reachable at
  `http://127.0.0.1:3000` because Lima auto-forwards `0.0.0.0:*` ports from
  the VM to your host. First boot installs Node 22 + git + curl inside the
  VM and takes ~1–2 min; subsequent runs are immediate.
- **`lima` opt-out → `e2b`** — set `SANDBOX_DRIVER=e2b` to use
  [E2B](https://e2b.dev) Firecracker microVMs in the cloud. Faster cold
  start, no local install, costs E2B credits.

Architecture in 10 lines:

1. Admin sets `Owner = Forge-Local` and `Status = Triaged|Provisioned` on a brief in Notion.
2. The Notion automation hits the Worker webhook.
3. The Worker publishes `{ briefId }` to Pusher channel `anvil-dispatch`.
4. Anvil (running on your Mac) receives the push, claims the brief
   (sets `Owner = Forge-Local-Busy`), and ensures a VM is ready
   (local Lima VM by default).
5. Inside the VM, Anvil clones (or scaffolds) the repo for that brief, starts
   a dev server on port 3000 bound to `0.0.0.0`. On Lima it's reachable at
   `http://127.0.0.1:3000`; on E2B at `https://{port}-{sandboxId}.e2b.app`.
6. **Forge-Local** — a Claude agent with `bash`, `text_editor`, and Playwright
   tools — works inside the VM until it calls `report_proof`.
7. Anvil captures a screenshot via a host-side Playwright MCP, reads console
   errors + failed requests, and commits + pushes the branch.
8. Anvil opens a GitHub PR for the work.
9. Anvil writes the proof (screenshot, summary, dev URL, commit SHA, PR URL)
   back into the brief's Notion project subtree.
10. Anvil sets `Status = Done`, `Owner = Forge-Local`, wipes the workdir,
    frees up. The Lima VM stays warm for the next brief; the E2B sandbox is
    destroyed.

Anvil's daemon has **no inbound network** on your machine. It only opens an
outbound WebSocket to Pusher and outbound HTTPS to Notion, Anthropic, E2B
(if used), GitHub, and the dev URL.

## Files

| Path | Purpose |
| --- | --- |
| [`src/main.ts`](src/main.ts) | CLI entry — `start`, `status`, `nuke`, `setup`, `run-local`. |
| [`src/pusher-subscriber.ts`](src/pusher-subscriber.ts) | Long-lived Pusher subscriber, callback wired to `dispatchBrief`. |
| [`src/vm-runtime.ts`](src/vm-runtime.ts) | Dispatcher; picks driver based on `SANDBOX_DRIVER`. |
| [`src/lima-runtime.ts`](src/lima-runtime.ts) | Local Lima VM driver — shells out to `limactl`. Single shared VM, workdir per brief. |
| [`src/e2b-runtime.ts`](src/e2b-runtime.ts) | Cloud E2B driver — thin wrapper over the E2B SDK (spawn, exec, files, port URL, kill). |
| [`src/github.ts`](src/github.ts) | Scaffold repo / clone repo / push branch / open PR via Octokit + simple-git. |
| [`src/playwright-mcp.ts`](src/playwright-mcp.ts) | Spawns `@playwright/mcp` over stdio, exposes `navigate / screenshot / consoleErrors / failedNetworkRequests / waitForReady`. |
| [`src/tools.ts`](src/tools.ts) | Anthropic native `bash_20250124` + `text_editor_20250728` plus 7 custom tools (Playwright + `git_commit_push` + `report_proof`). |
| [`src/forge-local.ts`](src/forge-local.ts) | Hand-rolled Anthropic tool-use loop with audit + transcript. |
| [`src/brief.ts`](src/brief.ts) | Notion brief load / claim-busy / release / stale-busy sweep. |
| [`src/proof.ts`](src/proof.ts) | Uploads screenshot via `notion.fileUploads` and appends Proof blocks. |
| [`src/audit.ts`](src/audit.ts) | Per-brief JSONL audit log under `$AUDIT_DIR`. |
| [`src/config.ts`](src/config.ts) | zod-validated env loader. |
| [`src/log.ts`](src/log.ts) | Tiny JSONL stderr logger. |
| [`src/types.ts`](src/types.ts) | Shared types. |

## Install

```bash
cd anvil
npm install
```

You need Node ≥ 22 and npm ≥ 10.9.2 (same as the root Worker).

**Local mode (default) also needs Lima.** On macOS:

```bash
brew install lima
```

(For other platforms, see https://lima-vm.io.) The first `anvil setup`
(or first dispatched brief) creates a Lima VM named `anvil` and provisions
Node 22 + git + curl inside. That step takes ~1–2 min, only once. After
that, dispatch is fast.

## Configure

Anvil reads the root project's `.env` (Notion + Anthropic) plus the Anvil-specific keys.

Required for real (non-mock) runs:

| Variable | Where to get it |
| --- | --- |
| `NOTION_API_TOKEN` | Same internal integration token the Worker uses. |
| `ANTHROPIC_API_KEY` | Same key the Worker uses. |
| `HIVEMIND_BRIEFS_DATABASE_ID` | Same DB ID the Worker uses. |
| `PUSHER_KEY`, `PUSHER_CLUSTER` | `https://dashboard.pusher.com` → Channels app → "App Keys". (Worker also needs `PUSHER_APP_ID`, `PUSHER_SECRET`, `PUSHER_KEY`, `PUSHER_CLUSTER`.) |
| `GITHUB_PAT` | `https://github.com/settings/personal-access-tokens` — fine-grained PAT with **Contents R/W**, **Pull requests R/W**, **Metadata R** on the org/user where Anvil will create repos. |
| `E2B_API_KEY` | *Only* if `SANDBOX_DRIVER=e2b`. `https://e2b.dev/dashboard` → "API Keys". |

Optional (have sensible defaults):

- `SANDBOX_DRIVER` — `lima` (default, local Lima VM) or `e2b` (cloud microVM).
- `GITHUB_DEFAULT_ORG` — leave unset to scaffold under the PAT owner's account.
- `PUSHER_CHANNEL` (default `anvil-dispatch`).
- `FORGE_LOCAL_MODEL` (default `claude-sonnet-4-5-20250929`).
- `ANVIL_WORKDIR_ROOT` (default `$HOME/.anvil`) — where screenshots, transcripts, audit logs live.
- `MOCK_MODE` (default `false`) — `true` skips all external service calls.

After adding the Anvil/Pusher entries to `.env` at the repo root,
`ntn workers env push` pushes them to the deployed Worker (so the Worker can
publish to Pusher).

### Notion DB properties

Add these select options to the existing **Owner** property on the Briefs DB:

- `Forge-Local` — admin sets this to hand a brief to Anvil.
- `Forge-Local-Busy` — Anvil sets this while it's working (claim lock).

Add these new properties to the Briefs DB:

- `Repo` (URL) — set by Anvil to the GitHub repo URL.
- `PR URL` (URL) — set by Anvil to the most recent PR URL.
- `BusyAt` (Number or Date) — optional but **strongly recommended**.
  Without it, Anvil falls back to leaving a comment when it claims a brief
  and the stale-claim sweeper can only release briefs that have **no** BusyAt
  property (much coarser).

## CLI

```bash
# Long-running daemon. Subscribes to Pusher and drives briefs end-to-end.
node dist/main.js start

# Live one-shot. Bypass Pusher, dispatch a single brief directly.
node dist/main.js run-local <briefId>

# Mock dispatch — no E2B, no GitHub, no Notion, no Anthropic. Just logs the steps.
node dist/main.js run-local <briefId> --mock

# List Anvil's E2B sandboxes (those tagged metadata.purpose=anvil).
node dist/main.js status

# Kill every Anvil-tagged sandbox. Requires --yes.
node dist/main.js nuke --yes

# Interactive: prompt for any missing .env entries.
node dist/main.js setup
```

Or run from source with `npm run dev` (uses `tsx watch`).

## Build / type-check

```bash
npm run check         # tsc --noEmit
npm run build         # tsc → dist/
```

The Worker (root project) does **not** depend on Anvil. Anvil depends on
nothing in the Worker's source tree.

## Verification runbook

These steps walk you from a fresh checkout to a fully-validated real run.
You own the third-party credentials; the steps tell you exactly what to do
with each.

### Step 0 — Type / build / mock (no external services needed)

```bash
# From repo root
cd anvil && npm install && npm run check && npm run build && cd ..

# Mock dispatch with fake env values — proves wiring & logging.
cd anvil
MOCK_MODE=true \
NOTION_API_TOKEN=ntn_fake \
ANTHROPIC_API_KEY=sk-ant-fake \
E2B_API_KEY=e2b_fake \
PUSHER_KEY=fake PUSHER_CLUSTER=us2 \
GITHUB_PAT=ghp_fake \
HIVEMIND_BRIEFS_DATABASE_ID=fake-database-id \
node dist/main.js run-local mock-brief-123 --mock
```

Expected output (JSONL to stderr):

```
[MOCK] would load brief                briefId=mock-brief-123
[MOCK] would claim brief busy          briefId=mock-brief-123
[MOCK] would spawn VM                  metadata={purpose:anvil,briefId:mock-brief-123}
[MOCK] would prepare GitHub repo …
[MOCK] would spawn Playwright MCP
[MOCK] would run Forge-Local
[MOCK] would capture proof, open PR, write Notion proof
```

If you see those 7 lines, the build is healthy.

### Step 1 — Wire up Pusher

1. Sign up at https://pusher.com/channels. Free tier is fine.
2. Create a **Channels** app. Note `App ID`, `Key`, `Secret`, `Cluster`.
3. Put them in `.env` at the repo root (see `.env.example`).
4. `ntn workers env push` to push these to the deployed Worker.

Smoke-test the publish from the Worker side. Pick any brief; flip
`Owner = Forge-Local` and `Status = Triaged`. Inspect the Worker run logs:

```bash
ntn workers runs list --plain | head -n1 | cut -f1 | xargs -I{} ntn workers runs logs {}
```

You want to see `[onBriefStatusChange] dispatched Forge-Local <pageId>`.
If you see `PUSHER_APP_ID/PUSHER_KEY/PUSHER_SECRET/PUSHER_CLUSTER not fully
configured; skipping Anvil dispatch publish.`, the env push didn't take —
re-push and retry.

### Step 2 — Wire up the VM backend

**Default: Lima (local).**

```bash
brew install lima                 # one-time
cd anvil
node dist/main.js setup           # bootstraps the `anvil` Lima VM,
                                  # ~1–2 min first time
limactl list                      # should now show: anvil  Running …
```

If you'd rather use E2B (cloud):

1. Set `SANDBOX_DRIVER=e2b` in `.env`.
2. Sign up at https://e2b.dev. Free tier gives ~150 sandbox-hours/month.
3. Dashboard → API Keys → create one. Put in `.env` as `E2B_API_KEY`.
4. Smoke-test:

   ```bash
   cd anvil
   E2B_API_KEY=$E2B_API_KEY node -e "
     const { Sandbox } = require('e2b');
     (async () => {
       const sb = await Sandbox.create('base', { timeoutMs: 60_000 });
       const r = await sb.commands.run('echo hello from \$(uname -a)');
       console.log(r.stdout);
       await sb.kill();
     })();
   "
   ```

### Step 3 — Wire up GitHub

1. https://github.com/settings/personal-access-tokens → "Generate new token"
   (fine-grained).
2. Resource owner: the org or user where Anvil should create repos.
3. Permissions: **Contents R/W**, **Pull requests R/W**, **Metadata R**.
4. Put in `.env` as `GITHUB_PAT`. Set `GITHUB_DEFAULT_ORG` if you picked an
   org (leave blank for personal repos).
5. Smoke-test:

   ```bash
   curl -s -H "Authorization: Bearer $GITHUB_PAT" https://api.github.com/user | jq .login
   ```

### Step 4 — Add the Notion properties

In Notion, on the Briefs DB:

- **Owner** (select) — add options `Forge-Local`, `Forge-Local-Busy`.
- **Repo** (URL) — new property.
- **PR URL** (URL) — new property.
- **BusyAt** (Number or Date) — new property, recommended for stale-claim sweep.

Make sure the same integration that powers `NOTION_API_TOKEN` has access to
the Briefs DB and to the page that will become the project subtree root
(or invite via `... → Connections`).

### Step 5 — Dry run a single brief locally

Pick (or create) a small brief in Notion. Note its page ID.

```bash
# Terminal 1 — daemon (or you can use run-local directly)
cd anvil
node dist/main.js start
```

In Notion, flip the brief's `Owner = Forge-Local`, `Status = Triaged`.
Watch terminal 1. Expected sequence (JSONL):

1. `[pusher] state` `connecting → connected`
2. `[pusher] subscribed channel=anvil-dispatch`
3. `[anvil] dispatch_start` briefId
4. Series of `[forge-local]` and tool logs — Claude bashes, edits, drives the browser
5. Screenshot + `[forge-local] complete`
6. `[anvil] dispatch_complete`

In Notion, the brief should now have:
- `Status = Done`, `Owner = Forge-Local`
- `Repo` and `PR URL` populated
- A new **Proof** section appended to the project subtree page with the
  screenshot, summary, console errors, failed requests, and links.

If anything fails, check `$ANVIL_WORKDIR_ROOT/audit/<briefId>.jsonl` for the
full audit trail and `$ANVIL_WORKDIR_ROOT/transcripts/<briefId>.json` for
the Forge-Local agent transcript.

### Step 6 — Cleanup

```bash
node dist/main.js status         # list VMs (Lima: the anvil VM; E2B: any active sandboxes)
node dist/main.js nuke --yes     # Lima: stop the anvil VM. E2B: kill all sandboxes.
```

For Lima, after `nuke` the VM is stopped (not deleted). To fully remove it:
`limactl delete anvil`.

For E2B, sandboxes auto-expire after `timeoutMs` (default 10 min in Anvil),
so forgotten sandboxes won't bill forever.

## Common failures

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `[pusherPublish] PUSHER_APP_ID/… not fully configured` in Worker logs | Worker env vars not pushed | `ntn workers env push` after editing root `.env` |
| `[pusher] subscription_error` in Anvil | Wrong `PUSHER_KEY` / `PUSHER_CLUSTER` | Re-check dashboard, copy-paste exactly |
| `Sandbox.create` 401 | Bad `E2B_API_KEY` (when `SANDBOX_DRIVER=e2b`) | Regenerate at https://e2b.dev/dashboard |
| `limactl not found in PATH` | Lima not installed for local mode | `brew install lima` (macOS) or see https://lima-vm.io |
| `[lima] anvil VM already running` followed by hang on first brief | Lima VM has no node/npm yet | Run `node dist/main.js setup` once; it provisions the toolchain |
| Git push fails 403 | PAT scopes wrong | Need Contents R/W on the target repo's owner |
| `git_commit_push` returns "nothing to commit" | Forge-Local didn't change files | Look at audit log; usually means the agent didn't reach the editing phase |
| Screenshot is blank | Dev server isn't actually ready when Anvil snaps | Forge-Local should call `playwright_wait_for` before reporting proof |
| Brief stuck in `Forge-Local-Busy` after crash | Crash before release | Daemon restart triggers `findStaleBusyBriefs` on startup (>30 min default) |

## Mock mode

Set `MOCK_MODE=true` (env or `.env`) to skip every external call. The CLI
runs through the full code path and logs `[MOCK] would …` for each step.
Useful for:

- Verifying a new piece of code wires through correctly.
- CI smoke tests.
- Demoing the architecture without burning E2B time.

## License

Same as the parent project.
