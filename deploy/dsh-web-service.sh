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

# Plugins must resolve dsh-tools to the exact module instance used by this
# service. A profile-level copy (even the same version) has different Cordis
# symbols and makes the agent loop see an undefined tool scheduler.
WEB_PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/web"
SERVICE_DSH_TOOLS="$DSH_ROOT/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools"
if [ ! -d "$SERVICE_DSH_TOOLS" ]; then
  # npm may hoist a peer to the runtime root. It is still the correct module
  # only when this is the copy resolved by this DSH_ROOT.
  SERVICE_DSH_TOOLS="$DSH_ROOT/node_modules/@deepseek-ai/dsh-tools"
fi
PROFILE_DSH_TOOLS="$WEB_PROFILE/node_modules/@deepseek-ai/dsh-tools"
if [ ! -f "$SERVICE_DSH_TOOLS/lib/index.js" ]; then
  echo "[dsh-web] fatal: dsh-tools missing under runtime: $DSH_ROOT" >&2
  exit 1
fi
service_tools_real="$(realpath "$SERVICE_DSH_TOOLS")"
if [ -d "$WEB_PROFILE/node_modules/@deepseek-ai" ]; then
  profile_tools_real="$(realpath "$PROFILE_DSH_TOOLS" 2>/dev/null || true)"
  if [ "$profile_tools_real" != "$service_tools_real" ]; then
    if [ -e "$PROFILE_DSH_TOOLS" ] || [ -L "$PROFILE_DSH_TOOLS" ]; then
      backup="$PROFILE_DSH_TOOLS.bak-runtime-mismatch-$(date +%Y%m%d-%H%M%S)"
      mv "$PROFILE_DSH_TOOLS" "$backup"
    fi
    ln -s "$SERVICE_DSH_TOOLS" "$PROFILE_DSH_TOOLS"
    echo "[dsh-web] repaired dsh-tools identity: $profile_tools_real -> $service_tools_real"
  fi
fi
service_tools_version="$("$NODE" -p "require('$SERVICE_DSH_TOOLS/package.json').version")"
echo "[dsh-web] runtime=$DSH_ROOT dsh-tools=$service_tools_version path=$service_tools_real"

export PATH="$RESOURCES/node-bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "$NODE" "$DSH_ROOT/node_modules/@deepseek-ai/dsh/lib/bin.js" web
