#!/usr/bin/env bash
# e4-build.sh — PRD-784 / E4: build the jitless V8 13.1 monolith for PS4 (OpenOrbis) and link the
# C++ embedder that runs it inside shadPS4.
#
#   out/eboot.bin        SELF form shadPS4 boots (create-fself, from out/e4-v8-hello.elf)
#   out/e4-v8-hello.elf  ld.lld over v8/out/ps4/obj/libv8_monolith.a + the OpenOrbis sysroot libs
#   v8/out/ps4/         the gn/ninja tree; 2715 steps the first time, incremental after
#
# Usage:
#   packages/runtime-native/scripts/ps4/e4-build.sh [--out DIR] [--force]
#     DIR defaults to $TN_PS4_E4_DIR, else ~/.cache/tmp-tn/prd784/e4.
#   A finished build is reused while the V8 patches, the gn args and e4-v8-hello.cc are unchanged:
#   the monolith stamp skips gn+ninja (the 2715 steps), the embedder stamp skips only the relink.
#   Pass --force (or TN_PS4_E4_REBUILD=1) to rebuild everything regardless.
#   The monolith is ninja's output and only ninja's: its stamp names the archive's own hash, and a
#   foreign .a (hand-assembled from objects of two vintages, which once aborted inside
#   i::Isolate::Enter on a struct offset the TUs disagreed about) is deleted before ninja runs.
#   OO_PS4_TOOLCHAIN defaults to $TN_PS4_DEPS/oo/OpenOrbis/PS4Toolchain
#   ($TN_PS4_DEPS = ~/.cache/tmp-tn/prd784/deps) and must hold OpenOrbis v0.5.4.
#
# Writes only under --out. The V8 tree is NOT fetched here (a gclient sync is its own 20 minutes):
# when it is missing the script prints the recipe and fails, so a silent re-download never happens.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPS="${TN_PS4_DEPS:-$HOME/.cache/tmp-tn/prd784/deps}"
OUT="${TN_PS4_E4_DIR:-$HOME/.cache/tmp-tn/prd784/e4}"
FORCE="${TN_PS4_E4_REBUILD:-0}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

export OO_PS4_TOOLCHAIN="${OO_PS4_TOOLCHAIN:-$DEPS/oo/OpenOrbis/PS4Toolchain}"
OO="$OO_PS4_TOOLCHAIN"
JOBS="${JOBS:-8}"

# === Pins (override any of these from the environment) ========================
V8_TAG="${V8_TAG:-13.1.201.22}"
V8_COMMIT="${V8_COMMIT:-9c09e7876ff830e1f9a731aa930040d1028ff5a1}"              # chromium.googlesource.com/v8/v8
V8_BUILD_COMMIT="${V8_BUILD_COMMIT:-61966507f36426729edb3cf308d78b80eecb7b73}"  # the v8/build sub-checkout
DEPOT_TOOLS_COMMIT="${DEPOT_TOOLS_COMMIT:-500126d6e351e4f0834b70f71b454ce5c3733c54}"

# The tree these products were built from:
#   git clone --depth 1 --branch "$V8_TAG" https://chromium.googlesource.com/v8/v8.git v8
#   (fetch depot_tools at $DEPOT_TOOLS_COMMIT, gclient sync with .gclient's custom_deps pruning
#   test262/mozilla/benchmarks/icu/libc++/fuzztest; v8/build is the DEPS sub-checkout).
V8="$OUT/v8"
V8OUT="$V8/out/ps4"
APP="$OUT/out"

# === GN args (one block, hashed into the monolith stamp) ======================
read -r -d '' GN_ARGS <<EOF || true
target_os = "ps4"
target_cpu = "x64"
v8_target_cpu = "x64"
is_debug = false
symbol_level = 0
is_component_build = false
v8_monolithic = true
v8_enable_pointer_compression = false
v8_enable_sandbox = false
v8_enable_i18n_support = false
v8_enable_webassembly = false
v8_use_external_startup_data = false
v8_enable_test_features = false
v8_enable_gdbjit = false
use_custom_libcxx = false
use_custom_libcxx_for_host = false
use_sysroot = false
is_clang = true
use_lld = true
clang_use_chrome_plugins = false
treat_warnings_as_errors = false
v8_snapshot_toolchain = "//build/toolchain/linux:clang_x64"
v8_enable_fuzztest = false
ps4_toolchain_root = "$OO"
EOF

# === dlmalloc: the guest allocator ps4-malloc.c compiles ====================
# Doug Lea's dlmalloc 2.8.6, public domain, DOWNLOADED and hash-pinned rather than vendored: the
# guest allocates every byte of V8's heap through it, so the provenance is a URL plus a digest, not
# a copy in this repo. A mirror (or a local copy) is fine as long as it is this file:
#   TN_PS4_MALLOC_URL=<url> packages/runtime-native/scripts/ps4/e4-build.sh
MALLOC_URL="${TN_PS4_MALLOC_URL:-https://gee.cs.oswego.edu/pub/misc/malloc.c}"
MALLOC_SHA="${TN_PS4_MALLOC_SHA:-be7be56b40b4b31417e74e77687f9b96127ea6cae534cf236aee40a4c739508d}"
MALLOC_SRC="$DEPS/dlmalloc.c"  # the name ps4-malloc.c includes

# Fail closed on anything but the pinned bytes: a different malloc.c is a different allocator, and
# the run that follows would be measuring it instead of the one the recipe describes.
ensure_dlmalloc() {
  if [ -f "$MALLOC_SRC" ] && [ "$(sha256sum "$MALLOC_SRC" | cut -d' ' -f1)" = "$MALLOC_SHA" ]; then
    return 0
  fi
  log "downloading dlmalloc $MALLOC_URL -> $MALLOC_SRC"
  mkdir -p "$DEPS"
  rm -f "$MALLOC_SRC"
  if ! curl -fsSL --max-time 120 -o "$MALLOC_SRC.part" "$MALLOC_URL"; then
    log "download failed: $MALLOC_URL"
    log "set TN_PS4_MALLOC_URL to a mirror of dlmalloc 2.8.6 that hashes to $MALLOC_SHA"
    rm -f "$MALLOC_SRC.part"
    exit 2
  fi
  local have
  have="$(sha256sum "$MALLOC_SRC.part" | cut -d' ' -f1)"
  if [ "$have" != "$MALLOC_SHA" ]; then
    log "$MALLOC_URL hashes to $have, the recipe pins $MALLOC_SHA: refusing to build a different allocator"
    rm -f "$MALLOC_SRC.part"
    exit 2
  fi
  mv "$MALLOC_SRC.part" "$MALLOC_SRC"
}

log() { printf '[e4-build] %s\n' "$*"; }

MONOLITH="$V8OUT/obj/libv8_monolith.a"
EBOOT="$APP/eboot.bin"
MONOLITH_STAMP="$OUT/.monolith-stamp"
EMBEDDER_STAMP="$OUT/.embedder-stamp"

# The monolith stamp is two facts, not one: the inputs that decide what every object means (both
# patches and the gn args), then the hash of the archive ninja actually produced from them. A
# hand-made, copied or replaced .a fails the second and is rebuilt instead of linked.
monolith_hash() {
  { cat "$HERE/patches/v8-ps4.patch" "$HERE/patches/v8-build-ps4.patch"; printf '%s' "$GN_ARGS"; } |
    sha256sum | cut -d' ' -f1
}
archive_hash() { sha256sum "$1" | cut -d' ' -f1; }
WANT_MONOLITH="$(monolith_hash)"

# True when the tree is provably the one this script built: same inputs, same gn args on disk, and
# the archive on disk is byte-for-byte the one ninja produced for them.
reuse_monolith() {
  [ "$FORCE" != 1 ] && [ -f "$MONOLITH_STAMP" ] && [ -f "$MONOLITH" ] || return 1
  # A hand-edited args.gn makes ninja regenerate with flags no stamp ever described.
  [ "$(cat "$V8OUT/args.gn" 2>/dev/null)" = "$GN_ARGS" ] || return 1
  [ "$(cat "$MONOLITH_STAMP")" = "$WANT_MONOLITH $(archive_hash "$MONOLITH")" ]
}

reuse() { [ "$FORCE" != 1 ] && [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; }
stamp() { printf '%s\n' "$2" >"$1"; }

# ---------------------------------------------------------------- 1. monolith
if reuse_monolith; then
  log "reusing $MONOLITH (monolith stamp unchanged; rm $MONOLITH_STAMP or --force to rebuild)"
else
  # Fail closed: a V8 tree at another commit is a different engine, and a fetch here would cost
  # a 20-minute gclient sync this script deliberately does not own.
  if [ ! -d "$V8/.git" ]; then
    log "no V8 tree at $V8"
    log "create it: git clone --depth 1 --branch $V8_TAG https://chromium.googlesource.com/v8/v8.git $V8"
    log "then gclient sync (depot_tools $DEPOT_TOOLS_COMMIT) and rerun"
    exit 2
  fi
  HAVE_V8="$(git -C "$V8" rev-parse HEAD)"
  if [ "$HAVE_V8" != "$V8_COMMIT" ]; then
    log "V8 tree is $HAVE_V8, the recipe pins $V8_COMMIT ($V8_TAG): refusing to build a different engine"
    exit 2
  fi
  if [ "$(git -C "$V8/build" rev-parse HEAD)" != "$V8_BUILD_COMMIT" ]; then
    log "v8/build is not at $V8_BUILD_COMMIT; the gn toolchain patch expects that checkout"
    exit 2
  fi

  # /third_party/icu is pruned from the sync (i18n off) but //BUILD.gn imports its config.
  mkdir -p "$V8/third_party/icu"
  if [ ! -f "$V8/third_party/icu/config.gni" ]; then
    cat >"$V8/third_party/icu/config.gni" <<'EOF'
# Stub for the PS4/E4 V8 build: //third_party/icu is not synced (i18n off),
# but //BUILD.gn imports this file unconditionally.
declare_args() {
  icu_use_data_file = false
  icu_enable_data_file = true
  icu_use_extras_data_file = false
}
EOF
  fi

  # v8/ itself: the ps4 port sources plus the BUILD.gn / base source edits.
  if git -C "$V8" apply --check "$HERE/patches/v8-ps4.patch" 2>/dev/null; then
    log "applying patches/v8-ps4.patch"
    git -C "$V8" apply "$HERE/patches/v8-ps4.patch"
  fi
  # v8/build is its own checkout: the gn toolchain and the platform selection.
  if git -C "$V8/build" apply --check "$HERE/patches/v8-build-ps4.patch" 2>/dev/null; then
    log "applying patches/v8-build-ps4.patch"
    git -C "$V8/build" apply "$HERE/patches/v8-build-ps4.patch"
  fi

  mkdir -p "$V8OUT"
  printf '%s' "$GN_ARGS" >"$V8OUT/args.gn"
  log "gn gen $V8OUT"
  # --root, not a cd: gn resolves .gn from the cwd, and this script runs from the repo.
  "$V8/buildtools/linux64/gn" gen "$V8OUT" --root="$V8" || exit 1
  # ninja is the only producer of this archive. Anything already sitting there did not come from
  # the tree as it is now, so it goes first: the link can only see ninja's own output.
  rm -f "$MONOLITH"
  log "ninja -j$JOBS v8_monolith (2715 steps the first time; ~25 min)"
  nice -n 19 ninja -C "$V8OUT" -j"$JOBS" v8_monolith
  if [ ! -f "$MONOLITH" ]; then
    log "ninja exited 0 but wrote no $MONOLITH"
    exit 1
  fi
  stamp "$MONOLITH_STAMP" "$WANT_MONOLITH $(archive_hash "$MONOLITH")"
fi
# The embedder stamp carries the archive identity too, so a rebuilt monolith relinks the guest. The
# allocator object is part of the guest, so its source and the dlmalloc pin ride in the same hash.
TRACE_DEFINE=""
if [ "${TN_PS4_E4_TRACE:-0}" != 0 ]; then TRACE_DEFINE="-DTN_PS4_E4_TRACE=1"; fi
WANT_EMBEDDER="$({ cat "$MONOLITH_STAMP"; cat "$HERE/e4-v8-hello.cc" "$HERE/ps4-malloc.c";
  printf '%s %s' "$MALLOC_SHA" "$TRACE_DEFINE"; } | sha256sum | cut -d' ' -f1)"

# ---------------------------------------------------------------- 2. embedder
if reuse "$EMBEDDER_STAMP" "$WANT_EMBEDDER" && [ -f "$EBOOT" ] && [ -f "$APP/e4-v8-hello.elf" ]; then
  log "reusing $EBOOT (embedder stamp unchanged)"
  log "done"
  exit 0
fi

CC_FLAGS=(
  --target=x86_64-pc-freebsd12-elf -fPIC -funwind-tables -std=c++20 -O2
  -DV8_OS_FREEBSD=1 -DV8_OS_BSD=1 -DV8_OS_POSIX=1 -DV8_OS_PS4=1
  '-DV8_OS_STRING="freebsd"' -D_GNU_SOURCE -D_POSIX_C_SOURCE=200809L
  -isysroot "$OO" -isystem "$OO/include" -isystem "$OO/include/c++/v1"
  -include stdlib.h
  -I "$V8/include"
)
if [ -n "$TRACE_DEFINE" ]; then CC_FLAGS+=("$TRACE_DEFINE"); fi

# The allocator, before anything that allocates. Its define set is the whole configuration (see
# ps4-malloc.c); -I $DEPS is what resolves the pinned `#include "dlmalloc.c"`.
MALLOC_FLAGS=(
  --target=x86_64-pc-freebsd12-elf -fPIC -funwind-tables -std=c11 -O2
  -DMMAP_CLEARS=0 -DHAVE_MORECORE=0 -DUSE_LOCKS=1 -DUSE_DL_PREFIX=0 -DMALLOC_ALIGNMENT=16
  '-DDEFAULT_GRANULARITY=(64*1024)'
  -isysroot "$OO" -isystem "$OO/include"
  -include stdlib.h
  -I "$DEPS"
)
mkdir -p "$APP"
ensure_dlmalloc
log "compiling ps4-malloc.c (dlmalloc 2.8.6, sha256 ${MALLOC_SHA:0:12})"
clang "${MALLOC_FLAGS[@]}" -c "$HERE/ps4-malloc.c" -o "$APP/ps4-malloc.o"
log "compiling e4-v8-hello.cc${TRACE_DEFINE:+ (trace build)}"
clang++ "${CC_FLAGS[@]}" -c "$HERE/e4-v8-hello.cc" -o "$APP/e4-v8-hello.o"

# Link order is the override: ps4-malloc.o defines malloc/free/calloc/realloc/posix_memalign/
# memalign/aligned_alloc/malloc_usable_size, so ld.lld never pulls libc.a's malloc.lo for them
# (that archive is only consulted for symbols still undefined) and no --wrap is needed.
log "linking e4-v8-hello.elf"
# Objects before archives, and ps4-malloc.o before the monolith: an archive is scanned for the
# symbols undefined at the point it appears, so the objects that define the allocator have to be
# seen first or libc.a's own malloc.lo/abort.lo are fetched alongside them.
ld.lld -m elf_x86_64 -pie --script "$OO/link.x" --eh-frame-hdr \
  "$APP/ps4-malloc.o" "$APP/e4-v8-hello.o" "$MONOLITH" \
  "$OO/lib/crt1.o" \
  -L"$OO/lib" -lc -lkernel -lc++ \
  -o "$APP/e4-v8-hello.elf"

log "create-fself -> $EBOOT"
# create-fself writes eboot.bin into $PWD; run it in the app dir and keep the elf beside it.
(cd "$APP" && "$OO/bin/linux/create-fself" \
  -in="$APP/e4-v8-hello.elf" -out="$APP/e4-v8-hello.oelf" \
  --eboot "eboot.bin" --paid 0x3800000000000011)
ls -l "$EBOOT"
stamp "$EMBEDDER_STAMP" "$WANT_EMBEDDER"
log "done"
