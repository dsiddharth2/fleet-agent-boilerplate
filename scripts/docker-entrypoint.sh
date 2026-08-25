#!/bin/sh
set -eu

# Live runs: start Fleet, register members, attach OAuth, then exec the command.
# `node --test` skips provision (mock).

skip_provision=0
for arg in "$@"; do
  if [ "$arg" = "--test" ]; then
    skip_provision=1
    break
  fi
done

if [ "$skip_provision" -eq 0 ]; then
  mkdir -p /workspace/workdir/BOILERPLATE-DOER /workspace/workdir/BOILERPLATE-REVIEWER
  cd /workspace

  apra-fleet start
  n=0
  while [ "$n" -lt 120 ]; do
    if apra-fleet status >/dev/null 2>&1; then
      break
    fi
    n=$((n + 1))
    sleep 0.5
  done
  if ! apra-fleet status >/dev/null 2>&1; then
    echo "Fleet server did not become ready within 60s after 'apra-fleet start'." >&2
    exit 1
  fi

  /workspace/scripts/provision-members.sh
fi

exec "$@"
