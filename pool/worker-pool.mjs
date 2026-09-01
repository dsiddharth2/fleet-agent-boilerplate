import fs from 'node:fs/promises';
import { cleanWorker } from './cleanup.mjs';
import { memberIsPresent, toolText } from './fleet-text.mjs';
import { buildRoster, poolConfig, rosterMemberNames } from './roster.mjs';
import { tryClaim } from './worker-lock.mjs';

// Beats the 60s first-response-byte timer immediately, then the 5-minute idle
// timer every 30s. See docs/mcp-interface.md for the timer inventory.
export const HEARTBEAT_MS = 30000;
// Cross-process releases cannot notify us, so waiting degrades to polling.
export const POLL_MS = 1000;

export class RosterError extends Error {}
export class PoolSaturatedError extends Error {}

export class WorkerPool {
  #fleetApi;
  #config;
  #roster;
  #held = new Set();
  #waiters = [];
  #pollTimer = null;
  #servicing = false;
  #closed = false;

  constructor(fleetApi, config, roster) {
    this.#fleetApi = fleetApi;
    this.#config = config;
    this.#roster = roster;
  }

  static async create({ fleetApi, env = process.env, config } = {}) {
    if (!fleetApi) throw new Error('WorkerPool.create requires fleetApi');
    const resolved = config ?? poolConfig(env);
    const pool = new WorkerPool(fleetApi, resolved, buildRoster(resolved));
    await pool.#verifyRoster();
    return pool;
  }

  get size() { return this.#roster.length; }
  get roster() { return this.#roster; }
  get config() { return this.#config; }

  // Verify, never register. Provisioning owns registration and OAuth; a pool
  // that self-registered would hide the drift this check exists to catch, and
  // the member it created would still have no credentials.
  async #verifyRoster() {
    const text = toolText(await this.#fleetApi.listMembers({ format: 'json' }));
    const missing = rosterMemberNames(this.#roster).filter((name) => !memberIsPresent(text, name));
    if (missing.length > 0) {
      throw new RosterError(
        `These worker members are not registered: ${missing.join(', ')}.\n` +
          `Run scripts/provision-members.sh with WORKER_POOL_SIZE=${this.size}, ` +
          'or in Docker: docker compose up --build.',
      );
    }
    for (const worker of this.#roster) {
      await fs.mkdir(worker.doer.folder, { recursive: true });
      await fs.mkdir(worker.reviewer.folder, { recursive: true });
    }
  }

  async acquire({ signal, reportPhase } = {}) {
    if (this.#closed) throw new Error('WorkerPool is closed');
    signal?.throwIfAborted();
    const lease = await this.#tryAcquireNow(signal);
    if (lease) return lease;
    return await this.#queue({ signal, reportPhase });
  }

  async #tryAcquireNow(signal) {
    for (const worker of this.#roster) {
      if (this.#held.has(worker.id)) continue;
      // Reserve in-process before awaiting, so two local callers never race
      // for the same lock file.
      this.#held.add(worker.id);

      const controller = new AbortController();
      let releaseLock;
      try {
        releaseLock = await tryClaim(worker.lockTarget, {
          onCompromised: (err) =>
            controller.abort(new Error(`worker-${worker.id} lock compromised: ${err?.message ?? err}`)),
        });
      } catch (err) {
        this.#held.delete(worker.id);
        throw err;
      }
      if (!releaseLock) {
        this.#held.delete(worker.id);
        continue;
      }

      if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      }

      // Load-bearing: a crashed holder's lock goes stale and is stolen, but its
      // files remain. Wipe before handing the worker to the next run.
      try {
        await cleanWorker(worker);
      } catch (err) {
        console.warn(`[pool] cleanup on acquire failed for worker-${worker.id}: ${err.message}`);
      }

      return this.#lease(worker, controller, releaseLock);
    }
    return null;
  }

  #lease(worker, controller, releaseLock) {
    let released = false;
    return {
      workerId: worker.id,
      doer: worker.doer,
      reviewer: worker.reviewer,
      signal: controller.signal,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await cleanWorker(worker);
        } catch (err) {
          console.warn(`[pool] cleanup on release failed for worker-${worker.id}: ${err.message}`);
        }
        try {
          await releaseLock();
        } catch (err) {
          console.warn(`[pool] releasing worker-${worker.id} lock failed: ${err.message}`);
        }
        // A cleanup or unlock failure must never wedge a worker as busy.
        this.#held.delete(worker.id);
        void this.#serviceWaiters();
      },
    };
  }

  #queue({ signal, reportPhase }) {
    return new Promise((resolve, reject) => {
      const waiter = { signal, settled: false };
      this.#waiters.push(waiter);

      const settle = (done, value) => {
        if (waiter.settled) return;
        waiter.settled = true;
        clearInterval(heartbeat);
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        if (this.#waiters.length === 0) this.#stopPolling();
        done(value);
      };
      waiter.grant = (lease) => settle(resolve, lease);

      const announce = () => {
        const position = this.#waiters.indexOf(waiter) + 1;
        Promise.resolve(
          reportPhase?.(`queued for a worker: position ${position}, pool size ${this.size}`),
        ).catch(() => {});
      };
      announce();
      const heartbeat = setInterval(announce, HEARTBEAT_MS);
      heartbeat.unref?.();

      // Keep this timer referenced: an outstanding acquire is real work, and
      // unref() would let the event loop drain before the timeout can reject
      // (Node's test runner then cancels remaining tests).
      const timeout = setTimeout(
        () =>
          settle(
            reject,
            new PoolSaturatedError(
              `all ${this.size} workers busy after ${this.#config.acquireTimeoutMs}ms; try again`,
            ),
          ),
        this.#config.acquireTimeoutMs,
      );

      const onAbort = () => settle(reject, signal.reason ?? new Error('acquire aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });

      this.#startPolling();
    });
  }

  // Serves waiters in FIFO order. Re-entrancy guard: an await inside the loop
  // would otherwise let a concurrent release start a second pass.
  async #serviceWaiters() {
    if (this.#servicing) return;
    this.#servicing = true;
    try {
      while (this.#waiters.length > 0) {
        const waiter = this.#waiters[0];
        const lease = await this.#tryAcquireNow(waiter.signal);
        if (!lease) return;
        if (waiter.settled) {
          await lease.release();
          continue;
        }
        waiter.grant(lease);
      }
    } finally {
      this.#servicing = false;
    }
  }

  #startPolling() {
    if (this.#pollTimer) return;
    this.#pollTimer = setInterval(
      () => void this.#serviceWaiters(),
      POLL_MS + Math.floor(Math.random() * 250),
    );
    this.#pollTimer.unref?.();
  }

  #stopPolling() {
    if (!this.#pollTimer) return;
    clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  async close() {
    this.#closed = true;
    this.#stopPolling();
  }
}
