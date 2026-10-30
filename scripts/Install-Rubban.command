#!/bin/bash
# Installs Rubban.app from this folder into /Applications (or ~/Applications when /Applications is
# not writable), clears the download quarantine and makes sure the app carries a valid ad hoc
# signature for this Mac. Run it from Terminal:  bash Install-Rubban.command
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
source_app="$here/Rubban.app"
if [ ! -d "$source_app" ]; then
  echo "Rubban.app was not found next to this script ($here)." >&2
  exit 1
fi
if pgrep -xq Rubban; then
  echo "Rubban is running. Quit it first (⌘Q), then run this again." >&2
  exit 1
fi

target_dir="/Applications"
if [ ! -w "$target_dir" ]; then
  target_dir="$HOME/Applications"
  mkdir -p "$target_dir"
fi
target="$target_dir/Rubban.app"

echo "Installing Rubban to $target"
rm -rf "$target"
ditto "$source_app" "$target"

# Downloaded files are quarantined by Gatekeeper; Rubban is not notarised by Apple.
xattr -dr com.apple.quarantine "$target" 2>/dev/null || true

# Apple silicon refuses to run code without a valid signature; sign ad hoc if needed.
if ! codesign --verify --deep --strict "$target" >/dev/null 2>&1; then
  echo "Signing Rubban ad hoc for this Mac…"
  codesign --force --deep --sign - "$target"
fi

echo "Rubban is installed. Your settings are kept in ~/Library/Application Support/Rubban."
open "$target"
