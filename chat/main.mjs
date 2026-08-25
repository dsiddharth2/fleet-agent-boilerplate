import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureApralabs } from '../workflows/boilerplate/ensure-apralabs.mjs';
import { createChatApp } from './app.mjs';

export async function startChatServer({ fleetApi, port } = {}) {
  // Attach to `apra-fleet start` (where members + OAuth were provisioned) —
  // same reasoning as workflows/boilerplate/main.mjs.
  if (!process.env.APRA_FLEET_TRANSPORT) {
    process.env.APRA_FLEET_TRANSPORT = 'http';
  }
  ensureApralabs();

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
      throw new Error(
        `Fleet server is not running or connectFleet() failed: ${detail}\nStart it with: cd ~/.apra-fleet/bin && apra-fleet start`,
        { cause: err },
      );
    }
  }

  const app = createChatApp({ fleetApi: api });
  const listenPort = port ?? Number(process.env.PORT ?? 3000);
  const server = app.listen(listenPort);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  console.log(`chat server listening on http://127.0.0.1:${server.address().port}`);

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    transport?.stop?.();
  };
  return { server, close };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const { close } = await startChatServer();
    const shutdown = async () => {
      await close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
