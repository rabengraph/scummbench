#!/usr/bin/env bash
# add-game.sh — drop a game into web/data/games/<id>/ so the fork's
# runtime can find it.
#
# Usage:
#   ./scripts/add-game.sh <zip-or-dir> <game-id>
#
# Examples:
#   ./scripts/add-game.sh ~/Downloads/monkey1-demo.zip monkey1
#   ./scripts/add-game.sh ~/games/Loom-demo        loom
#
# The first argument can be either a zip file or a directory. Either
# way, its contents end up under web/data/games/<game-id>/. After
# unpacking we re-run the fork's build-make_http_index.py to refresh
# the per-folder index.json files that the HTTP filesystem layer needs
# to see the new game.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$ROOT/web/data"
GAMES_DIR="$DATA_DIR/games"
INDEX_SCRIPT="$ROOT/vendor/scummvm-agent/dists/emscripten/build-make_http_index.py"

log()  { printf "\033[1;36m[add-game]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[add-game]\033[0m %s\n" "$*" >&2; }
err()  { printf "\033[1;31m[add-game]\033[0m %s\n" "$*" >&2; }

if [ "$#" -ne 2 ]; then
  err "usage: $0 <zip-or-dir> <game-id>"
  err "example: $0 ~/Downloads/monkey1-demo.zip monkey1"
  exit 1
fi

SRC="$1"
GAME_ID="$2"

if [ ! -e "$SRC" ]; then
  err "source not found: $SRC"
  exit 1
fi

if [[ ! "$GAME_ID" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
  err "game-id must be kebab-case (lowercase letters, digits, '._-')"
  err "got: $GAME_ID"
  exit 1
fi

if [ ! -d "$DATA_DIR" ]; then
  err "web/data/ does not exist. Run ./scripts/build-scummvm.sh first"
  err "  (or at least the dist-emscripten step) so the GUI theme and"
  err "  engine data are in place."
  exit 1
fi

if [ ! -f "$INDEX_SCRIPT" ]; then
  err "index generator not found: $INDEX_SCRIPT"
  err "  the scummvm fork isn't checked out. Run ./scripts/build-scummvm.sh first."
  exit 1
fi

DEST="$GAMES_DIR/$GAME_ID"
mkdir -p "$GAMES_DIR"

if [ -d "$DEST" ]; then
  warn "$DEST already exists — removing before re-adding"
  rm -rf "$DEST"
fi
mkdir -p "$DEST"

if [ -d "$SRC" ]; then
  log "copying directory $SRC → $DEST"
  # Copy contents of the source dir, not the dir itself.
  ( cd "$SRC" && find . -mindepth 1 -maxdepth 1 -print0 | \
    xargs -0 -I{} cp -R {} "$DEST/" )
elif [ -f "$SRC" ]; then
  case "$SRC" in
    *.zip)
      log "unzipping $SRC → $DEST"
      unzip -q -o "$SRC" -d "$DEST"
      ;;
    *)
      err "unsupported file type: $SRC (expected .zip or a directory)"
      exit 1
      ;;
  esac
else
  err "source is neither file nor directory: $SRC"
  exit 1
fi

# Some zips nest everything under a single top-level dir (e.g. the
# ScummVM freeware demos ship as monkey1-demo/<files>). Flatten that
# so game files land directly in $DEST.
shopt -s nullglob dotglob
entries=("$DEST"/*)
shopt -u nullglob dotglob
if [ "${#entries[@]}" -eq 1 ] && [ -d "${entries[0]}" ]; then
  inner="${entries[0]}"
  log "flattening single top-level dir: $(basename "$inner")"
  # mv contents (including dotfiles) up one level
  ( cd "$inner" && find . -mindepth 1 -maxdepth 1 -print0 | \
    xargs -0 -I{} mv {} "$DEST/" )
  rmdir "$inner"
fi

count=$(find "$DEST" -type f | wc -l | tr -d ' ')
log "placed $count file(s) under $DEST"

log "regenerating index.json tree under $DATA_DIR"
python3 "$INDEX_SCRIPT" "$DATA_DIR"

log "done. Launch with:"
log "  http://127.0.0.1:5173/routes/game.html?game=$GAME_ID"
