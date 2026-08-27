# Architecture

How this repo is put together and why. Read this before changing code. If you just want
to get something running, start with the [README](../README.md); if you are about to add
a workflow or a test, continue to the [development guide](development.md).

## What this repo is

A starter for driving [Apra Fleet](https://github.com/Apra-Labs/apra-fleet) **from your
own Node process**. You clone it, keep the shape, and replace the dummy body with real
work.

It is deliberately **not** a Fleet CLI workflow. Nothing here is meant to be registered
with `apra-fleet workflow …`. The entry point is an ordinary exported async function:

```js
import { runBoilerplate } from './workflows/boilerplate/main.mjs';

await runBoilerplate();               // live — connects to a running Fleet server
await runBoilerplate({ fleetApi });   // tests — inject a mock client
```

That single design choice drives most of what follows: because the workflow is a plain
function taking an injectable client, it can be called from a web server, from a test,
or from another workflow, and it can be tested without a Fleet server or an API token.

## Fleet concepts you need first

If you have never used Fleet, these five terms explain almost everything in this repo.

**Fleet server.** A long-running process you start yourself with `apra-fleet start`. It
owns the member registry and the credential store, and it is what actually spawns LLM
CLIs. This repo never starts it for you outside Docker — it expects it to already be
running and fails loudly with instructions when it isn't.

**MCP.** The Model Context Protocol is used on both sides of this process. On top, this
repo is an MCP **server**: it exposes each entry in `mcp/registry.mjs` as a tool for
Claude Code. Underneath, it is an MCP **client** to Fleet, whose tools include
`registerMember`, `fleetStatus`, `executeCommand`, and `executePrompt`. Every Fleet
operation ultimately becomes one MCP tool call, and each result returns in MCP's
envelope shape (`content[]` / `structuredContent`), which is why text extraction is a
shared helper rather than inline property access.

**Member.** A named agent workspace registered with the server: a name, a type
(`local` or `remote`), an LLM (`claude`), and a working folder on disk. Fleet runs
commands and prompts *as* a member, inside that member's folder. This repo registers
two: `BOILERPLATE-DOER` and `BOILERPLATE-REVIEWER`.

**Work folder.** The directory a member operates in. Each member needs its **own**
folder — two local members sharing a `cwd` collide. Hence `workdir/BOILERPLATE-DOER/`
and `workdir/BOILERPLATE-REVIEWER/`, each holding only a `.gitkeep`. Fleet may drop a
`.claude/settings.local.json` into them at registration time; that is local machine
state and is gitignored.

**Credential store.** Where OAuth tokens live, attached to a specific member via
`apra-fleet auth --oauth --member …`. This matters more than it looks: the Claude
process is spawned by the *Fleet server*, not by your Node process, so exporting
`CLAUDE_CODE_OAUTH_TOKEN` in your shell does **not** reach `agent()`. The token has to
be in Fleet's store on that member. Nearly every "works interactively, fails
unattended" problem traces back to this.

## The layers

```text
┌─────────────────────────────────────────────────────────────┐
│  Your Node process                                          │
│                                                             │
│   mcp/             POST /mcp — MCP server front door         │
│     │              one tool per registry entry               │
│     │ entry.run({ fleetApi, args, signal, reportPhase })     │
│     ▼                                                       │
│   workflows/       runBoilerplate() — connect + execute      │
│     │              inspect-members — read-only inspection    │
└─────┼───────────────────────────────────────────────────────┘
      │ connectFleet() — MCP over HTTP
      ▼
┌─────────────────────────────────────────────────────────────┐
│  Fleet server        http://127.0.0.1:7523/mcp              │
│                                                             │
│   BOILERPLATE-DOER              BOILERPLATE-REVIEWER        │
│   workdir/BOILERPLATE-DOER/     workdir/BOILERPLATE-REVIEWER/│
│   Claude Code + OAuth           registered, idle in the demo │
└─────────────────────────────────────────────────────────────┘
```

The dependency arrow points one way only: `mcp/` imports from `workflows/`, and nothing
under `workflows/` imports from `mcp/`. The workflow layer stands alone; MCP is a
stateless front door over it.

## Module map

### `workflows/boilerplate/`

| File | Responsibility |
|---|---|
| `main.mjs` | The launcher. Connects to Fleet, runs the engine, cleans up the transport. Exports `runBoilerplate()`; self-executes when run directly. |
| `boilerplate.js` | The workflow body. Receives an engine `context` and does the actual work. Contains no connection logic. |
| `dummy.py` | Stand-in for real Python work. Prints `hello-from-python`. |
| `ensure-apralabs.mjs` | Symlinks `node_modules/@apralabs` to the Fleet install so the packages resolve. |
| `workflow.json` | Metadata only. Not consumed by anything in this repo. |

The **launcher / body split** is the most important convention here. `main.mjs` owns
everything environmental — transport selection, `connectFleet()`, error framing, cleanup
in a `finally` — while `boilerplate.js` only knows how to do the work, given a context.
Keep that separation when you add workflows: it is what makes the body testable and the
launcher reusable.

`boilerplate.js` runs five phases, each demonstrating a primitive you would reuse:

1. **register** — `ensureMember()` for both members, idempotently.
2. **status** — `fleetStatus()`, confirming both members are present.
3. **command** — `python3 dummy.py` on the doer. Costs no LLM tokens.
4. **transform** — a pure local JS step, no Fleet involvement at all.
5. **agent** — `Reply with exactly: pong` on the doer. This is the step that spends
   tokens and needs the OAuth token to be in the credential store.

Registration is idempotent by design, because the workflow is expected to be re-run
constantly during development. `ensureMember()` checks `fleetStatus()` first, and if
`registerMember()` throws anyway it re-checks status before giving up — that second
check absorbs the race where something else registered the member in between.

`command()` passes `failSoft: true`, so a machine without `python3` still completes the
run. A throwing `transform()` or `agent()` does fail the run, and the process exits 1.

### `mcp/`

| File | Responsibility |
|---|---|
| `main.mjs` | Server launcher. Connects to Fleet, listens on loopback, and wires SIGINT/SIGTERM shutdown. |
| `server.mjs` | Builds the MCP server and registers one tool for each registry entry. Converts returned values to tool results and emits progress when requested. |
| `http.mjs` | Creates the Express app. Provides `GET /health` and a stateless `POST /mcp` with a fresh MCP server and transport per request. |
| `registry.mjs` | The tool catalog and workflow adapters: `{ name, description, inputSchema?, annotations?, run }`. |
| `auth.mjs` | Pass-through auth stub. Replace by injection, not by editing. |
| `fleet-text.mjs` | Pulls plain text out of Fleet MCP tool results. |

Full interface reference lives in [mcp-interface.md](mcp-interface.md).

## Data flow

### A workflow run

```text
runBoilerplate()
  ├─ default APRA_FLEET_TRANSPORT to 'http'
  ├─ ensureApralabs()                       symlink @apralabs packages
  ├─ connectFleet({ env })                  → { fleetApi, transport }   (skipped if injected)
  ├─ new WorkflowEngine(new FleetWorkflow(api))
  ├─ engine.executeFile('boilerplate.js', { fleetApi })
  │    register → status → command → transform → agent
  └─ finally: transport?.stop()
```

The `finally` matters. Without stopping the transport the HTTP client keeps the event
loop alive and the process prints its result but never returns to the shell.

### An MCP tool call

```text
Claude Code chooses a tool from tools/list
  └─ POST /mcp tools/call
       ├─ authenticate
       ├─ create a fresh MCP server + HTTP transport
       ├─ validate args with the entry's inputSchema, when present
       ├─ entry.run({ fleetApi, args, signal, reportPhase })
       │    ├─ phase()/log() output             → server terminal
       │    └─ reportPhase(), if progressToken  → heartbeat to Claude
       ├─ return one final MCP tool result      → Claude
       └─ close the per-request MCP server
```

Each tool call has one request and one final response. Progress notifications are
heartbeats only: workflow terminal output is not streamed into the model's context.
The MCP layer keeps no session state between calls.

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
with no server, no members, and no token, and still assert real behavior like "a re-run
does not re-register members".

**There is no internal router.** The model connected over MCP already sees the tool
names, descriptions, and schemas and decides which one to call. Adding another LLM
classification call inside this process would duplicate that routing, add latency, and
spend tokens unnecessarily. Tool descriptions are therefore part of the interface.

**Slow workflows use heartbeat plus client configuration.** The SDK does not implement
MCP Tasks, so long-running calls remain one request/response. When the client supplies a
progress token, phase reports provide a heartbeat; a sufficiently large `timeout` in
the client's `.mcp.json` is the reliable control for slow calls.

**Auth is replaced by injection.** `createMcpHttpApp({ authenticate })` takes
middleware. Routes depend only on `req.user`, so real auth drops in without editing
`auth.mjs`.

## Where state lives

| State | Location | Lifetime |
|---|---|---|
| Member registry | Fleet server | Survives restarts of your process. |
| OAuth tokens | Fleet credential store, per member | Until the token expires. |
| Member scratch space | `workdir/<MEMBER>/` | On disk; `.claude/` inside is gitignored local state. |

The MCP layer holds no state: every HTTP request gets a fresh MCP server and transport.

## Extension points

| You want to | Do this |
|---|---|
| Real Python work | Replace `dummy.py`, keep the `command()` call |
| Real LLM work | Change the `agent()` prompt, keep `member_name` |
| A second agent | Dispatch `agent({ member_name: 'BOILERPLATE-REVIEWER' })`; register and auth it the same way |
| Your own member names | Rename the constants in `boilerplate.js`, the `workdir/` folders, and `scripts/provision-members.sh` |
| A new MCP tool | Append its entry to `mcp/registry.mjs` — no server or HTTP changes |
| Real authentication | Pass middleware to `createMcpHttpApp({ authenticate })` |

Two things to avoid: do not pass OAuth tokens into `agent()` payloads (they belong in
Fleet's credential store), and do not clone `apra-fleet` into this repo — the symlink
resolution exists precisely so you don't have to.
