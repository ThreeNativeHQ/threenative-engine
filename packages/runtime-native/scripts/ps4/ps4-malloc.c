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

// TLS alignment pin, riding in the one object every guest links. OpenOrbis create-fself raises
// PT_TLS p_align to 0x20, and the loader (shadPS4 tcb.cpp, as Sony's rtld) copies the init image
// to tp - alignTo(memsz, 0x20). ld.lld baked tp - alignTo(memsz, p_align) into every TLS access,
// so with an 8-aligned segment each initialised thread_local read 0 (E4: V8's assert scopes ->
// "AllowHeapAllocationInRelease::IsAllowed()"). A 32-aligned member makes both offsets agree.
__attribute__((used, aligned(32))) _Thread_local char tn_ps4_tls_align32;

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

// The heap's segments come from direct memory, not from an anonymous mmap. An anonymous mapping
// takes the 448 MiB flexible pool (the retail limit, shadps4-src/src/core/memory.cpp:100), and
// procedural-animals filled it at its first frames: 3 521 mappings, std::bad_alloc (PRD-784 P5-10).
// Direct memory is the rest of the console's RAM, the pool a PS4 game keeps its data in.
// dlmalloc maps a whole segment or a large chunk, and unmaps all of one or, on a trim, its tail;
// the table keeps each mapping's direct-memory offset so either release returns the right range.
#include <stdatomic.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>
extern int64_t sceKernelGetDirectMemorySize(void);
extern int32_t sceKernelAllocateDirectMemory(int64_t, int64_t, uint64_t, uint64_t, int32_t, int64_t*);
extern int32_t sceKernelMapDirectMemory(void**, uint64_t, int32_t, int32_t, int64_t, uint64_t);
extern int32_t sceKernelMunmap(void*, uint64_t);
extern int32_t sceKernelReleaseDirectMemory(int64_t, uint64_t);

#define TN_DIRECT_PAGE ((size_t)16 * 1024)
#define TN_DIRECT_WB_ONION 0
// ponytail: a fixed table with a linear search; procedural-animals peaks near 3 000 live mappings.
#define TN_DIRECT_RANGES 16384
typedef struct { char* va; int64_t phys; size_t len; } tn_direct_range;
static tn_direct_range tn_ranges[TN_DIRECT_RANGES];
static size_t tn_range_count;
static atomic_flag tn_range_lock = ATOMIC_FLAG_INIT;

static void tn_ranges_lock(void) { while (atomic_flag_test_and_set_explicit(&tn_range_lock, memory_order_acquire)) {} }
static void tn_ranges_unlock(void) { atomic_flag_clear_explicit(&tn_range_lock, memory_order_release); }
static size_t tn_direct_len(size_t size) { return (size + TN_DIRECT_PAGE - 1) & ~(TN_DIRECT_PAGE - 1); }

static void* tn_direct_mmap(size_t size)
{
	const size_t len = tn_direct_len(size);
	int64_t phys = 0;
	void* va = NULL;
	if (sceKernelAllocateDirectMemory(0, sceKernelGetDirectMemorySize(), len, TN_DIRECT_PAGE, TN_DIRECT_WB_ONION, &phys) != 0)
		return (void*)-1;
	if (sceKernelMapDirectMemory(&va, len, PROT_READ | PROT_WRITE, 0, phys, TN_DIRECT_PAGE) != 0) {
		sceKernelReleaseDirectMemory(phys, len);
		return (void*)-1;
	}
	tn_ranges_lock();
	const int full = tn_range_count == TN_DIRECT_RANGES;
	if (!full) tn_ranges[tn_range_count++] = (tn_direct_range){(char*)va, phys, len};
	tn_ranges_unlock();
	if (full) {
		sceKernelMunmap(va, len);
		sceKernelReleaseDirectMemory(phys, len);
		return (void*)-1;
	}
	return va;
}

static int tn_direct_munmap(void* addr, size_t size)
{
	char* const a = (char*)addr;
	const size_t len = tn_direct_len(size);
	int64_t phys = -1;
	tn_ranges_lock();
	for (size_t i = 0; i < tn_range_count; ++i) {
		tn_direct_range* r = &tn_ranges[i];
		if (a < r->va || a + len > r->va + r->len) continue;
		if (a != r->va && a + len != r->va + r->len) break;  // a hole in the middle: dlmalloc makes none
		phys = r->phys + (a - r->va);
		if (len == r->len) *r = tn_ranges[--tn_range_count];
		else if (a == r->va) { r->va += len; r->phys += (int64_t)len; r->len -= len; }
		else r->len -= len;
		break;
	}
	tn_ranges_unlock();
	if (phys < 0) return -1;
	sceKernelMunmap(a, len);
	sceKernelReleaseDirectMemory(phys, len);
	return 0;
}

#define MMAP(s) tn_direct_mmap(s)
#define DIRECT_MMAP(s) tn_direct_mmap(s)
#define MUNMAP(a, s) tn_direct_munmap((a), (s))

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
