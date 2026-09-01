# workflow-kit

A workflow kit from [Apra Fleet](https://github.com/Apra-Labs/apra-fleet). Clone it, write your workflows and tools, `docker compose up`. Everything else — Fleet server, member registration, dependency installation, MCP server — is handled for you.

## Quick start

```bash
git clone https://github.com/dsiddharth2/workflow-kit.git
cd workflow-kit
```

Set the OAuth token and start the container in the background:

**Bash / macOS / Linux:**
```bash
CLAUDE_CODE_OAUTH_TOKEN="your-token" docker compose up -d
```

**PowerShell (Windows):**
```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN = "your-token"
docker compose up -d
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

Member identity, concurrent-run safety, provisioning, Docker, and mock tests are
already in the kit. The only remaining design work per project is the workflow itself.

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
  const data = await command('python3 analyze.py', { member_name: 'doer' });

  const reply = await agent('Summarize this data', { member_name: 'doer' });
  return { data, reply };
}
```

The launcher owns connection and cleanup. Copy the pattern from `workflows/demo/main.mjs`:

```js
// workflows/my-workflow/main.mjs
export async function runMyWorkflow({ fleetApi, pool } = {}) {
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
  async run({ fleetApi, pool, args, signal, reportPhase }) {
    return await runMyWorkflow({ fleetApi, pool, target: args.target, signal, reportPhase });
  },
}
```

No changes to `server.mjs` or `http.mjs` needed — the registry is data.

### 3. Capacity is already provisioned

`scripts/provision-members.sh` registers `WORKER_POOL_SIZE` (default 4) doer+reviewer
pairs and attaches OAuth to every role. Workflow bodies address them as `'doer'` and
`'reviewer'` — never by the `WORKER-{i}-*` names. To run more jobs at once, raise
`WORKER_POOL_SIZE` and re-run the provision script.

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
docker compose run --rm fleet node workflows/demo/main.mjs

# On host
node workflows/demo/main.mjs
```

---

## Testing

Tests run without a Fleet server, without members, and without tokens:

```bash
npm test                                                              # all mock tests
docker compose run --rm fleet node --test tests/demo.test.mjs         # in Docker
```

The mock tests inject a fake `fleetApi` and an optional pool and assert real behavior —
role-keyword remapping, command dispatch, agent calls, queueing. Write mock tests first
when adding workflows.

Live tests need a running Fleet server and a token:

```bash
node --test tests/demo.live.test.mjs        # full workflow with real LLM
node --test tests/mcp.live.test.mjs         # MCP server against live Fleet
```

---

## How it works

```text
┌─────────────────────────────────────────────────────────────┐
│  Your Node process                                          │
│                                                             │
│   mcp/             POST /mcp — one MCP tool per registry    │
│     │              entry. Claude chooses from descriptions.  │
│     │              One WorkerPool per process, built at start│
│     │ entry.run({ fleetApi, pool, args, signal, reportPhase })│
│     ▼                                                       │
│   workflows/       launcher acquires a lease, wraps fleetApi │
│     │              body uses 'doer' / 'reviewer' keywords    │
│     ▼                                                       │
│   pool/            shared worker pairs + file locks          │
└─────┼───────────────────────────────────────────────────────┘
      │ MCP over HTTP
      ▼
┌─────────────────────────────────────────────────────────────┐
│  Fleet server        http://127.0.0.1:7523/mcp              │
│                                                             │
│   WORKER-1-DOER / WORKER-1-REVIEWER   …   WORKER-N-*        │
│   workdir/worker-1/{doer,reviewer}/   …   workdir/worker-N/ │
│   Claude Code + OAuth on every role                         │
└─────────────────────────────────────────────────────────────┘
```

Five ideas explain most of the code:

- **Launcher / body split.** `main.mjs` owns connection, pool acquire/release, transport and cleanup; the `.js` body only does the work. That is what keeps bodies testable.
- **`fleetApi` is injected.** Launchers connect only when no client is passed in, so mock tests run with no server and no tokens.
- **Members are a pool, not names you pick.** Workflows pass `'doer'` / `'reviewer'`; the pool assigns a `WORKER-{i}-*` pair for the run. Concurrent calls cannot share a folder.
- **Fleet is a machine install, not a dependency.** `ensureApralabs()` symlinks `node_modules/@apralabs` to the Fleet install. No `@apralabs/*` in `package.json`.
- **Transport is pinned to `http`.** Left unset, the client would spawn Fleet over stdio and miss your provisioned members.

---

## Setting up the OAuth token

The OAuth token goes directly into Fleet's credential store — no files saved to disk.
Fleet spawns Claude (not your Node process), so the token must live in Fleet's store.

### Local development

```bash
apra-fleet auth --oauth --member WORKER-1-DOER "$(claude setup-token)"
```

`claude setup-token` opens a browser login and outputs the token. `apra-fleet auth`
writes it straight into Fleet's credential store on the member.

### Docker / VM

**Bash / macOS / Linux:**
```bash
CLAUDE_CODE_OAUTH_TOKEN="your-token" docker compose up -d
```

**PowerShell (Windows):**
```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN = "your-token"
docker compose up -d
```

The provision script picks up the env var and runs `apra-fleet auth` inside the
container automatically. The `-d` flag runs the container in the background.

### CI (GitHub Actions, Azure Pipelines, etc.)

1. Run `claude setup-token` locally and copy the output
2. Store it as a secret in your CI provider (e.g. GitHub Secrets → `CLAUDE_CODE_OAUTH_TOKEN`)
3. Pass it as an environment variable when starting the container

The token never enters the Docker image — it is injected at runtime and stored only
in Fleet's in-memory credential store.

---

## Docker configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | OAuth token for live `agent()` calls |
| `MCP_PORT` | `3000` | Host port mapped to the MCP server |
| `MCP_BIND_HOST` | `0.0.0.0` (compose) / `127.0.0.1` (local) | MCP server bind address |
| `WORKER_POOL_SIZE` | `4` | Number of doer+reviewer worker pairs. Re-provision after changing. |
| `WORKER_POOL_ROOT` | `<repo>/workdir` | Where worker folders and `.locks` live. Tests point this at a tmpdir. |
| `WORKER_POOL_ACQUIRE_TIMEOUT_MS` | `300000` | How long a call waits for a free worker before failing. |

Override the host port:

```bash
MCP_PORT=4000 docker compose up
```

---

## Layout

```text
workflows/
  demo/                 # demo workflow — replace the body with your own
    main.mjs            # launcher: connectFleet, acquire lease, execute, release
    demo.js             # body: status, command, transform, agent — uses 'doer'
    dummy.py            # stand-in for real Python work
    ensure-apralabs.mjs # symlinks @apralabs packages from Fleet install
  inspect-members/      # observational pool/folder inspection (no member session)
    main.mjs, inspect-members.js
pool/
  roster.mjs            # WORKER-{i}-* names, folders, poolConfig()
  worker-lock.mjs       # cross-process proper-lockfile wrapper
  cleanup.mjs           # wipe work folders, preserve .claude/
  worker-pool.mjs       # acquire/release, FIFO queue, heartbeats, leases
  pooled-fleet-api.mjs  # remaps 'doer'/'reviewer' to the leased members
  fleet-text.mjs        # token-exact listMembers() matching
mcp/
  main.mjs              # MCP server launcher, builds one pool at startup
  server.mjs            # one MCP tool per registry entry
  http.mjs              # stateless POST /mcp and GET /health
  registry.mjs          # tool catalog — add your workflows here
  auth.mjs              # injectable auth stub (replace for production)
  fleet-text.mjs        # extract text from Fleet MCP results
scripts/
  docker-entrypoint.sh  # start Fleet, install deps, provision, exec
  provision-members.sh  # register 2N workers + attach OAuth to every role
tests/                  # mock and live test suites
workdir/                # worker folders + .locks (gitignored runtime state)
docs/
  architecture.md       # layers, pool, data flow, design decisions
  development.md        # setup, testing, adding workflows, conventions
  mcp-interface.md      # MCP tool reference, timeouts, queueing, auth, hosting
Dockerfile
docker-compose.yml
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `These worker members are not registered: …` | `WORKER_POOL_SIZE` changed without re-provisioning. Run `scripts/provision-members.sh`. |
| `all N workers busy, try again` | Pool saturated for longer than `WORKER_POOL_ACQUIRE_TIMEOUT_MS`. Raise `WORKER_POOL_SIZE` or retry. |
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
