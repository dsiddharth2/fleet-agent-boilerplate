# Development guide

Day-to-day workflow for people writing code in this repo: getting set up, running
things, testing, and adding a workflow. For how the pieces fit together and why, read
[architecture.md](architecture.md) first.

## First-time setup

You need Node **22.16+**, `python3` on PATH for the dummy command, and the
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI if you want live
`agent()` calls.

```bash
npm install -g @apralabs/apra-fleet
apra-fleet install
cd ~/.apra-fleet/bin && apra-fleet start    # leave this running
```

Then, in the repo:

```bash
npm install                                  # installs express (the only dependency)
```

`npm install` does **not** install Fleet's packages. `@apralabs/apra-fleet-workflow` and
`@apralabs/apra-fleet-client` resolve at runtime through a symlink into
`~/.apra-fleet/node_modules`, created automatically by `ensureApralabs()`. This is
intentional — Fleet is a machine install, not a project dependency.

### Provisioning members

Live runs need both members registered and an OAuth token attached to the doer.
`scripts/provision-members.sh` does exactly this, or run the commands yourself:

```bash
claude setup-token          # paste the result into .token (gitignored)

apra-fleet register-member --type local --llm claude \
  --name BOILERPLATE-DOER --path "$(pwd)/workdir/BOILERPLATE-DOER"

apra-fleet register-member --type local --llm claude \
  --name BOILERPLATE-REVIEWER --path "$(pwd)/workdir/BOILERPLATE-REVIEWER"

apra-fleet auth --oauth --member BOILERPLATE-DOER "$(tr -d '\r\n' < .token)"
```

Three things bite people here. `--type local` is required — the default is remote and
demands a `host`. Auth must come **after** the member exists. And the token has to go
into Fleet's credential store on that member: exporting `CLAUDE_CODE_OAUTH_TOKEN` in
your shell does not reach `agent()`, because Claude is spawned by the Fleet server, not
by your process. Re-run the `auth` command when you see `OAuth session expired`.

## Running things

| Command | Needs a server? | Needs a token? |
|---|---|---|
| `npm test` | no | no |
| `node --test tests/boilerplate.test.mjs` | no | no |
| `node --test tests/chat.test.mjs` | no | no |
| `node --test tests/boilerplate.live.test.mjs` | yes | yes |
| `node workflows/boilerplate/main.mjs` | yes | yes |
| `npm run chat` | yes | yes |
| `python3 workflows/boilerplate/dummy.py` | no | no |

A successful live workflow run prints `agent result: pong` and **returns to the shell**
with exit 0. If it prints `pong` and hangs, the transport was not stopped — check the
`finally` block in the launcher.

The chat server listens on `PORT`, default 3000:

```bash
npm run chat

curl -s -X POST http://127.0.0.1:3000/chat \
  -H "content-type: application/json" \
  -d '{"message":"hello"}'
# → {"sessionId":"…","reply":"…","workflow":"direct"}
```

Pass the returned `sessionId` back on the next request to continue a conversation.

## Testing

Tests split by what they need, and the split is the point.

**Mock tests** (`tests/boilerplate.test.mjs`, `tests/chat.test.mjs`) run anywhere — no
Fleet server, no members, no tokens, no network. They work because both launchers accept
an injected `fleetApi`. These are what `npm test` runs, and what you should be running
constantly.

The mock is a hand-written object implementing the four MCP methods the code actually
uses (`registerMember`, `fleetStatus`, `executeCommand`, `executePrompt`) and recording
its calls. It returns realistic MCP envelopes — `content[]` plus `structuredContent` —
so the text-extraction paths get exercised rather than bypassed. Because
`fleetStatus()` is derived from what was registered, the mock can assert genuinely
useful behavior, such as a second `runBoilerplate()` not re-registering members.

**Live tests** (`tests/boilerplate.live.test.mjs`) run the real thing against a real
member with a real token, asserting `hello-from-python`, the transform payload, and
`pong`. They have a 180-second timeout. Run them before merging anything that touches
the Fleet integration, not on every save.

`tests/setup-fleet-modules.mjs` calls `ensureApralabs()` before any test imports Fleet
packages; import it first in any new test file that pulls in a launcher.

When you add behavior, prefer extending the mock over reaching for the live server. If
something can only be verified live, that is usually a hint that connection logic has
leaked into a workflow body.

## Adding a workflow

Follow the existing shape rather than inventing a new one.

**1. Create the launcher and body.** Copy the split from `workflows/boilerplate/`: a
`main.mjs` that owns connection, transport cleanup and the exported entry function, and
a body file that only knows how to do the work given the engine `context`. The entry
function must accept `{ fleetApi }` so it stays testable.

```js
export async function runMyWorkflow({ fleetApi } = {}) {
  if (!process.env.APRA_FLEET_TRANSPORT) {
    process.env.APRA_FLEET_TRANSPORT = 'http';
  }
  ensureApralabs();
  // …connect if fleetApi wasn't injected, execute the body, stop the transport in finally
}
```

**2. Write a mock test first.** Reuse the mock-client pattern. Assert the calls you care
about — which members, which commands, which prompts.

**3. Make it routable, if it should be.** Append an entry to `defaultRegistry` in
`chat/registry.mjs`:

```js
{
  name: 'my-workflow',
  description: 'One or two sentences the ROUTER reads to decide when to pick this. ' +
    'Describe the user intents it serves, not implementation details.',
  async run({ fleetApi, message, history }) {
    const result = await runMyWorkflow({ fleetApi });
    return `my-workflow completed: ${JSON.stringify(result)}`;
  },
}
```

No router or route changes are needed — the registry is data. `name` must be unique,
since it is literally what the router's LLM replies with. `description` is written for a
classifier, not for a human reading a changelog; if a workflow is never selected, the
description is almost always the reason. A throwing `run` returns 502 and the turn is
dropped from history.

**4. Register new members if you need them.** Each gets its own folder under `workdir/`,
and its own `register-member` call in `scripts/provision-members.sh`. Use unique names —
a shared Fleet server may host other projects, and `BOILERPLATE-*` is only a dummy
prefix.

## Conventions

- **ESM everywhere.** `"type": "module"`, `.mjs` for launchers and chat modules.
- **`node:test` and `node:assert/strict`.** No test framework dependency.
- **No `@apralabs/*` in `package.json`.** Fleet resolves through the symlink.
- **Dependency injection over module-level singletons.** Anything that talks to Fleet
  takes `fleetApi` as an argument.
- **Dynamic `import()` for Fleet packages**, always after `ensureApralabs()`.
- **Secrets live in Fleet's credential store**, never in source, never in an `agent()`
  payload, never in git.
- **Comments explain why, not what.** The existing comments mark non-obvious
  constraints — why transport is pinned, why `resume: false`, why `'junction'`.

## Local state and git

`.token`, `node_modules/`, `.claude/` (including the copies Fleet seeds inside
`workdir/*/`), `.env`, `.cursor/` and leftover `.fleet/` / `.fleet-src/` directories are
all gitignored. The `.claude/settings.local.json` files that appear under `workdir/`
after registering members are machine state, not product source — leave them out of
commits.

## Docker

Useful for a clean-room check. The image installs Fleet itself and bind-mounts the repo
at `/workspace`; your host `~/.apra-fleet` is not used, and secrets are excluded via
`.dockerignore`.

```bash
docker compose run --rm fleet node --test tests/boilerplate.test.mjs   # mock
docker compose run --rm fleet                                          # live, token from .token
docker compose run --rm -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" fleet
```

The entrypoint starts Fleet, waits up to 60 seconds for `apra-fleet status` to succeed,
then provisions members — unless `--test` appears in the arguments, which skips
provisioning entirely. Note the image does not install Claude Code, so live `agent()`
calls inside the container still need an LLM CLI present.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `connectFleet() failed` / MCP entry not found | Fleet server is down. `cd ~/.apra-fleet/bin && apra-fleet start`. |
| `Cannot find package 'undici'` | Stale `node_modules/@apralabs` symlink. `ensureApralabs()` should retarget it; delete any leftover `.fleet-src`. |
| `"host" is required for remote members` | Add `--type local` to `register-member`. |
| `Member "…" not found` on `auth` | Register the member before authenticating it. |
| `OAuth session expired` | `claude setup-token`, then re-run `apra-fleet auth --oauth --member BOILERPLATE-DOER …`. |
| Live run prints `pong` but never exits | Transport not stopped — check the launcher's `finally`. |
| Every chat reply is `workflow: "direct"` | The registry `description` isn't distinguishing the workflow. Test the classification with `buildRoutePrompt`. |
| Chat forgets context | Send the previous `sessionId` back; history is in-memory and lost on restart. |
