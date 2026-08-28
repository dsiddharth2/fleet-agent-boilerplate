#!/bin/sh
set -eu

# Same commands as a host provision. Docker entrypoint runs this after `apra-fleet start`.
# Token comes from CLAUDE_CODE_OAUTH_TOKEN and goes straight into Fleet's credential store.

STATUS=$(apra-fleet status 2>/dev/null || true)

register_if_absent() {
  name="$1"
  work_path="$2"
  if echo "$STATUS" | grep -q "$name"; then
    echo "✓ $name already registered; skipping."
  else
    apra-fleet register-member --type local --llm claude \
      --name "$name" \
      --path "$work_path"
  fi
}

register_if_absent DEMO-DOER "$(pwd)/workdir/DEMO-DOER"
register_if_absent DEMO-REVIEWER "$(pwd)/workdir/DEMO-REVIEWER"

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  apra-fleet auth --oauth --member DEMO-DOER "$CLAUDE_CODE_OAUTH_TOKEN"
else
  echo "CLAUDE_CODE_OAUTH_TOKEN is unset; skip auth. agent() calls will fail." >&2
fi
