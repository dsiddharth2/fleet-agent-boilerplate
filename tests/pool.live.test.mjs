import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { WorkerPool } = await import('../pool/worker-pool.mjs');

// Real Fleet server, real members, real lock files. Spends no LLM tokens: this
// exercises roster verification and lease handout, not agent().
// Needs `apra-fleet start` and provisioned workers.
async function connect() {
  process.env.APRA_FLEET_TRANSPORT ??= 'http';
  const { ensureApralabs } = await import('../workflows/demo/ensure-apralabs.mjs');
  ensureApralabs();
  const { connectFleet } = await import('@apralabs/apra-fleet-client/server-resolution');
  return await connectFleet({ env: process.env });
}

test('a live pool verifies its roster and hands out distinct workers', { timeout: 60000 }, async () => {
  const { fleetApi, transport } = await connect();
  const pool = await WorkerPool.create({ fleetApi });
  try {
    assert.ok(pool.size >= 1);

    const first = await pool.acquire();
    try {
      assert.equal(first.doer.name, `WORKER-${first.workerId}-DOER`);

      if (pool.size >= 2) {
        const second = await pool.acquire();
        try {
          assert.notEqual(second.workerId, first.workerId, 'two leases must not share a worker');
        } finally {
          await second.release();
        }
      }
    } finally {
      await first.release();
    }

    // The worker comes back: a second acquire after release must succeed.
    const reused = await pool.acquire();
    await reused.release();
  } finally {
    await pool.close();
    transport?.stop?.();
  }
});

test('a live pool rejects a roster larger than what is provisioned', { timeout: 60000 }, async () => {
  const { fleetApi, transport } = await connect();
  try {
    await assert.rejects(
      () => WorkerPool.create({ fleetApi, config: { size: 99, root: process.cwd() + '/workdir', acquireTimeoutMs: 1000 } }),
      /not registered/,
    );
  } finally {
    transport?.stop?.();
  }
});
