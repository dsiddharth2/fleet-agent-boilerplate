#!/bin/sh
set -eu

# Same commands as a host provision. Docker entrypoint runs this after `apra-fleet start`.
# Token comes from CLAUDE_CODE_OAUTH_TOKEN and goes straight into Fleet's credential store.

REGISTRY="${HOME}/.apra-fleet/data/registry.json"

ensure_member() {
  name="$1"
  work_path="$2"
  mkdir -p "$work_path"
  if [ -f "$REGISTRY" ] && grep -q "\"$name\"" "$REGISTRY"; then
    echo "✓ $name already registered; skipping."
    return 0
  fi
  apra-fleet register-member --type local --llm claude \
    --name "$name" \
    --path "$work_path"
}

WORKER_POOL_SIZE="${WORKER_POOL_SIZE:-4}"

i=1
while [ "$i" -le "$WORKER_POOL_SIZE" ]; do
  ensure_member "WORKER-${i}-DOER" "$(pwd)/workdir/worker-${i}/doer"
  ensure_member "WORKER-${i}-REVIEWER" "$(pwd)/workdir/worker-${i}/reviewer"
  i=$((i + 1))
done

if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  # Every role on every worker gets the token: a workflow author may target
  # either role with agent() and should not have to know which ones carry
  # credentials.
  i=1
  while [ "$i" -le "$WORKER_POOL_SIZE" ]; do
    apra-fleet auth --oauth --member "WORKER-${i}-DOER" "$CLAUDE_CODE_OAUTH_TOKEN"
    apra-fleet auth --oauth --member "WORKER-${i}-REVIEWER" "$CLAUDE_CODE_OAUTH_TOKEN"
    i=$((i + 1))
  done
else
  echo "CLAUDE_CODE_OAUTH_TOKEN is unset; skip auth. agent() calls will fail." >&2
fi
