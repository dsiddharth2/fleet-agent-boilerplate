# Express /chat Interface — Design

**Date:** 2026-08-25 (revised same day: chat promoted above workflows, LLM router added)
**Branch:** `feature/chat-interface`
**Status:** Revised per feedback — chat sits ABOVE all workflows and routes questions to them

## Goal

Add a top-level Express chat layer to fleet-agent-boilerplate. `POST /chat` accepts a
user message and decides — via an LLM routing call to **BOILERPLATE-DOER** — which
registered workflow should handle it. If no workflow fits, DOER answers the question
directly. Conversations are multi-turn: the server keeps per-session history in memory,
keyed by `sessionId`. Authentication is a stub middleware that a real implementation
replaces later without touching routes.

The chat layer is NOT a workflow. It lives in `chat/` at the repo root, above
`workflows/`, and consumes workflows through a registry.

## Non-goals (YAGNI)

- No persistence (history is in-memory, lost on restart)
- No streaming responses
- No history/read endpoints
- No rate limiting
- No real authentication — only the injectable stub
- No dynamic workflow discovery — the registry is a hand-maintained module

## HTTP API

| Route | Auth | Request | Response |
|---|---|---|---|
| `POST /chat` | `authenticate` middleware | JSON `{ message: string, sessionId?: string }` | `200 { sessionId, reply, workflow }` |
| `POST /chat` (bad input) | — | `message` missing / not a non-empty string | `400 { error }` |
| `POST /chat` (fleet/workflow failure) | — | routing call, direct answer, or workflow run throws / returns `structuredContent.isError` | `502 { error }` |
| `GET /health` | none | — | `200 { ok: true }` |

- `workflow` in the response is the registry name that handled the message, or `"direct"`
  when DOER answered without a workflow.
- No `sessionId` in the request → server generates one (`crypto.randomUUID()`) and returns it.
- A supplied `sessionId` the server has never seen starts a new session under that id (lazy create, idempotent).

## Components

```text
chat/                 # top-level layer, ABOVE workflows/
  app.mjs             createChatApp({ fleetApi, registry?, authenticate?, memberName?, maxHistory? }) → Express app
  router.mjs          buildRoutePrompt(registry, message); routeQuestion({ fleetApi, registry, message, memberName? }) → registry entry | null
  registry.mjs        defaultRegistry: [{ name, description, run({ fleetApi, message, history }) → Promise<string> }]
  auth.mjs            authenticate(req, res, next) — stub: sets req.user = { id: 'anonymous' }, next()
  fleet-text.mjs      toolText(result) — shared reply/text extraction (same shape as boilerplate.js)
  main.mjs            launcher: APRA_FLEET_TRANSPORT=http, ensureApralabs(), connectFleet(), listen(PORT ?? 3000)
  package.json        { "type": "module" }
tests/
  chat.test.mjs       node:test + fetch against app.listen(0), mock fleetApi
docs/
  chat-interface.md   full reference: architecture, API, routing, extending the registry, replacing auth
package.json          NEW at repo root: { type: module, dependencies: { express } } — no @apralabs deps (README rule)
```

## Documentation deliverables

- `README.md` gains a "Chat interface" section (quick start + curl examples + pointer to the full doc).
- `docs/chat-interface.md` is the full reference: request flow diagram, endpoint table,
  routing behavior and its failure modes, how to register a new workflow, how to replace
  the auth stub, session semantics (in-memory, cap, restart loss), and troubleshooting.
- Both ship in the same task as the launcher so docs and behavior land together.

## Request flow

```text
POST /chat → authenticate → validate message
  → routeQuestion(): LLM call to DOER with registry names+descriptions,
       must reply with exactly one workflow name or NONE
       (empty registry short-circuits to null — no LLM call)
  → registry entry matched?  entry.run({ fleetApi, message, history }) → reply
  → no match ("direct")?     executePrompt to DOER with transcript prompt → reply
  → record { user, assistant } exchange in session history (cap: maxHistory, default 20)
  → 200 { sessionId, reply, workflow }
```

- Routing match: DOER's trimmed reply compared case-insensitively against registry
  names; NONE or an unrecognized name → direct answer (garbage in, fallback out). An
  `isError` classification result is NOT a fallback — it throws and surfaces as 502.
- Workflow adapters receive `history` for future use; they are not required to use it.
- A failed exchange (any 502) is NOT recorded in session history.

## Registry seed

One entry to prove the pattern — the existing boilerplate workflow:

- `name: 'boilerplate'`
- `description`: runs the demo workflow (register members, python command, transform,
  agent smoke); route here when the user asks to run the demo/boilerplate or verify
  fleet plumbing.
- `run`: calls `runBoilerplate({ fleetApi })` from `workflows/boilerplate/main.mjs` and
  returns a one-line summary string of its result.

Future workflows become routable by appending `{ name, description, run }` to
`chat/registry.mjs` — no route or router changes.

## Fleet dispatch contract (verified against installed v0.4.0 source)

- `fleetApi.executePrompt(options)` exists at `apra-fleet-client/src/client/api.mjs:202`;
  payload fields used: `prompt`, `member_name`, `resume`.
- **`resume: false` must be passed explicitly on EVERY direct `executePrompt` call**
  (router classification AND direct answers). The raw client defaults `resume` to `true`
  when omitted; only the workflow-layer `agent()` overrides it.

## Windows fix (in scope)

`workflows/boilerplate/ensure-apralabs.mjs` calls `fs.symlinkSync(src, dest)`, which
throws `EPERM` on Windows without admin/Developer Mode. Change to
`fs.symlinkSync(src, dest, 'junction')` — junctions need no privileges on Windows and
the type argument is ignored on POSIX. This makes the link self-healing after
`npm install` touches `node_modules/`.

## Error handling

- Missing/invalid `message` → 400 before any fleet call.
- Routing call, direct answer, or `entry.run()` rejection — or `structuredContent.isError`
  on either LLM result — → 502 with the error message; nothing recorded in history.
- `createChatApp` without `fleetApi` throws at construction time.

## Testing

Mock tests (`tests/chat.test.mjs`), mock `fleetApi` records all calls:

- auth stub sets `req.user` and calls `next()`
- registry: boilerplate entry shape; adapter runs `runBoilerplate` against a full mock and returns a summary string
- router: prompt contains names, descriptions, question, and the NONE instruction; picks the entry DOER names; returns null on `NONE`/garbage/empty registry; sends `member_name: 'BOILERPLATE-DOER'` and `resume: false`
- app direct path (empty registry → no routing call): reply + generated `sessionId`; multi-turn transcript; session isolation; history cap
- app routed path: DOER's classification `boilerplate` → adapter runs, response `workflow: 'boilerplate'`
- errors: 400 (no fleet call), 502 on throw / `isError` / adapter throw (failed turn forgotten), injected `authenticate` can 401
- `/health` responds

Live smoke (manual): Fleet server running, members provisioned →
`node chat/main.mjs`, `curl POST /chat` with a normal question (expect `workflow: "direct"`),
then "run the boilerplate demo workflow" (expect `workflow: "boilerplate"`), then a
follow-up with the same `sessionId` to confirm multi-turn context.
