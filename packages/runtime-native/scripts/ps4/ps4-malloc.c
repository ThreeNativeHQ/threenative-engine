// PRD-784 E4: the guest allocator for the PS4 (OpenOrbis) target.
//
// Doug Lea's dlmalloc 2.8.6 (public domain), compiled in but not vendored: e4-build.sh downloads
// it to $TN_PS4_DEPS/malloc-2.8.6.c and checks the sha256 before this file includes it, so the
// source of every byte the guest allocates from is one pinned URL.
//
// Why the guest carries its own allocator: libc.a's malloc is musl's mallocng (malloc.lo exports
// __bin_chunk, __malloc_donate, bin_tab, mal), and in shadPS4 it derived a chunk header claiming
// 0x116E1 bytes inside a 0x4000-byte mapping, so V8's 0x106B8-byte Isolate overran its neighbour
// and nothing faulted (the whole system-managed range is PROT_READ|PROT_WRITE,
// shadps4-src/src/core/address_space.cpp:681). dlmalloc writes every chunk header it later reads;
// it never derives one from bytes another allocator left behind.
//
// The define set is the whole configuration, and e4-build.sh passes each of these too:
//   MMAP_CLEARS=0        a fresh anonymous mmap already reads as zero (the embedder prints
//                        TN_PS4_E4 fresh-mmap before this allocator is ever entered)
//   HAVE_MORECORE=0      no sbrk on this target: every segment is a guest mmap
//   USE_LOCKS=1          one spin lock: guest threads share this heap
//   USE_DL_PREFIX=0      plain names (malloc/free/...), so linking this object is the override
//   MALLOC_ALIGNMENT=16  the x86-64 ABI alignment
//   DEFAULT_GRANULARITY=(64*1024)
//                        the same 64 KiB quantum the guest libc used, so addresses in a run stay
//                        comparable with the runs that failed
//
// Link order is the mechanism, not a wrapper: ld.lld pulls libc.a's malloc.lo only to satisfy an
// undefined malloc, and this object defines it first (e4-build.sh links ps4-malloc.o before -lc
// and before libv8_monolith.a). E5 links the same object.
#include <errno.h>

#ifndef MMAP_CLEARS
#define MMAP_CLEARS 0
#endif
#ifndef HAVE_MORECORE
#define HAVE_MORECORE 0
#endif
#ifndef USE_LOCKS
#define USE_LOCKS 1
#endif
#ifndef USE_DL_PREFIX
#define USE_DL_PREFIX 0
#endif
#ifndef MALLOC_ALIGNMENT
#define MALLOC_ALIGNMENT 16
#endif
#ifndef DEFAULT_GRANULARITY
#define DEFAULT_GRANULARITY (64 * 1024)
#endif

// dlmalloc's prefix toggle is #ifndef, not #if: USE_DL_PREFIX merely *defined* (even as 0) keeps
// the dl* names and exports no malloc at all. The build passes the pinned -DUSE_DL_PREFIX=0 to
// say what it wants; undo it here so the guest really gets plain malloc/free/... and linking this
// object is the override.
#undef USE_DL_PREFIX

// Resolved through -I by e4-build.sh, which owns the download and its hash.
#include "dlmalloc.c"

// dlmalloc 2.8.6 predates C11's aligned_alloc. It defines the rest of the family itself
// (malloc, free, calloc, realloc, memalign, posix_memalign, malloc_usable_size), so this is the
// one entry point the guest would otherwise take from libc.a.
void* aligned_alloc(size_t alignment, size_t size)
{
	// C11 7.22.3.1: a power of two, or EINVAL. The "size a multiple of alignment" half is not a
	// property this allocator has to police: every chunk it hands out is MALLOC_ALIGNMENT aligned
	// and larger than asked for, which is what the standard's own note permits.
	if (alignment == 0 || (alignment & (alignment - 1)) != 0) {
		errno = EINVAL;
		return NULL;
	}
	return alignment <= MALLOC_ALIGNMENT ? malloc(size) : memalign(alignment, size);
}
