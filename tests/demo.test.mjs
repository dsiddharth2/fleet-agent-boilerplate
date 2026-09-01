import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { runDemo } = await import('../workflows/demo/main.mjs');
const { WorkerPool } = await import('../pool/worker-pool.mjs');

const dummyPy = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../workflows/demo/dummy.py',
);

async function withPool(fleetApi, size = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-pool-'));
  return await WorkerPool.create({
    fleetApi,
    config: { size, root, acquireTimeoutMs: 5000 },
  });
}

test('runDemo runs the python command and smokes the agent on its worker', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const pool = await withPool(fleetApi);

  const result = await runDemo({ fleetApi, pool });
  assert.match(String(result.command?.output ?? result.command), /hello-from-python/);
  assert.deepEqual(result.transform, { ok: true, source: 'transform' });
  assert.match(String(result.agent?.response ?? result.agent), /\bpong\b/i);

  assert.equal(fleetApi.commandCalls.length, 1);
  assert.equal(fleetApi.commandCalls[0].member_name, 'WORKER-1-DOER');
  assert.match(fleetApi.commandCalls[0].command, /python3/);
  assert.ok(fleetApi.commandCalls[0].command.includes(dummyPy));

  assert.equal(fleetApi.promptCalls.length, 1);
  assert.equal(fleetApi.promptCalls[0].member_name, 'WORKER-1-DOER');

  await pool.close();
});

test('the workflow registers nothing', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const pool = await withPool(fleetApi);
  await runDemo({ fleetApi, pool });
  assert.deepEqual(fleetApi.registerCalls, [], 'provisioning owns registration');
  await pool.close();
});

test('the worker is released back to the pool after a run', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const pool = await withPool(fleetApi);
  await runDemo({ fleetApi, pool });
  await runDemo({ fleetApi, pool });
  assert.equal(fleetApi.commandCalls.length, 2, 'a second run must get the worker back');
  await pool.close();
});

test('an aborted signal prevents the agent phase from spending tokens', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const pool = await withPool(fleetApi);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() => runDemo({ fleetApi, pool, signal: controller.signal }));
  assert.equal(fleetApi.promptCalls.length, 0, 'executePrompt must not run after abort');
  await pool.close();
});

test('aborting on the final progress notification prevents the agent call', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const pool = await withPool(fleetApi);
  const controller = new AbortController();

  const result = await runDemo({
    fleetApi,
    pool,
    signal: controller.signal,
    reportPhase(message) {
      if (message === 'dispatching the agent prompt') controller.abort();
    },
  });

  assert.equal(result.cancelled, true);
  assert.equal(fleetApi.promptCalls.length, 0, 'executePrompt must not run after final progress');
  await pool.close();
});

test('reportPhase receives one message per phase and is optional', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const pool = await withPool(fleetApi);
  const phases = [];
  await runDemo({ fleetApi, pool, reportPhase: (message) => phases.push(message) });
  assert.ok(phases.length >= 4, `expected a message per phase, got ${phases.length}`);

  // Omitting reportPhase must not throw.
  await runDemo({ fleetApi, pool });
  await pool.close();
});

test('runDemo builds its own pool when none is injected', async () => {
  const fleetApi = createMockFleetApi({ members: rosterNames(1) });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'demo-own-pool-'));
  const previous = { size: process.env.WORKER_POOL_SIZE, root: process.env.WORKER_POOL_ROOT };
  process.env.WORKER_POOL_SIZE = '1';
  process.env.WORKER_POOL_ROOT = root;
  try {
    const result = await runDemo({ fleetApi });
    assert.match(String(result.agent?.response ?? result.agent), /\bpong\b/i);
    assert.equal(fleetApi.commandCalls[0].member_name, 'WORKER-1-DOER');
  } finally {
    process.env.WORKER_POOL_SIZE = previous.size;
    process.env.WORKER_POOL_ROOT = previous.root;
  }
});
