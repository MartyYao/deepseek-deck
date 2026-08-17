#!/bin/sh
# Launchd entrypoint for the bundled DSH runtime.
# The shell owns both Node and dsh; this script does not depend on Hermes or an
# interactive PATH. An updated ~/.dsh/runtime takes precedence over app data.
set -eu

APP_ROOT="${DSH_SHELL_APP:-$HOME/Applications/DeepSeek Harness.app}"
RESOURCES="$APP_ROOT/Contents/Resources"
NODE="$RESOURCES/node-bin/node"
RESOURCE_RUNTIME="$RESOURCES/dsh-runtime"
USER_RUNTIME="${DSH_HOME:-$HOME/.dsh}/runtime"

if [ -f "$USER_RUNTIME/node_modules/@deepseek-ai/dsh/lib/bin.js" ]; then
  DSH_ROOT="$USER_RUNTIME"
else
  DSH_ROOT="$RESOURCE_RUNTIME"
fi

export PATH="$RESOURCES/node-bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "$NODE" "$DSH_ROOT/node_modules/@deepseek-ai/dsh/lib/bin.js" web
