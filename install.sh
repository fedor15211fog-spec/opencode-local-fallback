#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_SOURCE="$ROOT/plugins/limit-fallback"
PLUGIN_TARGET="$CONFIG/plugins/limit-fallback"

echo "Local Fallback installer"
echo "Config: $CONFIG"

mkdir -p "$(dirname "$PLUGIN_TARGET")"
rm -rf "$PLUGIN_TARGET"
cp -r "$PLUGIN_SOURCE" "$PLUGIN_TARGET"
echo "Plugin copied to $PLUGIN_TARGET"

CONFIG_FILE="$CONFIG/opencode.json"
if [ ! -f "$CONFIG_FILE" ]; then
  cp "$ROOT/opencode.example.json" "$CONFIG_FILE"
  echo "Created $CONFIG_FILE"
else
  echo
  echo "opencode.json already exists. Add this provider block manually:"
  echo
  cat "$ROOT/opencode.example.json"
fi

echo
echo "Next steps:"
echo "  1. Start your local server (LM Studio / Ollama) with a code model."
echo "  2. Open http://127.0.0.1:1236/ and set the server URL and model name."
echo "  3. In OpenCode run /local (or use the Ctrl+P command palette)."
