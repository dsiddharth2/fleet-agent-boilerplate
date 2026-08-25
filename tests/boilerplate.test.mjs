import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { runBoilerplate } = await import('../workflows/boilerplate/main.mjs');

const dummyPy = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../workflows/boilerplate/dummy.py',
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

test('runBoilerplate registers members, runs python command, and smokes agent', async () => {
  const fleetApi = createMockFleetApi();

  const result = await runBoilerplate({ fleetApi });
  assert.match(String(result.command?.output ?? result.command), /hello-from-python/);
  assert.deepEqual(result.transform, { ok: true, source: 'transform' });
  assert.match(String(result.agent?.response ?? result.agent), /\bpong\b/i);

  const registeredNames = fleetApi.registerCalls.map((call) => call.friendly_name);
  assert.ok(registeredNames.includes('BOILERPLATE-DOER'), 'BOILERPLATE-DOER should be registered');
  assert.ok(registeredNames.includes('BOILERPLATE-REVIEWER'), 'BOILERPLATE-REVIEWER should be registered');

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const doerCall = fleetApi.registerCalls.find((call) => call.friendly_name === 'BOILERPLATE-DOER');
  const reviewerCall = fleetApi.registerCalls.find((call) => call.friendly_name === 'BOILERPLATE-REVIEWER');
  assert.equal(doerCall.work_folder, path.join(repoRoot, 'workdir', 'BOILERPLATE-DOER'));
  assert.equal(reviewerCall.work_folder, path.join(repoRoot, 'workdir', 'BOILERPLATE-REVIEWER'));

  assert.equal(fleetApi.commandCalls.length, 1);
  const command = fleetApi.commandCalls[0].command;
  assert.match(command, /python3/);
  assert.ok(
    command.includes(dummyPy),
    `executeCommand should include dummy.py path, got: ${command}`,
  );

  assert.ok(fleetApi.promptCalls.length >= 1, 'executePrompt should be invoked');

  const registerCount = fleetApi.registerCalls.length;
  await runBoilerplate({ fleetApi });
  assert.equal(
    fleetApi.registerCalls.length,
    registerCount,
    're-run should not register members that status already lists',
  );
});
