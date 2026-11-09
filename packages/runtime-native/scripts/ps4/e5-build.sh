#!/usr/bin/env bash
# e5-build.sh — PRD-784 E5 slice 2: the V8 engine player, linked for PS4 into one eboot.bin.
#
#   <out>/out/tn-native-engine-player-v8.elf   the guest as ld.lld writes it (kept for llvm-nm)
#   <out>/out/app/eboot.bin                    the SELF shadPS4 boots, beside sce_sys/param.sfo
#   <out>/build/                               the tn-ps4 CMake/Ninja tree (slice 1's preset)
#
# What is linked: the engine's own archives (slice 1 compiles them), the player's V8 entry
# (tn-native-engine-player-v8.a, an archive on PS4: cmake/NativeEngineAdapters.cmake leaves the
# link to this script, since a CMake link has no way to reach OpenOrbis), SDL3 (scripts/ps4/
# ps4-sdl3.sh), Dawn (scripts/ps4/e3-build.sh) and the V8 monolith (scripts/ps4/e4-build.sh).
#
# Order is the mechanism, as in e4-build.sh: ps4-malloc.o first, so ld.lld never pulls libc.a's
# malloc.lo for a symbol this object defines. crt1.o stays with the archives that need it, as
# OO/samples/Makefile does.
#
# Usage:
#   packages/runtime-native/scripts/ps4/e5-build.sh [--out DIR] [--jobs N] [--force]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"
DEPS="${TN_PS4_DEPS:-$HOME/.cache/tmp-tn/prd784/deps}"
OUT="${TN_PS4_E5_DIR:-$HOME/.cache/tmp-tn/prd784/e5}"
E2="${TN_PS4_E2_DIR:-$HOME/.cache/tmp-tn/prd784/e2}"
FORCE="${TN_PS4_E5_REBUILD:-0}"
JOBS="${JOBS:-8}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h | --help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

export OO_PS4_TOOLCHAIN="${OO_PS4_TOOLCHAIN:-$DEPS/oo/OpenOrbis/PS4Toolchain}"
OO="$OO_PS4_TOOLCHAIN"
BUILD="$OUT/build"
D="$OUT/deps/third_party"
APP="$OUT/out/app"
ELF="$OUT/out/tn-native-engine-player-v8.elf"
OELF="$OUT/out/tn-native-engine-player-v8.oelf"
EBOOT="$APP/eboot.bin"
# SDL3's archive beside its headers in the staged layout (ps4-deps.sh links it there).
SDL_LIB=""
for candidate in "$D"/sdl3/SDL3-*/lib/libSDL3.a; do [ -f "$candidate" ] && SDL_LIB="$candidate" && break; done

log() { printf '[e5-build] %s\n' "$*"; }
die() { printf '[e5-build] %s\n' "$*" >&2; exit 2; }

[ -d "$BUILD" ] || die "no tn-ps4 CMake tree at $BUILD (cmake --preset tn-ps4)"
[ -f "$D/v8/libv8_monolith.a" ] || die "no V8 monolith (scripts/ps4/ps4-deps.sh)"
[ -f "$D/dawn/Dawn-ps4-Release/lib64/libwebgpu_dawn.a" ] || die "no Dawn archive (scripts/ps4/ps4-deps.sh)"
[ -n "$SDL_LIB" ] || die "no SDL3 static library under $D/sdl3 (scripts/ps4/ps4-sdl3.sh via ps4-deps.sh)"
[ -f "$DEPS/dlmalloc.c" ] || die "no dlmalloc source at $DEPS/dlmalloc.c (scripts/ps4/e4-build.sh)"
for a in "$E2/src/vulkan-ps4/libvulkan_ps4.a" "$E2/src/opengnm/libopengnm.a" \
         "$E2/src/opengnm-psbc/libpsbc.orbis.a"; do
  [ -f "$a" ] || die "missing E2 archive: $a (scripts/ps4/e2-build.sh)"
done
# Native physics (Rust Rapier, the same world Android and iOS link): only when the tn-ps4 tree was
# configured with TN_ENABLE_NATIVE_PHYSICS, which compiles the bindings into the player services.
PHYSICS_LIB=""
if grep -q '^TN_ENABLE_NATIVE_PHYSICS:BOOL=ON' "$BUILD/CMakeCache.txt" 2>/dev/null; then
  PHYSICS_LIB="$(sed -n 's/^THREENATIVE_PHYSICS_LIBRARY:[A-Z]*=//p' "$BUILD/CMakeCache.txt")"
  [ -n "$PHYSICS_LIB" ] || PHYSICS_LIB="$HERE/../../.runtime/physics-target/x86_64-unknown-linux-musl/release/libthreenative_native_physics.a"
  [ -f "$PHYSICS_LIB" ] || die "no native physics archive at $PHYSICS_LIB (node scripts/build-native-physics.mjs --ps4)"
fi

# The CSS UI (Rust, blitz + vello_cpu; the HUD backend v8_main.cpp picks on PS4): only when the tn-ps4
# tree compiled the CSS path into tn_engine_player. Both Rust archives carry their own std, which is
# why the link below already allows multiple definitions.
CSS_UI_LIB=""
if grep -q '^TN_ENABLE_CSS_UI:BOOL=ON' "$BUILD/CMakeCache.txt" 2>/dev/null; then
  CSS_UI_LIB="$HERE/../../native/css-ui/target/x86_64-unknown-linux-musl/release/libthreenative_css_ui.a"
  [ -f "$CSS_UI_LIB" ] || die "no CSS UI archive at $CSS_UI_LIB (node scripts/build-native-css-ui.mjs --ps4)"
fi

# libwebp: the tn-ps4 tree builds it from third_party/webp-source when that source is present, and
# cmake/NativeEngineCore.cmake then turns on TN_ENGINE_WEBP in the glTF decoder. The archive has to
# ride the link, or a glTF that carries EXT_texture_webp has no decoder behind it.
WEBP_LIB=""
WEBP_SHARPYUV_LIB=""
if [ -f "$BUILD/libwebp-build/libwebp.a" ]; then
  WEBP_LIB="$BUILD/libwebp-build/libwebp.a"
  [ -f "$BUILD/libwebp-build/libsharpyuv.a" ] && WEBP_SHARPYUV_LIB="$BUILD/libwebp-build/libsharpyuv.a"
fi

# The Rust archives speak musl's libc ABI (struct dirent, struct stat, Linux O_* flags); OpenOrbis'
# libc speaks FreeBSD's. Their copies call ps4-guest-libcxx.cc's tn_musl_* converters instead; the
# C/C++ objects keep libc's own. Without it Rust's read_dir returned names cut by 11 bytes.
musl_abi() {
  mkdir -p "$OUT/out"; local copy="$OUT/out/$(basename "$1" .a).musl-abi.a"
  printf 'readdir tn_musl_readdir\nstat tn_musl_stat\nlstat tn_musl_lstat\nfstat tn_musl_fstat\nopen tn_musl_open\nopenat tn_musl_openat\n' > "$OUT/out/musl-abi.syms"
  llvm-objcopy --redefine-syms="$OUT/out/musl-abi.syms" "$1" "$copy" || die "llvm-objcopy failed on $1"
  printf '%s' "$copy"
}
[ -z "$PHYSICS_LIB" ] || PHYSICS_LIB="$(musl_abi "$PHYSICS_LIB")"
[ -z "$CSS_UI_LIB" ] || CSS_UI_LIB="$(musl_abi "$CSS_UI_LIB")"

# 1. The player: every object and archive the link below reads. Ninja owns the compile flags (the
#    tn-ps4 preset), so this step and slice 1 cannot disagree about them.
if [ "$FORCE" = 1 ]; then rm -f "$BUILD"/*.a; fi
log "ninja tn-native-engine-player-v8 -j$JOBS"
nice -n 19 ninja -C "$BUILD" -k 0 -j"$JOBS" tn-native-engine-player-v8 > "$OUT/e5-player.log" 2>&1 || {
  log "engine build FAILED, see $OUT/e5-player.log"
  grep -m 10 "error:" "$OUT/e5-player.log" || tail -20 "$OUT/e5-player.log"
  exit 1
}

mkdir -p "$OUT/out" "$APP/sce_sys"

# 2. The guest allocator, before anything that allocates (see ps4-malloc.c for why the guest
#    carries dlmalloc at all). Its define set is its whole configuration.
log "compiling ps4-malloc.c (dlmalloc 2.8.6)"
nice -n 19 clang --target=x86_64-pc-freebsd12-elf -fPIC -funwind-tables -std=c11 -O2 \
  -DMMAP_CLEARS=0 -DHAVE_MORECORE=0 -DUSE_LOCKS=1 -DUSE_DL_PREFIX=0 -DMALLOC_ALIGNMENT=16 \
  '-DDEFAULT_GRANULARITY=(64*1024)' \
  -isysroot "$OO" -isystem "$OO/include" -include stdlib.h -I "$DEPS" \
  -c "$HERE/ps4-malloc.c" -o "$OUT/out/ps4-malloc.o"

# 3. libpsbc.orbis.a (the PS4 shader compiler behind vulkan-ps4) references Mesa/BLAKE3 symbols it
#    does not ship. E2 and E3 link the same stubs.
log "compiling mesa_stubs.c (libpsbc's unresolved Mesa/BLAKE3 symbols)"
nice -n 19 clang --target=x86_64-pc-freebsd12-elf -fPIC -funwind-tables -std=c11 \
  -O2 -DORBIS -D__ORBIS__ -D__PS4__ -DVK_USE_PLATFORM_PS4 -DVK_PS4_HAVE_PSBC=1 \
  -isysroot "$OO" -isystem "$OO/include" -I "$E2/src/vulkan-ps4/include" \
  -I "$E2/src/opengnm/include" -I "$E2/src/opengnm-psbc/libpsbc" \
  -I "$E2/src/Vulkan-Headers/include" \
  -c "$E2/src/vulkan-ps4/src/mesa_stubs.c" -o "$OUT/out/mesa_stubs.o"

# 3b. The C++ runtime entry points this libc lacks (ps4-guest-libcxx.cc): the long overload of
#     __libcpp_atomic_wait that <atomic> declares, and __cxa_thread_atexit_impl that libc++abi
#     registers thread_local destructors through. Both are undefined without this object.
log "compiling ps4-guest-libcxx.cc (libc++'s missing atomic-wait overload and thread dtor sink)"
nice -n 19 clang++ --target=x86_64-pc-freebsd12-elf -fPIC -funwind-tables -std=c++20 -O2 \
  -D__ORBIS__=1 -D_GNU_SOURCE -D_BSD_SOURCE -DV8_OS_PS4=1 \
  -isysroot "$OO" -isystem "$OO/include" -isystem "$OO/include/c++/v1" -include stdlib.h \
  -c "$HERE/ps4-guest-libcxx.cc" -o "$OUT/out/ps4-guest-libcxx.o"

# 4. The engine's archive order is the dependency order CMake generated for every other platform
#    (the target's link interface), so it is reused verbatim rather than re-derived here.
ENGINE_ARCHIVES=(
  libtn-native-engine-player-v8.a
  libtn_adapter_v8.a libtn_engine_player.a libtn_engine_assets.a libtn_engine_gltf.a
  libtn_player_v8_services.a libtn_engine_abi.a libtn_engine_bindings.a libtn_engine_player.a
  libtn_engine_inspect.a libtn_engine_world_admission.a libtn_engine_world.a
  libtn_engine_renderer.a libtn_engine_shader.a libtn_host_services.a libtn_engine_animation.a
  libtn_engine_scene.a libtn_engine_vsm.a libtn_engine_graph.a libtn_engine_probes.a
  libtn_engine_assets.a libtn_engine_foundation.a
)
# meshopt is optional in CMake: link it when this tree built it (the starter needs it).
[ -f "$BUILD/libtn_engine_meshopt.a" ] && ENGINE_ARCHIVES+=(libtn_engine_meshopt.a)
for a in "${ENGINE_ARCHIVES[@]}"; do
  [ -f "$BUILD/$a" ] || die "missing engine archive $BUILD/$a"
done

# --start-group: SSDL3, Dawn and the engine reference each other's archives in an order this script
# has no reason to compute (an archive is scanned once, against what is undefined when it appears).
# ld.lld resolves the group to a fixpoint, which is the same set a repeated list would produce.
# --allow-multiple-definition: the Dawn prebuilt and the V8 monolith each carry their own copy of
# the same abseil-lts revision, so absl::container_internal's raw_hash_set out-of-line statics are
# defined twice (EmptyGeneration(), ConvertDeletedToEmptyAndFullToDeleted(ctrl_t*, size_t),
# kSooControl). They are byte-identical definitions of one header's contract, and both prebuilts
# are imported artifacts this lane must not patch: the first definition wins, exactly as the
# desktop players' -Wl,--allow-multiple-definition already does (cmake/NativeEngineAdapters.cmake).
log "linking $ELF"
CORES="${JOBS}" nice -n 19 ld.lld -m elf_x86_64 -pie --script "$OO/link.x" --eh-frame-hdr \
  --allow-multiple-definition \
  --wrap=clock_gettime \
  --wrap=abort \
  -z max-page-size=0x4000 --gc-sections --dynamic-linker /libexec/ld-elf.so.1 \
  -L"$OO/lib" \
  "$OUT/out/ps4-malloc.o" "$OUT/out/ps4-guest-libcxx.o" "$OUT/out/mesa_stubs.o" "$OO/lib/crt1.o" \
  --start-group \
    $(printf '%s\n' "${ENGINE_ARCHIVES[@]/#/$BUILD/}") \
    "$SDL_LIB" \
    "$D/dawn/Dawn-ps4-Release/lib64/libwebgpu_dawn.a" \
    "$D/v8/libv8_monolith.a" \
    "$E2/src/vulkan-ps4/libvulkan_ps4.a" "$E2/src/opengnm/libopengnm.a" \
    "$E2/src/opengnm-psbc/libpsbc.orbis.a" \
    ${PHYSICS_LIB:+"$PHYSICS_LIB"} \
    ${CSS_UI_LIB:+"$CSS_UI_LIB"} \
    ${WEBP_LIB:+"$WEBP_LIB"} \
    ${WEBP_SHARPYUV_LIB:+"$WEBP_SHARPYUV_LIB"} \
  --end-group \
  -lkernel -lc -lc++ -lc++abi -lunwind -lSceGnmDriver -lSceVideoOut -lScePad -lSceUserService \
  "$OO/lib/crtn.o" \
  -o "$ELF"

# 5. create-fself writes eboot.bin into its cwd and needs OO_PS4_TOOLCHAIN.
log "create-fself -> $EBOOT"
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
(cd "$APP" && nice -n 19 "$OO/bin/linux/create-fself" -in="$ELF" -out="$OELF" \
  --eboot eboot.bin --paid 0x3800000000000011 > "$OUT/create-fself.log" 2>&1) \
  || die "create-fself failed: $(tail -3 "$OUT/create-fself.log")"

# 6. Title metadata, written by PkgTool.Core: generated here, never copied out of a dump.
PKGTOOL="$OO/bin/linux/PkgTool.Core"
"$PKGTOOL" sfo_new "$APP/sce_sys/param.sfo" > /dev/null
while read -r key type maxsize value; do
  "$PKGTOOL" sfo_setentry "$APP/sce_sys/param.sfo" "$key" --type "$type" \
    --maxsize "$maxsize" --value "$value" > /dev/null
done <<'SFO'  # a console TITLE_ID is 4 letters + 5 digits and CONTENT_ID is 36 characters (PkgTool pkg_build checks)
APP_TYPE Integer 4 1
APP_VER Utf8 8 1.00
ATTRIBUTE Integer 4 0
CATEGORY Utf8 4 gd
CONTENT_ID Utf8 48 IV0000-TNPS78405_00-TNPRD784E5000000
DOWNLOAD_DATA_SIZE Integer 4 0
SYSTEM_VER Integer 4 0
TITLE Utf8 128 ThreeNative PS4 E5
TITLE_ID Utf8 12 TNPS78405
VERSION Utf8 8 1.00
SFO

UNDEFINED="$(llvm-nm -u "$ELF" | wc -l)"
log "linked $ELF ($(stat -c%s "$ELF") bytes), $UNDEFINED undefined imports"
log "built $EBOOT ($(stat -c%s "$EBOOT") bytes)"
log "done"
