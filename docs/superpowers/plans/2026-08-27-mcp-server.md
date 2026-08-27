# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `chat/` HTTP front door with an MCP server layer so a Claude session can connect over streamable HTTP and call this repo's workflows as tools.

**Architecture:** The process speaks MCP in both directions — a new `mcp/` layer serves tools to a connected Claude session, while `workflows/` remains an MCP client to the Fleet server underneath. One MCP tool is generated per entry in `mcp/registry.mjs`; there is no internal LLM router, because the connected Claude already selects tools. The HTTP endpoint is stateless: a fresh `McpServer` and transport per request.

**Tech Stack:** Node 22.16+, ESM, `@modelcontextprotocol/server@2`, `@modelcontextprotocol/node@2`, `@modelcontextprotocol/express@2`, `@modelcontextprotocol/client@2` (tests), `zod@4`, `express@5`, `node:test`.

**Spec:** [`docs/superpowers/specs/2026-08-27-mcp-server-design.md`](../specs/2026-08-27-mcp-server-design.md)

## Global Constraints

- **No `@apralabs/*` in `package.json`.** Fleet is a machine install; those packages resolve at runtime through the `ensureApralabs()` symlink.
- **Dynamic `import()` for Fleet packages**, always after `ensureApralabs()`.
- **`fleetApi` is always injected**, never imported. Every entry point accepts `{ fleetApi }` so mock tests run with no server and no tokens.
- **`APRA_FLEET_TRANSPORT` defaults to `'http'`** in every launcher when unset; an explicitly set value is respected.
- **ESM everywhere.** `"type": "module"`; `.mjs` for launchers and `mcp/` modules, `.js` for workflow bodies loaded by the engine.
- **`node:test` and `node:assert/strict`.** No test framework dependency.
- **Zod is imported as `import * as z from 'zod/v4'`.**
- **Secrets never enter source, an `agent()` payload, or git.**
- **Comments explain why, not what.**
- **Nothing under `workflows/` may import from `mcp/`.**
- **Mock tests still run the real workflow engine.** `tests/setup-fleet-modules.mjs` only calls `ensureApralabs()`; `fleetApi` is the sole mock. Return shapes from `command()` therefore come from the real engine, so extract text defensively instead of assuming one shape.

## Execution environments — read before running anything

This plan is being implemented by a **remote agent** that has no Fleet install and no host
Fleet server. That constrains verification, so read this before the first task.

`tests/setup-fleet-modules.mjs` calls `ensureApralabs()` at module load, which **throws** unless
Fleet is installed at `~/.apra-fleet`. Every mock test imports it first. A bare machine
therefore cannot run `npm test` at all.

The repo already handles this. The Dockerfile installs Fleet into the image, and
`scripts/docker-entrypoint.sh` skips provisioning whenever `--test` appears in the arguments, so
the mock suite runs with no Fleet server and no tokens:

```bash
docker compose run --rm fleet node --test tests/boilerplate.test.mjs tests/inspect-members.test.mjs tests/mcp.test.mjs
```

**Wherever a task says `npm test` or `node --test …`, a remote agent runs the Docker form
instead.** The two are equivalent for mock tests. Note that the `--test` argument is what
suppresses provisioning, so this trick does **not** extend to the live test.

| Task | Remote agent | Needs the host machine |
|---|---|---|
| 1 Dependencies | Full — `npm install` and the import check | — |
| 2 `inspect.py` | Full — plain `python3`, no Fleet | — |
| 3 `inspect-members` | Full, via Docker | — |
| 4 Boilerplate cancellation | Full, via Docker | — |
| 5 Registry | Full, via Docker | — |
| 6 Server + HTTP | Full, via Docker | — |
| 7 Launcher | Step 2 only (the failure path) | Steps 3–4: live Fleet, `curl /health`, Ctrl+C |
| 8 Remove chat | Full, via Docker | — |
| 9 Live test | **Write the file only — do not run it** | Running it |
| 10 Docs | Full, via Docker | — |

**Do not mark a host-only step complete, and do not weaken a test so it passes remotely.** Leave
those checkboxes unticked and say so in the handoff. A test that has never run against a real
Fleet is not a passing test.

### Verified SDK behavior — do not re-derive

These were confirmed by running the real packages. Trusting them saves rediscovery:

1. **A tool with no `inputSchema` receives the context as its ONLY handler argument** — `(ctx) => …`, not `(args, ctx)`. A tool *with* `inputSchema` receives `(args, ctx)`. This asymmetry is handled once, in `mcp/server.mjs`.
2. **A thrown handler error automatically becomes `{ isError: true, content: [{ type: 'text', text: message }] }`** and the server keeps serving. Do **not** add try/catch around workflow calls.
3. **Invalid arguments are rejected by the SDK before the handler runs**, also as an `isError` result.
4. **`createMcpExpressApp()` parses JSON bodies itself.** Do not add `express.json()`.
5. **Progress requires a client token.** Read `ctx.mcpReq._meta?.progressToken`; if absent, send nothing. `progress` must increase on every notification.
6. **The MCP Tasks extension is NOT implemented by this SDK.** `execution.taskSupport` is silently dropped and `tasks/get` returns `Method not found`. Do not attempt to use tasks.

---

## File Structure

| File | Responsibility |
|---|---|
| `mcp/server.mjs` | Create | `buildMcpServer({ fleetApi, registry })` → `McpServer` with one tool per entry. No HTTP knowledge. |
| `mcp/http.mjs` | Create | `createMcpHttpApp({ buildServer, authenticate })` → express app, `POST /mcp` + `GET /health`. No workflow knowledge. |
| `mcp/main.mjs` | Create | `startMcpServer({ fleetApi, port })` — environment, connection, listen, shutdown. |
| `mcp/registry.mjs` | Create | The routable workflow list. The only file you edit to add a tool. |
| `mcp/fleet-text.mjs` | Create | `toolText()` — moved verbatim from `chat/`. |
| `mcp/auth.mjs` | Create | Pass-through auth stub — moved verbatim from `chat/`. |
| `workflows/inspect-members/inspect.py` | Create | Stdlib-only work-folder probe. Emits one JSON object. |
| `workflows/inspect-members/inspect-members.js` | Create | Workflow body: status → per-member `command()` → aggregated report. |
| `workflows/inspect-members/main.mjs` | Create | `runInspectMembers({ fleetApi, members, includeFiles, signal, reportPhase })`. |
| `workflows/inspect-members/workflow.json` | Create | Metadata only, matching the boilerplate convention. |
| `workflows/boilerplate/main.mjs` | Modify | Thread `signal` and `reportPhase` into the engine args. |
| `workflows/boilerplate/boilerplate.js` | Modify | Check cancellation and report each phase. |
| `tests/inspect-members.test.mjs` | Create | Mock test for the new workflow body. |
| `tests/mcp.test.mjs` | Create | Mock test driving the real client over a real port. |
| `tests/mcp.live.test.mjs` | Create | Live test for `inspect-members` (no tokens). |
| `package.json` | Modify | Dependencies and scripts. |
| `chat/` | Delete | Entire directory. |
| `tests/chat.test.mjs` | Delete | Pinned the removed HTTP behavior. |
| `docs/chat-interface.md` | Delete | Replaced by `docs/mcp-interface.md`. |
| `docs/mcp-interface.md` | Create | Full MCP reference. |
| `README.md`, `docs/architecture.md`, `docs/development.md` | Modify | Remove chat, describe MCP. |

---

## Task 1: Dependencies and scripts

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/express`, `zod` importable at runtime; `@modelcontextprotocol/client` importable in tests. `npm run mcp` script name.

- [ ] **Step 1: Install the runtime dependencies**

```bash
npm install @modelcontextprotocol/server@^2.0.0 @modelcontextprotocol/node@^2.0.0 @modelcontextprotocol/express@^2.0.0 zod@^4.4.3
```

- [ ] **Step 2: Install the test-only dependency**

```bash
npm install --save-dev @modelcontextprotocol/client@^2.0.0
```

- [ ] **Step 3: Replace the `chat` script with `mcp`**

In `package.json`, set the `scripts` block to exactly:

```json
  "scripts": {
    "test": "node --test tests/boilerplate.test.mjs tests/inspect-members.test.mjs tests/mcp.test.mjs",
    "mcp": "node mcp/main.mjs"
  },
```

Note: `npm test` will fail until Task 6, because it now names files that do not exist yet. That is expected and is fixed by Task 6.

- [ ] **Step 4: Verify the new packages import and the SDK is the version this plan assumes**

Run:

```bash
node -e "import('@modelcontextprotocol/server').then(m=>console.log('server ok', typeof m.McpServer)); import('@modelcontextprotocol/express').then(m=>console.log('express ok', typeof m.createMcpExpressApp)); import('@modelcontextprotocol/node').then(m=>console.log('node ok', typeof m.NodeStreamableHTTPServerTransport)); import('zod/v4').then(m=>console.log('zod ok', typeof m.object));"
```

Expected: four lines, each ending in `function`.

- [ ] **Step 5: Verify the pre-existing workflow test still passes**

Run: `node --test tests/boilerplate.test.mjs`
Expected: `# pass 1`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add MCP server SDK v2 dependencies and the mcp script"
```

---

## Task 2: The `inspect.py` work-folder probe

**Files:**
- Create: `workflows/inspect-members/inspect.py`

**Interfaces:**
- Consumes: nothing.
- Produces: a CLI contract used by `inspect-members.js` in Task 3 — `python3 inspect.py --root <abs path> [--files]`, printing exactly one JSON object on stdout with keys `root` (string), `exists` (boolean), and when `exists` is true `fileCount` (number), `totalBytes` (number), plus when `--files` is passed `entries` (array of strings, max 50) and `entriesOmitted` (number).

- [ ] **Step 1: Write the script**

Create `workflows/inspect-members/inspect.py`:

```python
#!/usr/bin/env python3
"""Report on one member work folder. Prints a single JSON object on stdout.

Run standalone as a smoke test:
    python3 workflows/inspect-members/inspect.py --root workdir/BOILERPLATE-DOER --files
"""
import argparse
import json
import os
import sys

# Claude Code truncates tool output at 25,000 tokens by default, so an
# unbounded listing of a large work folder would silently lose its tail.
MAX_ENTRIES = 50


def build_report(root, include_files):
    report = {"root": root, "exists": os.path.isdir(root)}
    if not report["exists"]:
        return report

    file_count = 0
    total_bytes = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            file_count += 1
            try:
                total_bytes += os.path.getsize(os.path.join(dirpath, name))
            except OSError:
                pass
    report["fileCount"] = file_count
    report["totalBytes"] = total_bytes

    if include_files:
        names = sorted(os.listdir(root))
        report["entries"] = names[:MAX_ENTRIES]
        report["entriesOmitted"] = max(0, len(names) - MAX_ENTRIES)

    return report


def main():
    parser = argparse.ArgumentParser(description="Inspect a member work folder.")
    parser.add_argument("--root", required=True, help="Path to the member work folder")
    parser.add_argument(
        "--files", action="store_true", help="Include a capped listing of top-level entries"
    )
    args = parser.parse_args()
    print(json.dumps(build_report(args.root, args.files)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Verify it reports an existing folder**

Run: `python3 workflows/inspect-members/inspect.py --root workdir/BOILERPLATE-DOER`
Expected: one line of JSON containing `"exists": true`, plus `fileCount` and `totalBytes`. Example:
`{"root": "workdir/BOILERPLATE-DOER", "exists": true, "fileCount": 3, "totalBytes": 1234}`

- [ ] **Step 3: Verify `--files` adds a capped listing**

Run: `python3 workflows/inspect-members/inspect.py --root workdir/BOILERPLATE-DOER --files`
Expected: the same JSON plus `"entries": [...]` and `"entriesOmitted": 0`.

- [ ] **Step 4: Verify a missing folder degrades instead of failing**

Run: `python3 workflows/inspect-members/inspect.py --root workdir/NOPE; echo "exit=$?"`
Expected: `{"root": "workdir/NOPE", "exists": false}` followed by `exit=0`.

- [ ] **Step 5: Verify the output is parseable JSON**

Run: `python3 workflows/inspect-members/inspect.py --root workdir/BOILERPLATE-DOER --files | python3 -c "import json,sys; d=json.load(sys.stdin); print('keys:', sorted(d))"`
Expected: `keys: ['entries', 'entriesOmitted', 'exists', 'fileCount', 'root', 'totalBytes']`

- [ ] **Step 6: Commit**

```bash
git add workflows/inspect-members/inspect.py
git commit -m "feat: add a stdlib-only probe that reports on a member work folder"
```

---

## Task 3: The `inspect-members` workflow

**Files:**
- Create: `workflows/inspect-members/inspect-members.js`
- Create: `workflows/inspect-members/main.mjs`
- Create: `workflows/inspect-members/workflow.json`
- Test: `tests/inspect-members.test.mjs`

**Interfaces:**
- Consumes: the `inspect.py` CLI contract from Task 2. `ensureApralabs()` from `workflows/boilerplate/ensure-apralabs.mjs` (imported across folders deliberately, rather than duplicating the symlink logic).
- Produces: `runInspectMembers({ fleetApi, members, includeFiles, signal, reportPhase })` → `Promise<{ generatedAt: string, members: Array<{ name: string, present: boolean, report?: object, error?: string }> }>`. Task 5's registry calls this.

- [ ] **Step 1: Write the failing test**

Create `tests/inspect-members.test.mjs`:

```javascript
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runInspectMembers } = await import('../workflows/inspect-members/main.mjs');

// Mirrors the mock shape in tests/boilerplate.test.mjs: realistic MCP envelopes
// so the text-extraction paths are exercised rather than bypassed.
function createMockFleetApi({ present = ['BOILERPLATE-DOER', 'BOILERPLATE-REVIEWER'], commandFails = false } = {}) {
  const commandCalls = [];
  return {
    commandCalls,
    async fleetStatus() {
      return { content: [{ type: 'text', text: present.join('\n') }] };
    },
    async executeCommand(options) {
      commandCalls.push(options);
      if (commandFails) {
        return {
          content: [{ type: 'text', text: 'python3: command not found' }],
          structuredContent: { stdout: '', exitCode: 127 },
        };
      }
      const payload = JSON.stringify({ root: '/tmp/x', exists: true, fileCount: 2, totalBytes: 10 });
      return {
        content: [{ type: 'text', text: payload }],
        structuredContent: { stdout: payload, exitCode: 0 },
      };
    },
  };
}

test('inspects both known members by default', async () => {
  const fleetApi = createMockFleetApi();
  const result = await runInspectMembers({ fleetApi });

  assert.equal(typeof result.generatedAt, 'string');
  assert.deepEqual(
    result.members.map((entry) => entry.name),
    ['BOILERPLATE-DOER', 'BOILERPLATE-REVIEWER'],
  );
  assert.equal(result.members[0].present, true);
  assert.equal(result.members[0].report.fileCount, 2);
  assert.equal(fleetApi.commandCalls.length, 2);
  assert.match(fleetApi.commandCalls[0].command, /inspect\.py/);
  assert.equal(fleetApi.commandCalls[0].member_name, 'BOILERPLATE-DOER');
  assert.equal(fleetApi.commandCalls[0].failSoft, true);
});

test('honors an explicit members list', async () => {
  const fleetApi = createMockFleetApi();
  const result = await runInspectMembers({ fleetApi, members: ['BOILERPLATE-DOER'] });

  assert.deepEqual(result.members.map((entry) => entry.name), ['BOILERPLATE-DOER']);
  assert.equal(fleetApi.commandCalls.length, 1);
});

test('reports an unregistered member as absent without running a command', async () => {
  const fleetApi = createMockFleetApi({ present: ['BOILERPLATE-DOER'] });
  const result = await runInspectMembers({ fleetApi });

  const reviewer = result.members.find((entry) => entry.name === 'BOILERPLATE-REVIEWER');
  assert.equal(reviewer.present, false);
  assert.equal(reviewer.report, undefined);
  assert.equal(fleetApi.commandCalls.length, 1, 'absent members must not be probed');
});

test('includeFiles adds the --files flag', async () => {
  const fleetApi = createMockFleetApi();
  await runInspectMembers({ fleetApi, includeFiles: true });
  assert.match(fleetApi.commandCalls[0].command, /--files/);

  const plain = createMockFleetApi();
  await runInspectMembers({ fleetApi: plain });
  assert.doesNotMatch(plain.commandCalls[0].command, /--files/);
});

test('a failSoft command failure becomes a per-member error, not a throw', async () => {
  const fleetApi = createMockFleetApi({ commandFails: true });
  const result = await runInspectMembers({ fleetApi });

  assert.equal(result.members[0].present, true);
  assert.equal(result.members[0].report, undefined);
  assert.match(result.members[0].error, /command not found/);
});

test('an aborted signal stops before the next member', async () => {
  const fleetApi = createMockFleetApi();
  const controller = new AbortController();
  controller.abort();

  const result = await runInspectMembers({ fleetApi, signal: controller.signal });
  assert.equal(fleetApi.commandCalls.length, 0, 'no member should be probed after abort');
  assert.deepEqual(result.members, []);
});

test('reportPhase is called and is optional', async () => {
  const phases = [];
  await runInspectMembers({
    fleetApi: createMockFleetApi(),
    reportPhase: (message) => phases.push(message),
  });
  assert.ok(phases.length >= 1, 'reportPhase should be invoked at least once');

  // Omitting reportPhase must not throw.
  await runInspectMembers({ fleetApi: createMockFleetApi() });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/inspect-members.test.mjs`
Expected: FAIL — cannot find module `../workflows/inspect-members/main.mjs`.

- [ ] **Step 3: Write the workflow body**

Create `workflows/inspect-members/inspect-members.js`:

```javascript
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const meta = { name: 'inspect-members' };

const DOER = 'BOILERPLATE-DOER';
const REVIEWER = 'BOILERPLATE-REVIEWER';

// Default to the members this repo owns. A shared Fleet server may host other
// projects' members, and reporting on those would leak unrelated information.
const DEFAULT_MEMBERS = [DOER, REVIEWER];

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const INSPECT_PY = fileURLToPath(new URL('./inspect.py', import.meta.url));

function toolText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const parts = result.content ?? [];
  if (parts.length > 0) {
    return parts.map((part) => part.text ?? '').join('\n');
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// The engine returns { ok, output, error } — verified from a live run. A
// failSoft failure carries an empty output and puts the reason in `error`, so
// read that first and skip empty candidates rather than returning ''.
function commandText(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (raw.ok === false) {
    const detail = raw.error ?? raw.output;
    return typeof detail === 'string' && detail.trim().length > 0 ? detail : 'command failed';
  }
  for (const candidate of [raw.output, raw.stdout, raw.structuredContent?.stdout]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return toolText(raw);
}

function parseReport(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('{')) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // Keep scanning earlier lines.
      }
    }
  }
  return null;
}

function memberListedInStatus(statusText, name) {
  return statusText.split(/[\n\r]/).some((line) => line.includes(name));
}

export async function main(context) {
  const { phase, command, log, args } = context;
  const fleetApi = args.fleetApi;
  if (!fleetApi) {
    throw new Error('inspect-members.js requires args.fleetApi');
  }
  const signal = args.signal;
  const reportPhase = args.reportPhase ?? (() => {});
  const includeFiles = args.includeFiles === true;
  const targets =
    Array.isArray(args.members) && args.members.length > 0 ? args.members : DEFAULT_MEMBERS;

  phase('status');
  await reportPhase('reading fleet status');
  const statusText = toolText(await fleetApi.fleetStatus());

  const members = [];
  for (const name of targets) {
    if (signal?.aborted) {
      log(`cancelled before inspecting ${name}`);
      break;
    }

    if (!memberListedInStatus(statusText, name)) {
      log(`${name} is not registered`);
      members.push({ name, present: false });
      continue;
    }

    phase(`inspect ${name}`);
    await reportPhase(`inspecting ${name}`);
    const flags = includeFiles ? ' --files' : '';
    const raw = await command(
      `python3 "${INSPECT_PY}" --root "${path.join(repoRoot, 'workdir', name)}"${flags}`,
      { member_name: name, failSoft: true },
    );
    const text = commandText(raw);
    const report = parseReport(text);
    if (report) {
      members.push({ name, present: true, report });
    } else {
      members.push({ name, present: true, error: text.trim() || 'no report produced' });
    }
  }

  return { generatedAt: new Date().toISOString(), members };
}
```

- [ ] **Step 4: Write the launcher**

Create `workflows/inspect-members/main.mjs`:

```javascript
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Shared with the boilerplate workflow on purpose: duplicating the symlink
// logic would mean two places to fix when the Fleet install layout changes.
import { ensureApralabs } from '../boilerplate/ensure-apralabs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineScript = path.join(here, 'inspect-members.js');

export const selfExecuting = true;

export async function runInspectMembers({
  fleetApi,
  members,
  includeFiles,
  signal,
  reportPhase,
} = {}) {
  // Attach to `apra-fleet start` (where members were provisioned). Unset
  // transport would fall back to a stdio spawn that cannot see them.
  if (!process.env.APRA_FLEET_TRANSPORT) {
    process.env.APRA_FLEET_TRANSPORT = 'http';
  }
  ensureApralabs();
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');

  let api = fleetApi;
  let transport = null;
  if (!api) {
    try {
      const { connectFleet } = await import('@apralabs/apra-fleet-client/server-resolution');
      const connected = await connectFleet({ env: process.env });
      api = connected.fleetApi;
      transport = connected.transport;
    } catch (err) {
      const detail = err?.message ?? err;
      const message = `Fleet server is not running or connectFleet() failed: ${detail}\nStart it with: cd ~/.apra-fleet/bin && apra-fleet start`;
      console.error(message);
      throw new Error(message, { cause: err });
    }
  }

  try {
    const workflow = new FleetWorkflow(api);
    const engine = new WorkflowEngine(workflow);
    return await engine.executeFile(engineScript, {
      fleetApi: api,
      members,
      includeFiles,
      signal,
      reportPhase,
    });
  } finally {
    transport?.stop?.();
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const report = await runInspectMembers();
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
```

- [ ] **Step 5: Write the metadata file**

Create `workflows/inspect-members/workflow.json`:

```json
{
  "name": "inspect-members",
  "description": "Reports on the work folders of this repo's Fleet members. Metadata only; not registered as an apra-fleet CLI workflow.",
  "entry": "main.mjs"
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test tests/inspect-members.test.mjs`
Expected: `# pass 7`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add workflows/inspect-members tests/inspect-members.test.mjs
git commit -m "feat: add a read-only inspect-members workflow with typed parameters"
```

---

## Task 4: Cancellation and phase reporting in the boilerplate workflow

**Files:**
- Modify: `workflows/boilerplate/main.mjs`
- Modify: `workflows/boilerplate/boilerplate.js`
- Test: `tests/boilerplate.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `runBoilerplate({ fleetApi, signal, reportPhase })`. When `signal` is already aborted the returned object contains `cancelled: true` and omits later phases. Task 5's registry calls this.

- [ ] **Step 1: Write the failing tests**

Append to `tests/boilerplate.test.mjs`:

```javascript
test('an aborted signal prevents the agent phase from spending tokens', async () => {
  const fleetApi = createMockFleetApi();
  const controller = new AbortController();
  controller.abort();

  const result = await runBoilerplate({ fleetApi, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(fleetApi.promptCalls.length, 0, 'executePrompt must not run after abort');
});

test('reportPhase receives one message per phase and is optional', async () => {
  const phases = [];
  await runBoilerplate({
    fleetApi: createMockFleetApi(),
    reportPhase: (message) => phases.push(message),
  });
  assert.ok(phases.length >= 5, `expected a message per phase, got ${phases.length}`);

  // Omitting reportPhase must not throw.
  await runBoilerplate({ fleetApi: createMockFleetApi() });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/boilerplate.test.mjs`
Expected: FAIL — `result.cancelled` is `undefined` and `promptCalls.length` is `1`.

- [ ] **Step 3: Thread the new options through the launcher**

In `workflows/boilerplate/main.mjs`, change the signature and the `executeFile` call:

```javascript
export async function runBoilerplate({ fleetApi, signal, reportPhase } = {}) {
```

```javascript
      return await engine.executeFile(engineScript, { fleetApi: api, signal, reportPhase });
```

Leave everything else in that file unchanged.

- [ ] **Step 4: Add cancellation checks and phase reports to the body**

In `workflows/boilerplate/boilerplate.js`, replace the whole `main` function with:

```javascript
export async function main(context) {
  const { phase, command, transform, agent, log, args } = context;
  const fleetApi = args.fleetApi;
  if (!fleetApi) {
    throw new Error('boilerplate.js requires args.fleetApi');
  }
  const signal = args.signal;
  const reportPhase = args.reportPhase ?? (() => {});
  // Cancellation is cooperative: an in-flight Fleet call cannot be aborted, so
  // each check prevents the NEXT phase from starting. The check before agent()
  // is the one that matters, because that is the phase that spends tokens.
  const cancelled = () => signal?.aborted === true;

  phase('register BOILERPLATE-DOER and BOILERPLATE-REVIEWER');
  await reportPhase('registering members');
  await ensureMember(fleetApi, DOER, DOER_WORK, log);
  await ensureMember(fleetApi, REVIEWER, REVIEWER_WORK, log);
  if (cancelled()) return { cancelled: true };

  phase('status');
  await reportPhase('reading fleet status');
  const status = await fleetApi.fleetStatus();
  const statusText = toolText(status);
  const hasDoer = statusText.includes(DOER);
  const hasReviewer = statusText.includes(REVIEWER);
  log(`fleet status: ${DOER}=${hasDoer ? 'present' : 'missing'}, ${REVIEWER}=${hasReviewer ? 'present' : 'missing'}`);
  log(statusText);
  if (cancelled()) return { cancelled: true };

  phase('python command');
  await reportPhase('running the python command');
  const cmdResult = await command(`python3 "${DUMMY_PY}"`, {
    member_name: DOER,
    failSoft: true,
  });
  log(`command result: ${typeof cmdResult === 'string' ? cmdResult : JSON.stringify(cmdResult)}`);
  if (cancelled()) return { cancelled: true, command: cmdResult };

  phase('transform returns value');
  await reportPhase('running the transform');
  const payload = await transform('dummy payload', () => ({ ok: true, source: 'transform' }));
  log(`transform result: ${JSON.stringify(payload)}`);
  if (cancelled()) return { cancelled: true, command: cmdResult, transform: payload };

  phase('agent smoke');
  await reportPhase('dispatching the agent prompt');
  const reply = await agent('Reply with exactly: pong', { member_name: DOER });
  log(`agent result: ${reply}`);

  return { command: cmdResult, transform: payload, agent: reply };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test tests/boilerplate.test.mjs`
Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add workflows/boilerplate/main.mjs workflows/boilerplate/boilerplate.js tests/boilerplate.test.mjs
git commit -m "feat: stop the boilerplate workflow at phase boundaries when cancelled"
```

---

## Task 5: The `mcp/` shared modules and registry

**Files:**
- Create: `mcp/fleet-text.mjs`
- Create: `mcp/auth.mjs`
- Create: `mcp/registry.mjs`

**Interfaces:**
- Consumes: `runBoilerplate` (Task 4), `runInspectMembers` (Task 3).
- Produces:
  - `toolText(result) → string`
  - `authenticate(req, res, next)` — sets `req.user = { id: 'anonymous' }`
  - `defaultRegistry` — an array of `{ name, description, inputSchema?, annotations?, run({ fleetApi, args, signal, reportPhase }) }`. Task 6's `buildMcpServer` reads this.

- [ ] **Step 1: Create the text helper, copied verbatim from the chat layer**

Create `mcp/fleet-text.mjs`:

```javascript
export function toolText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const response = result.structuredContent?.response;
  if (typeof response === 'string' && response.length > 0) return response;
  const parts = result.content ?? [];
  if (parts.length > 0) {
    return parts.map((part) => part.text ?? '').join('\n');
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}
```

- [ ] **Step 2: Create the auth stub, copied verbatim from the chat layer**

Create `mcp/auth.mjs`:

```javascript
// Pass-through stub. Replace by injection — createMcpHttpApp({ authenticate }) —
// not by editing this file. Routes depend only on req.user.
export function authenticate(req, res, next) {
  req.user = { id: 'anonymous' };
  next();
}
```

- [ ] **Step 3: Create the registry**

Create `mcp/registry.mjs`:

```javascript
import * as z from 'zod/v4';
import { runBoilerplate } from '../workflows/boilerplate/main.mjs';
import { runInspectMembers } from '../workflows/inspect-members/main.mjs';

// Routable workflows. To expose a new tool, append an entry here — no changes to
// server.mjs or http.mjs are needed. `description` is read by the connected
// model when it decides which tool to call, so write it for that reader.
export const defaultRegistry = [
  {
    name: 'boilerplate',
    description:
      'Runs the boilerplate demo workflow end to end: registers the BOILERPLATE members, ' +
      'runs the dummy python command, the transform, and an agent smoke test. ' +
      'Choose this to run the demo workflow or to verify that Fleet plumbing works. ' +
      'Spends LLM tokens and can take a minute.',
    annotations: { readOnlyHint: false, idempotentHint: true },
    async run({ fleetApi, signal, reportPhase }) {
      const result = await runBoilerplate({ fleetApi, signal, reportPhase });
      return `boilerplate workflow completed: ${JSON.stringify(result)}`;
    },
  },
  {
    name: 'inspect-members',
    description:
      "Reports on this repo's Fleet members: which are registered, and what is in each " +
      'work folder on the Fleet host. Choose this to check fleet health or to see what a ' +
      'member has been doing. Read-only and spends no LLM tokens.',
    inputSchema: z.object({
      members: z
        .array(z.string())
        .optional()
        .describe(
          'Member names to inspect. Defaults to BOILERPLATE-DOER and BOILERPLATE-REVIEWER.',
        ),
      includeFiles: z
        .boolean()
        .optional()
        .describe('Include a capped listing of top-level entries in each work folder.'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    async run({ fleetApi, args, signal, reportPhase }) {
      return await runInspectMembers({
        fleetApi,
        members: args.members,
        includeFiles: args.includeFiles,
        signal,
        reportPhase,
      });
    },
  },
];
```

- [ ] **Step 4: Verify the modules load and the registry has the expected shape**

Run:

```bash
node --input-type=module -e "const {defaultRegistry}=await import('./mcp/registry.mjs'); console.log(defaultRegistry.map(e=>e.name).join(',')); console.log('schemas:', defaultRegistry.map(e=>!!e.inputSchema).join(','));"
```

Expected:
```
boilerplate,inspect-members
schemas: false,true
```

- [ ] **Step 5: Commit**

```bash
git add mcp/fleet-text.mjs mcp/auth.mjs mcp/registry.mjs
git commit -m "feat: add the mcp registry and move the shared helpers out of chat"
```

---

## Task 6: The MCP server and its HTTP endpoint

**Files:**
- Create: `mcp/server.mjs`
- Create: `mcp/http.mjs`
- Test: `tests/mcp.test.mjs`

**Interfaces:**
- Consumes: `defaultRegistry` and `authenticate` (Task 5).
- Produces:
  - `buildMcpServer({ fleetApi, registry }) → McpServer`
  - `createMcpHttpApp({ buildServer, authenticate }) → express app` serving `POST /mcp` and `GET /health`. Task 7's launcher calls both.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp.test.mjs`:

```javascript
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { buildMcpServer } = await import('../mcp/server.mjs');
const { createMcpHttpApp } = await import('../mcp/http.mjs');

function createMockFleetApi() {
  const registerCalls = [];
  const commandCalls = [];
  const promptCalls = [];
  return {
    registerCalls,
    commandCalls,
    promptCalls,
    async registerMember(options) {
      registerCalls.push(options);
      return { content: [{ type: 'text', text: `registered ${options.friendly_name}` }] };
    },
    async fleetStatus() {
      return {
        content: [{ type: 'text', text: 'BOILERPLATE-DOER\nBOILERPLATE-REVIEWER' }],
      };
    },
    async executeCommand(options) {
      commandCalls.push(options);
      const payload = JSON.stringify({ root: '/tmp/x', exists: true, fileCount: 1, totalBytes: 4 });
      return {
        content: [{ type: 'text', text: payload }],
        structuredContent: { stdout: payload, exitCode: 0 },
      };
    },
    async executePrompt(options) {
      promptCalls.push(options);
      return { content: [{ type: 'text', text: 'pong' }], structuredContent: { response: 'pong' } };
    },
  };
}

// Starts the real express app on an ephemeral port and connects a real MCP
// client over streamable HTTP, so the transport wiring is exercised too.
async function withServer(registryOverride, run) {
  const fleetApi = createMockFleetApi();
  const app = createMcpHttpApp({
    buildServer: () => buildMcpServer({ fleetApi, registry: registryOverride }),
  });
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  const url = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  try {
    await run({ client, fleetApi });
  } finally {
    await client.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
}

test('advertises exactly the registry tools, with schemas and annotations', async () => {
  await withServer(undefined, async ({ client }) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['boilerplate', 'inspect-members']);

    const inspect = tools.find((tool) => tool.name === 'inspect-members');
    assert.deepEqual(Object.keys(inspect.inputSchema.properties).sort(), ['includeFiles', 'members']);
    assert.equal(inspect.annotations.readOnlyHint, true);

    const boilerplate = tools.find((tool) => tool.name === 'boilerplate');
    assert.deepEqual(boilerplate.inputSchema.properties ?? {}, {});
    assert.equal(boilerplate.annotations.readOnlyHint, false);
  });
});

test('calling boilerplate runs the workflow', async () => {
  await withServer(undefined, async ({ client, fleetApi }) => {
    const result = await client.callTool({ name: 'boilerplate' });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /boilerplate workflow completed/);
    assert.ok(fleetApi.promptCalls.length >= 1, 'the agent phase should have run');
  });
});

test('calling inspect-members with one member touches only that member', async () => {
  await withServer(undefined, async ({ client, fleetApi }) => {
    const result = await client.callTool({
      name: 'inspect-members',
      arguments: { members: ['BOILERPLATE-DOER'] },
    });
    assert.equal(result.isError, undefined);
    assert.equal(fleetApi.commandCalls.length, 1);
    assert.equal(fleetApi.commandCalls[0].member_name, 'BOILERPLATE-DOER');

    const report = JSON.parse(result.content[0].text);
    assert.deepEqual(report.members.map((entry) => entry.name), ['BOILERPLATE-DOER']);
  });
});

test('a throwing workflow returns isError and the server keeps serving', async () => {
  const registry = [
    {
      name: 'boom',
      description: 'always throws',
      async run() {
        throw new Error('workflow exploded');
      },
    },
    {
      name: 'fine',
      description: 'always works',
      async run() {
        return 'still here';
      },
    },
  ];
  await withServer(registry, async ({ client }) => {
    const failed = await client.callTool({ name: 'boom' });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /workflow exploded/);

    const after = await client.callTool({ name: 'fine' });
    assert.equal(after.isError, undefined);
    assert.equal(after.content[0].text, 'still here');
  });
});

test('invalid arguments are rejected before the workflow runs', async () => {
  let ran = false;
  const registry = [
    {
      name: 'typed',
      description: 'takes a number',
      inputSchema: z.object({ count: z.number() }),
      async run() {
        ran = true;
        return 'ok';
      },
    },
  ];
  await withServer(registry, async ({ client }) => {
    const result = await client.callTool({ name: 'typed', arguments: { count: 'nope' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /count/);
    assert.equal(ran, false, 'run must not be called with invalid arguments');
  });
});

test('an unknown tool name fails cleanly', async () => {
  await withServer(undefined, async ({ client }) => {
    await assert.rejects(() => client.callTool({ name: 'no-such-tool' }));
  });
});

test('a client requesting progress receives a heartbeat per phase', async () => {
  await withServer(undefined, async ({ client }) => {
    const updates = [];
    const result = await client.callTool(
      { name: 'inspect-members', arguments: {} },
      { onprogress: (update) => updates.push(update) },
    );
    assert.equal(result.isError, undefined);
    assert.ok(updates.length >= 1, 'expected at least one progress notification');
    assert.ok(
      updates.every((update, index) => index === 0 || update.progress > updates[index - 1].progress),
      'progress must strictly increase',
    );
  });
});

test('a client that does not request progress still gets the result', async () => {
  await withServer(undefined, async ({ client }) => {
    const result = await client.callTool({ name: 'inspect-members', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.ok(JSON.parse(result.content[0].text).members.length >= 1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/mcp.test.mjs`
Expected: FAIL — cannot find module `../mcp/server.mjs`.

- [ ] **Step 3: Write the server builder**

Create `mcp/server.mjs`:

```javascript
import { McpServer } from '@modelcontextprotocol/server';
import { defaultRegistry } from './registry.mjs';

const SERVER_INFO = { name: 'fleet-agent-boilerplate', version: '1.0.0' };

function toToolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

// Progress notifications are only legal when the client sent a progressToken,
// and `progress` must increase on every one. With no token this is a no-op, so
// workflow bodies can call reportPhase unconditionally.
function makePhaseReporter(ctx) {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  let progress = 0;
  return async (message) => {
    if (progressToken === undefined) return;
    progress += 1;
    await ctx.mcpReq.notify({
      method: 'notifications/progress',
      params: { progressToken, progress, message },
    });
  };
}

export function buildMcpServer({ fleetApi, registry = defaultRegistry } = {}) {
  if (!fleetApi) {
    throw new Error('buildMcpServer requires fleetApi');
  }
  const server = new McpServer(SERVER_INFO);

  for (const entry of registry) {
    const config = { description: entry.description };
    if (entry.inputSchema) config.inputSchema = entry.inputSchema;
    if (entry.annotations) config.annotations = entry.annotations;

    // A thrown error is turned into an isError result by the SDK, so there is
    // deliberately no try/catch here.
    const invoke = async (args, ctx) =>
      toToolResult(
        await entry.run({
          fleetApi,
          args,
          signal: ctx.mcpReq.signal,
          reportPhase: makePhaseReporter(ctx),
        }),
      );

    // The SDK passes (args, ctx) only when inputSchema is declared; without one
    // the context arrives as the single argument.
    server.registerTool(
      entry.name,
      config,
      entry.inputSchema ? (args, ctx) => invoke(args ?? {}, ctx) : (ctx) => invoke({}, ctx),
    );
  }

  return server;
}
```

- [ ] **Step 4: Write the HTTP app**

Create `mcp/http.mjs`:

```javascript
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { authenticate as defaultAuthenticate } from './auth.mjs';

export function createMcpHttpApp({ buildServer, authenticate = defaultAuthenticate } = {}) {
  if (typeof buildServer !== 'function') {
    throw new Error('createMcpHttpApp requires a buildServer function');
  }

  // createMcpExpressApp() enables Host header validation (DNS rebinding
  // protection) for localhost and parses JSON bodies, so no express.json().
  const app = createMcpExpressApp();

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.post('/mcp', authenticate, async (req, res) => {
    // Stateless: a fresh server and transport per request share nothing between
    // concurrent calls, and no MCP session ids are issued.
    const server = buildServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/mcp.test.mjs`
Expected: `# pass 8`, `# fail 0`.

- [ ] **Step 6: Verify the whole mock suite passes**

Run: `npm test`
Expected: `# fail 0` across all three files.

- [ ] **Step 7: Commit**

```bash
git add mcp/server.mjs mcp/http.mjs tests/mcp.test.mjs
git commit -m "feat: serve registry workflows as MCP tools over streamable HTTP"
```

---

## Task 7: The launcher

**Files:**
- Create: `mcp/main.mjs`

**Interfaces:**
- Consumes: `buildMcpServer` and `createMcpHttpApp` (Task 6).
- Produces: `startMcpServer({ fleetApi, port }) → Promise<{ server, close }>`, and a directly runnable `node mcp/main.mjs`.

- [ ] **Step 1: Write the launcher**

Create `mcp/main.mjs`:

```javascript
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureApralabs } from '../workflows/boilerplate/ensure-apralabs.mjs';
import { createMcpHttpApp } from './http.mjs';
import { buildMcpServer } from './server.mjs';

export async function startMcpServer({ fleetApi, port } = {}) {
  // Attach to `apra-fleet start` (where members + OAuth were provisioned) —
  // same reasoning as workflows/boilerplate/main.mjs.
  if (!process.env.APRA_FLEET_TRANSPORT) {
    process.env.APRA_FLEET_TRANSPORT = 'http';
  }
  ensureApralabs();

  let api = fleetApi;
  let transport = null;
  if (!api) {
    try {
      const { connectFleet } = await import('@apralabs/apra-fleet-client/server-resolution');
      const connected = await connectFleet({ env: process.env });
      api = connected.fleetApi;
      transport = connected.transport;
    } catch (err) {
      const detail = err?.message ?? err;
      throw new Error(
        `Fleet server is not running or connectFleet() failed: ${detail}\nStart it with: cd ~/.apra-fleet/bin && apra-fleet start`,
        { cause: err },
      );
    }
  }

  const app = createMcpHttpApp({ buildServer: () => buildMcpServer({ fleetApi: api }) });
  const listenPort = port ?? Number(process.env.PORT ?? 3000);
  // Bind loopback by default. Hosting this on a VM needs an explicit bind
  // address AND real authentication — see docs/mcp-interface.md.
  const server = app.listen(listenPort, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  console.log(`MCP server listening on http://127.0.0.1:${server.address().port}/mcp`);

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    transport?.stop?.();
  };
  return { server, close };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const { close } = await startMcpServer();
    const shutdown = async () => {
      await close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
```

- [ ] **Step 2: Verify the launcher fails loudly with no Fleet server** *(remote agent can do this)*

With no Fleet server running, run: `npm run mcp` — or, on a machine without a Fleet install,
`docker compose run --rm fleet npm run mcp`.
Expected: exit 1 and a message containing `Fleet server is not running` and `apra-fleet start`.

This is the one launcher behavior verifiable without a live server, because it is the failure
path. Steps 3 and 4 are host-only.

- [ ] **Step 3: HOST ONLY — verify it serves health with a Fleet server running**

Start Fleet (`cd ~/.apra-fleet/bin && apra-fleet start`), then in the repo run `npm run mcp` and, in another terminal:

```bash
curl -s http://127.0.0.1:3000/health
```

Expected: `{"ok":true}`, and the server terminal shows `MCP server listening on http://127.0.0.1:3000/mcp`.

- [ ] **Step 4: HOST ONLY — verify Ctrl+C returns the shell**

Press Ctrl+C in the server terminal.
Expected: the process exits and the shell prompt returns. A hang means the Fleet transport was not stopped.

- [ ] **Step 5: Commit**

```bash
git add mcp/main.mjs
git commit -m "feat: add the MCP server launcher with graceful shutdown"
```

---

## Task 8: Remove the chat layer

**Files:**
- Delete: `chat/app.mjs`, `chat/main.mjs`, `chat/router.mjs`, `chat/registry.mjs`, `chat/auth.mjs`, `chat/fleet-text.mjs`
- Delete: `tests/chat.test.mjs`

**Interfaces:**
- Consumes: nothing. Everything the chat layer provided now lives under `mcp/`.
- Produces: a tree with exactly one front door.

- [ ] **Step 1: Confirm nothing outside `chat/` imports from it**

Run: `rg -n "chat/" --glob '!chat/**' --glob '!docs/**' --glob '!node_modules/**' .`
Expected: matches only inside `tests/chat.test.mjs`, which this task deletes.

- [ ] **Step 2: Delete the chat layer and its test**

```bash
git rm -r chat tests/chat.test.mjs
```

- [ ] **Step 3: Verify the mock suite still passes**

Run: `npm test`
Expected: `# fail 0`. No module-resolution errors.

- [ ] **Step 4: Verify no source file references the removed layer**

Run: `rg -n "POST /chat|createChatApp|startChatServer|routeQuestion|defaultRegistry.*chat" --glob '!docs/**' .`
Expected: no matches.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: remove the chat front door now that MCP replaces it"
```

---

## Task 9: The live test — write only, do not run

**Environment:** A remote agent **writes this file and stops there.** It needs a real Fleet
server with provisioned members, which no remote environment has. The Docker mock path does not
help: `scripts/docker-entrypoint.sh` skips provisioning whenever `--test` is passed, which is
exactly the argument this test needs, so the container would start with no members registered.

Commit the file with its checkbox for Step 2 left unticked and flag it in the handoff. Do not
soften the assertions to make it pass somewhere else — an unrun live test is honest, whereas one
weakened until it passes without Fleet is worse than none.

**Files:**
- Create: `tests/mcp.live.test.mjs`

**Interfaces:**
- Consumes: `startMcpServer` (Task 7).
- Produces: nothing that later tasks depend on.

- [ ] **Step 1: Write the live test**

Create `tests/mcp.live.test.mjs`:

```javascript
import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { startMcpServer } = await import('../mcp/main.mjs');

// Real Fleet server, real members. Spends no LLM tokens: inspect-members makes
// no agent() call. Needs `apra-fleet start` and provisioned members.
test('inspect-members reports on live members over MCP', { timeout: 180000 }, async () => {
  const { server, close } = await startMcpServer({ port: 0 });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const client = new Client({ name: 'live-test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));

  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['boilerplate', 'inspect-members']);

    const result = await client.callTool({ name: 'inspect-members', arguments: {} });
    assert.equal(result.isError, undefined, `tool call failed: ${result.content?.[0]?.text}`);

    const report = JSON.parse(result.content[0].text);
    assert.deepEqual(
      report.members.map((entry) => entry.name),
      ['BOILERPLATE-DOER', 'BOILERPLATE-REVIEWER'],
    );
    for (const member of report.members) {
      assert.equal(member.present, true, `${member.name} should be registered`);
      assert.equal(member.report.exists, true, `${member.name} work folder should exist`);
    }
  } finally {
    await client.close();
    await close();
  }
});
```

- [ ] **Step 2: HOST ONLY — run it against a live Fleet**

With `apra-fleet start` running and members provisioned, run:

```bash
node --test tests/mcp.live.test.mjs
```

Expected: `# pass 1`, `# fail 0`.

A remote agent leaves this box unticked.

- [ ] **Step 3: Confirm it is excluded from `npm test`**

Run: `npm test`
Expected: three files run and `tests/mcp.live.test.mjs` is not among them, because `npm test` names files explicitly.

- [ ] **Step 4: Commit**

```bash
git add tests/mcp.live.test.mjs
git commit -m "test: exercise inspect-members over MCP against a live Fleet"
```

---

## Task 10: Documentation

**Files:**
- Create: `docs/mcp-interface.md`
- Delete: `docs/chat-interface.md`
- Modify: `README.md`, `docs/architecture.md`, `docs/development.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code depends on.

- [ ] **Step 1: Write `docs/mcp-interface.md`**

It must cover, at minimum:

- **Setup:** `npm install`, `apra-fleet start`, `provision-members.sh`, `npm run mcp`, then `claude mcp add --transport http fleet http://127.0.0.1:3000/mcp`.
- **Tool catalog:** `boilerplate` (no arguments, spends tokens, not read-only) and `inspect-members` (`members`, `includeFiles`, read-only, no tokens).
- **Registry contract:** the `{ name, description, inputSchema?, annotations?, run({ fleetApi, args, signal, reportPhase }) }` shape, that `inputSchema` is a `z.object(...)`, that omitting it means no arguments, and that a thrown `run` becomes an `isError` result automatically.
- **Adding a workflow:** append to `mcp/registry.mjs`; no changes to `server.mjs` or `http.mjs`.
- **Execution model:** one request/response per tool call; `phase()`/`log()` output goes to the server's terminal, while Claude sees only heartbeat messages and the final result.
- **Timeouts**, copied from the spec:

| Timer | Default | Notes |
|---|---|---|
| Wall clock per tool call | ~28 hours | `MCP_TOOL_TIMEOUT`, or per-server `timeout` in `.mcp.json`. Progress does not extend it. |
| First response byte | 60 seconds | HTTP/SSE only. Rises only if `timeout` / `MCP_TOOL_TIMEOUT` is ≥60s. |
| Idle | 5 minutes | Aborts a call sending neither a response nor progress. `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`; `0` disables. |

  State plainly that the heartbeat only fires when the client requests progress, and that the reliable fix for a slow workflow is `"timeout": 600000` in that server's `.mcp.json` entry.
- **Cancellation:** cooperative, checked between phases; it stops the next phase rather than the current one.
- **Replacing the auth stub:** inject via `createMcpHttpApp({ authenticate })`.
- **Hosting:** loopback bind by default; a VM or container needs an explicit bind address plus `requireBearerAuth` from `@modelcontextprotocol/express` and `claude mcp add --header "Authorization: Bearer …"`.
- **Output limits:** Claude Code warns above 10,000 tokens and truncates at 25,000 (`MAX_MCP_OUTPUT_TOKENS`); `inspect.py` caps its listing at 50 entries.
- **Troubleshooting:** `connectFleet() failed` → start Fleet; `OAuth session expired` → re-auth the doer; tool not chosen → improve its `description`; call times out → set `timeout` in `.mcp.json`.

- [ ] **Step 2: Delete the chat reference**

```bash
git rm docs/chat-interface.md
```

- [ ] **Step 3: Update `README.md`**

- Replace the `## Chat interface` section with an MCP section showing `npm run mcp` and `claude mcp add --transport http fleet http://127.0.0.1:3000/mcp`.
- In the "How it works" diagram, replace the `chat/ POST /chat` box with `mcp/ POST /mcp — one MCP tool per registry entry`.
- In "Layout", replace the `chat/` block with `mcp/` (`main.mjs`, `server.mjs`, `http.mjs`, `registry.mjs`, `auth.mjs`, `fleet-text.mjs`) and add `workflows/inspect-members/`.
- Update the `tests/` list: drop `chat.test.mjs`, add `inspect-members.test.mjs`, `mcp.test.mjs`, `mcp.live.test.mjs`.
- Fix the line stating REVIEWER is "registered so a later product can dispatch to a second member" — `inspect-members` now inspects it.
- Update "Further reading" to point at `docs/mcp-interface.md`.

- [ ] **Step 4: Update `docs/architecture.md`**

- **Most important:** the Fleet concepts section says "This repo is purely an MCP **client**; there is no MCP server code here." Replace it with an explanation that the process is now an MCP server on top and an MCP client to Fleet underneath.
- Update the layer diagram, replacing the `chat/` box with `mcp/`.
- Replace the `chat/` module map table with the `mcp/` one from this plan's File Structure.
- Replace the "A chat request" data-flow block with a tool-call flow, and note the heartbeat.
- In "Where state lives", delete the chat-sessions row and note that the MCP layer holds no state.
- In "Extension points", change "A new routable workflow" to reference `mcp/registry.mjs`.
- Add the two new design decisions: no internal router because the connected model already routes, and the SDK does not implement MCP Tasks so a heartbeat plus client configuration covers slow workflows.

- [ ] **Step 5: Update `docs/development.md`**

- In the "Running things" table, drop `tests/chat.test.mjs` and `npm run chat`; add `tests/inspect-members.test.mjs`, `tests/mcp.test.mjs` (no server, no token), `tests/mcp.live.test.mjs` (server, no token), `npm run mcp` (server, token only for `boilerplate`), and `python3 workflows/inspect-members/inspect.py --root workdir/BOILERPLATE-DOER`.
- Replace the `curl … /chat` example with the `claude mcp add` flow.
- In "Testing", replace the `chat.test.mjs` mention and explain that `tests/mcp.test.mjs` drives a real MCP client over a real port.
- In "Adding a workflow", change step 3 to append to `mcp/registry.mjs` with the new signature:

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

- Note that a thrown `run` becomes an `isError` result, replacing the old "returns 502" sentence.
- In "Troubleshooting", replace the two chat rows with: a tool never being chosen (fix the `description`) and a tool call timing out (set `"timeout"` in `.mcp.json`).

- [ ] **Step 6: Verify no stale references remain**

Run: `rg -n "POST /chat|npm run chat|chat/registry|chat-interface|chat\.test|createChatApp|sessionId" README.md docs/`
Expected: no matches.

- [ ] **Step 7: Verify the documented commands actually work**

Run: `npm test`
Expected: `# fail 0`.

Run: `python3 workflows/inspect-members/inspect.py --root workdir/BOILERPLATE-DOER`
Expected: one line of JSON with `"exists": true`.

- [ ] **Step 8: Commit**

```bash
git add README.md docs/
git commit -m "docs: document the MCP interface and retire the chat references"
```

---

## Final verification

### The remote agent completes these

- [ ] The mock suite passes with no Fleet server and no tokens: `docker compose run --rm fleet node --test tests/boilerplate.test.mjs tests/inspect-members.test.mjs tests/mcp.test.mjs`
- [ ] `npm run mcp` with no Fleet server exits 1 with the `apra-fleet start` hint.
- [ ] `rg -n "from '\.\./mcp/" workflows/` returns nothing — no workflow imports the MCP layer.
- [ ] No `chat/` directory exists and `rg -n "POST /chat" .` returns nothing.
- [ ] `tests/mcp.live.test.mjs` exists and is excluded from `npm test`.

### Handoff to the host machine

State plainly in the handoff which of these remain unverified, then run them locally:

- [ ] `npm test` passes on a machine with Fleet installed.
- [ ] `npm run mcp` starts, prints its URL, and `curl http://127.0.0.1:3000/health` returns `{"ok":true}`.
- [ ] Ctrl+C exits cleanly and returns the shell.
- [ ] `node --test tests/mcp.live.test.mjs` passes against a live Fleet.
- [ ] `claude mcp add --transport http fleet http://127.0.0.1:3000/mcp` connects and a Claude session lists both tools.
- [ ] Asking that session to check fleet health calls `inspect-members` and returns a report naming both members.
- [ ] Asking it to run the demo calls `boilerplate` and the reply contains `pong`.
- [ ] Observe whether Claude Code sends a `progressToken`. If it does not, the heartbeat never fires and `docs/mcp-interface.md` should lead with the `"timeout"` setting as the fix rather than presenting it as a fallback.
