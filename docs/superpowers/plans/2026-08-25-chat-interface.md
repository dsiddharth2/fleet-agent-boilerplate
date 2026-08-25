# Express /chat Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a top-level multi-turn `POST /chat` Express layer that LLM-routes each question to a registered workflow (via BOILERPLATE-DOER) or answers it directly, with an injectable authentication stub.

**Architecture:** A `chat/` layer at the repo root, ABOVE `workflows/` — never inside it. A pure app factory `createChatApp({ fleetApi, registry, authenticate })` validates input, asks DOER to classify the question against a workflow registry (`chat/registry.mjs`), then either runs the matched workflow's adapter or answers directly via `fleetApi.executePrompt`. Per-session history lives in an in-memory Map. A thin launcher `chat/main.mjs` connects to the running Fleet server.

**Tech Stack:** Node 22+ ESM, Express 5, `node:test` + built-in `fetch` for tests, `@apralabs/apra-fleet-client` resolved via the `node_modules/@apralabs` link (never a package.json dependency).

**Spec:** `docs/superpowers/specs/2026-08-25-chat-interface-design.md`

## Global Constraints

- Node.js 22.16+; all files ESM (`.mjs` or `"type": "module"`).
- The chat layer lives in `chat/` at the repo root — it is NOT a workflow and nothing under `workflows/` may import from `chat/`.
- The root `package.json` MUST NOT depend on `@apralabs/apra-fleet-workflow` or `@apralabs/apra-fleet-client` — they resolve from `~/.apra-fleet/node_modules` via the `node_modules/@apralabs` link (README rule).
- Every direct `fleetApi.executePrompt` call (routing AND direct answers) MUST pass `resume: false` explicitly — the raw client defaults `resume` to `true` when omitted (verified in `apra-fleet-client/src/client/api.mjs`).
- Member name for routing and direct replies: `BOILERPLATE-DOER` (exact string).
- No tokens or secrets in source, prompts, or tests. `.token` stays gitignored.
- Must work on Windows without admin rights (junction, not plain symlink).
- Git: commit on `feature/chat-interface` only; commit messages are plain (no AI attribution, no Co-Authored-By); NEVER push to main/master/development.
- All commands below run from the repo root: `C:\2_WorkSpace\Apra-Fleet-Agents\fleet-agent-boilerplate`.

---

### Task 1: Root package.json, Express install, Windows-safe ensure-apralabs

**Files:**
- Create: `package.json`
- Modify: `workflows/boilerplate/ensure-apralabs.mjs:33`
- Test: existing `tests/boilerplate.test.mjs` (regression gate)

**Interfaces:**
- Consumes: nothing.
- Produces: `express` importable from repo root; `ensureApralabs()` (unchanged signature, now recreates the link as a junction on Windows); `npm test` runs both test files; `npm run chat` starts the server (file arrives in Task 8).

- [ ] **Step 1: Create `package.json` at the repo root**

```json
{
  "name": "fleet-agent-boilerplate",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.16"
  },
  "scripts": {
    "test": "node --test tests/boilerplate.test.mjs tests/chat.test.mjs",
    "chat": "node chat/main.mjs"
  },
  "dependencies": {
    "express": "^5.1.0"
  }
}
```

- [ ] **Step 2: Fix the symlink type in `ensure-apralabs.mjs`**

Change line 33 from:

```js
    fs.symlinkSync(src, dest);
```

to:

```js
    // 'junction' needs no admin rights on Windows; the type arg is ignored on POSIX.
    fs.symlinkSync(src, dest, 'junction');
```

- [ ] **Step 3: Install and prove the link self-heals without admin**

```bash
rm -rf node_modules/@apralabs   # remove any hand-made link
npm install
node --test tests/boilerplate.test.mjs
```

Expected: `npm install` succeeds; the boilerplate test prints `pass 1` — which proves `ensureApralabs()` recreated `node_modules/@apralabs` as a junction with no EPERM.

- [ ] **Step 4: Verify express resolves**

```bash
node -e "import('express').then(m => console.log('express ok', typeof m.default))"
```

Expected: `express ok function`

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json workflows/boilerplate/ensure-apralabs.mjs
git commit -m "feat: add root package.json with express; use junction symlink for Windows"
```

---

### Task 2: Authentication stub and shared text extraction

**Files:**
- Create: `chat/auth.mjs`
- Create: `chat/fleet-text.mjs`
- Create: `chat/package.json`
- Test: `tests/chat.test.mjs` (new file, first tests)

**Interfaces:**
- Consumes: nothing.
- Produces: `authenticate(req, res, next)` — Express middleware; sets `req.user = { id: 'anonymous' }` then calls `next()`. `toolText(result)` — extracts reply text from a fleet tool result (`structuredContent.response` first, else joined `content[].text`). Tasks 3–5 import both.

- [ ] **Step 1: Create `chat/package.json`** (marks the folder ESM, same as `workflows/boilerplate/package.json`)

```json
{
  "type": "module"
}
```

- [ ] **Step 2: Write the failing tests — create `tests/chat.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { authenticate } = await import('../chat/auth.mjs');
const { toolText } = await import('../chat/fleet-text.mjs');

test('authenticate stub sets req.user and calls next', () => {
  const req = {};
  let nextCalled = false;
  authenticate(req, null, () => {
    nextCalled = true;
  });
  assert.deepEqual(req.user, { id: 'anonymous' });
  assert.ok(nextCalled, 'next() must be called');
});

test('toolText prefers structuredContent.response, falls back to content text', () => {
  assert.equal(
    toolText({ content: [{ type: 'text', text: 'ignored' }], structuredContent: { response: 'answer' } }),
    'answer',
  );
  assert.equal(toolText({ content: [{ type: 'text', text: 'from-content' }] }), 'from-content');
  assert.equal(toolText('plain string'), 'plain string');
  assert.equal(toolText(null), '');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/chat.test.mjs`
Expected: FAIL — `Cannot find module ... chat/auth.mjs`

- [ ] **Step 4: Write `chat/auth.mjs`**

```js
// Authentication stub. Replace this middleware with real auth (JWT, API key, ...)
// and inject it via createChatApp({ authenticate }); routes rely only on req.user.
export function authenticate(req, res, next) {
  req.user = { id: 'anonymous' };
  next();
}
```

- [ ] **Step 5: Write `chat/fleet-text.mjs`** (same extraction shape as `toolText()` in `workflows/boilerplate/boilerplate.js`)

```js
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

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/chat.test.mjs`
Expected: PASS (`pass 2`)

- [ ] **Step 7: Commit**

```bash
git add chat/auth.mjs chat/fleet-text.mjs chat/package.json tests/chat.test.mjs
git commit -m "feat: add chat auth stub and shared fleet text extraction"
```

---

### Task 3: Workflow registry

**Files:**
- Create: `chat/registry.mjs`
- Test: `tests/chat.test.mjs` (append)

**Interfaces:**
- Consumes: `runBoilerplate({ fleetApi })` from `workflows/boilerplate/main.mjs` (existing).
- Produces: `defaultRegistry` — `Array<{ name: string, description: string, run({ fleetApi, message, history }) => Promise<string> }>` with one `boilerplate` entry. Tasks 4–5 consume this exact shape.

- [ ] **Step 1: Append registry tests to `tests/chat.test.mjs`**

```js
// --- registry tests ---

const { defaultRegistry } = await import('../chat/registry.mjs');

// Full mock: enough surface for runBoilerplate's engine phases
// (same shape as tests/boilerplate.test.mjs).
function createFullMockFleetApi() {
  const registerCalls = [];
  return {
    async registerMember(options) {
      registerCalls.push(options);
      return { content: [{ type: 'text', text: `registered ${options.friendly_name}` }] };
    },
    async fleetStatus() {
      const names = registerCalls.map((call) => call.friendly_name);
      return { content: [{ type: 'text', text: names.join('\n') }] };
    },
    async executeCommand() {
      return {
        content: [{ type: 'text', text: 'hello-from-python' }],
        structuredContent: { stdout: 'hello-from-python', exitCode: 0 },
      };
    },
    async executePrompt() {
      return { content: [{ type: 'text', text: 'pong' }], structuredContent: { response: 'pong' } };
    },
  };
}

test('defaultRegistry entries have the routable shape', () => {
  assert.ok(defaultRegistry.length >= 1);
  for (const entry of defaultRegistry) {
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.name.length > 0);
    assert.equal(typeof entry.description, 'string');
    assert.ok(entry.description.length > 0);
    assert.equal(typeof entry.run, 'function');
  }
  assert.ok(defaultRegistry.some((entry) => entry.name === 'boilerplate'));
});

test('boilerplate registry entry runs the workflow and returns a summary string', async () => {
  const entry = defaultRegistry.find((candidate) => candidate.name === 'boilerplate');
  const reply = await entry.run({ fleetApi: createFullMockFleetApi(), message: 'run the demo', history: [] });
  assert.equal(typeof reply, 'string');
  assert.match(reply, /boilerplate workflow completed/);
  assert.match(reply, /pong/);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test tests/chat.test.mjs`
Expected: FAIL — `Cannot find module ... chat/registry.mjs` (earlier tests still pass)

- [ ] **Step 3: Write `chat/registry.mjs`**

```js
import { runBoilerplate } from '../workflows/boilerplate/main.mjs';

// Routable workflows. To make a new workflow routable, append
// { name, description, run } here — no router or route changes needed.
// `description` is what the LLM router reads to pick a workflow; write it
// for a classifier, not a human changelog.
export const defaultRegistry = [
  {
    name: 'boilerplate',
    description:
      'Runs the boilerplate demo workflow end to end: registers BOILERPLATE members, ' +
      'runs the dummy python command, the transform, and the agent smoke test. ' +
      'Choose this when the user asks to run the demo/boilerplate workflow or to verify fleet plumbing.',
    async run({ fleetApi }) {
      const result = await runBoilerplate({ fleetApi });
      return `boilerplate workflow completed: ${JSON.stringify(result)}`;
    },
  },
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/chat.test.mjs`
Expected: PASS (`pass 4`, `fail 0`)

- [ ] **Step 5: Commit**

```bash
git add chat/registry.mjs tests/chat.test.mjs
git commit -m "feat: add workflow registry with boilerplate entry"
```

---

### Task 4: LLM router

**Files:**
- Create: `chat/router.mjs`
- Test: `tests/chat.test.mjs` (append)

**Interfaces:**
- Consumes: `toolText` from Task 2; registry entry shape from Task 3.
- Produces: `DOER = 'BOILERPLATE-DOER'`; `buildRoutePrompt(registry, message) → string`; `routeQuestion({ fleetApi, registry, message, memberName = DOER }) → Promise<entry | null>` (null = answer directly). Task 5 calls `routeQuestion` on every `/chat` request.

- [ ] **Step 1: Append router tests to `tests/chat.test.mjs`**

```js
// --- router tests ---

const { buildRoutePrompt, routeQuestion, DOER } = await import('../chat/router.mjs');

function createRoutingMockFleetApi(replyText) {
  const promptCalls = [];
  return {
    promptCalls,
    async executePrompt(options) {
      promptCalls.push(options);
      return { content: [{ type: 'text', text: replyText }], structuredContent: { response: replyText } };
    },
  };
}

const sampleRegistry = [
  { name: 'boilerplate', description: 'runs the demo workflow', run: async () => 'done' },
];

test('buildRoutePrompt lists workflows, the question, and the NONE escape', () => {
  const prompt = buildRoutePrompt(sampleRegistry, 'please run the demo');
  assert.match(prompt, /boilerplate: runs the demo workflow/);
  assert.match(prompt, /please run the demo/);
  assert.match(prompt, /NONE/);
});

test('routeQuestion returns the entry DOER names, dispatched with resume false', async () => {
  const fleetApi = createRoutingMockFleetApi('boilerplate');
  const entry = await routeQuestion({ fleetApi, registry: sampleRegistry, message: 'run the demo' });
  assert.equal(entry, sampleRegistry[0]);
  assert.equal(fleetApi.promptCalls.length, 1);
  assert.equal(fleetApi.promptCalls[0].member_name, DOER);
  assert.equal(fleetApi.promptCalls[0].resume, false);
});

test('routeQuestion tolerates case and surrounding whitespace in the reply', async () => {
  const fleetApi = createRoutingMockFleetApi('  Boilerplate\n');
  const entry = await routeQuestion({ fleetApi, registry: sampleRegistry, message: 'demo please' });
  assert.equal(entry, sampleRegistry[0]);
});

test('routeQuestion returns null on NONE, garbage, or an empty registry', async () => {
  assert.equal(
    await routeQuestion({ fleetApi: createRoutingMockFleetApi('NONE'), registry: sampleRegistry, message: 'hi' }),
    null,
  );
  assert.equal(
    await routeQuestion({ fleetApi: createRoutingMockFleetApi('no idea, maybe ask someone'), registry: sampleRegistry, message: 'hi' }),
    null,
  );
  const emptyRegistryApi = createRoutingMockFleetApi('boilerplate');
  assert.equal(await routeQuestion({ fleetApi: emptyRegistryApi, registry: [], message: 'hi' }), null);
  assert.equal(emptyRegistryApi.promptCalls.length, 0, 'empty registry must not spend an LLM call');
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test tests/chat.test.mjs`
Expected: FAIL — `Cannot find module ... chat/router.mjs` (earlier tests still pass)

- [ ] **Step 3: Write `chat/router.mjs`**

```js
import { toolText } from './fleet-text.mjs';

export const DOER = 'BOILERPLATE-DOER';
export const NO_WORKFLOW = 'NONE';

export function buildRoutePrompt(registry, message) {
  const lines = registry
    .map((entry) => `- ${entry.name}: ${entry.description}`)
    .join('\n');
  return [
    'You are a router for a fleet of workflows. Pick the single best workflow for the user question.',
    'Workflows:',
    lines,
    `Question: ${message}`,
    `Reply with exactly one workflow name from the list, or ${NO_WORKFLOW} if no workflow fits. No other text.`,
  ].join('\n');
}

// Returns the matched registry entry, or null when DOER should answer directly.
export async function routeQuestion({ fleetApi, registry, message, memberName = DOER }) {
  if (!registry || registry.length === 0) return null;
  const result = await fleetApi.executePrompt({
    prompt: buildRoutePrompt(registry, message),
    member_name: memberName,
    // The raw client defaults resume to true; routing prompts are self-contained.
    resume: false,
  });
  const answer = toolText(result).trim().toLowerCase();
  return registry.find((entry) => entry.name.toLowerCase() === answer) ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/chat.test.mjs`
Expected: PASS (`pass 8`, `fail 0`)

- [ ] **Step 5: Commit**

```bash
git add chat/router.mjs tests/chat.test.mjs
git commit -m "feat: add LLM router that classifies questions against the workflow registry"
```

---

### Task 5: Chat app factory — POST /chat (routed + direct) and GET /health

**Files:**
- Create: `chat/app.mjs`
- Test: `tests/chat.test.mjs` (append)

**Interfaces:**
- Consumes: `authenticate` (Task 2), `toolText` (Task 2), `defaultRegistry` (Task 3), `routeQuestion`/`DOER` (Task 4).
- Produces: `createChatApp({ fleetApi, registry = defaultRegistry, authenticate?, memberName = DOER, maxHistory = 20 })` → Express app with `POST /chat` (`{ message, sessionId? }` → `200 { sessionId, reply, workflow }`) and `GET /health`. Tasks 6–8 build on exactly these names.

- [ ] **Step 1: Append app tests to `tests/chat.test.mjs`**

Note the pattern used from here on: tests of the DIRECT path pass `registry: []` so no
routing LLM call happens (one `executePrompt` per message); tests of the ROUTED path use
a registry plus a scripted mock whose first reply is the classification.

```js
// --- chat app tests ---

const { createChatApp } = await import('../chat/app.mjs');

function createScriptedMockFleetApi(replies) {
  const promptCalls = [];
  let index = 0;
  return {
    promptCalls,
    async executePrompt(options) {
      promptCalls.push(options);
      const text = replies[Math.min(index++, replies.length - 1)];
      return { content: [{ type: 'text', text }], structuredContent: { response: text } };
    },
  };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postChat(base, body) {
  const res = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('GET /health responds ok', async () => {
  const app = createChatApp({ fleetApi: createScriptedMockFleetApi(['x']) });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('direct path: DOER answers, response carries workflow "direct" and a generated sessionId', async () => {
  const fleetApi = createScriptedMockFleetApi(['hello there']);
  const app = createChatApp({ fleetApi, registry: [] });
  await withServer(app, async (base) => {
    const { status, body } = await postChat(base, { message: 'hi doer' });
    assert.equal(status, 200);
    assert.equal(body.reply, 'hello there');
    assert.equal(body.workflow, 'direct');
    assert.match(body.sessionId, /^[0-9a-f-]{36}$/);

    assert.equal(fleetApi.promptCalls.length, 1);
    const call = fleetApi.promptCalls[0];
    assert.equal(call.member_name, 'BOILERPLATE-DOER');
    assert.equal(call.resume, false);
    assert.match(call.prompt, /hi doer/);
  });
});

test('routed path: classification hits a registry entry, its run() answers', async () => {
  // First executePrompt call = router classification.
  const fleetApi = createScriptedMockFleetApi(['demo']);
  const runCalls = [];
  const registry = [
    {
      name: 'demo',
      description: 'demo workflow',
      run: async ({ message, history }) => {
        runCalls.push({ message, history });
        return 'demo workflow ran';
      },
    },
  ];
  const app = createChatApp({ fleetApi, registry });
  await withServer(app, async (base) => {
    const { status, body } = await postChat(base, { message: 'please run the demo' });
    assert.equal(status, 200);
    assert.equal(body.workflow, 'demo');
    assert.equal(body.reply, 'demo workflow ran');
    assert.equal(runCalls.length, 1);
    assert.equal(runCalls[0].message, 'please run the demo');
    // Only the classification call reached the fleet; the answer came from run().
    assert.equal(fleetApi.promptCalls.length, 1);
  });
});

test('createChatApp throws without fleetApi', () => {
  assert.throws(() => createChatApp({}), /fleetApi/);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test tests/chat.test.mjs`
Expected: FAIL — `Cannot find module ... chat/app.mjs` (earlier tests still pass)

- [ ] **Step 3: Write `chat/app.mjs`**

```js
import crypto from 'node:crypto';
import express from 'express';
import { authenticate as defaultAuthenticate } from './auth.mjs';
import { toolText } from './fleet-text.mjs';
import { defaultRegistry } from './registry.mjs';
import { routeQuestion, DOER } from './router.mjs';

const MAX_HISTORY = 20; // messages kept per session (user + assistant combined)

function buildDirectPrompt(history, message) {
  const transcript = [...history, { role: 'user', content: message }]
    .map((entry) => `${entry.role}: ${entry.content}`)
    .join('\n');
  return [
    'You are a helpful assistant in a chat conversation.',
    'Conversation so far:',
    transcript,
    "Reply with only the assistant's next message, no preamble.",
  ].join('\n');
}

export function createChatApp({
  fleetApi,
  registry = defaultRegistry,
  authenticate = defaultAuthenticate,
  memberName = DOER,
  maxHistory = MAX_HISTORY,
} = {}) {
  if (!fleetApi) {
    throw new Error('createChatApp requires fleetApi');
  }
  const sessions = new Map();
  const app = express();
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.post('/chat', authenticate, async (req, res) => {
    const { message, sessionId } = req.body ?? {};
    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: 'message (non-empty string) is required' });
      return;
    }
    const id = typeof sessionId === 'string' && sessionId !== '' ? sessionId : crypto.randomUUID();
    const history = sessions.get(id) ?? [];

    let reply;
    let workflowName = 'direct';
    try {
      const entry = await routeQuestion({ fleetApi, registry, message, memberName });
      if (entry) {
        workflowName = entry.name;
        reply = await entry.run({ fleetApi, message, history });
      } else {
        const result = await fleetApi.executePrompt({
          prompt: buildDirectPrompt(history, message),
          member_name: memberName,
          // The raw client defaults resume to true; chat prompts are self-contained.
          resume: false,
        });
        if (result?.structuredContent?.isError) {
          res.status(502).json({ error: toolText(result) || 'agent dispatch failed' });
          return;
        }
        reply = toolText(result);
      }
    } catch (err) {
      res.status(502).json({ error: err?.message ?? String(err) });
      return;
    }

    history.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    sessions.set(id, history.slice(-maxHistory));
    res.json({ sessionId: id, reply, workflow: workflowName });
  });

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/chat.test.mjs`
Expected: PASS (`pass 12`, `fail 0`)

- [ ] **Step 5: Commit**

```bash
git add chat/app.mjs tests/chat.test.mjs
git commit -m "feat: add POST /chat with LLM-routed workflow dispatch and direct answers"
```

---

### Task 6: Multi-turn sessions and history cap

**Files:**
- Modify: `chat/app.mjs` (only if a test fails — Task 5's code already stores history; these tests pin the behavior)
- Test: `tests/chat.test.mjs` (append)

**Interfaces:**
- Consumes: `createChatApp`, `createScriptedMockFleetApi`, `withServer`, `postChat` from Task 5.
- Produces: pinned behavior — the direct prompt of turn N contains all prior turns of that session (up to `maxHistory`); sessions are isolated; routed exchanges also land in history.

- [ ] **Step 1: Append the multi-turn tests to `tests/chat.test.mjs`**

```js
test('same sessionId includes prior exchange in the direct prompt', async () => {
  const fleetApi = createScriptedMockFleetApi(['first answer', 'second answer']);
  const app = createChatApp({ fleetApi, registry: [] });
  await withServer(app, async (base) => {
    const first = await postChat(base, { message: 'my name is Sid' });
    const second = await postChat(base, {
      message: 'what is my name?',
      sessionId: first.body.sessionId,
    });

    assert.equal(second.status, 200);
    assert.equal(second.body.sessionId, first.body.sessionId);
    assert.equal(second.body.reply, 'second answer');

    const secondPrompt = fleetApi.promptCalls[1].prompt;
    assert.match(secondPrompt, /user: my name is Sid/);
    assert.match(secondPrompt, /assistant: first answer/);
    assert.match(secondPrompt, /user: what is my name\?/);
  });
});

test('sessions are isolated from each other', async () => {
  const fleetApi = createScriptedMockFleetApi(['a', 'b']);
  const app = createChatApp({ fleetApi, registry: [] });
  await withServer(app, async (base) => {
    await postChat(base, { message: 'secret-alpha' });
    await postChat(base, { message: 'hello from session two' });
    const secondPrompt = fleetApi.promptCalls[1].prompt;
    assert.doesNotMatch(secondPrompt, /secret-alpha/);
  });
});

test('history is capped at maxHistory messages', async () => {
  const fleetApi = createScriptedMockFleetApi(['r1', 'r2', 'r3']);
  // maxHistory 2 keeps only the latest user+assistant pair between requests.
  const app = createChatApp({ fleetApi, registry: [], maxHistory: 2 });
  await withServer(app, async (base) => {
    const first = await postChat(base, { message: 'oldest message' });
    const sid = first.body.sessionId;
    await postChat(base, { message: 'middle message', sessionId: sid });
    await postChat(base, { message: 'newest message', sessionId: sid });

    const thirdPrompt = fleetApi.promptCalls[2].prompt;
    assert.doesNotMatch(thirdPrompt, /oldest message/);
    assert.match(thirdPrompt, /user: middle message/);
    assert.match(thirdPrompt, /assistant: r2/);
    assert.match(thirdPrompt, /user: newest message/);
  });
});

test('a routed exchange is remembered in the session history', async () => {
  // Call 1: classification → 'demo'; call 2: classification → NONE; call 3: direct answer.
  const fleetApi = createScriptedMockFleetApi(['demo', 'NONE', 'follow-up answer']);
  const registry = [
    { name: 'demo', description: 'demo workflow', run: async () => 'demo workflow ran' },
  ];
  const app = createChatApp({ fleetApi, registry });
  await withServer(app, async (base) => {
    const first = await postChat(base, { message: 'run the demo' });
    assert.equal(first.body.workflow, 'demo');

    const second = await postChat(base, { message: 'what just happened?', sessionId: first.body.sessionId });
    assert.equal(second.body.workflow, 'direct');
    const directPrompt = fleetApi.promptCalls[2].prompt;
    assert.match(directPrompt, /user: run the demo/);
    assert.match(directPrompt, /assistant: demo workflow ran/);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/chat.test.mjs`
Expected: PASS (`pass 16`, `fail 0`) — Task 5's implementation already covers this. If any fail, fix `chat/app.mjs` history handling (record AFTER a successful reply — routed or direct; trim with `history.slice(-maxHistory)`) until they pass; do not weaken the assertions.

- [ ] **Step 3: Commit**

```bash
git add tests/chat.test.mjs chat/app.mjs
git commit -m "test: pin multi-turn session behavior, isolation, and history cap for /chat"
```

---

### Task 7: Validation, failure handling, and auth injectability

**Files:**
- Modify: `chat/app.mjs` (only if a test fails — Task 5's code implements these paths; these tests pin them)
- Test: `tests/chat.test.mjs` (append)

**Interfaces:**
- Consumes: everything from Tasks 2–6.
- Produces: pinned error contract — `400` bad input (no fleet call), `502` on routing/direct/adapter failure (failed turn forgotten), custom `authenticate` can reject with `401`.

- [ ] **Step 1: Append the error-path tests to `tests/chat.test.mjs`**

```js
test('POST /chat without a message returns 400 and never calls the fleet', async () => {
  const fleetApi = createScriptedMockFleetApi(['x']);
  const app = createChatApp({ fleetApi, registry: [] });
  await withServer(app, async (base) => {
    for (const body of [{}, { message: '' }, { message: '   ' }, { message: 42 }]) {
      const res = await postChat(base, body);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.match(res.body.error, /message/);
    }
    assert.equal(fleetApi.promptCalls.length, 0);
  });
});

test('502 when executePrompt rejects, and the failed turn is forgotten', async () => {
  let shouldFail = true;
  const promptCalls = [];
  const fleetApi = {
    promptCalls,
    async executePrompt(options) {
      promptCalls.push(options);
      if (shouldFail) throw new Error('member offline');
      return { content: [{ type: 'text', text: 'recovered' }], structuredContent: { response: 'recovered' } };
    },
  };
  const app = createChatApp({ fleetApi, registry: [] });
  await withServer(app, async (base) => {
    const failed = await postChat(base, { message: 'doomed message', sessionId: 'fixed-session' });
    assert.equal(failed.status, 502);
    assert.match(failed.body.error, /member offline/);

    shouldFail = false;
    await postChat(base, { message: 'next message', sessionId: 'fixed-session' });
    // The failed turn must not appear in the next prompt's transcript.
    assert.doesNotMatch(promptCalls[1].prompt, /doomed message/);
  });
});

test('502 when the direct answer is an error payload', async () => {
  const fleetApi = {
    async executePrompt() {
      return {
        content: [{ type: 'text', text: 'OAuth session expired' }],
        structuredContent: { isError: true, reason: 'auth' },
      };
    },
  };
  const app = createChatApp({ fleetApi, registry: [] });
  await withServer(app, async (base) => {
    const res = await postChat(base, { message: 'hi' });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /OAuth session expired/);
  });
});

test('502 when a routed workflow adapter throws, and the turn is forgotten', async () => {
  // Call 1: classification → 'demo' (adapter throws); call 2: NONE; call 3: direct answer.
  const fleetApi = createScriptedMockFleetApi(['demo', 'NONE', 'later answer']);
  const registry = [
    {
      name: 'demo',
      description: 'demo workflow',
      run: async () => {
        throw new Error('workflow exploded');
      },
    },
  ];
  const app = createChatApp({ fleetApi, registry });
  await withServer(app, async (base) => {
    const failed = await postChat(base, { message: 'run the demo', sessionId: 'wf-session' });
    assert.equal(failed.status, 502);
    assert.match(failed.body.error, /workflow exploded/);

    await postChat(base, { message: 'hello again', sessionId: 'wf-session' });
    const directPrompt = fleetApi.promptCalls[2].prompt;
    assert.doesNotMatch(directPrompt, /run the demo/);
  });
});

test('an injected authenticate middleware can reject requests', async () => {
  const fleetApi = createScriptedMockFleetApi(['x']);
  const rejectAll = (req, res, next) => {
    res.status(401).json({ error: 'unauthorized' });
  };
  const app = createChatApp({ fleetApi, registry: [], authenticate: rejectAll });
  await withServer(app, async (base) => {
    const res = await postChat(base, { message: 'hi' });
    assert.equal(res.status, 401);
    assert.equal(fleetApi.promptCalls.length, 0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/chat.test.mjs`
Expected: PASS (`pass 21`, `fail 0`). If a pinned path fails, fix `chat/app.mjs` to match the spec's error table (400 before any fleet call; 502 on throw or `structuredContent.isError` from routing, direct answer, or adapter; failed turns not stored) — do not weaken the assertions.

- [ ] **Step 3: Run the full suite (regression gate)**

Run: `npm test`
Expected: both files pass — boilerplate `pass 1`, chat `pass 21`, `fail 0` overall.

- [ ] **Step 4: Commit**

```bash
git add tests/chat.test.mjs chat/app.mjs
git commit -m "test: pin /chat validation, failure handling, and auth injection"
```

---

### Task 8: Live launcher, documentation (README + docs/chat-interface.md), and live smoke

**Files:**
- Create: `chat/main.mjs`
- Create: `docs/chat-interface.md`
- Modify: `README.md` (add a "Chat interface" section after "Live run on this machine")

**Interfaces:**
- Consumes: `createChatApp` from Task 5; `ensureApralabs` from `workflows/boilerplate/ensure-apralabs.mjs`; `connectFleet` from `@apralabs/apra-fleet-client/server-resolution`.
- Produces: `npm run chat` / `node chat/main.mjs` starts the server on `PORT` (default 3000). Exports `startChatServer({ fleetApi, port } = {})` for reuse.

- [ ] **Step 1: Write `chat/main.mjs`** (same launcher shape as `workflows/boilerplate/main.mjs`)

```js
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureApralabs } from '../workflows/boilerplate/ensure-apralabs.mjs';
import { createChatApp } from './app.mjs';

export async function startChatServer({ fleetApi, port } = {}) {
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

  const app = createChatApp({ fleetApi: api });
  const listenPort = port ?? Number(process.env.PORT ?? 3000);
  const server = app.listen(listenPort);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  console.log(`chat server listening on http://127.0.0.1:${server.address().port}`);

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
    const { close } = await startChatServer();
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

- [ ] **Step 2: Live smoke (requires running Fleet server + provisioned BOILERPLATE-DOER)**

```bash
node chat/main.mjs &   # or a second terminal on Windows
curl -s http://127.0.0.1:3000/health
# direct path
curl -s -X POST http://127.0.0.1:3000/chat -H "content-type: application/json" \
  -d '{"message":"Reply with exactly: chat-pong"}'
# routed path
curl -s -X POST http://127.0.0.1:3000/chat -H "content-type: application/json" \
  -d '{"message":"run the boilerplate demo workflow"}'
```

Expected: `{"ok":true}` from /health. The first chat response has `"workflow":"direct"` and a reply near `chat-pong`. The second has `"workflow":"boilerplate"` and a summary containing `boilerplate workflow completed` (this really runs the demo workflow — allow it a couple of minutes). Then a follow-up POST reusing the first `sessionId` with `{"message":"repeat your previous reply"}` should mention `chat-pong`, proving multi-turn context. Stop the server with Ctrl+C (or `kill`) — the shell must return.

If the Fleet server is down this smoke fails with the `connectFleet` hint — start it and retry; do not mark the step complete on a failed smoke.

- [ ] **Step 3: Add a "Chat interface" section to `README.md`** (insert after the "Live run on this machine" section; also add `docs/chat-interface.md` to the Layout tree near the top of the README)

````markdown
## Chat interface

`POST /chat` sits ABOVE the workflows: an LLM routing call to **BOILERPLATE-DOER**
matches each question against the workflow registry (`chat/registry.mjs`); a match runs
that workflow, otherwise DOER answers directly. The response's `workflow` field says
which. Multi-turn: pass back the returned `sessionId`. History is in-memory (lost on
restart), capped at 20 messages per session. Auth is a stub (`chat/auth.mjs`) — inject
real middleware via `createChatApp({ authenticate })`. New workflows become routable by
appending `{ name, description, run }` to the registry.

```bash
npm install                      # once: installs express
npm run chat                     # needs Fleet running + members provisioned (see above)

curl -s -X POST http://127.0.0.1:3000/chat \
  -H "content-type: application/json" \
  -d '{"message":"hello"}'
# → {"sessionId":"…","reply":"…","workflow":"direct"}   — send sessionId back for follow-ups
```

Mock tests (no server, no tokens): `node --test tests/chat.test.mjs`.

**Full reference: [docs/chat-interface.md](docs/chat-interface.md)** — API details,
routing behavior, adding workflows to the registry, replacing the auth stub,
troubleshooting.
````

- [ ] **Step 4: Create `docs/chat-interface.md`** — the full reference. Use exactly this content:

````markdown
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
````

- [ ] **Step 5: Full suite one last time**

Run: `npm test`
Expected: all pass, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add chat/main.mjs README.md docs/chat-interface.md
git commit -m "feat: add chat server launcher and full /chat documentation"
```
