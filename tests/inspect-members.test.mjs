import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

const { runInspectMembers } = await import('../workflows/inspect-members/main.mjs');
const { tryClaim } = await import('../pool/worker-lock.mjs');

async function withRoot(size, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inspect-'));
  const previous = { size: process.env.WORKER_POOL_SIZE, root: process.env.WORKER_POOL_ROOT };
  process.env.WORKER_POOL_SIZE = String(size);
  process.env.WORKER_POOL_ROOT = root;
  try {
    for (let id = 1; id <= size; id += 1) {
      await fs.mkdir(path.join(root, `worker-${id}`, 'doer'), { recursive: true });
      await fs.mkdir(path.join(root, `worker-${id}`, 'reviewer'), { recursive: true });
    }
    await run(root);
  } finally {
    process.env.WORKER_POOL_SIZE = previous.size;
    process.env.WORKER_POOL_ROOT = previous.root;
  }
}

test('reports every worker in the pool by default', async () => {
  await withRoot(2, async () => {
    const fleetApi = createMockFleetApi({ members: rosterNames(2) });
    const report = await runInspectMembers({ fleetApi });
    assert.equal(report.poolSize, 2);
    assert.deepEqual(report.workers.map((w) => w.id), [1, 2]);
    assert.equal(report.workers[0].doer.name, 'WORKER-1-DOER');
    assert.ok(Date.parse(report.generatedAt) > 0);
  });
});

test('never executes commands as a member', async () => {
  await withRoot(1, async () => {
    const fleetApi = createMockFleetApi({ members: rosterNames(1) });
    await runInspectMembers({ fleetApi });
    assert.deepEqual(fleetApi.commandCalls, [], 'inspection must not touch a member session');
  });
});

test('reports folder contents from disk', async () => {
  await withRoot(1, async (root) => {
    await fs.writeFile(path.join(root, 'worker-1', 'doer', 'a.txt'), 'hello');
    const fleetApi = createMockFleetApi({ members: rosterNames(1) });
    const report = await runInspectMembers({ fleetApi, includeFiles: true });
    assert.equal(report.workers[0].doer.exists, true);
    assert.equal(report.workers[0].doer.fileCount, 1);
    assert.equal(report.workers[0].doer.totalBytes, 5);
    assert.deepEqual(report.workers[0].doer.entries, ['a.txt']);
    assert.equal(report.workers[0].reviewer.entries.length, 0);
  });
});

test('omits entries unless includeFiles is set', async () => {
  await withRoot(1, async (root) => {
    await fs.writeFile(path.join(root, 'worker-1', 'doer', 'a.txt'), 'hello');
    const fleetApi = createMockFleetApi({ members: rosterNames(1) });
    const report = await runInspectMembers({ fleetApi });
    assert.equal(report.workers[0].doer.entries, undefined);
    assert.equal(report.workers[0].doer.fileCount, 1);
  });
});

test('reports a held worker as busy with the time it was taken', async () => {
  await withRoot(1, async (root) => {
    const release = await tryClaim(path.join(root, '.locks', 'worker-1'));
    try {
      const fleetApi = createMockFleetApi({ members: rosterNames(1) });
      const report = await runInspectMembers({ fleetApi });
      assert.equal(report.workers[0].busy, true);
      assert.ok(Date.parse(report.workers[0].heldSince) > 0);
    } finally {
      await release();
    }
  });
});

test('a free worker reports busy false', async () => {
  await withRoot(1, async () => {
    const fleetApi = createMockFleetApi({ members: rosterNames(1) });
    const report = await runInspectMembers({ fleetApi });
    assert.equal(report.workers[0].busy, false);
    assert.equal(report.workers[0].heldSince, null);
  });
});

test('a workers filter narrows the report', async () => {
  await withRoot(3, async () => {
    const fleetApi = createMockFleetApi({ members: rosterNames(3) });
    const report = await runInspectMembers({ fleetApi, workers: [2] });
    assert.deepEqual(report.workers.map((w) => w.id), [2]);
  });
});

test('an out-of-range worker id is rejected', async () => {
  await withRoot(2, async () => {
    const fleetApi = createMockFleetApi({ members: rosterNames(2) });
    await assert.rejects(() => runInspectMembers({ fleetApi, workers: [5] }), /worker 5/i);
  });
});

test('reportPhase is called and is optional', async () => {
  await withRoot(1, async () => {
    const fleetApi = createMockFleetApi({ members: rosterNames(1) });
    const phases = [];
    await runInspectMembers({ fleetApi, reportPhase: (message) => phases.push(message) });
    assert.ok(phases.length >= 1, 'reportPhase should be invoked at least once');
    await runInspectMembers({ fleetApi });
  });
});
