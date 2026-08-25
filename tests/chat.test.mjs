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
