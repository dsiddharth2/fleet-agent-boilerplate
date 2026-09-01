import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Shared with the demo workflow on purpose: duplicating the symlink
// logic would mean two places to fix when the Fleet install layout changes.
import { ensureApralabs } from '../demo/ensure-apralabs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineScript = path.join(here, 'inspect-members.js');

export const selfExecuting = true;

export async function runInspectMembers({
  fleetApi,
  workers,
  includeFiles,
  signal,
  reportPhase,
} = {}) {
  if (!process.env.APRA_FLEET_TRANSPORT) {
    process.env.APRA_FLEET_TRANSPORT = 'http';
  }
  ensureApralabs();
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');
  const { buildRoster, poolConfig } = await import('../../pool/roster.mjs');

  const config = poolConfig();
  const fullRoster = buildRoster(config);

  // Validated here rather than in the MCP schema: the pool is sized at runtime
  // from the environment, so the valid set is not known when the schema is built.
  let roster = fullRoster;
  if (Array.isArray(workers) && workers.length > 0) {
    for (const id of workers) {
      if (!Number.isInteger(id) || id < 1 || id > fullRoster.length) {
        throw new Error(`Unknown worker ${String(id)}: the pool has ${fullRoster.length} workers`);
      }
    }
    roster = fullRoster.filter((worker) => workers.includes(worker.id));
  }

  // Observational only: it takes no lease and needs no Fleet connection for the
  // folder or lock reads. fleetApi is still accepted so the launcher signature
  // matches every other workflow.
  let api = fleetApi;
  let transport = null;
  if (!api) {
    try {
      const { connectFleet } = await import('@apralabs/apra-fleet-client/server-resolution');
      const connected = await connectFleet({ env: process.env });
      api = connected.fleetApi;
      transport = connected.transport;
    } catch (err) {
      const detail = err?.message ?? err;
      const message = `Fleet server is not running or connectFleet() failed: ${detail}\nStart it with: cd ~/.apra-fleet/bin && apra-fleet start`;
      console.error(message);
      throw new Error(message, { cause: err });
    }
  }

  try {
    const workflow = new FleetWorkflow(api);
    const engine = new WorkflowEngine(workflow);
    return await engine.executeFile(engineScript, {
      fleetApi: api,
      roster,
      includeFiles,
      signal,
      reportPhase,
    });
  } finally {
    transport?.stop?.();
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const report = await runInspectMembers();
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
