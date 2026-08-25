import { ensureApralabs } from '../workflows/boilerplate/ensure-apralabs.mjs';

// Tests must call this before importing main.mjs's Fleet packages. ensureApralabs
// also runs inside runBoilerplate() for `node workflows/boilerplate/main.mjs`.
ensureApralabs();
