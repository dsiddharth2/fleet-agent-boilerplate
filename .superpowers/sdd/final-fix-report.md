# Final Fix Report

## Fixes

- Restricted the MCP `members` schema to `BOILERPLATE-DOER` and `BOILERPLATE-REVIEWER`.
- Validated direct workflow inputs against those two members and resolved each to a fixed work-folder path before dispatch.
- Rechecked cancellation after the final phase notification and immediately before `agent()`.
- Nested mock MCP client cleanup so the HTTP server closes after connection or client-close failures.

## TDD evidence

The new regressions failed before production changes:

- `node --test tests/inspect-members.test.mjs` — exit 1; 7 passed, 1 failed because the unsupported shell-like member did not reject.
- `node --test tests/boilerplate.test.mjs` — exit 1; 3 passed, 1 failed because aborting on the final notification still reached the agent phase.
- `node --test tests/mcp.test.mjs` — exit 1; 10 passed, 1 failed because the advertised member schema had no enum.

## Covering test output

- `node --test tests/inspect-members.test.mjs` — exit 0; 8 passed, 0 failed.
- `node --test tests/boilerplate.test.mjs` — exit 0; 4 passed, 0 failed.
- `node --test tests/mcp.test.mjs` — exit 0; 11 passed, 0 failed.
- `npm test` — exit 0; 23 passed, 0 failed.
- `git diff --check` — exit 0; no whitespace errors.

`tests/mcp.live.test.mjs` was not run, as required.
