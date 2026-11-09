// PS4 (OpenOrbis) compat shim, force-included into every PS4 translation unit (engine, Dawn, V8
// embedder). Fixes the OpenOrbis sysroot headers where they disagree with what POSIX/glibc-based
// C++ code expects. Keep each entry one line + a reason.
#ifndef PS4_SHIM_COMPAT_H_
#define PS4_SHIM_COMPAT_H_

// libkernel (FreeBSD ABI) keeps a pointer in each pthread attr object, but the OpenOrbis musl
// alltypes.h declares 4 bytes, so libkernel's 8-byte store runs past the caller's object (E4:
// pthread_mutexattr_destroy zeroed V8's saved `this`). Declared first, the musl typedefs are
// skipped by their guards. Same six lines as toolchain/ps4/ps4-compat.h in patches/v8-build-ps4.patch:
// std::condition_variable and std::shared_mutex construct these attributes, so every engine TU
// needs them, not just the V8 one.
typedef struct { void* __p; } pthread_mutexattr_t;
#define __DEFINED_pthread_mutexattr_t
typedef struct { void* __p; } pthread_condattr_t;
#define __DEFINED_pthread_condattr_t
typedef struct { void* __p; } pthread_barrierattr_t;
#define __DEFINED_pthread_barrierattr_t

#include <signal.h>

// OpenOrbis signal.h:142 defines sa_sigaction as __sa_handler.sa_sigaction,
// but the union member is spelled __sa_sigaction (the plugin-sdk typo).
#undef sa_sigaction
#define sa_sigaction __sa_handler.__sa_sigaction

#endif  // PS4_SHIM_COMPAT_H_
