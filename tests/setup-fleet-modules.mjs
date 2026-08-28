import { ensureApralabs } from '../workflows/demo/ensure-apralabs.mjs';

// Tests must call this before importing main.mjs's Fleet packages. ensureApralabs
// also runs inside runDemo() for `node workflows/demo/main.mjs`.
ensureApralabs();
