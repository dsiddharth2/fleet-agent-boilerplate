import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { runDemo } = await import('../workflows/demo/main.mjs');

const dummyPy = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../workflows/demo/dummy.py',
);

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
      return {
        content: [{ type: 'text', text: `registered ${options.friendly_name}` }],
      };
    },
    async fleetStatus() {
      const names = registerCalls.map((call) => call.friendly_name);
      return { content: [{ type: 'text', text: names.join('\n') }] };
    },
    async executeCommand(options) {
      commandCalls.push(options);
      return {
        content: [{ type: 'text', text: 'hello-from-python' }],
        structuredContent: { stdout: 'hello-from-python', exitCode: 0 },
      };
    },
    async executePrompt(options) {
      promptCalls.push(options);
      return {
        content: [{ type: 'text', text: 'pong' }],
        structuredContent: { response: 'pong' },
      };
    },
  };
}

test('runDemo registers members, runs python command, and smokes agent', async () => {
  const fleetApi = createMockFleetApi();

  const result = await runDemo({ fleetApi });
  assert.match(String(result.command?.output ?? result.command), /hello-from-python/);
  assert.deepEqual(result.transform, { ok: true, source: 'transform' });
  assert.match(String(result.agent?.response ?? result.agent), /\bpong\b/i);

  const registeredNames = fleetApi.registerCalls.map((call) => call.friendly_name);
  assert.ok(registeredNames.includes('DEMO-DOER'), 'DEMO-DOER should be registered');
  assert.ok(registeredNames.includes('DEMO-REVIEWER'), 'DEMO-REVIEWER should be registered');

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const doerCall = fleetApi.registerCalls.find((call) => call.friendly_name === 'DEMO-DOER');
  const reviewerCall = fleetApi.registerCalls.find((call) => call.friendly_name === 'DEMO-REVIEWER');
  assert.equal(doerCall.work_folder, path.join(repoRoot, 'workdir', 'DEMO-DOER'));
  assert.equal(reviewerCall.work_folder, path.join(repoRoot, 'workdir', 'DEMO-REVIEWER'));

  assert.equal(fleetApi.commandCalls.length, 1);
  const command = fleetApi.commandCalls[0].command;
  assert.match(command, /python3/);
  assert.ok(
    command.includes(dummyPy),
    `executeCommand should include dummy.py path, got: ${command}`,
  );

  assert.ok(fleetApi.promptCalls.length >= 1, 'executePrompt should be invoked');

  const registerCount = fleetApi.registerCalls.length;
  await runDemo({ fleetApi });
  assert.equal(
    fleetApi.registerCalls.length,
    registerCount,
    're-run should not register members that status already lists',
  );
});

test('an aborted signal prevents the agent phase from spending tokens', async () => {
  const fleetApi = createMockFleetApi();
  const controller = new AbortController();
  controller.abort();

  const result = await runDemo({ fleetApi, signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(fleetApi.promptCalls.length, 0, 'executePrompt must not run after abort');
});

test('aborting on the final progress notification prevents the agent call', async () => {
  const fleetApi = createMockFleetApi();
  const controller = new AbortController();

  const result = await runDemo({
    fleetApi,
    signal: controller.signal,
    reportPhase(message) {
      if (message === 'dispatching the agent prompt') controller.abort();
    },
  });

  assert.equal(result.cancelled, true);
  assert.equal(fleetApi.promptCalls.length, 0, 'executePrompt must not run after final progress');
});

test('reportPhase receives one message per phase and is optional', async () => {
  const phases = [];
  await runDemo({
    fleetApi: createMockFleetApi(),
    reportPhase: (message) => phases.push(message),
  });
  assert.ok(phases.length >= 5, `expected a message per phase, got ${phases.length}`);

  // Omitting reportPhase must not throw.
  await runDemo({ fleetApi: createMockFleetApi() });
});
