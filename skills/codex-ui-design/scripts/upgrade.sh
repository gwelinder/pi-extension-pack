#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd -P "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="${CODEX_UI_RUNTIME:-$SKILL_DIR/runtime}"
if [ ! -f "$RUNTIME_DIR/bin/codex-ui-design.mjs" ]; then
  echo "codex-ui-design: runtime not found. Set CODEX_UI_RUNTIME=/abs/path/to/runtime." >&2
  exit 2
fi
if [ ! -d "$RUNTIME_DIR/node_modules" ]; then
  echo "codex-ui-design: installing runtime dependencies (first run only)..." >&2
  (cd "$RUNTIME_DIR" && npm install --silent)
fi
exec node "$RUNTIME_DIR/bin/codex-ui-design.mjs" upgrade "$@"
