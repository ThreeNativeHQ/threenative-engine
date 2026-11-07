# PS4 (OpenOrbis) cross toolchain for Dawn, Vulkan backend only.
# clang on the host drives --target=x86_64-pc-freebsd12-elf against the
# OpenOrbis sysroot (same triple/flag set as OO/samples and e4's V8 port).
# Only static libraries are produced; the embedder links libkernel/OpenOrbis libs.
#
# Both roots are cache variables e3-build.sh sets, so this file names no machine:
#   PS4_OO    the OpenOrbis PS4Toolchain ($OO_PS4_TOOLCHAIN)
#   PS4_SHIM  <out>/shim, the copy of scripts/ps4/shim e3-build.sh stages (the
#             <concepts>/<bit>/ps4-compat.h the OpenOrbis libc++ 11 lacks)
set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

set(PS4_OO "" CACHE PATH "OpenOrbis PS4Toolchain root")
set(PS4_SHIM "" CACHE PATH "PS4 shim headers (<concepts>, <bit>, ps4-compat.h)")
if(NOT PS4_OO)
  message(FATAL_ERROR "PS4_OO is not set; configure through e3-build.sh")
endif()
if(NOT PS4_SHIM)
  message(FATAL_ERROR "PS4_SHIM is not set; configure through e3-build.sh")
endif()

set(CMAKE_C_COMPILER /usr/bin/clang)
set(CMAKE_CXX_COMPILER /usr/bin/clang++)
set(CMAKE_AR /usr/bin/llvm-ar)
set(CMAKE_RANLIB /usr/bin/llvm-ranlib)
set(CMAKE_C_COMPILER_TARGET x86_64-pc-freebsd12-elf)
set(CMAKE_CXX_COMPILER_TARGET x86_64-pc-freebsd12-elf)

# No working linker until the embedder links against OpenOrbis libs.
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

# -isysroot/-isystem as in OO/samples/Makefile:31-32. sysroot headers first,
# then the shim (<concepts> must beat libc++'s empty one), then libc++.
set(PS4_INC
    "-isysroot ${PS4_OO} -isystem ${PS4_OO}/include -isystem ${PS4_SHIM} -isystem ${PS4_OO}/include/c++/v1")
# __ORBIS__: OO/include/c++/v1/__config:12 #undef __FreeBSD__, so Platform.h
# needs an explicit platform macro.  _GNU_SOURCE/_BSD_SOURCE: nanosleep and
# vasprintf are hidden behind them.  ps4-compat.h/stdlib.h force-includes as e4.
set(PS4_DEFS "-D__ORBIS__=1 -D_GNU_SOURCE -D_POSIX_C_SOURCE=200809L -D_BSD_SOURCE")
set(PS4_COMMON "--target=x86_64-pc-freebsd12-elf -fPIC -funwind-tables ${PS4_INC} ${PS4_DEFS} -include ps4-compat.h -include stdlib.h")

set(CMAKE_C_FLAGS_INIT "${PS4_COMMON}")
set(CMAKE_CXX_FLAGS_INIT "${PS4_COMMON} -std=c++20")
# Assembler is not used by Dawn; keep it consistent anyway.
set(CMAKE_ASM_FLAGS_INIT "--target=x86_64-pc-freebsd12-elf -fPIC")

# find_package() (Python3 for the code generator) must use host tools.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE BOTH)
