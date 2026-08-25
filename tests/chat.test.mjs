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
