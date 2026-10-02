#!/bin/sh
set -e

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -f "$SCRIPT_DIR/bin/jmc.mjs" ]; then
  JMC_BUNDLE="$SCRIPT_DIR/bin/jmc.mjs"
  INSTALL_SCRIPT="$SCRIPT_DIR/bin/install.mjs"
elif [ -f "$SCRIPT_DIR/../dist/bin/jmc.mjs" ]; then
  JMC_BUNDLE="$SCRIPT_DIR/../dist/bin/jmc.mjs"
  INSTALL_SCRIPT="$SCRIPT_DIR/../scripts/install.mjs"
else
  printf '[FAILED] JMC bundle not found next to %s\n' "$0" >&2
  exit 1
fi

if [ ! -f "$INSTALL_SCRIPT" ]; then
  printf '[FAILED] install.mjs not found next to the JMC bundle\n' >&2
  exit 1
fi

exec node "$INSTALL_SCRIPT" "$@"
