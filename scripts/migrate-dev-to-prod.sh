#!/usr/bin/env bash
# Copy the board's data from the dev build to the production build (macOS).
#
#   scripts/migrate-dev-to-prod.sh            # do it
#   scripts/migrate-dev-to-prod.sh --dry-run  # only show what would happen
#
# What moves (dev replaces prod; prod is backed up first):
#   - app data files: people.json, notes.json, settings.json, briefs.json, memo.txt
#   - localStorage of the window (collapsed rows, change log, NEW highlights, recent projects, Zoom "sent" marks…),
#     key by key, into the prod WebKit store.
# Both apps must be closed. Launch the prod app once beforehand so its WebKit store exists.
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

LIB="$HOME/Library"
DEV_ID="dev.jirapeopleboard.devbuild"
PROD_ID="dev.jirapeopleboard.app"
DEV_DATA="$LIB/Application Support/$DEV_ID"
PROD_DATA="$LIB/Application Support/$PROD_ID"
FILES=(people.json notes.json settings.json briefs.json memo.txt)

run() { if ((DRY)); then echo "  would: $*"; else "$@"; fi; }
die() { echo "error: $*" >&2; exit 1; }

# Newest localstorage.sqlite3 under the given WebKit folders (tauri dev and the dev bundle use different ones).
newest_ls() {
  local best="" f
  for d in "$@"; do
    [[ -d "$d" ]] || continue
    while IFS= read -r f; do
      if [[ -z "$best" || "$f" -nt "$best" ]]; then best="$f"; fi
    done < <(find "$d" -name localstorage.sqlite3 -path '*/Default/*' 2>/dev/null)
  done
  printf '%s' "$best"
}

[[ -d "$DEV_DATA" ]] || die "no dev data at $DEV_DATA"
if pgrep -fi "jira[- ]people[- ]board" >/dev/null; then
  die "Jira People Board is running (dev or prod). Quit both and run again."
fi

DEV_LS="$(newest_ls "$LIB/WebKit/$DEV_ID" "$LIB/WebKit/jira-people-board")"
PROD_LS="$(newest_ls "$LIB/WebKit/$PROD_ID")"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$LIB/Application Support/$PROD_ID.backup-$STAMP"

echo "Dev data:   $DEV_DATA"
echo "Prod data:  $PROD_DATA"
echo "Backup to:  $BACKUP"
echo

# 1. Backup prod (data folder + localStorage file).
run mkdir -p "$BACKUP"
[[ -d "$PROD_DATA" ]] && run cp -Rp "$PROD_DATA/." "$BACKUP/data/"
if [[ -n "$PROD_LS" ]]; then
  run mkdir -p "$BACKUP/localstorage"
  run cp -p "$PROD_LS"* "$BACKUP/localstorage/"
fi

# 2. App data files.
run mkdir -p "$PROD_DATA"
for f in "${FILES[@]}"; do
  if [[ -f "$DEV_DATA/$f" ]]; then
    echo "copy $f"
    run cp -p "$DEV_DATA/$f" "$PROD_DATA/$f"
  fi
done

# 3. localStorage, key by key (the store files are per-origin and salted, so the file itself can't just be copied).
if [[ -z "$DEV_LS" ]]; then
  echo "skip localStorage: none found for the dev build"
elif [[ -z "$PROD_LS" ]]; then
  echo "skip localStorage: the prod app has no WebKit store yet. Launch it once, quit, and run this again."
else
  echo "copy localStorage keys:"
  sqlite3 "file:$DEV_LS?mode=ro" "select '  ' || key from ItemTable order by key"
  run sqlite3 "$PROD_LS" "attach 'file:$DEV_LS?mode=ro' as dev; insert or replace into main.ItemTable select key, value from dev.ItemTable; detach dev;"
fi

echo
if ((DRY)); then echo "Dry run: nothing changed."; else echo "Done. Prod backup: $BACKUP"; fi
if [[ -f "$DEV_DATA/settings.json" ]]; then
  echo "Note: settings.json came from dev. If dev used a different credentials file, check it in Settings."
fi
