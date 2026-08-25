import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureApralabs } from './ensure-apralabs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineScript = path.join(here, 'boilerplate.js');

export const selfExecuting = true;

export async function runBoilerplate({ fleetApi } = {}) {
  // Attach to `apra-fleet start` (where members + OAuth were provisioned).
  // Unset transport would fall back to stdio spawn, which cannot find the
  // npm-global server layout and would also miss those members.
  if (!process.env.APRA_FLEET_TRANSPORT) {
    process.env.APRA_FLEET_TRANSPORT = 'http';
  }
  ensureApralabs();
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');

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
    return await engine.executeFile(engineScript, { fleetApi: api });
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
    await runBoilerplate();
    process.exit(0);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
