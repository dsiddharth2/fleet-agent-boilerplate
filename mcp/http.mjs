import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { authenticate as defaultAuthenticate } from './auth.mjs';

export function createMcpHttpApp({ buildServer, authenticate = defaultAuthenticate } = {}) {
  if (typeof buildServer !== 'function') {
    throw new Error('createMcpHttpApp requires a buildServer function');
  }

  // createMcpExpressApp() enables Host header validation (DNS rebinding
  // protection) for localhost and parses JSON bodies, so no express.json().
  const app = createMcpExpressApp();

  app.get('/health', (req, res) => {
    res.json({ ok: true });
  });

  app.post('/mcp', authenticate, async (req, res) => {
    // Stateless: a fresh server and transport per request share nothing between
    // concurrent calls, and no MCP session ids are issued.
    const server = buildServer();
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return app;
}
