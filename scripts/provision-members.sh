#!/bin/sh
set -eu

# Same commands as a host provision. Docker entrypoint runs this after `apra-fleet start`.
# Token comes from gitignored .token (bind-mounted) or CLAUDE_CODE_OAUTH_TOKEN (CI).

apra-fleet register-member --type local --llm claude \
  --name BOILERPLATE-DOER \
  --path "$(pwd)/workdir/BOILERPLATE-DOER" || true

apra-fleet register-member --type local --llm claude \
  --name BOILERPLATE-REVIEWER \
  --path "$(pwd)/workdir/BOILERPLATE-REVIEWER" || true

if [ -f .token ]; then
  apra-fleet auth --oauth --member BOILERPLATE-DOER "$(tr -d '\r\n' < .token)"
elif [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  apra-fleet auth --oauth --member BOILERPLATE-DOER "$CLAUDE_CODE_OAUTH_TOKEN"
else
  echo "No .token file and CLAUDE_CODE_OAUTH_TOKEN is unset; skip auth." >&2
fi
