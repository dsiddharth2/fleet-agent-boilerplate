# fleet-agent-boilerplate

A batteries-included starter for building agents with [Apra Fleet](https://github.com/Apra-Labs/apra-fleet). Clone it, write your workflows and tools, `docker compose up`. Everything else — Fleet server, member registration, dependency installation, MCP server — is handled for you.

## Quick start

```bash
git clone https://github.com/dsiddharth2/fleet-agent-boilerplate.git
cd fleet-agent-boilerplate

# Provide an OAuth token for live agent() calls:
export CLAUDE_CODE_OAUTH_TOKEN="your-token"

docker compose up
```

That's it. The MCP server is now listening on `http://localhost:3000/mcp`. Register it with Claude Code:

```bash
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

Claude can now call your workflows as MCP tools.

---

## What you get out of the box

The Docker image handles everything on startup:

1. Installs Fleet, Claude Code, and project dependencies
2. Starts the Fleet server and waits for it to be ready
3. Registers members and attaches your OAuth token
4. Starts the MCP server on port 3000

You only write two things:

- **Workflow bodies** — the actual work your agents do (`workflows/`)
- **Tool entries** — one entry per workflow in the MCP registry (`mcp/registry.mjs`)

---

## Writing your first workflow

### 1. Create the workflow body

```text
workflows/my-workflow/
  main.mjs          # launcher: connects to Fleet, runs the engine, cleans up
  my-workflow.js    # body: receives engine context, does the work
```

The body receives `context` with Fleet primitives — `command()`, `transform()`, `agent()` — and does the work:

```js
// workflows/my-workflow/my-workflow.js
export const meta = { name: 'my-workflow' };

export async function main(context) {
  const { command, agent, log } = context;

  log('running analysis');
  const data = await command('python3 analyze.py', { member_name: 'MY-DOER' });

  const reply = await agent('Summarize this data', { member_name: 'MY-DOER' });
  return { data, reply };
}
```

The launcher owns connection and cleanup. Copy the pattern from `workflows/boilerplate/main.mjs`:

```js
// workflows/my-workflow/main.mjs
export async function runMyWorkflow({ fleetApi } = {}) {
  if (!process.env.APRA_FLEET_TRANSPORT) {
    process.env.APRA_FLEET_TRANSPORT = 'http';
  }
  ensureApralabs();
  // …connect if fleetApi wasn't injected, execute the body, stop the transport in finally
}
```

### 2. Expose it as an MCP tool

Append one entry to `mcp/registry.mjs`:

```js
{
  name: 'my-workflow',
  description: 'What this does and when a model should choose it.',
  inputSchema: z.object({ target: z.string().describe('What to act on') }),
  async run({ fleetApi, args, signal, reportPhase }) {
    return await runMyWorkflow({ fleetApi, target: args.target, signal, reportPhase });
  },
}
```

No changes to `server.mjs` or `http.mjs` needed — the registry is data.

### 3. Register your members

Add your members to `scripts/provision-members.sh`:

```bash
apra-fleet register-member --type local --llm claude \
  --name MY-DOER --path "$(pwd)/workdir/MY-DOER"
```

Create matching folders under `workdir/`. Each member needs its own folder — two members sharing a `cwd` will collide.

### 4. Run it

```bash
docker compose up
```

---

## Running without Docker

If you prefer running directly on your machine:

```bash
# Install Fleet globally
npm install -g @apralabs/apra-fleet
apra-fleet install
apra-fleet start                    # leave running

# Install project deps
npm install

# Provision members and token
scripts/provision-members.sh

# Start the MCP server
npm run mcp
```

---

## Running workflows directly

```bash
# Inside Docker
docker compose run --rm fleet node workflows/boilerplate/main.mjs

# On host
node workflows/boilerplate/main.mjs
```

---

## Testing

Tests run without a Fleet server, without members, and without tokens:

```bash
npm test                                                              # all mock tests
docker compose run --rm fleet node --test tests/boilerplate.test.mjs  # in Docker
```

The mock tests inject a fake `fleetApi` and assert real behavior — member registration, command dispatch, agent calls. Write mock tests first when adding workflows.

Live tests need a running Fleet server and a token:

```bash
node --test tests/boilerplate.live.test.mjs   # full workflow with real LLM
node --test tests/mcp.live.test.mjs           # MCP server against live Fleet
```

---

## How it works

```text
┌─────────────────────────────────────────────────────────────┐
│  Your Node process                                          │
│                                                             │
│   mcp/             POST /mcp — one MCP tool per registry    │
│     │              entry. Claude chooses from descriptions.  │
│     │ entry.run({ fleetApi, args, signal, reportPhase })    │
│     ▼                                                       │
│   workflows/       runBoilerplate() — connect + execute      │
│     │              Your workflow bodies live here.           │
└─────┼───────────────────────────────────────────────────────┘
      │ MCP over HTTP
      ▼
┌─────────────────────────────────────────────────────────────┐
│  Fleet server        http://127.0.0.1:7523/mcp              │
│                                                             │
│   YOUR-DOER                     YOUR-REVIEWER               │
│   workdir/YOUR-DOER/            workdir/YOUR-REVIEWER/      │
│   Claude Code + OAuth           registered, ready            │
└─────────────────────────────────────────────────────────────┘
```

Four ideas explain most of the code:

- **Launcher / body split.** `main.mjs` owns connection, transport and cleanup; the `.js` body only does the work. That is what keeps bodies testable.
- **`fleetApi` is injected.** Launchers connect only when no client is passed in, so mock tests run with no server and no tokens.
- **Fleet is a machine install, not a dependency.** `ensureApralabs()` symlinks `node_modules/@apralabs` to the Fleet install. No `@apralabs/*` in `package.json`.
- **Transport is pinned to `http`.** Left unset, the client would spawn Fleet over stdio and miss your provisioned members.

---

## Secrets

| Where | Purpose |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` env | Passed at startup, written into Fleet's credential store |
| Fleet credential store | Where the token lives at runtime — Fleet spawns Claude, not your process |

The OAuth token goes directly into Fleet's credential store on the member at startup. The Fleet server spawns Claude — not your Node process — so the token must live in Fleet's store, not your shell environment. The entrypoint and provision script handle this automatically via `apra-fleet auth`.

---

## Docker configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | OAuth token for live `agent()` calls |
| `MCP_PORT` | `3000` | Host port mapped to the MCP server |
| `MCP_BIND_HOST` | `0.0.0.0` (compose) / `127.0.0.1` (local) | MCP server bind address |

Override the host port:

```bash
MCP_PORT=4000 docker compose up
```

---

## Layout

```text
workflows/
  boilerplate/          # demo workflow — replace with your own
    main.mjs            # launcher: connectFleet, execute, exit
    boilerplate.js      # body: register, status, command, transform, agent
    dummy.py            # stand-in for real Python work
    ensure-apralabs.mjs # symlinks @apralabs packages from Fleet install
  inspect-members/      # read-only member inspection workflow
    main.mjs, inspect-members.js, inspect.py
mcp/
  main.mjs              # MCP server launcher, configurable bind address
  server.mjs            # one MCP tool per registry entry
  http.mjs              # stateless POST /mcp and GET /health
  registry.mjs          # tool catalog — add your workflows here
  auth.mjs              # injectable auth stub (replace for production)
  fleet-text.mjs        # extract text from Fleet MCP results
scripts/
  docker-entrypoint.sh  # start Fleet, install deps, provision, exec
  provision-members.sh  # register members + attach OAuth
tests/                  # mock and live test suites
workdir/                # member working directories (one per member)
docs/
  architecture.md       # layers, data flow, design decisions
  development.md        # setup, testing, conventions
  mcp-interface.md      # MCP tool reference, timeouts, auth, hosting
Dockerfile
docker-compose.yml
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `connectFleet() failed` | Fleet server is down. `apra-fleet start`, then retry. |
| `"host" is required for remote members` | Add `--type local` to `register-member`. |
| `Member "…" not found` on `auth` | Register the member first, then `auth`. |
| `OAuth session expired` | `claude setup-token`, re-run `apra-fleet auth --oauth --member …`. |
| `Cannot find package 'undici'` | Stale `@apralabs` symlink. Delete `node_modules/@apralabs` and re-run. |
| Live run prints `pong` but never exits | Transport not stopped — check the launcher's `finally` block. |
| MCP tool not chosen by Claude | Improve its `description` in `mcp/registry.mjs`. |
| MCP tool call times out | Set `"timeout": 600000` in `.mcp.json` for that server. |

---

## Further reading

| Document | Covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Fleet concepts, layer diagram, module map, design decisions |
| [docs/development.md](docs/development.md) | First-time setup, testing, adding workflows, conventions |
| [docs/mcp-interface.md](docs/mcp-interface.md) | MCP tool catalog, registry contract, timeouts, auth, hosting |
