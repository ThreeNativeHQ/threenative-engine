#!/usr/bin/env bash
# ps4-sdl3.sh — PRD-784 E5: SDL3 as a static library for PS4 (OpenOrbis).
#
#   <out>/libSDL3.a          every driver SDL3 needs for a console and none it cannot have
#   <out>/                   the CMake/Ninja tree; incremental, untouched while the stamp holds
#
# Why SDL3 at all: the engine player's loop, input translation and audio decode are written against
# SDL3 (62 SDL_ calls in run.cpp, 159 in platform/input.cpp, 25 in audio_context.cpp), and rewriting
# them would fork the player for one platform. Its video/audio drivers are the dummy pair, which is
# still what a console wants for frames: the PS4's image reaches the screen through Dawn's VideoOut
# swapchain (Context::PLATFORM_PS4), not through SDL, so SDL only has to own events, timing and the
# window handle the loop sizes its drawing buffer from.
#
# Usage:
#   packages/runtime-native/scripts/ps4/ps4-sdl3.sh [--out DIR] [--src DIR] [--force]
#     --out defaults to $TN_PS4_E5_DIR/sdl3-build (~/.cache/tmp-tn/prd784/e5).
#     --src defaults to the host checkout's third_party/sdl3/SDL3-* (scripts/download-deps.mjs);
#     the tree is READ, never cloned or patched.
#   OO_PS4_TOOLCHAIN defaults to $TN_PS4_DEPS/oo/OpenOrbis/PS4Toolchain.
#
# The three platform rejections, each answered with a cache variable rather than a patch (the SDL3
# sources stay byte-identical to the pinned 3.2.30 release):
#   -SDL_UNIX_CONSOLE_BUILD=ON  without X11 or Wayland SDL's summary aborts the configure.
#   -DHAVE_LINUX_INPUT_H=OFF    the FreeBSD section would compile src/core/linux/SDL_evdev.c against
#                               the HOST's /usr/include/linux/input.h, which is not the guest's ABI.
#   -D__SIZEOF_WCHAR_T__=2      OpenOrbis' <bits/alltypes.h> typedefs wchar_t as unsigned short (2
#                               bytes), while clang's builtin __SIZEOF_WCHAR_T__ says 4 -- SDL_string.c
#                               asserts the two agree, and 2 is what the sysroot actually hands it.
#   -DSDL_HIDAPI=OFF            hidapi/libusb is compiled on this platform otherwise, and a console
#                               has no libusb: the whole HID seam would be dead code for a build fail.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPS="${TN_PS4_DEPS:-$HOME/.cache/tmp-tn/prd784/deps}"
OUT="${TN_PS4_E5_DIR:-$HOME/.cache/tmp-tn/prd784/e5}/sdl3-build"
MAIN_REPO="${TN_PS4_MAIN_REPO:-$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | xargs -r dirname || true)}"
SRC=""
FORCE="${TN_PS4_SDL3_REBUILD:-0}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --src) SRC="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h | --help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

export OO_PS4_TOOLCHAIN="${OO_PS4_TOOLCHAIN:-$DEPS/oo/OpenOrbis/PS4Toolchain}"
OO="$OO_PS4_TOOLCHAIN"
JOBS="${JOBS:-8}"

log() { printf '[ps4-sdl3] %s\n' "$*"; }
die() { printf '[ps4-sdl3] %s\n' "$*" >&2; exit 2; }

[ -d "$OO/include" ] || die "no OpenOrbis sysroot at $OO"
if [ -z "$SRC" ]; then
  for d in "$MAIN_REPO"/packages/runtime-native/third_party/sdl3/SDL3-*; do
    [ -d "$d/include" ] && SRC="$d" && break
  done
fi
[ -n "$SRC" ] && [ -f "$SRC/CMakeLists.txt" ] ||
  die "no SDL3 source tree (node packages/runtime-native/scripts/download-deps.mjs, or --src DIR)"

SHIM="$HERE/shim"
LIB="$OUT/libSDL3.a"

# One block, hashed into the stamp: every knob that changes a byte of the library's meaning.
read -r -d '' SDL_CMAKE_ARGS <<EOF || true
CMAKE_SYSTEM_NAME=FreeBSD
CMAKE_SYSTEM_PROCESSOR=x86_64
CMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY
CMAKE_C_COMPILER=/usr/bin/clang
CMAKE_C_COMPILER_TARGET=x86_64-pc-freebsd12-elf
CMAKE_AR=/usr/bin/llvm-ar
CMAKE_RANLIB=/usr/bin/llvm-ranlib
CMAKE_BUILD_TYPE=Release
SDL_SHARED=OFF
SDL_STATIC=ON
SDL_TEST_LIBRARY=OFF
SDL_TESTS=OFF
SDL_EXAMPLES=OFF
SDL_INSTALL=OFF
SDL_UNIX_CONSOLE_BUILD=ON
SDL_X11=OFF
SDL_WAYLAND=OFF
SDL_KMSDRM=OFF
SDL_RPI=OFF
SDL_ROCKCHIP=OFF
SDL_VIVANTE=OFF
SDL_VULKAN=OFF
SDL_OPENGL=OFF
SDL_OPENGLES=OFF
SDL_ALSA=OFF
SDL_PULSEAUDIO=OFF
SDL_PIPEWIRE=OFF
SDL_JACK=OFF
SDL_SNDIO=OFF
SDL_OSS=OFF
SDL_DBUS=OFF
SDL_IBUS=OFF
SDL_LIBURING=OFF
SDL_HIDAPI=OFF
SDL_JOYSTICK=OFF
SDL_HAPTIC=OFF
SDL_SENSOR=OFF
SDL_CAMERA=OFF
SDL_DIALOG=OFF
SDL_DUMMYVIDEO=ON
SDL_DUMMYAUDIO=ON
HAVE_LINUX_INPUT_H=OFF
EOF

# The C flags are part of the same fact: the sysroot, and the one shim every guest TU compiles with
# (ps4-compat.h carries the pointer-size pthread attributes the engine's mutexes and SDL's need).
C_FLAGS="-isysroot $OO -isystem $OO/include -isystem $SHIM -D__ORBIS__=1 -D_GNU_SOURCE -D_BSD_SOURCE -D__SIZEOF_WCHAR_T__=2 -O2 -fPIC -funwind-tables -include ps4-compat.h -include stdlib.h"

WANT="$({ cat "$HERE/ps4-sdl3.sh" "$SHIM/ps4-compat.h" "$SHIM/sys/endian.h" "$SHIM/sys/sysctl.h"; printf '%s\n' "$SDL_CMAKE_ARGS" "$C_FLAGS" "$(cat "$SRC/REVISION.txt" 2>/dev/null)" "$OO"; } |
  sha256sum | cut -d' ' -f1)"
STAMP="$OUT/.sdl3-stamp"
if [ "$FORCE" != 1 ] && [ -f "$LIB" ] && [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$WANT" ]; then
  log "reusing $LIB (stamp unchanged; --force to rebuild)"
  log "done"
  exit 0
fi

mkdir -p "$OUT"
log "configure SDL3 ($(basename "$SRC")): static, dummy video/audio, no window systems"
nice -n 19 cmake -S "$SRC" -B "$OUT" -G Ninja \
  "-DCMAKE_C_FLAGS=$C_FLAGS" \
  $(printf -- '-D%s\n' $SDL_CMAKE_ARGS) > "$OUT/configure.log" 2>&1 || {
  log "configure FAILED, see $OUT/configure.log"
  tail -20 "$OUT/configure.log"
  exit 1
}

rm -f "$LIB"
log "ninja -j$JOBS SDL3-static"
nice -n 19 ninja -C "$OUT" -k 0 -j"$JOBS" SDL3-static > "$OUT/build.log" 2>&1 || {
  log "build FAILED, see $OUT/build.log"
  grep -m 5 "error:" "$OUT/build.log" || tail -20 "$OUT/build.log"
  exit 1
}
[ -f "$LIB" ] || die "ninja exited 0 but wrote no $LIB"
printf '%s\n' "$WANT" >"$STAMP"
log "built $LIB ($(stat -c%s "$LIB") bytes, $(llvm-nm --defined-only "$LIB" 2>/dev/null | grep -c ' T SDL_') SDL_ entry points)"
log "done"
