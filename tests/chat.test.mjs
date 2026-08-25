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
