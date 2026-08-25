# Chat interface

The chat layer (`chat/`) is the HTTP front door of this repo. It sits **above** all
workflows: every incoming question is classified by an LLM routing call to
**BOILERPLATE-DOER**, which either picks a registered workflow to handle it or answers
the question directly. The chat layer is not a workflow itself and nothing under
`workflows/` imports from `chat/`.

## Request flow

```text
POST /chat → authenticate → validate message
  → routeQuestion(): LLM call to DOER with registry names + descriptions,
       replies with exactly one workflow name or NONE
       (empty registry short-circuits to null — no LLM call)
  → match?        entry.run({ fleetApi, message, history }) → reply
  → no match?     executePrompt to DOER with the session transcript → reply
  → record { user, assistant } in session history (cap: 20 messages)
  → 200 { sessionId, reply, workflow }
```

## API

### POST /chat

Request body (JSON):

| Field | Type | Required | Notes |
|---|---|---|---|
| `message` | string | yes | Non-empty. Whitespace-only is rejected. |
| `sessionId` | string | no | Omit to start a new session; the response returns the generated id. An unknown id lazily starts a session under that id. |

Responses:

| Status | Body | When |
|---|---|---|
| 200 | `{ sessionId, reply, workflow }` | Success. `workflow` is the registry entry name that handled the message, or `"direct"`. |
| 400 | `{ error }` | `message` missing / not a non-empty string. No fleet call is made. |
| 401 | `{ error }` | Only once a real `authenticate` middleware rejects (the stub accepts everything). |
| 502 | `{ error }` | The routing call, direct answer, or workflow adapter failed. The failed turn is NOT recorded in history. |

### GET /health

`200 { ok: true }`. No auth.

## Sessions

- History is **in-memory** (`Map` in the app factory): lost on restart, never shared
  across processes. Run one instance, or add persistence before scaling out.
- Capped at 20 messages (user + assistant combined) per session; oldest are dropped.
- Routed exchanges are recorded too, so a follow-up like "what just happened?" is
  answered with context.

## Routing

`chat/router.mjs` builds a classification prompt from the registry's names and
descriptions and dispatches it to BOILERPLATE-DOER with `resume: false`. The reply is
trimmed and matched case-insensitively against registry names; `NONE` or anything
unrecognized falls back to a direct answer. Every message therefore costs up to two LLM
calls (classify + direct answer) or one classify plus a workflow run.

## Adding a workflow to the registry

Append an entry to `defaultRegistry` in `chat/registry.mjs`:

```js
{
  name: 'my-workflow',
  description: 'One or two sentences the ROUTER reads to decide when to pick this. ' +
    'Describe the user intents it serves, not implementation details.',
  async run({ fleetApi, message, history }) {
    // Call your workflow here; return the reply string shown to the user.
    return 'my-workflow finished';
  },
},
```

Rules:

- `name` must be unique in the registry (it is what the router's LLM replies with).
- `description` is router food — write it for a classifier.
- `run` receives the live `fleetApi`, the raw `message`, and the session `history`
  (read-only use; the app records the exchange itself). Throwing rejects the request
  with 502 and the turn is forgotten.

## Replacing the auth stub

`chat/auth.mjs` is a pass-through that sets `req.user = { id: 'anonymous' }`. Replace it
by injecting your own Express middleware — routes only rely on `req.user`:

```js
import { createChatApp } from './chat/app.mjs';

function bearerAuth(req, res, next) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!isValid(token)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.user = { id: subjectOf(token) };
  next();
}

const app = createChatApp({ fleetApi, authenticate: bearerAuth });
```

Keep secrets in Fleet's credential store or your own secret manager — never in source.

## Running

```bash
npm install        # once
npm run chat       # PORT=3000 by default; needs Fleet running + members provisioned
```

Prerequisites are the same as the boilerplate live run (see README): a running
`apra-fleet start` server and registered `BOILERPLATE-DOER` / `BOILERPLATE-REVIEWER`
members, with an OAuth token attached to the doer for unattended use.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Fleet server is not running or connectFleet() failed` on startup | `cd ~/.apra-fleet/bin && apra-fleet start`, then retry. |
| Every reply is `workflow: "direct"` even for obvious workflow asks | Check the registry entry's `description` — the router picks by it. Test the exact classification with `buildRoutePrompt` in a REPL. |
| 502 `OAuth session expired` | Re-auth the doer: `claude setup-token`, then `apra-fleet auth --oauth --member BOILERPLATE-DOER "$(tr -d '\r\n' < .token)"`. |
| 502 `member offline` / busy | `apra-fleet status` — make sure BOILERPLATE-DOER is present and idle. |
| Context forgotten between messages | Pass the `sessionId` from the previous response back in the request body; note history is lost on server restart. |
