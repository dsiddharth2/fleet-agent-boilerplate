# fleet-agent-boilerplate

Clone this repo and add your product code. It is a starter for calling [Apra Fleet](https://github.com/Apra-Labs/apra-fleet) **from your own Node process**, not a named `apra-fleet workflow` CLI command.

```js
import { runBoilerplate } from './workflows/boilerplate/main.mjs';

await runBoilerplate();                 // live: connects to a running Fleet server
await runBoilerplate({ fleetApi });     // tests inject a mock client
```

The dummy run proves the primitives you will reuse: register members, `command()` (Python), `transform()` (JS), `agent()` (LLM). Replace `dummy.py` and extend `boilerplate.js` for real work.

This repo does **not** vendor Fleet. `@apralabs/apra-fleet-workflow` and `@apralabs/apra-fleet-client` resolve from `~/.apra-fleet/node_modules` (or the Docker image). There is no root `package.json` dependency on those packages.

**New here?** Read [docs/architecture.md](docs/architecture.md) — it explains Fleet's concepts (server, MCP, members, credential store) and how this repo is layered. Then [docs/development.md](docs/development.md) for setup, testing, and adding a workflow.

---

## How it works

Two layers over a Fleet server you run yourself.

```text
mcp/         POST /mcp — one MCP tool per registry entry
  ▼
workflows/   runBoilerplate() — connects, then runs the workflow body
  │
  ▼ MCP over HTTP (127.0.0.1:7523)
Fleet server — owns members, credentials, and spawns the LLM CLI
  BOILERPLATE-DOER          workdir/BOILERPLATE-DOER/
  BOILERPLATE-REVIEWER      workdir/BOILERPLATE-REVIEWER/
```

`mcp/` imports from `workflows/`; nothing under `workflows/` imports from `mcp/`.
The MCP layer is a stateless front door, while each workflow remains independently
callable and testable.

Four ideas explain most of the code:

- **Launcher / body split.** `main.mjs` owns connection, transport and cleanup; `boilerplate.js` only does the work. That is what keeps the body testable.
- **`fleetApi` is injected.** Both launchers connect only when no client is passed in, so mock tests run with no server and no tokens.
- **Fleet is a machine install, not a dependency.** `ensureApralabs()` symlinks `node_modules/@apralabs` to `~/.apra-fleet/node_modules/@apralabs` before any dynamic import.
- **Transport is pinned to `http`.** Left unset, the client would spawn Fleet over stdio and never see the members you provisioned.

The dummy run proves the primitives in order: register members → `fleetStatus()` → `command()` (Python, no tokens) → `transform()` (pure JS) → `agent()` (LLM, spends tokens). Registration is idempotent, so re-running is cheap.

The one thing that surprises everyone: **the OAuth token must be in Fleet's credential store on the member**, because the Fleet server spawns Claude — not your Node process. Exporting `CLAUDE_CODE_OAUTH_TOKEN` in your shell does not reach `agent()`.

---

## Use this in another project

1. Clone (or copy) this tree into your product repo.
2. Keep the launcher / engine split: `main.mjs` connects and runs the engine; `boilerplate.js` is the workflow body.
3. Give members **unique names** on a shared Fleet server (`BOILERPLATE-DOER` is only a dummy).
4. Give each member its **own folder** under `workdir/`. Two local members on the same `cwd` will collide.
5. Put secrets in Fleet’s credential store with `apra-fleet auth`, not in workflow source, not in `agent()` payloads, not in git.
6. Call `runBoilerplate()` (or a renamed export) from your app or tests. Do not register this as `apra-fleet workflow …`.

---

## Layout

```text
workflows/boilerplate/
  main.mjs              # runBoilerplate() — connectFleet, execute, exit
  boilerplate.js        # dummy phases (register, status, command, transform, agent)
  dummy.py              # prints hello-from-python
  ensure-apralabs.mjs   # symlink node_modules/@apralabs → Fleet install (local or npm global)
  package.json          # { "type": "module" }
  workflow.json         # metadata only; not used as a Fleet CLI workflow
workflows/inspect-members/
  main.mjs, inspect-members.js, inspect.py, workflow.json
mcp/
  main.mjs              # connect to Fleet, listen on loopback, graceful close
  server.mjs            # expose one MCP tool per registry entry
  http.mjs              # stateless POST /mcp and GET /health transport
  registry.mjs          # tool catalog and workflow adapters
  auth.mjs              # injectable pass-through auth stub
  fleet-text.mjs        # extract text from Fleet MCP results
docs/
  architecture.md       # how it fits together + Fleet concepts primer
  development.md        # setup, testing, adding a workflow, conventions
  mcp-interface.md      # MCP setup, tool, registry, timeout, and hosting reference
tests/
  boilerplate.test.mjs  # mock fleetApi — no live server, no tokens
  inspect-members.test.mjs # mock fleetApi — no live server, no tokens
  mcp.test.mjs          # real MCP client and port, mock Fleet, no tokens
  mcp.live.test.mjs     # real MCP and Fleet servers, no tokens
  boilerplate.live.test.mjs  # real server, real member, real token
  setup-fleet-modules.mjs
scripts/
  provision-members.sh  # register local members + OAuth on BOILERPLATE-DOER
  docker-entrypoint.sh  # start Fleet, provision, then exec
workdir/
  BOILERPLATE-DOER/     # doer workspace (dummy command/agent use this member)
  BOILERPLATE-REVIEWER/ # second member, separate folder
Dockerfile
docker-compose.yml
```

Dummy `command()` and `agent()` run on **BOILERPLATE-DOER** only.
`inspect-members` inspects both DOER and REVIEWER by default.

---

## Prerequisites (machine install)

- Node.js **22.16+**
- `python3` on PATH (dummy `command()`; `failSoft: true` if missing)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI for live `agent()`
- Global Fleet:

```bash
npm install -g @apralabs/apra-fleet
apra-fleet install
cd ~/.apra-fleet/bin && apra-fleet start
```

Leave that server running (`http://127.0.0.1:7523/mcp` by default). `runBoilerplate()` sets `APRA_FLEET_TRANSPORT=http` so it attaches to that server. If transport is unset, Fleet may try a stdio spawn that cannot see your provisioned members.

More: [install.md](https://github.com/Apra-Labs/apra-fleet/blob/main/docs/install.md), [authoring-workflows.md](https://github.com/Apra-Labs/apra-fleet/blob/main/docs/authoring-workflows.md).

---

## Mock test (no server, no tokens)

```bash
node --test tests/boilerplate.test.mjs
```

This imports `runBoilerplate` with a **mock** `fleetApi`. It checks that both members would be registered against separate `workdir/` folders, that `python3` + `dummy.py` would be invoked, and that `agent()` would be called. Pass = `# pass 1`.

Live (real Fleet, real `BOILERPLATE-DOER`, uses tokens). Same provision as below:

```bash
node --test tests/boilerplate.live.test.mjs
```

That calls `runBoilerplate()` with **no mock** and asserts Python `hello-from-python`, transform payload, and agent `pong`.

---

## Live run on this machine

### 1. Start Fleet

```bash
cd ~/.apra-fleet/bin && apra-fleet start
```

### 2. Put the OAuth token in a gitignored file

```bash
claude setup-token
# paste into .token at the repo root — never commit it
```

`.token` is gitignored. Do not put tokens in `boilerplate.js` or in the `agent()` prompt.

### 3. Register members and attach the token to the doer

`--type local` is required. The default is remote, which demands `host` and will not register.

Auth **after** the member exists. The token must live in **Fleet’s credential store on that member** (`encryptedEnvVars` in the registry). Setting `CLAUDE_CODE_OAUTH_TOKEN` only in the Node process does **not** reach `agent()` — Claude is spawned by the Fleet server as the member.

Same three commands as `scripts/provision-members.sh`:

```bash
cd /path/to/fleet-agent-boilerplate

apra-fleet register-member --type local --llm claude \
  --name BOILERPLATE-DOER \
  --path "$(pwd)/workdir/BOILERPLATE-DOER"

apra-fleet register-member --type local --llm claude \
  --name BOILERPLATE-REVIEWER \
  --path "$(pwd)/workdir/BOILERPLATE-REVIEWER"

apra-fleet auth --oauth --member BOILERPLATE-DOER "$(tr -d '\r\n' < .token)"
```

Re-run `auth` when the token expires (`OAuth session expired`). Interactive `claude` login is not the same as unattended `agent()`.

### 4. Run the dummy workflow

```bash
node workflows/boilerplate/main.mjs
```

The process should print `agent result: pong` and **return to the shell** (exit 0). It closes the HTTP transport after `executeFile`. If you ever see `pong` but no prompt, Ctrl+C — that was an older hang.

| Phase | Success signal |
|-------|----------------|
| Register | `registered BOILERPLATE-DOER` / `REVIEWER`, or `already present; skipping registration` |
| Status | `fleet status: BOILERPLATE-DOER=present, BOILERPLATE-REVIEWER=present` |
| `command()` | `hello-from-python` from `dummy.py` (no LLM tokens) |
| `transform()` | `{"ok":true,"source":"transform"}` (JS only; independent of Python) |
| `agent()` | `pong` from `BOILERPLATE-DOER` (uses tokens) |

`command()` uses `failSoft: true`: missing `python3` still continues. A thrown `transform()` or `agent()` fails the run (exit 1).

---

## MCP interface

The MCP server exposes one tool for each entry in `mcp/registry.mjs`. Claude chooses
between the token-spending `boilerplate` demo and the read-only, no-token
`inspect-members` report from their descriptions.

```bash
npm install
npm run mcp
claude mcp add --transport http fleet http://127.0.0.1:3000/mcp
```

The server needs Fleet running and members provisioned. The default bind is loopback
only. **Full reference: [docs/mcp-interface.md](docs/mcp-interface.md)** — setup, tools,
the registry contract, timeouts, cancellation, authentication, hosting, and
troubleshooting.

---

## Secrets

| Place | Use it for |
|-------|------------|
| Gitignored `.token` | Input to `apra-fleet auth` / `provision-members.sh` |
| `apra-fleet auth --oauth --member …` | Live `agent()` on that member |
| CI `CLAUDE_CODE_OAUTH_TOKEN` | Same as `.token` for Docker / provision script |

Pipeline pattern: CI secret → `apra-fleet auth` (or `provision-members.sh`) → workflows only call `agent({ member_name: 'BOILERPLATE-DOER' })`.

---

## Docker (optional)

Needs Docker Engine. The image runs `npm install -g @apralabs/apra-fleet` and `apra-fleet install --skill none`. Secrets are **not** copied into the image (see `.dockerignore`). The repo is bind-mounted at `/workspace`. Host `~/.apra-fleet` is unused.

On a **live** `docker compose run`, the entrypoint starts Fleet in the container, waits until `apra-fleet status` works, runs `scripts/provision-members.sh`, then execs the command. Mock tests pass `--test` and skip provision.

```bash
# mock
docker compose run --rm fleet node --test tests/boilerplate.test.mjs

# live — token from gitignored .token on the host (in the bind mount)
docker compose run --rm fleet

# live — token from CI
docker compose run --rm -e CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" fleet
```

The image does not install Claude Code. Live `agent()` in Docker still needs an LLM CLI in that environment.

Host-only Python smoke (no Fleet):

```bash
python3 workflows/boilerplate/dummy.py
```

---

## Adapting the dummy

| You want | Change |
|----------|--------|
| Real Python work | Replace `workflows/boilerplate/dummy.py`; keep the `command()` call |
| Real LLM work | Change the `agent()` prompt in `boilerplate.js`; keep `member_name` |
| Your own member names | Rename constants in `boilerplate.js`, `workdir/` folders, and `scripts/provision-members.sh` |
| A second agent | Dispatch `agent({ member_name: 'BOILERPLATE-REVIEWER' })` — register + auth that member the same way |
| Call from another module | `import { runBoilerplate } from './workflows/boilerplate/main.mjs'` |

Do not pass OAuth tokens into `agent()`. Do not clone `apra-fleet` into this repo (no `.fleet-src`). Do not ship a private Node under `.fleet`.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `connectFleet() failed` / MCP entry not found | Fleet HTTP server is down. `cd ~/.apra-fleet/bin && apra-fleet start`, then retry. |
| `"host" is required for remote members` | Add `--type local` to `register-member`. |
| `Member "…" not found` on `auth` | Register the member first, then `auth`. |
| `OAuth session expired` / `claude auth status` logged-in is false for the member | `claude setup-token`, then `apra-fleet auth --oauth --member BOILERPLATE-DOER "$(tr -d '\r\n' < .token)"`. |
| `Cannot find package 'undici'` | Stale `node_modules/@apralabs` symlink. `ensureApralabs()` checks `~/.apra-fleet/node_modules/@apralabs` first, then the npm global prefix. Delete a leftover repo-local `.fleet-src` if you created one. |
| Extra member named `doer` in `fleet status` | Leftover from experiments. The dummy workflow does not use it. |
| Live run prints `pong` but the shell does not return | Update `main.mjs` (transport `stop()` + `process.exit(0)`). Ctrl+C the hung client; the Fleet server can stay up. |

---

## Further reading

| Document | Covers |
|----------|--------|
| [docs/architecture.md](docs/architecture.md) | Fleet concepts, the layer diagram, module map, data flow, and the reasoning behind each design decision |
| [docs/development.md](docs/development.md) | First-time setup, provisioning, the mock vs. live test split, adding a workflow end to end, conventions |
| [docs/mcp-interface.md](docs/mcp-interface.md) | MCP setup, tool catalog, registry contract, execution limits, auth, hosting, and troubleshooting |

---

## What is gitignored (do not commit)

`.token`, `node_modules/`, `.claude/` (including `workdir/*/.claude/settings.local.json`), leftover `.fleet/` and `.fleet-src/` if they appear. `.env` is also ignored so an accidental file is never committed. Fleet may seed those Claude settings when you register members — they are local machine state, not product source.
