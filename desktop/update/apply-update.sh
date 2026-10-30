#!/bin/bash
# Applies a downloaded Rubban update after Rubban has exited. Started detached by desktop/updater.cjs:
#   apply-update.sh <zip> <Rubban.app> <pid> <result.json> <version>
# Always opens a Rubban again (the new one, or the old one when something went wrong) and writes result.json.
set -u
zip="$1"; bundle="$2"; pid="$3"; result="$4"; version="${5:-}"
work="$(dirname "$zip")"
extract="$work/extract"
installed="$bundle"

write_result() {
  local message
  message="$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')"
  printf '{"ok":%s,"version":"%s","error":"%s","installedTo":"%s"}\n' "$1" "$version" "$message" "$installed" > "$result"
}
finish() {
  rm -rf "$extract"
  write_result "$1" "$2"
  if [ "${RUBBAN_NO_START:-}" != "1" ] && command -v open >/dev/null 2>&1; then open "$installed"; fi
  exit 0
}

for _ in $(seq 1 240); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$pid" 2>/dev/null; then finish false "Rubban did not close in time."; fi

rm -rf "$extract"; mkdir -p "$extract"
if command -v ditto >/dev/null 2>&1; then ditto -x -k "$zip" "$extract" || finish false "The update could not be unpacked."
else unzip -q "$zip" -d "$extract" || finish false "The update could not be unpacked."; fi
new="$(find "$extract" -maxdepth 3 -name Rubban.app -type d | head -n 1)"
[ -n "$new" ] || finish false "The update does not contain Rubban.app."

command -v xattr >/dev/null 2>&1 && xattr -dr com.apple.quarantine "$new" 2>/dev/null
if command -v codesign >/dev/null 2>&1 && ! codesign --verify --deep --strict "$new" >/dev/null 2>&1; then
  codesign --force --deep --sign - "$new" >/dev/null 2>&1 || finish false "The update could not be signed for this Mac."
fi

target="$bundle"
if [ ! -w "$(dirname "$bundle")" ]; then
  target="$HOME/Applications/Rubban.app"
  mkdir -p "$HOME/Applications"
fi
backup="$target.old"
rm -rf "$backup"
if [ -e "$target" ]; then mv "$target" "$backup" || finish false "The previous version could not be moved aside."; fi
if mv "$new" "$target"; then
  rm -rf "$backup" "$zip"
  installed="$target"
  finish true ""
else
  rm -rf "$target"
  [ -e "$backup" ] && mv "$backup" "$target"
  finish false "The new version could not be put in place."
fi
