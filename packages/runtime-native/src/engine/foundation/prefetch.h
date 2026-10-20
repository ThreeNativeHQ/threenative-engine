#pragma once

// A cache prefetch hint that every desktop compiler accepts. MSVC has no `__builtin_prefetch`, so
// the Windows engine player failed to compile (release-proof run 39254781473); x64 MSVC takes the
// SSE hint and any other MSVC target drops it, because a prefetch never changes a result.
#if defined(_MSC_VER) && !defined(__clang__)
#if defined(_M_X64)
#include <xmmintrin.h>
#define TN_PREFETCH(address, rw, locality) \
    _mm_prefetch(static_cast<const char*>(static_cast<const void*>(address)), _MM_HINT_T0)
#else
#define TN_PREFETCH(address, rw, locality) static_cast<void>(address)
#endif
#else
#define TN_PREFETCH(address, rw, locality) __builtin_prefetch(address, rw, locality)
#endif
