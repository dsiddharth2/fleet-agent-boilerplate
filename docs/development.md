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
npm install                                  # installs the MCP and HTTP dependencies
```

`npm install` does **not** install Fleet's packages. `@apralabs/apra-fleet-workflow` and
`@apralabs/apra-fleet-client` resolve at runtime through a symlink created automatically
by `ensureApralabs()`. It checks `~/.apra-fleet/node_modules/@apralabs` first, then falls
back to the npm global prefix (where `npm install -g @apralabs/apra-fleet` lands). This
is intentional — Fleet is a machine install, not a project dependency.

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
| `node --test tests/inspect-members.test.mjs` | no | no |
| `node --test tests/mcp.test.mjs` | no | no |
| `node --test tests/mcp.live.test.mjs` | yes | no |
| `node --test tests/boilerplate.live.test.mjs` | yes | yes |
| `node workflows/boilerplate/main.mjs` | yes | yes |
| `npm run mcp` | yes | only for `boilerplate` |
| `python3 workflows/boilerplate/dummy.py` | no | no |
| `python3 workflows/inspect-members/inspect.py --root workdir/BOILERPLATE-DOER` | no | no |

A successful live workflow run prints `agent result: pong` and **returns to the shell**
with exit 0. If it prints `pong` and hangs, the transport was not stopped — check the
`finally` block in the launcher.

The MCP server listens on loopback at `PORT`, default 3000. Start it, then register it
with Claude Code from another terminal:

```bash
npm run mcp
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

See [mcp-interface.md](mcp-interface.md) for timeout, hosting, and authentication
configuration.

## Testing

Tests split by what they need, and the split is the point.

**Mock tests** (`tests/boilerplate.test.mjs`, `tests/inspect-members.test.mjs`) run
anywhere — no Fleet server, no members, no tokens, no network. They work because the
launchers accept an injected `fleetApi`.

`tests/mcp.test.mjs` also needs no Fleet server or token. It drives a real MCP client
over a real ephemeral port against the HTTP application, with Fleet mocked underneath.
These three files are what `npm test` runs, and what you should run constantly.

The mock is a hand-written object implementing the four MCP methods the code actually
uses (`registerMember`, `fleetStatus`, `executeCommand`, `executePrompt`) and recording
its calls. It returns realistic MCP envelopes — `content[]` plus `structuredContent` —
so the text-extraction paths get exercised rather than bypassed. Because
`fleetStatus()` is derived from what was registered, the mock can assert genuinely
useful behavior, such as a second `runBoilerplate()` not re-registering members.

**Live tests** split further. `tests/mcp.live.test.mjs` exercises the MCP server against
a live Fleet without spending tokens. `tests/boilerplate.live.test.mjs` runs the full
workflow against a real member with a real token, asserting `hello-from-python`, the
transform payload, and `pong`. Run live tests before merging changes that touch the
Fleet integration, not on every save.

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

**3. Expose it as an MCP tool, if it should be.** Append an entry to `defaultRegistry`
in `mcp/registry.mjs`:

```js
{
  name: 'my-workflow',
  description: 'What this does and when a model should choose it.',
  inputSchema: z.object({ target: z.string().describe('What to act on') }),
  annotations: { readOnlyHint: true },
  async run({ fleetApi, args, signal, reportPhase }) {
    return await runMyWorkflow({ fleetApi, signal, reportPhase, target: args.target });
  },
}
```

No changes to `server.mjs` or `http.mjs` are needed — the registry is data. `name` must
be unique, `inputSchema` must be a `z.object(...)`, and omitting `inputSchema` declares
a no-argument tool. Write `description` for the connected model deciding whether to
choose the tool. A thrown `run` automatically becomes an MCP `isError` result.

**4. Register new members if you need them.** Each gets its own folder under `workdir/`,
and its own `register-member` call in `scripts/provision-members.sh`. Use unique names —
a shared Fleet server may host other projects, and `BOILERPLATE-*` is only a dummy
prefix.

## Conventions

- **ESM everywhere.** `"type": "module"`, `.mjs` for launchers and MCP modules.
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
| `Cannot find package 'undici'` | Stale `node_modules/@apralabs` symlink. `ensureApralabs()` checks `~/.apra-fleet/node_modules` first, then the npm global prefix; delete any leftover `.fleet-src`. |
| `"host" is required for remote members` | Add `--type local` to `register-member`. |
| `Member "…" not found` on `auth` | Register the member before authenticating it. |
| `OAuth session expired` | `claude setup-token`, then re-run `apra-fleet auth --oauth --member BOILERPLATE-DOER …`. |
| Live run prints `pong` but never exits | Transport not stopped — check the launcher's `finally`. |
| A tool is never chosen | Improve its registry `description` so the connected model knows when to use it. |
| A tool call times out | Set `"timeout"` in that server's `.mcp.json` entry. |
