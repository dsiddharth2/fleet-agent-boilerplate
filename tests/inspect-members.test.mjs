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

test('rejects member names outside this repo before command dispatch', async () => {
  const unsupported = 'OTHER"; touch /tmp/inspect-members-injection; #';
  const fleetApi = createMockFleetApi({ present: [unsupported] });

  await assert.rejects(
    () => runInspectMembers({ fleetApi, members: [unsupported] }),
    /unsupported member/i,
  );
  assert.equal(fleetApi.commandCalls.length, 0);
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
