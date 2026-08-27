import { McpServer } from '@modelcontextprotocol/server';
import { defaultRegistry } from './registry.mjs';

const SERVER_INFO = { name: 'fleet-agent-boilerplate', version: '1.0.0' };

function toToolResult(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

// Progress notifications are only legal when the client sent a progressToken,
// and `progress` must increase on every one. With no token this is a no-op, so
// workflow bodies can call reportPhase unconditionally.
function makePhaseReporter(ctx) {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  let progress = 0;
  return async (message) => {
    if (progressToken === undefined) return;
    progress += 1;
    await ctx.mcpReq.notify({
      method: 'notifications/progress',
      params: { progressToken, progress, message },
    });
  };
}

export function buildMcpServer({ fleetApi, registry = defaultRegistry } = {}) {
  if (!fleetApi) {
    throw new Error('buildMcpServer requires fleetApi');
  }
  const server = new McpServer(SERVER_INFO);

  for (const entry of registry) {
    const config = { description: entry.description };
    if (entry.inputSchema) config.inputSchema = entry.inputSchema;
    if (entry.annotations) config.annotations = entry.annotations;

    // A thrown error is turned into an isError result by the SDK, so there is
    // deliberately no try/catch here.
    const invoke = async (args, ctx) =>
      toToolResult(
        await entry.run({
          fleetApi,
          args,
          signal: ctx.mcpReq.signal,
          reportPhase: makePhaseReporter(ctx),
        }),
      );

    // The SDK passes (args, ctx) only when inputSchema is declared; without one
    // the context arrives as the single argument.
    server.registerTool(
      entry.name,
      config,
      entry.inputSchema ? (args, ctx) => invoke(args ?? {}, ctx) : (ctx) => invoke({}, ctx),
    );
  }

  return server;
}
