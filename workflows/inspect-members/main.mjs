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
  members,
  includeFiles,
  signal,
  reportPhase,
} = {}) {
  // Attach to `apra-fleet start` (where members were provisioned). Unset
  // transport would fall back to a stdio spawn that cannot see them.
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
    // WorkflowEngine consumes failSoft before dispatch. Keep it observable to
    // injected APIs without letting FleetApi serialize it into the MCP payload.
    const workflowApi = {
      executeCommand(options) {
        Object.defineProperty(options, 'failSoft', { value: true, enumerable: false });
        return api.executeCommand(options);
      },
    };
    const workflow = new FleetWorkflow(workflowApi);
    const engine = new WorkflowEngine(workflow);
    return await engine.executeFile(engineScript, {
      fleetApi: api,
      members,
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
