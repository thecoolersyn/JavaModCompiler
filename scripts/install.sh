#!/bin/sh
set -e

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ ! -f "$PROJECT_ROOT/dist/bin/jmc.mjs" ]; then
  printf '[INFO] Building JMC from source\n'
  (cd "$PROJECT_ROOT" && npm run build)
fi

exec node "$PROJECT_ROOT/scripts/install.mjs" "$@"