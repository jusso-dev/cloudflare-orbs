# Architecture

## Principles

1. **State that matters lives in the Durable Object's SQLite, or in the container's filesystem. Never in memory.** Every in-memory field in `Orb` (`parsers`, `waiters`, `pumping`, …) is rebuilt after a restart. This is what makes hibernation, deploys and evictions safe.
2. **The agent's output file is the source of truth for a running turn**, not the stream that carries it. Progress is a byte offset stored with the events it produced.
3. **Credentials exist only in the Worker.** The container has no internet; its traffic is rewritten in the Worker.
4. **One alarm drives everything**, and every wake-up recomputes what is due from SQLite.

## Components

| Piece | Where | Job |
|---|---|---|
| Router | `src/worker/index.ts` | REST + ticket-authenticated WebSockets; authentication; maps a request to `${ownerKey}:${orbId}`, so a user can only reach their own orbs |
| `Orb` | `src/worker/orb.ts` | One per orb. Conversation log, turn state machine, approvals, schedule, alarm supervisor, WebSocket fan-out, terminal and preview proxies. Owns the container via `ctx.container` |
| `Sandbox` | `src/worker/sandbox.ts` | Container lifecycle: start (snapshot or image), egress interception, readiness, snapshot, stop, `exec` |
| `workspace` | `src/worker/workspace.ts` | Clone, rebuild after loss, recovery patch, diff, push + PR |
| `OrbStore` | `src/worker/store.ts` | All SQL. Written against a minimal interface so it is unit-tested under Node |
| `Outbound` | `src/worker/outbound.ts` | The container's only way out: allowlist, credential injection, git push restriction, approvals channel |
| `UserHub` | `src/worker/user-hub.ts` | One per user. Thread list, usage totals, the cap on concurrently awake orbs |
| Harnesses | `packages/harness` | Command line + stream parser per agent CLI |
| Container | `container/` | Image, `orb-run` (detached runner), `approve-mcp.mjs`, `demo-agent.mjs` |

The agent CLI runs **inside the container** (the documented pattern for Claude Code and Codex). The Durable Object supervises it rather than hosting the loop, because those CLIs are the loop.

## A turn

```
POST /messages ─▶ Orb.sendMessage ─ INSERT turn(queued) + user_message event ─ setAlarm(now)
                                                                │
alarm() ─▶ tick() ─▶ startTurn:  ensureAwake()  (restore snapshot or fresh image, intercepts, clone if empty)
                                 write prompt.txt, exec: orb-run <dir> -- claude … (returns once the pid file exists)
                    superviseTurn: pump = exec `tail -c +<offset> -F events.jsonl`
                                   for each batch of complete lines:
                                     parse → [events, deltas]
                                     transaction { INSERT events; UPDATE turn SET offset }     ← atomic
                                     broadcast deltas, then events, to every socket
                                   stops on the __orb_exit marker → finalizeTurn
                                   every 45s: probe the process (pid + boot id) in case it vanished
```

`orb-run` starts the agent with `setsid` (own process group), stdin from `prompt.txt`, stdout to `events.jsonl`, and on exit appends an `__orb_exit` line and an `exit-code` file. A process whose output is piped to a request that ends would die of SIGPIPE; a file does not.

Why a file and a byte offset: the DO can be evicted or redeployed at any moment. On the next alarm it re-attaches with `tail -c +<offset>`; nothing is lost or duplicated. Parser state (Codex pairs `item.started`/`item.completed`) is rebuilt by replaying the already-ingested prefix.

An alarm invocation follows one turn for up to 14 minutes (alarm handlers are capped at 15), then re-enters; the running handler is what keeps the object active during a turn. When nothing is running, nothing keeps it resident.

## Sleep and wake

```
awake ── no activity for IDLE_SLEEP ──▶ refreshDiff (cached in SQLite, so Changes works asleep)
                                        recovery patch → R2          (git diff --binary since the clone)
                                        container.snapshotContainer() → id stored in SQLite
                                        container.destroy()
                                        status = sleeping; no alarm unless something is scheduled
                                        → no container, no alarm: the DO hibernates, sockets stay open

sleeping ── message / schedule / Wake / terminal ──▶ UserHub.claimSlot (per-user cap)
                                        start({ containerSnapshot })  ─ ok ─▶ ready in seconds
                                              │ fails, or snapshot image ≠ IMAGE_VERSION
                                              ▼
                                        start({ image }) → git clone → checkout the original base commit
                                        → apply the R2 recovery patch → conversation replayed into the prompt
```

While awake, a 15-minute checkpoint snapshot (only when idle and the workspace changed) bounds what an abrupt stop can lose, and each alarm tick resets the container's inactivity timeout (always longer than the tick interval) so a live orb never idles out between checks. If the container dies unexpectedly, `monitor()` notices; a running turn is marked `lost`, and the next message wakes the orb as above.

The restore fallback matters because snapshots are tied to the image they came from and expire after 30 days of non-use.

## Approvals

For Claude Code in `ask` mode the CLI runs with `--permission-prompt-tool mcp__orb__approve` and a stdio MCP server (`approve-mcp.mjs`). For every prompt it `POST`s `http://orb.internal/approvals`: a hostname the Worker intercepts. The DO stores the request, emits `approval_requested`, and the UI shows it. The shim long-polls `GET /approvals/:id?wait=20`; the DO answers when a human decides over REST or the socket. Requests are idempotent on `tool_use_id` and decided state is in SQLite, so a restart on either side just resumes the poll. "Always allow" adds the tool to the orb's rules. Interrupting or finishing a turn expires pending approvals.

## Egress

The container starts with `enableInternet: false` and three intercepts (`orb.internal`, all HTTP, all HTTPS) all pointing at `Outbound` with per-orb props. Containers re-sign HTTPS with a Cloudflare CA, which is why the environment points every common tool (`NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, `SSL_CERT_FILE`, `PIP_CERT`, …) at it; the CA alone is trusted, which works because nothing bypasses the intercept.

- AI Gateway, own path only: `x-api-key`/`authorization` removed, `cf-aig-authorization` added, `cf-aig-metadata` set to `{orb, owner}` for per-orb attribution.
- `github.com/<owner>/<repo>.git` only: upload-pack and receive-pack, token added. A push body is `tee`d and its pkt-line command list parsed (including the `shallow` lines a push from a shallow clone starts with); anything but `refs/heads/orb/<id>` is refused before the request leaves.
- `packages` policy: anonymous pass-through to the registries in `PACKAGE_HOSTS`. `strict`: nothing else.
- Plain HTTP is refused for everything but `orb.internal`, so a credential is never attached to cleartext.

## Real-time delivery

The orb socket uses the **hibernation API**: the DO can be evicted with sockets connected. Clients send `hello{lastSeq}` and receive the events they missed (chunked), then live events; sequence numbers make delivery idempotent. Text deltas are ephemeral (never stored; the full text arrives as `agent_message`). Keep-alive `ping`s are answered by `setWebSocketAutoResponse` without waking the object. The client reconnects with jittered exponential backoff, a heartbeat that detects half-open connections, and an immediate retry when the page becomes visible. The terminal socket is not hibernatable (it holds a live pty handle) and counts as activity while open.

## Authentication

Cloudflare Access JWT (verified against the team JWKS, audience-checked) or a static bearer token. Browsers cannot set headers on a WebSocket, so an authenticated REST call mints a 60-second HMAC ticket scoped to one orb and one purpose (`events`, `terminal`, `hub`, `preview`). Cookie-authenticated writes are rejected unless the `Origin` matches. Preview responses carry `Content-Security-Policy: sandbox` so code from a repo cannot use the app's session.

## Failure behaviour

| Event | Result |
|---|---|
| DO restarts mid-turn | Alarm re-attaches at the stored offset; parser rebuilt |
| Agent process killed / container OOM | Probe finds the pid gone → turn `lost` (or `interrupted` if a stop was requested); next message resumes |
| Snapshot restore fails or image changed | Rebuild from git + recovery patch; session replayed as context |
| Resume points at a missing agent session | One automatic retry with the conversation replayed |
| Client loses signal | Reconnect, replay from cursor, nothing lost |
| Approval pending for hours | State in SQLite; shim keeps polling; the orb does not sleep |
| Budget reached | Running turn interrupted, queue cleared, orb sleeps; raising the budget lifts it |
| Orb deleted while its alarm is queued | Alarm exits because the config is gone |

## Decisions and trade-offs

- **Alarm-driven supervision rather than request-scoped work.** The create request returns immediately; startup and the turn run in an alarm, which can outlive any HTTP request. The cost is a small alarm latency before work starts.
- **Polling probes in addition to the live stream.** A dead agent produces no end-of-stream, so the supervisor checks the process every 45 s.
- **R2 recovery patch besides snapshots.** Snapshots are the fast path; the patch makes the slow path lossless for file changes.
- **One turn at a time per orb**, with a queue. The agent CLIs are single-session; concurrency belongs at the orb level (the per-user cap).
- **Bash, not sh, for signalling:** dash's `kill` cannot address a process group (`--` is rejected), which the end-to-end test caught.
