// PS4 (OpenOrbis) compat shim, force-included into every Dawn target translation
// unit. Fixes the OpenOrbis sysroot headers where they disagree with what
// POSIX/glibc-based C++ code expects. Keep each entry one line + a reason.
#ifndef PS4_SHIM_COMPAT_H_
#define PS4_SHIM_COMPAT_H_

#include <signal.h>

// OpenOrbis signal.h:142 defines sa_sigaction as __sa_handler.sa_sigaction,
// but the union member is spelled __sa_sigaction (the plugin-sdk typo).
#undef sa_sigaction
#define sa_sigaction __sa_handler.__sa_sigaction

#endif  // PS4_SHIM_COMPAT_H_
