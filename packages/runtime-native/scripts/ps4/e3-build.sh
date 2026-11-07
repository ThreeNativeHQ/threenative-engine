#!/usr/bin/env bash
# e3-build.sh — PRD-784 / E3: Dawn (WebGPU) as a static library for PS4/OpenOrbis, plus the
# guest that exercises it.
#
#   <out>/out/libwebgpu_dawn.a   Dawn's Vulkan backend, monolithic static library
#   <out>/out/app/eboot.bin      e3-triangle.cc: adapter + device through webgpu.h, a WGSL
#                                triangle compiled at run time, 600 frames presented through
#                                vulkan-ps4's VideoOut swapchain (+ sce_sys/param.sfo)
#   <out>/dawn/                  the pinned Dawn checkout the library is built from
#   <out>/deps/                  Dawn's DEPS pins, only the Vulkan-only set
#   <out>/build/                 the CMake/Ninja tree; incremental, and untouched while the
#                                stamp holds
#   <out>/shim/                  the copy of scripts/ps4/shim the build was configured with
#
# Usage:
#   packages/runtime-native/scripts/ps4/e3-build.sh [--out DIR] [--force]
#     DIR defaults to $TN_PS4_E3_DIR, else ~/.cache/tmp-tn/prd784/e3.
#   A finished build is reused while the patches, the shim, the toolchain file and the cmake
#   arguments are unchanged: the Dawn stamp skips configure+ninja, the guest stamp only the
#   compile+link. Pass --force (or TN_PS4_E3_REBUILD=1) to rebuild everything regardless.
#   The Dawn tree is NOT cloned here (the pins below plus a DEPS sync are its own recipe); when it
#   is missing the script prints that recipe and fails, so a silent re-download never happens.
#   OO_PS4_TOOLCHAIN defaults to $TN_PS4_DEPS/oo/OpenOrbis/PS4Toolchain
#   ($TN_PS4_DEPS = ~/.cache/tmp-tn/prd784/deps) and must hold OpenOrbis v0.5.4.
#   TN_PS4_E2_DIR (default ~/.cache/tmp-tn/prd784/e2) supplies the vulkan-ps4/OpenGNM archives
#   the guest links against: e2-build.sh owns those sources and their fourteen PS4 patches, this
#   lane only links libvulkan_ps4.a, so an E2 run and an E3 run see the same driver.
#
# Writes only under --out. Host needs clang/ld.lld/llvm-{ar,ranlib} (tested clang 23.1.4), cmake,
# ninja, git, python3 with jinja2.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPS="${TN_PS4_DEPS:-$HOME/.cache/tmp-tn/prd784/deps}"
OUT="${TN_PS4_E3_DIR:-$HOME/.cache/tmp-tn/prd784/e3}"
FORCE="${TN_PS4_E3_REBUILD:-0}"
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
E2="${TN_PS4_E2_DIR:-$HOME/.cache/tmp-tn/prd784/e2}"

log() { printf '[e3-build] %s\n' "$*"; }

# === Pins (override any of these from the environment) ========================
# packages/runtime-native/scripts/build-dawn-linux.mjs:8 names this Dawn commit, and
# scripts/download-deps.mjs:66,157-158 the two it reuses from the host build. The rest are the
# DEPS pins of that same Dawn revision, cloned shallow by step 1.
DAWN_COMMIT="${DAWN_COMMIT:-d14ae3d97ad74100e9f382efef5e9c0872ddbeb2}"                  # dawn v20260117.152313
ABSEIL_COMMIT="${ABSEIL_COMMIT:-1597226b825a16493de66c1732171efe89b271d9}"
VKHEADERS_COMMIT="${VKHEADERS_COMMIT:-0007545ec811852c8ea6154f201624583c88563f}"
SPIRV_HEADERS_COMMIT="${SPIRV_HEADERS_COMMIT:-babee77020ff82b571d723ce2c0262e2ec0ee3f1}"
SPIRV_TOOLS_COMMIT="${SPIRV_TOOLS_COMMIT:-660eff0326c9ca446a4bc891e7a34c1c49a56fd5}"
VULKAN_UTILITY_COMMIT="${VULKAN_UTILITY_COMMIT:-b4e9ebbfc779cba85f1efbe2f69fdfc5744ed5e5}"
WEBGPU_HEADERS_COMMIT="${WEBGPU_HEADERS_COMMIT:-0bfcdc4f487023d85e33597de0a94fc523e30fca}"

# The guest is e3-triangle.cc in one of five builds: the plain triangle (the E3 pass), its compute
# variant (TN_PS4_E3_GUEST=e3cs, the E5 device-lost repro), and the texture repro family -- e3tex
# (the scene target sampled back, float16), e3tex8 (the same target as R8G8B8A8_UNORM) and
# e3texmsaa (a 4x multisampled target plus its resolve), which is the render-target -> sampled-image
# hand-off E5's black frame runs through. Each build owns its own app folder, so one never
# overwrites another's eboot.bin and the stamps cannot mask each other.
GUEST_STEM="${TN_PS4_E3_GUEST:-e3-triangle}"
case "$GUEST_STEM" in
  e3-triangle) GUEST_DEFS="" ;;
  e3cs) GUEST_DEFS="-DTN_E3_GUEST_CS=1" ;;
  e3tex) GUEST_DEFS="-DTN_E3_GUEST_TEX=1" ;;
  e3tex8) GUEST_DEFS="-DTN_E3_GUEST_TEX=1 -DTN_E3_TEX_RGBA8=1" ;;
  e3texmsaa) GUEST_DEFS="-DTN_E3_GUEST_TEX=1 -DTN_E3_TEX_MSAA=1 -DTN_E3_TEX_RGBA8=1" ;;
  # e3texmsaa renders into R8G8B8A8_UNORM, not RGBA16Float: Dawn grants Cap::Multisample to
  # RGBA16Float only under Feature::CoreFeaturesAndLimits (dawn/native/Format.cpp, the
  # AddCaps({... RGBA16Float ...}, Cap::Multisample) group), which this guest's device does not
  # request, so a 4x float16 target is refused at creation with "The texture format
  # (TextureFormat::RGBA16Float) does not support multisampling" before any resolve is reached.
  # The resolve mechanism is format-independent; the engine's own float16 MSAA target is E5's
  # evidence, not this guest's.
  *) echo "unknown TN_PS4_E3_GUEST: $GUEST_STEM (e3-triangle|e3cs|e3tex|e3tex8|e3texmsaa)" >&2; exit 2 ;;
esac

DAWN="$OUT/dawn"
BUILD="$OUT/build"
OUTD="$OUT/out"
SHIM="$OUT/shim"
APP="$OUTD/$GUEST_STEM/app"
GUEST="$BUILD/guest"
LIB="$OUTD/libwebgpu_dawn.a"
EBOOT="$APP/eboot.bin"
ELF="$GUEST/$GUEST_STEM.elf"

mkdir -p "$OUT"

# === cmake arguments (one block, hashed into the Dawn stamp) =================
# Vulkan backend only, one monolithic static library, no window system, no samples/tests:
# src/dawn/replay is not part of the bundled library and needs <ranges>, which OpenOrbis
# libc++ 11 does not have.
read -r -d '' E3_CMAKE_ARGS <<EOF || true
DAWN_ENABLE_VULKAN=ON
DAWN_ENABLE_NULL=OFF
DAWN_ENABLE_D3D11=OFF
DAWN_ENABLE_D3D12=OFF
DAWN_ENABLE_METAL=OFF
DAWN_ENABLE_WEBGPU_ON_WEBGPU=OFF
DAWN_ENABLE_DESKTOP_GL=OFF
DAWN_ENABLE_OPENGLES=OFF
DAWN_ENABLE_SWIFTSHADER=OFF
DAWN_ENABLE_SPIRV_VALIDATION=OFF
DAWN_USE_GLFW=OFF
DAWN_USE_X11=OFF
DAWN_USE_WAYLAND=OFF
DAWN_USE_WINDOWS_UI=OFF
DAWN_BUILD_SAMPLES=OFF
DAWN_BUILD_TESTS=OFF
DAWN_BUILD_BENCHMARKS=OFF
DAWN_BUILD_PROTOBUF=OFF
DAWN_BUILD_NODE_BINDINGS=OFF
TINT_BUILD_TESTS=OFF
TINT_BUILD_CMD_TOOLS=OFF
TINT_BUILD_SPV_READER=OFF
TINT_BUILD_SPV_WRITER=ON
TINT_BUILD_WGSL_READER=ON
TINT_BUILD_GLSL_WRITER=OFF
TINT_BUILD_MSL_WRITER=OFF
TINT_BUILD_HLSL_WRITER=OFF
TINT_BUILD_NULL_WRITER=OFF
TINT_BUILD_IR_BINARY=OFF
TINT_ENABLE_IR_VALIDATION=OFF
DAWN_ENABLE_INSTALL=OFF
DAWN_WERROR=OFF
DAWN_ENABLE_PIC=ON
DAWN_FETCH_DEPENDENCIES=OFF
CMAKE_BUILD_TYPE=Release
BUILD_SHARED_LIBS=OFF
DAWN_BUILD_MONOLITHIC_LIBRARY=STATIC
EOF

# === Stamps ===================================================================
# Both stamps are the facts that decide what the binaries mean, not their mtimes: every input the
# script itself owns (patches, shim, toolchain file, cmake arguments, pins, the OpenOrbis root)
# plus -- for Dawn -- the hash of the archive ninja actually produced from them. A hand-made,
# copied or replaced .a fails the second and is rebuilt instead of linked.
PATCHES="$HERE/patches"
DAWN_STAMP="$OUT/.dawn-stamp"
GUEST_STAMP="$OUT/.guest-stamp-$GUEST_STEM"

dawn_inputs() {
  cat "$PATCHES"/dawn-*.patch "$PATCHES"/oo-*.patch "$PATCHES"/abseil-*.patch \
    "$HERE/e3-ps4.toolchain.cmake" "$HERE"/shim/*
  printf '%s\n' "$E3_CMAKE_ARGS" "$DAWN_COMMIT $ABSEIL_COMMIT $VKHEADERS_COMMIT \
$SPIRV_HEADERS_COMMIT $SPIRV_TOOLS_COMMIT $VULKAN_UTILITY_COMMIT $WEBGPU_HEADERS_COMMIT" \
    "$OO"
}
WANT_DAWN="$(dawn_inputs | sha256sum | cut -d' ' -f1)"

archive_hash() { sha256sum "$1" | cut -d' ' -f1; }
reuse() { [ "$FORCE" != 1 ] && [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; }
stamp() { printf '%s\n' "$2" >"$1"; }

################################################################################
# 1. Dawn + its DEPS pins
################################################################################
fetch() { # dir url sha
  local d="$1" u="$2" s="$3"
  if [ -f "$d/.git/HEAD" ] && [ "$(git -C "$d" rev-parse -q --verify HEAD || true)" = "$s" ]; then
    return 0
  fi
  mkdir -p "$d"
  git -C "$d" init -q
  git -C "$d" fetch -q --depth 1 "$u" "$s"
  git -C "$d" checkout -q FETCH_HEAD
  log "fetched $d @ $s"
}

# The tree is READ, never created: its clone plus DEPS sync is a 20-minute step of its own, and a
# fetch here would silently build a different engine than the pins name.
ensure_dawn_tree() {
  if [ ! -d "$DAWN/.git" ]; then
    log "no Dawn tree at $DAWN"
    log "create it: git clone --filter=blob:none https://dawn.googlesource.com/dawn $DAWN"
    log "then: git -C $DAWN checkout $DAWN_COMMIT && (cd $DAWN && gclient sync --revision dawn@$DAWN_COMMIT)"
    log "step 1 below fetches the Vulkan-only third_party subset itself, so gclient may be skipped"
    exit 2
  fi
  local have
  have="$(git -C "$DAWN" rev-parse HEAD)"
  if [ "$have" != "$DAWN_COMMIT" ]; then
    log "Dawn tree is $have, the recipe pins $DAWN_COMMIT: refusing to build a different engine"
    exit 2
  fi
}

ensure_deps() {
  local G=https://chromium.googlesource.com/external/github.com
  fetch "$OUT/deps/abseil-cpp"             "$G/../chromium/src/third_party/abseil-cpp" "$ABSEIL_COMMIT"
  fetch "$OUT/deps/vkheaders"              "$G/KhronosGroup/Vulkan-Headers"             "$VKHEADERS_COMMIT"
  fetch "$OUT/deps/spirv-headers"          "$G/KhronosGroup/SPIRV-Headers"              "$SPIRV_HEADERS_COMMIT"
  fetch "$OUT/deps/spirv-tools"            "$G/KhronosGroup/SPIRV-Tools"                "$SPIRV_TOOLS_COMMIT"
  fetch "$OUT/deps/vulkan-utility-libraries" "$G/KhronosGroup/Vulkan-Utility-Libraries"  "$VULKAN_UTILITY_COMMIT"
  fetch "$OUT/deps/webgpu-headers"         "$G/webgpu-native/webgpu-headers"            "$WEBGPU_HEADERS_COMMIT"
}

# The shim is staged, not configured in place: the compile line therefore holds this one path,
# and a stamp from a pre-repo build of the same shim still matches (no accidental 941-TU rebuild).
# A file is copied only when its bytes differ, and then with its own mtime: ps4-compat.h is
# force-included and <concepts>/<bit> are on -isystem, so rewriting them (cp -f) would dirty every
# one of Dawn's object files on every run.
stage_shim() {
  local f
  mkdir -p "$SHIM"
  for f in "$HERE"/shim/*; do
    # shim/ carries one subdirectory (sys/), for headers Dawn and the V8 player include.
    [ -d "$f" ] && { cp -rp "$f" "$SHIM"/; continue; }
    cmp -s "$f" "$SHIM/$(basename "$f")" || cp -p "$f" "$SHIM/"
  done
}

# Patches are applied idempotently: `--check` first, then reversed `--check` for "already there".
apply_patch() { # repo patch
  if git -C "$1" apply --check "$2" 2>/dev/null; then
    git -C "$1" apply "$2"
    log "applied $(basename "$2")"
  elif git -C "$1" apply -R --check "$2" 2>/dev/null; then
    :
  else
    log "patch does not apply: $2"
    exit 1
  fi
}

ensure_patches() {
  local p
  # dawn-*: the platform macro, the static Vulkan loader, the PS4 surface, SystemUtils, renderdoc.
  # oo-*: OpenOrbis libc++ 11 gaps in Dawn's own sources (patched in Dawn, named for the cause).
  for p in "$PATCHES"/dawn-*.patch "$PATCHES"/oo-*.patch; do apply_patch "$DAWN" "$p"; done
  # abseil-*: its config.h derives ABSL_HAVE_MMAP from __FreeBSD__, which the OO libc++
  # __config #undefs; without it absl::Mutex's platform files build empty and Dawn does not link.
  for p in "$PATCHES"/abseil-*.patch; do apply_patch "$OUT/deps/abseil-cpp" "$p"; done
}

# Same inputs AND the archive on disk is byte-for-byte the one ninja produced for them: the stamp
# is "<inputs hash> <archive hash>", so both facts are checked, not just the file's existence.
reuse_dawn() {
  [ "$FORCE" != 1 ] && [ -f "$DAWN_STAMP" ] && [ -f "$LIB" ] || return 1
  [ "$(cat "$DAWN_STAMP")" = "$WANT_DAWN $(archive_hash "$LIB")" ]
}

if reuse_dawn; then
  log "reusing $LIB (Dawn stamp unchanged; rm $DAWN_STAMP or --force to rebuild)"
else
  ensure_dawn_tree
  ensure_deps
  stage_shim
  ensure_patches

  log "configure Dawn (Vulkan only, monolithic static)"
  nice -n 19 cmake -S "$DAWN" -B "$BUILD" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$HERE/e3-ps4.toolchain.cmake" \
    -DPS4_OO="$OO" -DPS4_SHIM="$SHIM" \
    -DDAWN_ABSEIL_DIR="$OUT/deps/abseil-cpp" \
    -DDAWN_SPIRV_HEADERS_DIR="$OUT/deps/spirv-headers" \
    -DDAWN_SPIRV_TOOLS_DIR="$OUT/deps/spirv-tools" \
    -DDAWN_VULKAN_HEADERS_DIR="$OUT/deps/vkheaders" \
    -DDAWN_VULKAN_UTILITY_LIBRARIES_DIR="$OUT/deps/vulkan-utility-libraries" \
    -DDAWN_WEBGPU_HEADERS_DIR="$OUT/deps/webgpu-headers" \
    -DDAWN_JINJA2_DIR= -DDAWN_MARKUPSAFE_DIR= \
    $(printf -- '-D%s\n' $E3_CMAKE_ARGS) \
    > "$OUT/configure.log" 2>&1 || { log "configure FAILED, see $OUT/configure.log"; tail -20 "$OUT/configure.log"; exit 1; }

  # ninja is the only producer of this archive: anything already sitting there did not come from
  # the tree as it is now, so it goes first and the link can only see ninja's own output.
  rm -f "$LIB"
  find "$BUILD" -name 'libwebgpu_dawn.a' -delete
  log "ninja -j$JOBS webgpu_dawn"
  nice -n 19 timeout 2400 ninja -C "$BUILD" -k 0 -j"$JOBS" webgpu_dawn > "$OUT/build.log" 2>&1 || {
    log "build FAILED, see $OUT/build.log"
    tail -30 "$OUT/build.log"
    exit 1
  }
  PRODUCED="$(find "$BUILD" -name 'libwebgpu_dawn.a' -print -quit)"
  [ -n "$PRODUCED" ] || { log "ninja exited 0 but wrote no libwebgpu_dawn.a"; exit 1; }
  mkdir -p "$OUTD"
  cp "$PRODUCED" "$LIB"
  log "built $LIB ($(stat -c%s "$LIB") bytes)"
  stamp "$DAWN_STAMP" "$WANT_DAWN $(archive_hash "$LIB")"
fi

################################################################################
# 2. the ICD is E2's: patches 0001-0014 are applied by e2-build.sh, which hashes them into its
#    own stamp, so this lane only links $E2/src/vulkan-ps4/libvulkan_ps4.a (step 3) and rebuilds
#    nothing here. Two of those patches exist for Dawn: 0013 passes VkPipelineShaderStageCreateInfo
#    ::pName through to libpsbc (Dawn renames every entry point "dawn_entry_point"), and 0014
#    implements the VK_KHR_surface queries, without which wgpuSurfaceConfigure jumps to a null proc.
################################################################################
# 3. guest: e3-triangle.cc + the E2 runner archives -> eboot.bin
#    Recipe from E1's buildGuest (clang object, ld.lld with the OO link.x script, crt1.o/crtn.o)
#    and E2's Makefile.orbis (libvulkan_ps4/libopengnm whole-archive, libpsbc selective, then the
#    PS4 system stubs). vulkan-ps4 is the driver Dawn's Vulkan backend talks to: E2's build
#    output, patches 0001-0014 included.
################################################################################
for a in "$E2/src/vulkan-ps4/libvulkan_ps4.a" "$E2/src/opengnm/libopengnm.a" \
         "$E2/src/opengnm-psbc/libpsbc.orbis.a"; do
  [ -f "$a" ] || { log "missing E2 archive: $a (run e2-build.sh)"; exit 2; }
done
[ -f "$SHIM/ps4-compat.h" ] || stage_shim

# The guest is part of the same claim as the library: a rebuilt Dawn relinks it, an edited guest
# recompiles it.
WANT_GUEST="$({
  cat "$DAWN_STAMP"
  cat "$HERE/e3-triangle.cc"
  printf '%s\n' "$GUEST_STEM $GUEST_DEFS $OO $E2" "$(sha256sum "$E2/src/vulkan-ps4/libvulkan_ps4.a" | cut -d' ' -f1)"
} | sha256sum | cut -d' ' -f1)"

if reuse "$GUEST_STAMP" "$WANT_GUEST" && [ -f "$EBOOT" ] && [ -f "$ELF" ]; then
  log "reusing $EBOOT (guest stamp unchanged)"
  log "done"
  exit 0
fi

mkdir -p "$GUEST" "$APP/sce_sys"
INC="-isysroot $OO -isystem $OO/include -isystem $OO/include/c++/v1 -isystem $SHIM"

log "compiling e3-triangle.cc as $GUEST_STEM"
nice -n 19 clang++ --target=x86_64-pc-freebsd12-elf -fPIC -funwind-tables \
  -std=c++20 -fno-exceptions -fno-rtti -O2 -D__ORBIS__=1 -D_GNU_SOURCE -D_BSD_SOURCE $GUEST_DEFS \
  $INC -I "$BUILD/gen/include" -I "$DAWN/include" \
  -c "$HERE/e3-triangle.cc" -o "$GUEST/$GUEST_STEM.o"

# libpsbc.orbis.a references Mesa/BLAKE3 symbols it does not ship; E2 links the same stubs.
log "compiling mesa_stubs.c (libpsbc's unresolved Mesa/BLAKE3 symbols)"
nice -n 19 clang --target=x86_64-pc-freebsd12-elf -fPIC -funwind-tables -std=c11 \
  -O2 -DORBIS -D__ORBIS__ -D__PS4__ -DVK_USE_PLATFORM_PS4 -DVK_PS4_HAVE_PSBC=1 \
  -isysroot "$OO" -isystem "$OO/include" -I "$E2/src/vulkan-ps4/include" \
  -I "$E2/src/opengnm/include" -I "$E2/src/opengnm-psbc/libpsbc" \
  -I "$E2/src/Vulkan-Headers/include" \
  -c "$E2/src/vulkan-ps4/src/mesa_stubs.c" -o "$GUEST/mesa_stubs.o"

log "linking $GUEST_STEM.elf"
nice -n 19 ld.lld "$GUEST/$GUEST_STEM.o" "$GUEST/mesa_stubs.o" -o "$ELF" \
  -m elf_x86_64 --script "$OO/link.x" --eh-frame-hdr -L"$OO/lib" -pie \
  -z max-page-size=0x4000 --gc-sections --dynamic-linker /libexec/ld-elf.so.1 \
  "$OO/lib/crt1.o" "$LIB" \
  "$E2/src/vulkan-ps4/libvulkan_ps4.a" "$E2/src/opengnm/libopengnm.a" \
  "$E2/src/opengnm-psbc/libpsbc.orbis.a" \
  -lkernel -lc -lc++ -lc++abi -lunwind -lSceGnmDriver -lSceVideoOut "$OO/lib/crtn.o"

# create-fself writes eboot.bin into its cwd and needs OO_PS4_TOOLCHAIN.
log "create-fself -> $EBOOT"
rm -rf "$APP"
mkdir -p "$APP/sce_sys"
export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1
(cd "$APP" && nice -n 19 "$OO/bin/linux/create-fself" -in="$ELF" \
  -out="$GUEST/$GUEST_STEM.oelf" --eboot eboot.bin --paid 0x3800000000000011 > /dev/null)

# Title metadata, written by PkgTool.Core: generated here, never copied out of a dump.
PKGTOOL="$OO/bin/linux/PkgTool.Core"
"$PKGTOOL" sfo_new "$APP/sce_sys/param.sfo" > /dev/null
while read -r key type maxsize value; do
  "$PKGTOOL" sfo_setentry "$APP/sce_sys/param.sfo" "$key" --type "$type" \
    --maxsize "$maxsize" --value "$value" > /dev/null
done <<'SFO'
APP_TYPE Integer 4 1
APP_VER Utf8 8 1.00
ATTRIBUTE Integer 4 0
CATEGORY Utf8 4 gd
CONTENT_ID Utf8 48 IV0000-TNPRD784E3_00-TNPS4E3000000000
DOWNLOAD_DATA_SIZE Integer 4 0
SYSTEM_VER Integer 4 0
TITLE Utf8 128 ThreeNative PS4 E3
TITLE_ID Utf8 12 TNPRD784E3
VERSION Utf8 8 1.00
SFO

stamp "$GUEST_STAMP" "$WANT_GUEST"
log "built $EBOOT ($(stat -c%s "$EBOOT") bytes)"
log "done"
