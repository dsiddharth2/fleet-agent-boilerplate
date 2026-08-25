import './setup-fleet-modules.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runBoilerplate } = await import('../workflows/boilerplate/main.mjs');

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value.output === 'string') return value.output;
  if (typeof value.response === 'string') return value.response;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

test(
  'live runBoilerplate runs python command and agent on BOILERPLATE-DOER',
  { timeout: 180_000 },
  async () => {
    const result = await runBoilerplate();

    assert.equal(typeof result, 'object', 'runBoilerplate() should return the dummy phase results');
    assert.match(asText(result.command), /hello-from-python/);
    assert.deepEqual(result.transform, { ok: true, source: 'transform' });
    assert.match(asText(result.agent), /\bpong\b/i);
  },
);
