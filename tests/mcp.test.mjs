import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { buildMcpServer } = await import('../mcp/server.mjs');
const { createMcpHttpApp } = await import('../mcp/http.mjs');

function createMockFleetApi() {
  const registerCalls = [];
  const commandCalls = [];
  const promptCalls = [];
  return {
    registerCalls,
    commandCalls,
    promptCalls,
    async registerMember(options) {
      registerCalls.push(options);
      return { content: [{ type: 'text', text: `registered ${options.friendly_name}` }] };
    },
    async fleetStatus() {
      return {
        content: [{ type: 'text', text: 'BOILERPLATE-DOER\nBOILERPLATE-REVIEWER' }],
      };
    },
    async executeCommand(options) {
      commandCalls.push(options);
      const payload = JSON.stringify({ root: '/tmp/x', exists: true, fileCount: 1, totalBytes: 4 });
      return {
        content: [{ type: 'text', text: payload }],
        structuredContent: { stdout: payload, exitCode: 0 },
      };
    },
    async executePrompt(options) {
      promptCalls.push(options);
      return { content: [{ type: 'text', text: 'pong' }], structuredContent: { response: 'pong' } };
    },
  };
}

// Starts the real express app on an ephemeral port and connects a real MCP
// client over streamable HTTP, so the transport wiring is exercised too.
async function withServer(registryOverride, run) {
  const fleetApi = createMockFleetApi();
  const app = createMcpHttpApp({
    buildServer: () => buildMcpServer({ fleetApi, registry: registryOverride }),
  });
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  const url = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  try {
    await run({ client, fleetApi });
  } finally {
    await client.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
}

test('advertises exactly the registry tools, with schemas and annotations', async () => {
  await withServer(undefined, async ({ client }) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['boilerplate', 'inspect-members']);

    const inspect = tools.find((tool) => tool.name === 'inspect-members');
    assert.deepEqual(Object.keys(inspect.inputSchema.properties).sort(), ['includeFiles', 'members']);
    assert.equal(inspect.annotations.readOnlyHint, true);

    const boilerplate = tools.find((tool) => tool.name === 'boilerplate');
    assert.deepEqual(boilerplate.inputSchema.properties ?? {}, {});
    assert.equal(boilerplate.annotations.readOnlyHint, false);
  });
});

test('calling boilerplate runs the workflow', async () => {
  await withServer(undefined, async ({ client, fleetApi }) => {
    const result = await client.callTool({ name: 'boilerplate' });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /boilerplate workflow completed/);
    assert.ok(fleetApi.promptCalls.length >= 1, 'the agent phase should have run');
  });
});

test('calling inspect-members with one member touches only that member', async () => {
  await withServer(undefined, async ({ client, fleetApi }) => {
    const result = await client.callTool({
      name: 'inspect-members',
      arguments: { members: ['BOILERPLATE-DOER'] },
    });
    assert.equal(result.isError, undefined);
    assert.equal(fleetApi.commandCalls.length, 1);
    assert.equal(fleetApi.commandCalls[0].member_name, 'BOILERPLATE-DOER');

    const report = JSON.parse(result.content[0].text);
    assert.deepEqual(report.members.map((entry) => entry.name), ['BOILERPLATE-DOER']);
  });
});

test('a throwing workflow returns isError and the server keeps serving', async () => {
  const registry = [
    {
      name: 'boom',
      description: 'always throws',
      async run() {
        throw new Error('workflow exploded');
      },
    },
    {
      name: 'fine',
      description: 'always works',
      async run() {
        return 'still here';
      },
    },
  ];
  await withServer(registry, async ({ client }) => {
    const failed = await client.callTool({ name: 'boom' });
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /workflow exploded/);

    const after = await client.callTool({ name: 'fine' });
    assert.equal(after.isError, undefined);
    assert.equal(after.content[0].text, 'still here');
  });
});

test('invalid arguments are rejected before the workflow runs', async () => {
  let ran = false;
  const registry = [
    {
      name: 'typed',
      description: 'takes a number',
      inputSchema: z.object({ count: z.number() }),
      async run() {
        ran = true;
        return 'ok';
      },
    },
  ];
  await withServer(registry, async ({ client }) => {
    const result = await client.callTool({ name: 'typed', arguments: { count: 'nope' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /count/);
    assert.equal(ran, false, 'run must not be called with invalid arguments');
  });
});

test('an unknown tool name fails cleanly', async () => {
  await withServer(undefined, async ({ client }) => {
    await assert.rejects(() => client.callTool({ name: 'no-such-tool' }));
  });
});

test('a client requesting progress receives a heartbeat per phase', async () => {
  await withServer(undefined, async ({ client }) => {
    const updates = [];
    const result = await client.callTool(
      { name: 'inspect-members', arguments: {} },
      { onprogress: (update) => updates.push(update) },
    );
    assert.equal(result.isError, undefined);
    assert.ok(updates.length >= 1, 'expected at least one progress notification');
    assert.ok(
      updates.every((update, index) => index === 0 || update.progress > updates[index - 1].progress),
      'progress must strictly increase',
    );
  });
});

test('a client that does not request progress still gets the result', async () => {
  await withServer(undefined, async ({ client }) => {
    const result = await client.callTool({ name: 'inspect-members', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.ok(JSON.parse(result.content[0].text).members.length >= 1);
  });
});
