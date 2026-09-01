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

Live runs need `WORKER_POOL_SIZE` (default 4) worker pairs registered and an OAuth
token attached to **every** role. `scripts/provision-members.sh` does exactly this.
Changing `WORKER_POOL_SIZE` requires re-running that script — the pool verifies the
roster at startup and refuses to start if a worker is missing.

```bash
WORKER_POOL_SIZE=4 scripts/provision-members.sh
```

Or the equivalent by hand:

```bash
apra-fleet register-member --type local --llm claude \
  --name WORKER-1-DOER --path "$(pwd)/workdir/worker-1/doer"

apra-fleet register-member --type local --llm claude \
  --name WORKER-1-REVIEWER --path "$(pwd)/workdir/worker-1/reviewer"

# Repeat for each i in 1..N. Set the token on every role:
apra-fleet auth --oauth --member WORKER-1-DOER "$(claude setup-token)"
apra-fleet auth --oauth --member WORKER-1-REVIEWER "$(claude setup-token)"
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
| `node --test tests/demo.test.mjs` | no | no |
| `node --test tests/inspect-members.test.mjs` | no | no |
| `node --test tests/mcp.test.mjs` | no | no |
| `node --test tests/pool-*.test.mjs` | no | no |
| `node --test tests/mcp.live.test.mjs` | yes | no |
| `node --test tests/demo.live.test.mjs` | yes | yes |
| `node workflows/demo/main.mjs` | yes | yes |
| `npm run mcp` | yes | only for `demo` |
| `python3 workflows/demo/dummy.py` | no | no |

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

**Mock tests** (`tests/demo.test.mjs`, `tests/inspect-members.test.mjs`, and the
`tests/pool-*.test.mjs` files) run anywhere — no Fleet server, no members, no tokens,
no network. They work because the launchers accept an injected `fleetApi` and an
optional `pool`, and because `WORKER_POOL_ROOT` can point the folders and `.locks` at a
tmpdir.

`tests/mcp.test.mjs` also needs no Fleet server or token. It drives a real MCP client
over a real ephemeral port against the HTTP application, with Fleet mocked underneath.
These three files are what `npm test` runs, and what you should run constantly.

The mock is a hand-written object implementing the MCP methods the code actually
uses (`listMembers`, `fleetStatus`, `registerMember`, `executeCommand`, `executePrompt`)
and recording its calls. It returns realistic MCP envelopes — `content[]` plus
`structuredContent` — so the text-extraction paths get exercised rather than bypassed.
`listMembers()` is the call the pool verifies its roster with; a mock that answered
member names from `fleetStatus()` would hide a real bug.

**Live tests** split further. `tests/mcp.live.test.mjs` exercises the MCP server against
a live Fleet without spending tokens. `tests/demo.live.test.mjs` runs the full
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

**1. Create the launcher and body.** Copy the split from `workflows/demo/`: a
`main.mjs` that owns connection, transport cleanup and the exported entry function, and
a body file that only knows how to do the work given the engine `context`. The entry
function must accept `{ fleetApi }` so it stays testable.

```js
export async function runMyWorkflow({ fleetApi, pool } = {}) {
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
  async run({ fleetApi, pool, args, signal, reportPhase }) {
    return await runMyWorkflow({ fleetApi, pool, signal, reportPhase, target: args.target });
  },
}
```

No changes to `server.mjs` or `http.mjs` are needed — the registry is data. `name` must
be unique, `inputSchema` must be a `z.object(...)`, and omitting `inputSchema` declares
a no-argument tool. Write `description` for the connected model deciding whether to
choose the tool. A thrown `run` automatically becomes an MCP `isError` result.

**4. Do not register members from the workflow.** Provisioning owns registration and
OAuth. Address members by the role keywords `'doer'` and `'reviewer'`; the pool
resolves them to the worker assigned to that run. Raising `WORKER_POOL_SIZE` and
re-running `scripts/provision-members.sh` is how you add capacity, not new names in
workflow bodies.

## Conventions

- **Address members by role, never by name.** Pass `'doer'` or `'reviewer'` as
  `member_name`; the pool resolves them to the worker assigned to your run.
- **Keep workflow module scope immutable.** The engine loads your body once with
  `import()` and Node's ESM cache shares that instance across every concurrent
  run, so a module-level `let`, counter, or cache is shared between runs on
  different workers. Per-run state belongs inside `main()`.
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

`node_modules/`, `.claude/` (including the copies Fleet seeds inside
`workdir/*/`), `.env`, `.cursor/` and leftover `.fleet/` / `.fleet-src/` directories are
all gitignored. The `.claude/settings.local.json` files that appear under `workdir/`
after registering members are machine state, not product source — leave them out of
commits.

## Docker

Build once, run, done. The image installs Fleet, Claude Code, and project dependencies.
The entrypoint handles everything — deps, Fleet startup, member provisioning — so users
only need to write workflows and tools.

### Quick start

```bash
docker compose up                    # starts Fleet + MCP server on port 3000
```

Then register the MCP server with Claude Code from the host:

```bash
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

Pass an OAuth token for live `agent()` calls:

```bash
CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)" docker compose up
```

The token is passed as an environment variable and written directly into Fleet's
credential store at startup — nothing is saved to disk.

Override the host port with `MCP_PORT`:

```bash
MCP_PORT=4000 docker compose up
```

### Running workflows or tests directly

```bash
docker compose run --rm fleet node workflows/demo/main.mjs      # live workflow
docker compose run --rm fleet node --test tests/demo.test.mjs   # mock tests
```

Passing `--test` skips Fleet startup and member provisioning.

### How it works

The entrypoint runs automatically on every container start:

1. Installs project deps if the named volume is empty (first run)
2. Symlinks `@apralabs` packages so workflows resolve them
3. Starts Fleet and waits up to 60 seconds for it to be ready
4. Provisions members and attaches the OAuth token

The compose file sets `MCP_BIND_HOST=0.0.0.0` so the MCP server is reachable from the
host. The default bind address remains `127.0.0.1` for local development outside Docker.
A named volume for `node_modules` prevents the host bind mount from overwriting
Linux-native dependencies.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `connectFleet() failed` / MCP entry not found | Fleet server is down. `cd ~/.apra-fleet/bin && apra-fleet start`. |
| `Cannot find package 'undici'` | Stale `node_modules/@apralabs` symlink. `ensureApralabs()` checks `~/.apra-fleet/node_modules` first, then the npm global prefix; delete any leftover `.fleet-src`. |
| `"host" is required for remote members` | Add `--type local` to `register-member`. |
| `Member "…" not found` on `auth` | Register the member before authenticating it. |
| `OAuth session expired` | `claude setup-token`, then re-run `apra-fleet auth --oauth --member WORKER-1-DOER …`. |
| Live run prints `pong` but never exits | Transport not stopped — check the launcher's `finally`. |
| A tool is never chosen | Improve its registry `description` so the connected model knows when to use it. |
| A tool call times out | Set `"timeout"` in that server's `.mcp.json` entry. |
