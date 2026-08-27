# MCP server design

Status: approved, ready for implementation planning
Date: 2026-08-27
Branch: `feat/mcp`

## Goal

A Claude session connects to this repo over MCP, sees the workflows this repo provides as
tools, calls one, and gets the answer back. You start the server yourself; Claude attaches
to it over HTTP.

Today the repo is purely an MCP **client**: `workflows/` calls the Fleet server's MCP tools,
and `chat/` sits above it as an HTTP front door with an LLM router. This work replaces the
`chat/` layer with an MCP **server** layer, so the process speaks MCP in both directions —
server on top, client to Fleet underneath.

## Decisions

| Decision | Choice | Reasoning |
|---|---|---|
| Tool surface | One MCP tool per registry entry | The connected Claude is already an orchestrator; it selects tools itself. An internal LLM router would add a classification call per message and pick blind. |
| Fate of `chat/` | Replaced, not kept alongside | One front door to maintain, and the docs stay honest. HTTP/`curl` access is lost deliberately. |
| Transport | Streamable HTTP | The only transport that works once this is hosted on a VM or in Docker; stdio requires the server to be a locally spawned child process. |
| Exposed capabilities | Registry workflows only | No `ask_member` and no `run_command`. A nested LLM duplicates the orchestrator, and arbitrary command execution is an unacceptable surface for a hosted server. |
| Tool arguments | Optional per-entry `inputSchema` | `boilerplate` needs none; real workflows need typed parameters. The extension point is what this boilerplate exists to teach. |
| Second example workflow | `inspect-members` | Demonstrates typed parameters, fan-out across members, and structured output — the three things no existing code shows. Also gives `BOILERPLATE-REVIEWER` a job. |
| HTTP session mode | Stateless | No per-request state is held, so a fresh server and transport per request is simpler, shares nothing between concurrent calls, and leaves room to scale out later. |
| Chat sessions | Deleted | Claude owns the conversation. Removes the in-memory `Map`, the 20-message cap, and the repo's only scaling constraint. |
| Cancellation | Honored, cooperatively between phases | A cancelled or disconnected call otherwise keeps spending real tokens on `agent()` while the SDK discards the result. |
| Tool annotations | Declared per entry | `readOnlyHint` lets a host auto-approve `inspect-members` and prompt before the side-effecting `boilerplate`. |
| Progress notifications | Deferred | Whether Claude Code sends a `progressToken` and renders the messages is the client's choice, not ours. Ship without it, then decide with evidence. |

Explicitly out of scope: a member that authors new workflows on demand, MCP progress
notifications, `outputSchema` / `structuredContent`, Fleet reconnection, and real
authentication. Concurrency and scaling are deferred.

MCP's logging channel is **not** an option for streaming workflow output: it is deprecated as
of protocol version 2026-07-28 (SEP-2577). Progress notifications are the sanctioned path if
we later want workflow phases visible inside the Claude session.

## Architecture

```text
Claude session  (the orchestrator — an MCP client)
  │  streamable HTTP → POST /mcp
  ▼
mcp/          this process as MCP SERVER — one tool per registry entry
  │
  ▼
workflows/    runBoilerplate(), runInspectMembers()
  │  MCP over HTTP (client role, unchanged)
  ▼
Fleet server  127.0.0.1:7523/mcp — members, credentials, spawns the LLM CLI
```

The existing one-way dependency rule carries over: `mcp/` imports from `workflows/`, and
nothing under `workflows/` imports from `mcp/`. Delete `mcp/` and the workflow layer still
stands alone.

### New modules

| File | Responsibility |
|---|---|
| `mcp/server.mjs` | `buildMcpServer({ fleetApi, registry })` → an `McpServer` with one tool per registry entry. Knows nothing about HTTP. |
| `mcp/http.mjs` | `createMcpHttpApp({ buildServer, authenticate })` → express app serving `POST /mcp` and `GET /health`. Knows nothing about workflows. |
| `mcp/main.mjs` | `startMcpServer({ fleetApi, port })`. Pins `APRA_FLEET_TRANSPORT=http`, calls `ensureApralabs()`, connects unless `fleetApi` is injected, listens, wires SIGINT/SIGTERM shutdown. Mirrors today's `chat/main.mjs`. |
| `mcp/registry.mjs` | Moved from `chat/registry.mjs`. Entries gain an optional `inputSchema`. |
| `mcp/fleet-text.mjs` | Moved unchanged from `chat/fleet-text.mjs`. |
| `mcp/auth.mjs` | Moved unchanged from `chat/auth.mjs`. Still a pass-through stub, still replaced by injection. |

### Deletions

`chat/app.mjs`, `chat/router.mjs`, `chat/main.mjs`, the now-empty `chat/` directory,
`tests/chat.test.mjs`, and `docs/chat-interface.md`.

### Dependencies

`@modelcontextprotocol/sdk@1.x` is the legacy v1 line. The SDK split into separate packages
at v2.0.0, implementing the 2026-07-28 MCP spec, and v2 is the stable release line. Build
against v2.

Added to `package.json` dependencies:

- `@modelcontextprotocol/server` `^2.0.0`
- `@modelcontextprotocol/node` `^2.0.0` — the `IncomingMessage`/`ServerResponse` streamable HTTP transport
- `@modelcontextprotocol/express` `^2.0.0` — app defaults plus Host header validation
- `zod` `^4.4.3` — a **peer** dependency of the SDK, so it must be declared explicitly

Added as a dev/test dependency:

- `@modelcontextprotocol/client` `^2.0.0`

`express` stays. The MCP express adapter depends on `express@^5.2.1`, which the existing
`^5.1.0` range already permits, so no version change is needed unless a lockfile pins lower.

These are genuine project dependencies, like express. The repo's "machine install, not a
project dependency" rule applies only to `@apralabs/*` and is unchanged: those still resolve
at runtime through the `ensureApralabs()` symlink, and no `@apralabs/*` package is ever added
to `package.json`.

### HTTP wiring

Stateless mode: a fresh transport **and** a fresh `McpServer` per request. `createMcpHttpApp`
therefore takes `buildServer` as a factory rather than a prebuilt server instance, so no
server state is ever shared between concurrent requests.

```js
app.post('/mcp', authenticate, async (req, res) => {
  const server = buildServer();
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

The app is built with `createMcpExpressApp()`, which enables Host header validation (DNS
rebinding protection) for localhost by default. The listener binds `127.0.0.1` by default and
reads `PORT`, defaulting to 3000 — same convention as the current chat server.

One detail to confirm during implementation: `handleRequest` is passed `req.body`, so JSON
body parsing must be active. If `createMcpExpressApp()` does not install `express.json()`
itself, add it explicitly.

## Registry contract

`message` and `history` are gone, because Claude owns the conversation. `args` replaces them.

```js
{
  name: 'inspect-members',                 // becomes the MCP tool name; must be unique
  description: '...',                      // Claude reads this to decide when to call it
  inputSchema: z.object({ /* … */ }),      // omit entirely to mean "no arguments"
  annotations: { readOnlyHint: true },     // behavior hints for the host
  async run({ fleetApi, args, signal }) { /* → string or object */ },
}
```

- `inputSchema` is a full `z.object(...)` schema, not a bare shape. The SDK derives the JSON
  Schema Claude sees, validates arguments, and types the handler from that one declaration.
- `args` is the tool input **after** validation. It is `{}` for entries that declare no schema.
- `signal` is the request's `AbortSignal`, forwarded from `ctx.mcpReq.signal`. Workflows check
  it between phases (see Cancellation).
- `annotations` are hints the host may act on — `readOnlyHint`, `destructiveHint`,
  `idempotentHint`. They never change how the SDK runs the tool.
- A returned string becomes the tool's text content. A returned object is JSON-serialized
  into text content.
- A throwing `run` becomes an `isError` tool result (see Error handling).
- `description` is written for a model choosing a tool, not as a human changelog entry.

## Workflows

### `boilerplate` (existing, minimally changed)

No `inputSchema`, so the tool takes no arguments. `run({ fleetApi, signal })` calls
`runBoilerplate({ fleetApi, signal })` and returns its result. Annotations declare
`readOnlyHint: false` and `idempotentHint: true` — it registers members and spends tokens, but
re-running it is safe because registration is idempotent.

The only body change is a cancellation check between phases. The five phases and the
launcher/body split are otherwise untouched.

### `inspect-members` (new)

New folder `workflows/inspect-members/`, following the existing convention: `main.mjs`
(launcher), `inspect-members.js` (body), `inspect.py`, `workflow.json`.

Input schema, both parameters optional:

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `members` | array of strings | `['BOILERPLATE-DOER', 'BOILERPLATE-REVIEWER']` | Which members to inspect. |
| `includeFiles` | boolean | `false` | Include a listing of top-level entries per work folder. |

The default is the two names this repo owns, held as constants in the workflow body the same
way `boilerplate.js` holds them — **not** every member returned by `fleetStatus()`. A shared
Fleet server may host other projects' members, and reporting on those would be both
surprising and an information leak.

Body flow:

1. Call `fleetStatus()` and determine which members are present.
2. Resolve the target list from `members`, defaulting to `BOILERPLATE-DOER` and
   `BOILERPLATE-REVIEWER`.
3. For each target, run `python3 inspect.py --root <that member's workdir>` (plus `--files`
   when `includeFiles` is true) via `command()` on that member, with `failSoft: true`.
4. Aggregate per-member JSON into one report: `{ generatedAt, members: [{ name, present, report | error }] }`.

Annotations declare `readOnlyHint: true` and `idempotentHint: true`, so a host may auto-approve
it.

Three deliberate properties:

- **Read-only.** It never registers or mutates anything, so `boilerplate` remains the only
  workflow with side effects and Claude can call this one freely.
- **Degrades instead of failing.** An unregistered member comes back as `present: false`
  rather than throwing. Because `python3` is optional on this repo's machines, the
  `command()` call keeps `failSoft: true` and a failure is recorded as a per-member `error`
  instead of sinking the whole report.
- **Zero LLM tokens.** No `agent()` call, so it is cheap to call repeatedly and cheap to test
  against a live Fleet.

`inspect.py` is stdlib-only and takes `--root` explicitly rather than relying on the member's
working directory, so it can be run standalone as a smoke test the way the README already
suggests for `dummy.py`. It reports the work folder path, whether it exists, a file count,
total bytes, and — when `--files` is passed — a listing of top-level entries.

## How a call starts, reports, and finishes

A tool call is a **single request/response pair**, so by default Claude gets no signal that
work is underway — it simply awaits the result.

```text
Claude ──tools/call (one HTTP POST, held open)──▶ mcp/http.mjs
                                                   buildServer() → handler
                                                   registry.run({ fleetApi, args, signal })
                                                   → runInspectMembers(...) → Fleet
Claude ◀──── CallToolResult on that same POST ────  { content: [{ type: 'text', … }] }
```

The workflow's return value travels back the way it came: the body returns, `executeFile`
resolves, `run` produces a string or object, `mcp/server.mjs` wraps it in a text content
block, and the SDK writes it as the JSON-RPC result on the still-open POST. Claude reads that
text as the tool result and continues its turn. There is no polling and no callback.

One asymmetry to document for users: `phase()` and `log()` output goes to the terminal running
`npm run mcp`, so the operator sees live progress while Claude sees nothing until the call
returns.

### Cancellation

`ctx.mcpReq.signal` aborts when Claude cancels the call or the connection drops, and the SDK
discards whatever a cancelled handler eventually returns. Without handling it, a cancelled
`boilerplate` run keeps spending real tokens on `agent()` for a result nobody will read.

The signal is forwarded from the tool handler into `run({ signal })`, then into the launcher
as `runBoilerplate({ fleetApi, signal })` / `runInspectMembers({ fleetApi, signal, … })`, and
reaches the body through the engine's `args`. Bodies check `signal?.aborted` **between
phases** and return early with what they have.

This is deliberately **cooperative and coarse-grained**. An in-flight Fleet MCP call cannot be
aborted mid-flight, so cancelling does not kill the current step — it prevents the *next* one
from starting. For `boilerplate` that is still the thing that matters, because it stops the
`agent()` phase from ever beginning.

## Error handling

MCP separates protocol failures from tool failures, and this design uses that split.

| Situation | Behavior |
|---|---|
| Workflow `run` throws | Caught in `mcp/server.mjs`, returned as a tool result flagged `isError` with the message text. The connection survives and Claude can react. Replaces today's 502 mapping. |
| Fleet returns `structuredContent.isError` | Surfaced the same way, so cases like `OAuth session expired` reach Claude as readable text. |
| Invalid tool arguments | Rejected by the SDK against `inputSchema` before `run` is called. Replaces the hand-rolled validation in the chat route. |
| Fleet not running at startup | `connectFleet()` fails loudly with the existing `apra-fleet start` hint; the process exits 1. Unchanged from today's launchers. |
| Fleet dies after startup | Tool calls return `isError` until the server is restarted. No reconnection. Documented limitation, not a regression — the chat layer behaves the same way today. |
| Long-running tool call | `boilerplate` makes a real LLM call and can outlast a client-side timeout. Documented limitation; progress notifications are the eventual fix. Cancellation at least stops the next phase from starting. |
| Client cancels or disconnects | The abort signal reaches the workflow body, which stops at its next phase boundary. The SDK sends no response for a cancelled request. |

Returning tool failures in-band rather than as protocol errors is the key choice: Claude sees
the failure text and can retry, report, or choose another tool, where a protocol error would
break the connection.

## Security

- `createMcpExpressApp()` enables Host header validation against DNS rebinding by default.
- The listener binds `127.0.0.1` by default. Hosting on a VM or in Docker requires an explicit
  bind address **and** authentication.
- `mcp/auth.mjs` stays a pass-through stub, replaced by injection via
  `createMcpHttpApp({ authenticate })`, exactly as the chat layer worked.
- The documented upgrade path for hosting is `requireBearerAuth` from
  `@modelcontextprotocol/express`, paired with
  `claude mcp add --header "Authorization: Bearer …"`. Not built now.
- No secrets move into this layer. OAuth tokens stay in Fleet's credential store, attached to
  a member.

## Testing

The repo's mock-versus-live split is preserved. `tests/setup-fleet-modules.mjs` must be
imported first in any new test file that pulls in a launcher.

**`tests/mcp.test.mjs`** (mock — no Fleet server, no tokens). Starts the app on an ephemeral
port with a mock `fleetApi` and drives it with a real `@modelcontextprotocol/client`.
Asserts:

- the tool list is exactly `boilerplate` and `inspect-members`;
- `inspect-members` advertises both parameters and `boilerplate` advertises none;
- `inspect-members` advertises `readOnlyHint: true` and `boilerplate` does not;
- calling `boilerplate` reaches `runBoilerplate`;
- calling `inspect-members` with `{ members: ['BOILERPLATE-DOER'] }` touches only that member;
- a throwing workflow yields an `isError` result carrying the message, **and a subsequent call
  still succeeds**;
- invalid arguments are rejected before `run` executes;
- an unknown tool name fails cleanly;
- aborting the call from the client stops the workflow at its next phase boundary — asserted
  by a mock `fleetApi` that aborts partway and then verifying no further Fleet calls were made.

Driving this over a real port rather than an in-memory transport is deliberate: it exercises
`createMcpExpressApp` and the per-request transport wiring, which is where subtle bugs live.

**`tests/inspect-members.test.mjs`** (mock). Covers the workflow body in isolation: default
targets are both members, an absent member reports `present: false`, `includeFiles` reaches
the command, and a `failSoft` command failure produces a per-member `error` rather than a
throw.

**`tests/mcp.live.test.mjs`** (live — real Fleet, real members). Calls `inspect-members` end
to end. Cheap because it spends no tokens. Complements the existing
`tests/boilerplate.live.test.mjs`, which is unchanged.

**Standalone smoke:** `python3 workflows/inspect-members/inspect.py --root workdir/BOILERPLATE-DOER`.

`package.json` scripts: `test` drops `tests/chat.test.mjs` and adds the two new mock test
files; `chat` is replaced by `mcp` running `node mcp/main.mjs`.

## Documentation

Four documents describe the chat layer and go stale with this change.

| Document | Change |
|---|---|
| `docs/chat-interface.md` | Deleted, replaced by `docs/mcp-interface.md`: tool catalog, registry contract, `claude mcp add` setup, adding a workflow, replacing the auth stub, hosting notes, troubleshooting. Must also explain that a tool call is a single request/response with no progress signal, that workflow logs appear in the server's terminal rather than in the Claude session, and how cancellation behaves. |
| `README.md` | Replace the "Chat interface" section with an MCP section. Update the layer diagram, the layout tree, the npm scripts, and the claim that `BOILERPLATE-REVIEWER` is idle. |
| `docs/architecture.md` | Update the layer diagram, module map, data flow (a tool call replaces a chat request), the "where state lives" table (the sessions row goes), and the extension points table. **Most important fix:** the MCP concepts section currently states "This repo is purely an MCP **client**; there is no MCP server code here," which becomes false. |
| `docs/development.md` | Update the run table, the testing section, and the "Adding a workflow" walkthrough, which currently instructs readers to append to `chat/registry.mjs` with a `run({ fleetApi, message, history })` signature. |

## Setup, end to end

```bash
# once
npm install
cd ~/.apra-fleet/bin && apra-fleet start          # leave running
./scripts/provision-members.sh                    # members + OAuth on the doer

# start this server, leave it running
npm run mcp                                       # http://127.0.0.1:3000/mcp

# register it with Claude once
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

A Claude session then sees two tools and can run either.

## Success criteria

1. `npm test` passes with no Fleet server and no tokens.
2. `npm run mcp` starts, connects to a running Fleet, and serves `GET /health`.
3. `claude mcp add --transport http fleet http://127.0.0.1:3000/mcp` connects, and a Claude
   session lists both tools.
4. Asking that session to check the fleet calls `inspect-members` and returns a report
   naming both members, with no LLM tokens spent inside this repo.
5. Asking it to run the demo calls `boilerplate` and returns the `pong` result.
6. A workflow failure reaches Claude as readable error text and the server keeps serving.
7. Cancelling a `boilerplate` call prevents the `agent()` phase from starting, so no tokens are
   spent on a result nobody reads.
8. No file under `workflows/` imports from `mcp/`.
9. No `chat/` directory remains, and no doc references `POST /chat`.
