import { test } from 'node:test';
import assert from 'node:assert/strict';

const { authenticate } = await import('../chat/auth.mjs');
const { toolText } = await import('../chat/fleet-text.mjs');

test('authenticate stub sets req.user and calls next', () => {
  const req = {};
  let nextCalled = false;
  authenticate(req, null, () => {
    nextCalled = true;
  });
  assert.deepEqual(req.user, { id: 'anonymous' });
  assert.ok(nextCalled, 'next() must be called');
});

test('toolText prefers structuredContent.response, falls back to content text', () => {
  assert.equal(
    toolText({ content: [{ type: 'text', text: 'ignored' }], structuredContent: { response: 'answer' } }),
    'answer',
  );
  assert.equal(toolText({ content: [{ type: 'text', text: 'from-content' }] }), 'from-content');
  assert.equal(toolText('plain string'), 'plain string');
  assert.equal(toolText(null), '');
});
