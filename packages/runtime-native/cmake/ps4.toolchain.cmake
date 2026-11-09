# PS4 (OpenOrbis) cross toolchain for the native engine, its V8 adapter and the V8 player.
# clang on the host drives --target=x86_64-pc-freebsd12-elf against the OpenOrbis sysroot (the same
# triple and flag set OO/samples, scripts/ps4/e3-build.sh and scripts/ps4/e4-build.sh use).
#
# Configure through the `tn-ps4` preset (CMakePresets.json). It is the only consumer of this file,
# so every desktop/Android/iOS configure is byte-identical with and without it.
#
# Cache variables, both optional:
#   PS4_OO     OpenOrbis PS4Toolchain root; defaults to $OO_PS4_TOOLCHAIN
#   PS4_SHIM   the libc++ shim headers this repo owns; defaults to scripts/ps4/shim
#
# No linker: OpenOrbis links through ld.lld with OO's link.x script (scripts/ps4/e3-build.sh), so a
# CMake configure only has to survive compiler checks, and those produce static libraries.
set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

# Read by CMakeLists.txt to name this platform "ps4" instead of letting the GNU-ish target fall
# through to the UNIX -> "linux" branch, which would configure SDL3, X11 and fontconfig for a host
# that cannot run them.
set(TN_PS4 ON)

set(PS4_OO "$ENV{OO_PS4_TOOLCHAIN}" CACHE PATH "OpenOrbis PS4Toolchain root")
if(NOT PS4_OO)
  message(FATAL_ERROR "PS4_OO is not set: export OO_PS4_TOOLCHAIN or pass -DPS4_OO=<OpenOrbis PS4Toolchain>")
endif()
set(PS4_SHIM "${CMAKE_CURRENT_LIST_DIR}/../scripts/ps4/shim" CACHE PATH
    "PS4 libc++ 11 shim headers (<bit>, <concepts>, <ranges>, <source_location>, ps4-compat.h)")

set(CMAKE_C_COMPILER /usr/bin/clang)
set(CMAKE_CXX_COMPILER /usr/bin/clang++)
set(CMAKE_AR /usr/bin/llvm-ar)
set(CMAKE_RANLIB /usr/bin/llvm-ranlib)
set(CMAKE_C_COMPILER_TARGET x86_64-pc-freebsd12-elf)
set(CMAKE_CXX_COMPILER_TARGET x86_64-pc-freebsd12-elf)

# No working CMake link step until an embedder links against OpenOrbis' crt1/libkernel/libc/libc++.
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

# -isysroot/-isystem as in OO/samples/Makefile:31-32. sysroot headers first, then the shim (so
# <concepts>, <bit>, <ranges>, <source_location> beat libc++'s empty or missing ones), then libc++.
set(PS4_INC
    "-isysroot ${PS4_OO} -isystem ${PS4_OO}/include -isystem ${PS4_SHIM} -isystem ${PS4_OO}/include/c++/v1")
# __ORBIS__: OO/include/c++/v1/__config:12 #undef __FreeBSD__, so Platform.h needs an explicit
# platform macro. _GNU_SOURCE/_BSD_SOURCE: nanosleep and vasprintf are hidden behind them.
# V8_OS_PS4: the embedder half of the pair every V8 build needs. v8config.h:144 selects the
# freebsd flavour (V8_OS_FREEBSD/BSD/POSIX/STRING) from this one macro, so the engine TUs see the
# same layout as the monolith scripts/ps4/e4-build.sh built — a TU that disagrees aborts at run
# time inside Isolate::Enter.
# TN_PS4: the same fact as the configure-time variable, visible to source. It names the few places
# where a libc++ 11 gap cannot be shimmed and a PS4-only branch is the honest fix.
set(PS4_DEFS "-D__ORBIS__=1 -DTN_PS4=1 -D_GNU_SOURCE -D_POSIX_C_SOURCE=200809L -D_BSD_SOURCE -DV8_OS_PS4=1")
set(PS4_COMMON "--target=x86_64-pc-freebsd12-elf -fPIC -funwind-tables ${PS4_INC} ${PS4_DEFS} -include ps4-compat.h -include stdlib.h")

set(CMAKE_C_FLAGS_INIT "${PS4_COMMON}")
set(CMAKE_CXX_FLAGS_INIT "${PS4_COMMON} -std=c++20")
set(CMAKE_ASM_FLAGS_INIT "--target=x86_64-pc-freebsd12-elf -fPIC")

# find_package() (Python3 for the runtime-script code generator) must use host tools.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE BOTH)
