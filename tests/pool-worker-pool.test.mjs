import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PoolSaturatedError, RosterError, WorkerPool } from '../pool/worker-pool.mjs';
import { createMockFleetApi, rosterNames } from './helpers/mock-fleet.mjs';

async function makePool({ size = 1, acquireTimeoutMs = 300000, missing = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-pool-'));
  const fleetApi = createMockFleetApi({ members: rosterNames(size), missing });
  const pool = await WorkerPool.create({
    fleetApi,
    config: { size, root, acquireTimeoutMs },
  });
  return { pool, fleetApi, root };
}

test('create fails loudly when a worker is not registered', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-pool-'));
  const fleetApi = createMockFleetApi({
    members: rosterNames(2),
    missing: ['WORKER-2-REVIEWER'],
  });
  await assert.rejects(
    () => WorkerPool.create({ fleetApi, config: { size: 2, root, acquireTimeoutMs: 1000 } }),
    (err) => {
      assert.ok(err instanceof RosterError);
      assert.match(err.message, /WORKER-2-REVIEWER/);
      assert.match(err.message, /provision-members\.sh/);
      return true;
    },
  );
});

test('create never registers members itself', async () => {
  const { fleetApi } = await makePool({ size: 2 });
  assert.deepEqual(fleetApi.registerCalls, [], 'provisioning owns registration');
});

test('create makes every worker folder', async () => {
  const { root } = await makePool({ size: 2 });
  for (const id of [1, 2]) {
    assert.deepEqual(
      (await fs.readdir(path.join(root, `worker-${id}`))).sort(),
      ['doer', 'reviewer'],
    );
  }
});

test('concurrent acquires get different workers', async () => {
  const { pool } = await makePool({ size: 2 });
  const [first, second] = await Promise.all([pool.acquire(), pool.acquire()]);
  assert.notEqual(first.workerId, second.workerId);
  assert.equal(first.doer.name, `WORKER-${first.workerId}-DOER`);
  await first.release();
  await second.release();
  await pool.close();
});

test('a saturated pool queues and hands off on release', async () => {
  const { pool } = await makePool({ size: 1 });
  const held = await pool.acquire();

  let waitingResolved = false;
  const waiting = pool.acquire().then((lease) => {
    waitingResolved = true;
    return lease;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(waitingResolved, false, 'must not hand out a held worker');

  await held.release();
  const lease = await waiting;
  assert.equal(lease.workerId, 1);
  await lease.release();
  await pool.close();
});

test('a queued caller gets an immediate heartbeat with its position', async () => {
  const { pool } = await makePool({ size: 1 });
  const held = await pool.acquire();
  const phases = [];

  const waiting = pool.acquire({ reportPhase: (message) => phases.push(message) });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(phases.length, 1, 'one heartbeat on entering the queue');
  assert.match(phases[0], /position 1/);
  assert.match(phases[0], /pool size 1/);

  await held.release();
  await (await waiting).release();
  await pool.close();
});

test('a queued caller fails with a readable error after the timeout', async () => {
  const { pool } = await makePool({ size: 1, acquireTimeoutMs: 100 });
  const held = await pool.acquire();
  await assert.rejects(() => pool.acquire(), (err) => {
    assert.ok(err instanceof PoolSaturatedError);
    assert.match(err.message, /all 1 workers busy/);
    return true;
  });
  await held.release();
  await pool.close();
});

test('aborting while queued dequeues the waiter', async () => {
  const { pool } = await makePool({ size: 1 });
  const held = await pool.acquire();
  const controller = new AbortController();
  const waiting = pool.acquire({ signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error('caller went away'));
  await assert.rejects(() => waiting, /caller went away/);

  // The dangling waiter must be gone: releasing hands off to nobody, and the
  // next acquire succeeds immediately.
  await held.release();
  const lease = await pool.acquire();
  assert.equal(lease.workerId, 1);
  await lease.release();
  await pool.close();
});

test('acquire cleans a folder left dirty by a crashed holder', async () => {
  const { pool, root } = await makePool({ size: 1 });
  const stale = path.join(root, 'worker-1', 'doer', 'left-behind.txt');
  await fs.writeFile(stale, 'from a crashed run');

  const lease = await pool.acquire();
  await assert.rejects(() => fs.access(stale), 'acquire must wipe inherited files');
  await lease.release();
  await pool.close();
});

test('release is idempotent', async () => {
  const { pool } = await makePool({ size: 1 });
  const lease = await pool.acquire();
  await lease.release();
  await lease.release();
  const second = await pool.acquire();
  assert.equal(second.workerId, 1);
  await second.release();
  await pool.close();
});
