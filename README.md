# Cloudflare Orbs

Remote coding-agent workspaces on Cloudflare. Each **orb** is a persistent, addressable agent thread:

- a **Durable Object** is the always-addressable control plane (conversation log, approvals, schedule, WebSockets), and costs nothing while idle;
- a **Linux container** is the computer the agent works on. It starts when there is work, is snapshotted and stopped when there is not, and is restored on the next message.

Start an orb from your phone, close the tab, come back hours later to a finished (or still running) task with the full conversation, the files, and a diff ready to turn into a pull request.

```
 browser / phone ──HTTPS+WS──▶ Worker (/api/*, auth, tickets) ──RPC──▶ Orb Durable Object ─────────┐
   React app (static assets)                                            SQLite: events, turns,      │ ctx.container
                                                                        approvals, snapshots        ▼
 UserHub Durable Object  ◀── summaries, slot accounting ──────────────  alarms: supervise / sleep   Container (Debian)
   (thread list, usage, concurrency cap)                                                            claude / codex CLI
                                                                                                    │ all egress
 AI Gateway ◀── token added here ──┐                                                                ▼
 GitHub     ◀── token added here ──┴─────────────────────────────────  Outbound entrypoint (Worker): allowlist,
                                                                        credential injection, approvals channel
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the sleep/wake cycle, streaming, approvals and egress control work, and why.

## What works

| | |
|---|---|
| Create an orb from a GitHub repo + prompt | Clone, run the agent, stream tool calls, finish with a diff |
| Streaming | Live text deltas and tool calls over hibernatable WebSockets; reconnecting clients replay from a cursor, no duplicates |
| Sleep / wake | Idle → snapshot → container stopped, DO hibernates. Next message restores the snapshot (seconds). Snapshot unusable → rebuild from git + a recovery patch kept in R2 |
| Approvals | Per-action human approval (Claude Code) via a permission-prompt MCP tool that talks to the DO; allow, deny, always-allow |
| Diff, PR | Inline diff (readable while asleep), one-click commit + push + pull request. The agent never holds the GitHub token |
| Terminal | xterm.js to a tmux session in the workspace; survives disconnects |
| Harnesses | Claude Code and Codex, plus a scripted `demo` harness for testing without credentials. Adding one is one file ([below](#adding-a-harness)) |
| Scheduled wake-ups | "Message this orb at 9am": the alarm wakes it, runs the turn, and it goes back to sleep |
| Cost controls | Per-orb model-spend and awake-time budgets (enforced), per-user cap on concurrently awake orbs, usage page, per-orb attribution in AI Gateway logs |
| Safety | No direct container egress; allowlist enforced in the Worker; credentials only added in the Worker; sandboxed previews; scoped, expiring socket tickets |
| UI | Responsive web app (phone first), installable as a PWA |

## Repository layout

```
apps/orbs/                the deployable: one Worker project (cloudflare.config.ts)
  src/worker/             API router, Orb + UserHub Durable Objects, Outbound entrypoint, auth
  src/web/                React app (built to static assets)
  scripts/e2e.mjs         end-to-end check against a running dev server
  test/                   unit tests (store, auth, pkt-line, timeline, diff)
packages/protocol/        wire types + zod schemas shared by Worker and app
packages/harness/         agent adapters: command line + event-stream parser (tested on real captured output)
container/                Dockerfile and the scripts baked into the workspace image
docs/ARCHITECTURE.md
```

## Run it locally

Requirements: Node ≥ 22.18, pnpm 10, Docker (OrbStack/Docker Desktop), network access to github.com. Uses the [`cf` CLI](https://developers.cloudflare.com/cf/); there is no Wrangler config.

```sh
pnpm install

# Local secrets. The demo harness needs none of them to be real.
cp apps/orbs/.dev.vars.example apps/orbs/.dev.vars
#   SESSION_SECRET=$(openssl rand -hex 32)    AUTH_TOKEN=dev-token    GITHUB_TOKEN=(empty is fine for public repos)

cd apps/orbs
ENABLE_DEMO_HARNESS=true IDLE_SLEEP_MINUTES=1 AI_GATEWAY_ACCOUNT_ID=dev cf dev
# open http://localhost:5173 and sign in with the AUTH_TOKEN
```

`cf dev` builds the container image and runs real containers, so the whole pipeline (clone through the egress firewall, detached agent, event pump, snapshots, terminal) is exercised locally. The demo harness is a scripted agent that edits a file in the repo, so diffs and snapshots have content.

```sh
node scripts/e2e.mjs        # 14 end-to-end checks against the running dev server
pnpm test                   # unit tests
pnpm typecheck
```

Restart the dev server after changing Durable Object code if you are testing supervision: hot reload leaves already-running object instances on the old code.

## Deploy

1. **AI Gateway.** Create an [authenticated gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/), give it Anthropic (and OpenAI for Codex) credentials or Unified Billing, and create a token with the **Run** permission.
2. **GitHub token.** Fine-grained, on the repos you will use: Contents (read/write) and Pull requests (read/write).
3. **Secrets** in a file that is not committed (`.env` format):

   ```
   AI_GATEWAY_TOKEN=...
   GITHUB_TOKEN=...
   SESSION_SECRET=...      # openssl rand -hex 32
   AUTH_TOKEN=...          # what you type into the web app; still required (unused) with Access
   ```
4. **Configuration** is read from the environment `cf` runs in (defaults in `apps/orbs/cloudflare.config.ts`):

   | Variable | Meaning | Default |
   |---|---|---|
   | `AI_GATEWAY_ACCOUNT_ID`, `AI_GATEWAY_ID` | the gateway agents call through | `REPLACE_WITH_ACCOUNT_ID`, `default` |
   | `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | enable Cloudflare Access (recommended) | off |
   | `CLAUDE_CODE_MODELS`, `CODEX_MODELS` | comma-separated model allowlists, first is the default | built in |
   | `MAX_CONCURRENT_ORBS` | awake orbs per user | 5 |
   | `IDLE_SLEEP_MINUTES` | idle time before snapshot + stop | 10 |
   | `DEFAULT_MAX_COST_USD`, `DEFAULT_MAX_RUNTIME_MINUTES` | default per-orb budget | 10, 240 |
   | `EXTRA_ALLOWED_HOSTS` | extra hostnames containers may reach | none |
   | `IMAGE_VERSION` | **bump when `container/` changes** so snapshots from the old image are not restored | 1 |
   | `ORBS_WORKER_NAME`, `ORBS_ARTIFACTS_BUCKET` | names | `cloudflare-orbs`, `orbs-artifacts` |

5. ```sh
   cd apps/orbs
   AI_GATEWAY_ACCOUNT_ID=<id> cf deploy --secrets-file ../../.secrets.env
   ```
   `cf deploy` builds and pushes the container image (Docker must be running) and provisions the R2 bucket.

**Put it behind Cloudflare Access** (an Access application on the Worker's hostname, then set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`). With Access the browser needs no token; the `AUTH_TOKEN` bearer still works for API clients. Without Access, anyone with the token has a root shell in your workspaces, so treat it like a password.

Preview URLs of dev servers inside an orb are served from the app's origin under a `sandbox` CSP. For production-grade previews give each its own hostname (see the Sandbox docs on [previews on their own hostnames](https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/)).

## Security model

- **The container holds no secrets.** It has no internet. Every HTTP(S) request goes to the `Outbound` entrypoint, which allows the AI Gateway (adds the gateway token, strips the placeholder key), the orb's own GitHub repo (adds the GitHub token; pushes limited to `orb/<id>`), and, under the default `packages` policy, anonymous access to common package registries. Everything else gets a 403.
- **Approvals are a safety layer, not the boundary.** The agent runs as root inside its own sandbox; a determined agent can alter its own settings. The boundary is the container, its egress rules, and the lack of credentials.
- **Tenancy.** Orbs are named from a hash of the authenticated user, derived on the server; a user cannot address another's orb. Sockets use 60-second, single-purpose, per-orb tickets.
- Snapshots and the R2 recovery patch can contain whatever the agent wrote to disk. Treat them as the user's data.

## Cost model

An idle orb is a Durable Object with a SQLite file and nothing else: no container, no alarm, hibernated WebSockets. Costs accrue only while a container is awake (billed by instance size and time; the usage page shows awake time per orb) and for model calls (reported by the agent, and attributed per orb in AI Gateway). Snapshots persist for 30 days after their last use.

## Adding a harness

1. Implement `Harness` in `packages/harness/src/<name>.ts`: `command()` builds the argv and env (the prompt is fed over stdin), `createParser()` turns one line of the agent's JSON stream into events. Capture real output from the CLI and add it as a fixture test.
2. Register it in `packages/harness/src/index.ts` and add its id to `HARNESS_IDS` in `packages/protocol`.
3. Install the CLI (pinned) in `container/Dockerfile` and bump `IMAGE_VERSION`.
4. If the CLI cannot route model calls through an `*_BASE_URL`, add its host handling in `src/worker/outbound.ts`.

## Known limits

- **Not yet run against a real Cloudflare deployment or real model credentials.** Everything above was exercised end to end locally with `cf dev` and real containers using the demo harness; the Claude Code approval contract and both agents' event formats were verified against the real CLIs; the in-container Claude Code / Codex runs through AI Gateway, the GitHub push + PR path, and Access JWT validation have been implemented from the documented behaviour but not run.
- Codex cannot ask for approvals (`codex exec` has no callback), so approvals are Claude Code only.
- Container `durable_object` scheduling policy and snapshots are public beta; expect API changes.
- Previews are HTTP only (no WebSocket upgrade), so HMR does not work through them.
- Model spend for Codex is not reported by the CLI, so only its tokens are shown and cost budgets do not apply to it; the awake-time budget does.
- One agent turn runs at a time per orb; further messages queue.
