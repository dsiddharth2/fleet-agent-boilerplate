#!/bin/sh
set -eu

# Same commands as a host provision. Docker entrypoint runs this after `apra-fleet start`.
# Token comes from CLAUDE_CODE_OAUTH_TOKEN and goes straight into Fleet's credential store.

apra-fleet register-member --type local --llm claude \
  --name DEMO-DOER \
  --path "$(pwd)/workdir/DEMO-DOER" || true

apra-fleet register-member --type local --llm claude \
  --name DEMO-REVIEWER \
  --path "$(pwd)/workdir/DEMO-REVIEWER" || true

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  apra-fleet auth --oauth --member DEMO-DOER "$CLAUDE_CODE_OAUTH_TOKEN"
else
  echo "CLAUDE_CODE_OAUTH_TOKEN is unset; skip auth. agent() calls will fail." >&2
fi
