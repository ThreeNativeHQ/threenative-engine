// FreeBSD names its byte-order macros in <sys/endian.h>; the OpenOrbis sysroot ships musl's
// <endian.h> only, which defines the same BYTE_ORDER/BIG_ENDIAN/LITTLE_ENDIAN. SDL3's SDL_endian.h
// picks the FreeBSD spelling from __FreeBSD__ (the compiler's own triple, which the OO C++.h
// __config cannot #undef), so the name has to resolve. This shim is the alias, nothing else.
#ifndef PS4_SHIM_SYS_ENDIAN_H_
#define PS4_SHIM_SYS_ENDIAN_H_

#include <endian.h>

#endif  // PS4_SHIM_SYS_ENDIAN_H_
