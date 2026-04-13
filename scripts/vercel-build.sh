#!/usr/bin/env bash
# vercel-build.sh — Install Emscripten and build the ScummVM fork
# during Vercel's build step. The resulting WASM artifacts land in
# web/public/scummvm/ so the static deployment serves them.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EMSDK_DIR="$ROOT/vendor/emsdk"
EMSDK_VERSION="${EMSDK_VERSION:-latest}"

log()  { printf "\033[1;36m[vercel-build]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[vercel-build]\033[0m %s\n" "$*" >&2; }

# ── 1. Install Emscripten SDK ────────────────────────────────────────
log "installing emsdk ($EMSDK_VERSION)…"
git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
cd "$EMSDK_DIR"
./emsdk install "$EMSDK_VERSION"
./emsdk activate "$EMSDK_VERSION"
source ./emsdk_env.sh
log "emcc version: $(emcc --version | head -1)"

# ── 2. Build ScummVM ─────────────────────────────────────────────────
cd "$ROOT"
log "running build-scummvm.sh…"
./scripts/build-scummvm.sh

log "vercel build complete."
