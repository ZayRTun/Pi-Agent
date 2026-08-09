#!/usr/bin/env bash
# Reapply the Prime Agent TUI patches to the installed pi.
#
# Pi ships as an npm package; any `npm update` / reinstall of
# @earendil-works/pi-coding-agent wipes node_modules, so run this script
# afterwards to restore the Prime TUI look.
#
# Usage: bash ~/.pi/agent/prime-tui/apply-patches.sh

set -euo pipefail

PI_PKG="$HOME/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent"
TUI_DIST="$PI_PKG/node_modules/@earendil-works/pi-tui/dist"
PATCHES="$HOME/.pi/agent/prime-tui/patched"

if [[ ! -d "$TUI_DIST" ]]; then
  echo "error: pi-tui not found at $TUI_DIST" >&2
  exit 1
fi

BACKUP="$HOME/.pi/agent/prime-tui/backup"
mkdir -p "$BACKUP"

apply() {
  local src="$1" dst="$2"
  if [[ ! -f "$src" ]]; then
    echo "error: missing patch file $src" >&2
    exit 1
  fi
  # First copy is a pristine backup of whatever is currently installed.
  if [[ ! -f "$BACKUP/$(basename "$dst")" ]]; then
    cp "$dst" "$BACKUP/" 2>/dev/null || true
  fi
  cp "$src" "$dst"
  echo "patched: $dst"
}

apply "$PATCHES/editor.js"                    "$TUI_DIST/components/editor.js"
apply "$PATCHES/select-list.js"               "$TUI_DIST/components/select-list.js"
apply "$PATCHES/autocomplete.js"              "$TUI_DIST/autocomplete.js"
apply "$PATCHES/settings-list.js"             "$TUI_DIST/components/settings-list.js"
apply "$PATCHES/pi-coding-agent-theme.js"     "$PI_PKG/dist/modes/interactive/theme/theme.js"
apply "$PATCHES/pi-coding-agent-interactive-mode.js" "$PI_PKG/dist/modes/interactive/interactive-mode.js"

echo
echo "Prime TUI patches applied. Restart pi to see the new look."
echo "To revert: copy files from $BACKUP back over the same paths."
