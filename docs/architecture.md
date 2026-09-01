# Architecture

How this repo is put together and why. Read this before changing code. If you just want
to get something running, start with the [README](../README.md); if you are about to add
a workflow or a test, continue to the [development guide](development.md).

## What this repo is

A **ready-made kit** for driving [Apra Fleet](https://github.com/Apra-Labs/apra-fleet)
**from your own Node process**, reused across projects. You clone it, keep the shape,
and replace the dummy workflow body with the work that is unique to that project.

Provisioning, member identity, concurrent-run safety, MCP exposure, Docker, and mock
tests are already solved. The only thing that remains, per project, is **workflow
design**: what `command()`, `transform()`, and `agent()` should do, and which MCP tools
to publish.

It is deliberately **not** a Fleet CLI workflow. Nothing here is meant to be registered
with `apra-fleet workflow …`. The entry point is an ordinary exported async function:

```js
import { runDemo } from './workflows/demo/main.mjs';

await runDemo();                      // live — connects, acquires a worker, runs
await runDemo({ fleetApi });          // tests — inject a mock client; builds its own pool
await runDemo({ fleetApi, pool });    // MCP / scheduler — share one process-wide pool
```

That single design choice drives most of what follows: because the workflow is a plain
function taking an injectable client (and an optional pool), it can be called from a
web server, from a test, from a scheduled runner, or from another workflow, and it can
be tested without a Fleet server or an API token.

## Fleet concepts you need first

If you have never used Fleet, these five terms explain almost everything in this repo.

**Fleet server.** A long-running process you start yourself with `apra-fleet start`. It
owns the member registry and the credential store, and it is what actually spawns LLM
CLIs. This repo never starts it for you outside Docker — it expects it to already be
running and fails loudly with instructions when it isn't.

**MCP.** The Model Context Protocol is used on both sides of this process. On top, this
repo is an MCP **server**: it exposes each entry in `mcp/registry.mjs` as a tool for
Claude Code. Underneath, it is an MCP **client** to Fleet, whose tools include
`registerMember`, `fleetStatus`, `listMembers`, `executeCommand`, and `executePrompt`.
Every Fleet operation ultimately becomes one MCP tool call, and each result returns in
MCP's envelope shape (`content[]` / `structuredContent`), which is why text extraction
is a shared helper rather than inline property access.

**Member.** A named agent workspace registered with the server: a name, a type
(`local` or `remote`), an LLM (`claude`), and a working folder on disk. Fleet runs
commands and prompts *as* a member, inside that member's folder. This repo registers
`WORKER_POOL_SIZE` (default 4) pairs: `WORKER-{i}-DOER` and `WORKER-{i}-REVIEWER`.
Workflow bodies never name them — they use the reserved role keywords `'doer'` and
`'reviewer'`, which the pool resolves to the members assigned to that run. See
[the concurrency spec](specs/concurrency-spec.md).

**Work folder.** The directory a member operates in. Each member needs its **own**
folder — two local members sharing a `cwd` collide. Hence `workdir/worker-{i}/doer/`
and `workdir/worker-{i}/reviewer/`. Locks live in `workdir/.locks/` *outside* the
folders they protect, so cleanup can wipe a work folder without a lock-file carve-out.
Fleet may drop a `.claude/settings.local.json` into a work folder at registration
time; that is local machine state, is gitignored, and is the one entry cleanup
preserves.

**Credential store.** Where OAuth tokens live, attached to a specific member via
`apra-fleet auth --oauth --member …`. This matters more than it looks: the Claude
process is spawned by the *Fleet server*, not by your Node process, so exporting
`CLAUDE_CODE_OAUTH_TOKEN` in your shell does **not** reach `agent()`. The token has to
be in Fleet's store on that member. Nearly every "works interactively, fails
unattended" problem traces back to this. Provisioning attaches the token to *every*
role on every worker, so a workflow author may target either role with `agent()`.

## The layers

```text
┌─────────────────────────────────────────────────────────────┐
│  Your Node process                                          │
│                                                             │
│   mcp/             POST /mcp — MCP server front door         │
│     │              one tool per registry entry               │
│     │              one WorkerPool built at process startup   │
│     │ entry.run({ fleetApi, pool, args, signal, reportPhase })│
│     ▼                                                       │
│   workflows/       launcher acquires a lease, wraps fleetApi │
│     │              body uses 'doer' / 'reviewer' keywords    │
│     ▼                                                       │
│   pool/            roster, file locks, cleanup, leases       │
└─────┼───────────────────────────────────────────────────────┘
      │ connectFleet() — MCP over HTTP
      ▼
┌─────────────────────────────────────────────────────────────┐
│  Fleet server        http://127.0.0.1:7523/mcp              │
│                                                             │
│   WORKER-1-DOER / WORKER-1-REVIEWER   …   WORKER-N-*        │
│   workdir/worker-1/doer|reviewer/     …   workdir/worker-N/ │
│   Claude Code + OAuth on every role                         │
└─────────────────────────────────────────────────────────────┘
```

The dependency arrow points one way only: `mcp/` → `workflows/` → `pool/`. Nothing
under `pool/` imports from `workflows/` or `mcp/`. A non-MCP caller — a CLI run, a
scheduled runner — uses the pool without touching MCP code. MCP is a stateless front
door over the workflow layer; the pool is the shared capacity layer under it.

## Module map

### `pool/`

The concurrency substrate. Every process that runs a workflow builds a `WorkerPool`
against the same `workdir/` and the same lock files, so MCP and a future scheduled
runner share one set of workers rather than partitioning them.

| File | Responsibility |
|---|---|
| `roster.mjs` | Names and folders for worker `i`; `poolConfig()` from `WORKER_POOL_*` env. |
| `worker-lock.mjs` | `proper-lockfile` wrapper: non-blocking claim, stale steal, holder metadata. |
| `cleanup.mjs` | Wipe a worker folder's contents, preserving `.claude/`. |
| `worker-pool.mjs` | Roster verification, acquire/release, FIFO queue, heartbeats, leases. |
| `pooled-fleet-api.mjs` | `member_name` remapping wrapper around a `fleetApi`. |
| `fleet-text.mjs` | Token-exact member matching against `listMembers()` output. |

A run **acquires a whole pair** (doer + reviewer), holds it for its duration, and
releases it. Free workers are taken immediately; otherwise the caller waits in a FIFO
queue. See [the concurrency spec](specs/concurrency-spec.md) for the full design.

### `workflows/demo/`

| File | Responsibility |
|---|---|
| `main.mjs` | The launcher. Connects to Fleet, acquires a pooled worker, runs the engine, releases the lease, cleans up the transport. Exports `runDemo()`; self-executes when run directly. |
| `demo.js` | The workflow body. Receives an engine `context` and does the actual work. Contains no connection logic and names no members. |
| `dummy.py` | Stand-in for real Python work. Prints `hello-from-python`. |
| `ensure-apralabs.mjs` | Symlinks `node_modules/@apralabs` to the Fleet install so the packages resolve. |
| `workflow.json` | Metadata only. Not consumed by anything in this repo. |

The **launcher / body split** is the most important convention here. `main.mjs` owns
everything environmental — transport selection, `connectFleet()`, pool acquire/release,
error framing, cleanup in a `finally` — while `demo.js` only knows how to do the work,
given a context. Keep that separation when you add workflows: it is what makes the
body testable and the launcher reusable. Swap `demo.js` for your project's body;
leave the launcher, the pool, and the MCP front door alone.

`demo.js` runs four phases, each demonstrating a primitive you would reuse:

1. **status** — `fleetStatus()`, a cheap connectivity check.
2. **command** — `python3 dummy.py` on `'doer'`. Costs no LLM tokens.
3. **transform** — a pure local JS step, no Fleet involvement at all.
4. **agent** — `Reply with exactly: pong` on `'doer'`. This is the step that spends
   tokens and needs the OAuth token to be in the credential store.

Registration is **not** a workflow concern. `scripts/provision-members.sh` creates
folders, registers all 2N members, and attaches OAuth. The pool verifies that roster
at startup with `listMembers()` and refuses to start if anything is missing.

`command()` passes `failSoft: true`, so a machine without `python3` still completes the
run. A throwing `transform()` or `agent()` does fail the run, and the process exits 1.

The body also receives `args.workspace` (`workerId`, `doer`/`reviewer` `{ name, folder }`)
for workflows that need the assigned folders. `demo.js` only logs it.

### `workflows/inspect-members/`

Observational only. It reads folder contents through Node's `fs` and busy/free from
the lock files. It never executes a command *as* a member, so inspecting a worker some
run is holding cannot collide with that run.

### `mcp/`

| File | Responsibility |
|---|---|
| `main.mjs` | Server launcher. Connects to Fleet, builds one `WorkerPool` at startup, listens on loopback, and wires SIGINT/SIGTERM shutdown. |
| `server.mjs` | Builds the MCP server and registers one tool for each registry entry. Converts returned values to tool results and emits progress when requested. Passes the process-wide `pool` into every `run`. |
| `http.mjs` | Creates the Express app. Provides `GET /health` and a stateless `POST /mcp` with a fresh MCP server and transport per request. |
| `registry.mjs` | The tool catalog and workflow adapters: `{ name, description, inputSchema?, annotations?, run }`. |
| `auth.mjs` | Pass-through auth stub. Replace by injection, not by editing. |
| `fleet-text.mjs` | Pulls plain text out of Fleet MCP tool results. |

Full interface reference lives in [mcp-interface.md](mcp-interface.md).

## Data flow

### A workflow run

```text
runDemo({ fleetApi?, pool?, signal, reportPhase })
  ├─ default APRA_FLEET_TRANSPORT to 'http'
  ├─ ensureApralabs()                       symlink @apralabs packages
  ├─ connectFleet({ env })                  → { fleetApi, transport }   (skipped if injected)
  ├─ WorkerPool.create()                    (skipped if a pool is injected)
  ├─ pool.acquire({ signal, reportPhase })  → Lease { workerId, doer, reviewer, signal }
  ├─ createPooledFleetApi(api, lease)       remaps 'doer'/'reviewer'
  ├─ engine.executeFile('demo.js', { fleetApi: wrapped, workspace: lease, … })
  │    status → command → transform → agent
  └─ finally: lease.release(); ownPool?.close(); transport?.stop()
```

The `finally` matters. Without releasing the lease the worker stays busy. Without
stopping the transport the HTTP client keeps the event loop alive and the process
prints its result but never returns to the shell.

### An MCP tool call

```text
Claude Code chooses a tool from tools/list
  └─ POST /mcp tools/call
       ├─ authenticate
       ├─ create a fresh MCP server + HTTP transport
       ├─ validate args with the entry's inputSchema, when present
       ├─ entry.run({ fleetApi, pool, args, signal, reportPhase })
       │    ├─ acquire a worker (or queue with heartbeats)
       │    ├─ phase()/log() output             → server terminal
       │    └─ reportPhase(), if progressToken  → heartbeat to Claude
       ├─ return one final MCP tool result      → Claude
       └─ close the per-request MCP server; the process-wide pool stays
```

Each tool call has one request and one final response. Progress notifications are
heartbeats only: workflow terminal output is not streamed into the model's context.
The MCP HTTP layer keeps no session state between calls. The **pool** does: it is
built once at process startup and shared by every in-flight tool call.

## Design decisions worth knowing

**Transport is forced to `http`.** Both launchers set `APRA_FLEET_TRANSPORT=http` when
it is unset. Left unset, the client falls back to spawning Fleet over stdio, which
cannot find the npm-global server layout and — worse — would not see the members you
provisioned against the long-running server. The failure is confusing, so the default is
pinned. An explicitly set value is respected.

**`@apralabs` packages resolve through a symlink.** The root `package.json` deliberately
does not depend on any `@apralabs/*` package; Fleet is a machine install, not a project
dependency. `ensureApralabs()` links `node_modules/@apralabs` to whichever location
actually contains the packages: first `~/.apra-fleet/node_modules/@apralabs`, then the
npm global prefix (where `npm install -g @apralabs/apra-fleet` lands). It verifies the
link target with `realpathSync` and relinks when stale, which is what fixes the
`Cannot find package 'undici'` symptom. It uses `'junction'` so Windows does not require
admin rights; POSIX ignores the argument.

**`fleetApi` is injected, never imported.** Both launchers accept a client and only
connect when one isn't supplied. This is what makes the mock tests possible — they run
with no server, no members, and no token, and still assert real behavior like "the
workflow registers nothing" and "role keywords remap to this run's worker".

**There is no internal router.** The model connected over MCP already sees the tool
names, descriptions, and schemas and decides which one to call. Adding another LLM
classification call inside this process would duplicate that routing, add latency, and
spend tokens unnecessarily. Tool descriptions are therefore part of the interface.

**Slow workflows use heartbeat plus client configuration.** The SDK does not implement
MCP Tasks, so long-running calls remain one request/response. When the client supplies a
progress token, phase reports provide a heartbeat; a sufficiently large `timeout` in
the client's `.mcp.json` is the reliable control for slow calls. A queued acquire also
heartbeats immediately and then every 30s so the call survives the 60s first-byte timer
and the 5-minute idle timer while waiting for a worker.

**Auth is replaced by injection.** `createMcpHttpApp({ authenticate })` takes
middleware. Routes depend only on `req.user`, so real auth drops in without editing
`auth.mjs`.

### Concurrency

Two concurrent operations on the same Fleet member share that folder and that CLI
session, so they corrupt each other. The pool is the mechanism that makes concurrent
calls safe:

- **One lease per run.** A run holds a doer *and* a reviewer for its whole duration.
  They communicate through returned values and prompts, not a shared folder.
- **Two processes, one capacity.** The MCP server and a scheduled runner each build
  their own pool object, but both draw from one shared set of workers via file locks
  under `workdir/.locks/`. An idle scheduler does not hold a worker away from MCP.
- **In-process vs cross-process.** Within a process, a FIFO queue, cancellation, and
  instant handoff. Across processes, waiting degrades to polling. You pay for polling
  only in the rarer cross-process case.
- **Cleanup on acquire and on release.** Acquire is load-bearing: a crashed holder's
  lock goes stale and is stolen, but its files remain. Release is hygiene.
- **Fail-fast roster verification.** The pool calls `listMembers()` once at
  construction and refuses to start if a worker is missing, naming
  `scripts/provision-members.sh`. It never calls `registerMember`. A pool that
  self-healed registration but not OAuth would start cleanly and then fail inside
  `agent()` with an unrelated-looking error.
- **Presence uses `listMembers()`, never `fleetStatus()`.** `fleetStatus()` reports
  server info, not the member roster. Matching is token-exact: `WORKER-1-DOER` is a
  substring of `WORKER-11-DOER`.

Full rationale is in [the concurrency spec](specs/concurrency-spec.md).

## Where state lives

| State | Location | Lifetime |
|---|---|---|
| Member registry | Fleet server | Survives restarts of your process. |
| OAuth tokens | Fleet credential store, per member | Until the token expires. |
| Member scratch space | `workdir/worker-{i}/{doer,reviewer}/` | On disk; wiped on acquire and release; `.claude/` is preserved and gitignored. |
| Worker leases | `workdir/.locks/worker-{i}` | Held for one run; stolen if the heartbeat goes stale. |
| In-process queue | `WorkerPool` instance | Lives for the process; MCP builds one at startup. |

The MCP HTTP layer holds no session state: every HTTP request gets a fresh MCP server
and transport. The pool is the exception, on purpose.

## Extension points

This kit is meant to be cloned per project. Infrastructure stays; only the work
changes.

| You want to | Do this |
|---|---|
| Real Python work | Replace `dummy.py`, keep the `command()` call and `member_name: 'doer'` |
| Real LLM work | Change the `agent()` prompt, keep `member_name: 'doer'` or `'reviewer'` |
| A second agent in the same run | Dispatch `agent({ member_name: 'reviewer' })` — that run already holds both |
| A new workflow | Copy `workflows/demo/`'s launcher/body split, address members by role, append one registry entry |
| A new MCP tool | Append its entry to `mcp/registry.mjs` — no server or HTTP changes |
| More (or fewer) parallel runs | Set `WORKER_POOL_SIZE` and re-run `scripts/provision-members.sh` |
| Real authentication | Pass middleware to `createMcpHttpApp({ authenticate })` |

You do **not** invent member names, work folders, or locking. The pool owns those.
Workflow authors pass `'doer'` / `'reviewer'` and, when they need paths, read
`args.workspace`.

Two things to avoid: do not pass OAuth tokens into `agent()` payloads (they belong in
Fleet's credential store), and do not clone `apra-fleet` into this repo — the symlink
resolution exists precisely so you don't have to.
