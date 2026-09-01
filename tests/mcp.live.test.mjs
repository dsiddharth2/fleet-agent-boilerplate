import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { startMcpServer } = await import('../mcp/main.mjs');

// Real Fleet server, real members. Spends no LLM tokens: inspect-members makes
// no agent() call. Needs `apra-fleet start` and provisioned workers.
test('inspect-members reports on live members over MCP', { timeout: 180000 }, async () => {
  const { server, close } = await startMcpServer({ port: 0 });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const client = new Client({ name: 'live-test-client', version: '1.0.0' });

  try {
    await client.connect(new StreamableHTTPClientTransport(url));

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['demo', 'inspect-members']);

    const result = await client.callTool({ name: 'inspect-members', arguments: {} });
    assert.equal(result.isError, undefined, `tool call failed: ${result.content?.[0]?.text}`);

    const report = JSON.parse(result.content[0].text);
    assert.ok(report.poolSize >= 1, 'the pool should have at least one worker');
    assert.equal(report.workers.length, report.poolSize);
    for (const worker of report.workers) {
      assert.equal(worker.doer.name, `WORKER-${worker.id}-DOER`);
      assert.equal(worker.reviewer.name, `WORKER-${worker.id}-REVIEWER`);
      assert.equal(worker.doer.exists, true, `worker-${worker.id} doer folder should exist`);
      assert.equal(worker.reviewer.exists, true, `worker-${worker.id} reviewer folder should exist`);
      assert.equal(typeof worker.busy, 'boolean');
    }
  } finally {
    try {
      await client.close();
    } finally {
      await close();
    }
  }
});
