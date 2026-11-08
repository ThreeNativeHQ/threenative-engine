#!/usr/bin/env bash
# Stage the PS4 third-party prebuilts the `tn-ps4` preset configures against.
#
# The engine, its V8 adapter and the player build FROM THE REPO but AGAINST binaries no
# download-deps.mjs lane produces (there is no PS4 target there): the Dawn archive scripts/ps4/
# e3-build.sh built and the V8 monolith scripts/ps4/e4-build.sh built. CMakeLists.txt looks for
# them where it looks for every other platform's prebuilts — ${THIRD_PARTY_DIR}/{dawn,v8,sdl3,
# stb,cgltf} — so this script stages that exact layout under --out and points the worktree's
# (git-ignored) third_party at it with one symlink. It builds nothing and copies no bytes: every
# entry is a symlink, so a rebuilt Dawn or V8 is picked up by relinking, never by restaging.
#
# Usage:
#   packages/runtime-native/scripts/ps4/ps4-deps.sh [--out DIR] [--repo DIR]
#     DIR defaults to $TN_PS4_E5_DIR, else ~/.cache/tmp-tn/prd784/e5.
#     --repo defaults to this script's package root; only its git-ignored `third_party` entry is
#     written (and only when absent, unless --force).
#
# Inputs it refuses to invent (fail closed, naming the recipe):
#   $TN_PS4_E4_DIR/v8/out/ps4/obj/libv8_monolith.a   (scripts/ps4/e4-build.sh)
#   $TN_PS4_E3_DIR/out/libwebgpu_dawn.a              (scripts/ps4/e3-build.sh)
#   <repo-checkout>/third_party/{stb,cgltf,sdl3}     (node scripts/download-deps.mjs)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${REPO:-$(cd "$HERE/../.." && pwd)}"
DEPS="${TN_PS4_DEPS:-$HOME/.cache/tmp-tn/prd784/deps}"
E3="${TN_PS4_E3_DIR:-$HOME/.cache/tmp-tn/prd784/e3}"
E4="${TN_PS4_E4_DIR:-$HOME/.cache/tmp-tn/prd784/e4}"
OUT="${TN_PS4_E5_DIR:-$HOME/.cache/tmp-tn/prd784/e5}"
FORCE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

log() { printf '[ps4-deps] %s\n' "$*"; }
die() { printf '[ps4-deps] %s\n' "$*" >&2; exit 2; }

# The host checkout, not this worktree: download-deps output is platform-independent here (stb,
# cgltf and SDL3 headers are the same bytes on every host), and a worktree rarely has its own.
MAIN_REPO="${TN_PS4_MAIN_REPO:-$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | xargs -r dirname || true)}"
[ -n "$MAIN_REPO" ] && [ -d "$MAIN_REPO/packages/runtime-native/third_party" ] ||
  die "no host third_party: run 'node packages/runtime-native/scripts/download-deps.mjs' in the main checkout, or set TN_PS4_MAIN_REPO"

V8_MONOLITH="$E4/v8/out/ps4/obj/libv8_monolith.a"
[ -f "$V8_MONOLITH" ] || die "no V8 monolith at $V8_MONOLITH (scripts/ps4/e4-build.sh)"
[ -d "$E4/v8/include" ] || die "no V8 headers at $E4/v8/include"
DAWN_LIB="$E3/out/libwebgpu_dawn.a"
DAWN_GEN="$E3/build/gen/include"
[ -f "$DAWN_LIB" ] || die "no Dawn archive at $DAWN_LIB (scripts/ps4/e3-build.sh)"
[ -d "$E3/dawn/include" ] && [ -d "$DAWN_GEN" ] || die "no Dawn headers under $E3 (scripts/ps4/e3-build.sh)"

D="$OUT/deps/third_party"
mkdir -p "$D/v8/lib" "$D/dawn/Dawn-ps4-Release/lib64" "$D/sdl3"

log "staging prebuilts under $D"
ln -sfn "$V8_MONOLITH" "$D/v8/libv8_monolith.a"
ln -sfn "$E4/v8/include" "$D/v8/include"
ln -sfn "$DAWN_LIB" "$D/dawn/Dawn-ps4-Release/lib64/libwebgpu_dawn.a"
# One include root holding Dawn's own headers and the generated ones (webgpu/webgpu.h,
# dawn/webgpu_cpp.h, ...), generated last so it wins where both ship a name.
DAWN_INC="$D/dawn/Dawn-ps4-Release/include"
rm -rf "$DAWN_INC"
mkdir -p "$DAWN_INC"
for src in "$E3/dawn/include" "$DAWN_GEN"; do
  ( cd "$src" && find . -type f | while read -r f; do
      mkdir -p "$DAWN_INC/$(dirname "$f")"
      ln -sf "$src/${f#./}" "$DAWN_INC/${f#./}"
    done )
done

HOST_TP="$MAIN_REPO/packages/runtime-native/third_party"
ln -sfn "$HOST_TP/stb" "$D/stb"
ln -sfn "$HOST_TP/cgltf" "$D/cgltf"
# meshopt decodes EXT_meshopt_compression (the starter's GLBs): the host copy, else fetched into the stage.
if [ -d "$HOST_TP/meshopt" ]; then ln -sfn "$HOST_TP/meshopt" "$D/meshopt"
elif [ ! -f "$D/meshopt/vertexcodec.cpp" ]; then
  node "$HERE/../download-deps.mjs" --only meshopt >/dev/null && mv "$HERE/../../third_party/meshopt" "$D/meshopt" 2>/dev/null || true
fi
# SDL3: headers only. The source tree's CMakeLists.txt is deliberately NOT staged, so
# CMakeLists.txt takes its header-only branch instead of trying to build a driver for a
# platform upstream SDL3 has no port for.
for sdldir in "$HOST_TP"/sdl3/SDL3-*; do
  [ -d "$sdldir/include" ] || continue
  mkdir -p "$D/sdl3/$(basename "$sdldir")"
  ln -sfn "$sdldir/include" "$D/sdl3/$(basename "$sdldir")/include"
done
[ -d "$D/sdl3"/SDL3-*/include ] || die "no SDL3 headers under $HOST_TP/sdl3"
# SDL3's static library: the headers above let the engine compile the player's 62 SDL calls, and
# this archive lets the guest link them. scripts/ps4/ps4-sdl3.sh owns the build (its own CMake tree
# and stamp, its own answers to SDL's FreeBSD/console checks); this stages only its product, as a
# symlink, so a changed SDL3 knob is a relink here and never a copy.
"$HERE/ps4-sdl3.sh" --out "$OUT/sdl3-build"
for sdldir in "$D/sdl3"/SDL3-*; do
  mkdir -p "$sdldir/lib"
  ln -sfn "$OUT/sdl3-build/libSDL3.a" "$sdldir/lib/libSDL3.a"
done
[ -e "$D/sdl3"/SDL3-*/lib/libSDL3.a ] || die "no SDL3 static library under $D/sdl3"

TP="$REPO/third_party"
if [ -e "$TP" ] && [ ! -L "$TP" ]; then
  log "$TP exists and is not a symlink: leaving it alone (run with --force after moving it)"
  [ "$FORCE" = 1 ] || { log "done"; exit 0; }
  mv "$TP" "$TP.bak-$(date +%s)"
fi
rm -f "$TP"
ln -sfn "$D" "$TP"
log "linked $TP -> $D"

for f in "$D/dawn/Dawn-ps4-Release/include/webgpu/webgpu.h" "$D/dawn/Dawn-ps4-Release/include/dawn/webgpu_cpp.h" \
         "$D/v8/include/v8.h" "$D/v8/libv8_monolith.a" "$D/dawn/Dawn-ps4-Release/lib64/libwebgpu_dawn.a"; do
  [ -e "$f" ] || die "staged tree is missing $f"
done
# The preset links native physics (Rust Rapier, as on Android and iOS): its PS4 staticlib.
log "native physics: node scripts/build-native-physics.mjs --ps4"
(cd "$REPO" && node scripts/build-native-physics.mjs --ps4) || die "native physics build failed (rustup target add x86_64-unknown-linux-musl)"
# ... and the CSS UI (Rust; the HUD backend): its PS4 staticlib, built without system fonts.
log "css ui: node scripts/build-native-css-ui.mjs --ps4"
(cd "$REPO" && node scripts/build-native-css-ui.mjs --ps4) || die "css ui build failed (rustup target add x86_64-unknown-linux-musl)"
log "done: cmake --preset tn-ps4 && cmake --build --preset tn-ps4"
