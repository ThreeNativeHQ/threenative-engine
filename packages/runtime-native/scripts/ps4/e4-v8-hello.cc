// E4: minimal V8 embedder for the PS4 (OpenOrbis) target.
// Builds/links against a jitless, pointer-compression-free v8_monolith.

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>  // memset, in the fresh-mmap probe
#include <sys/mman.h>  // the fresh-mmap probe
#include <unwind.h>  // _Unwind_Backtrace
#include <unistd.h>  // _exit, sysconf

#include <memory>
#include <unordered_map>

#include "libplatform/libplatform.h"
#include "v8.h"

// Two internals the public headers do not expose but the monolith exports. Declared rather than
// included: src/base/logging.h drags the whole internal tree into a 130-line embedder.
namespace v8 {
namespace base {
void SetFatalFunction(void (*fatal_function)(const char* file, int line,
                                             const char* message));
class OS {
 public:
  static size_t AllocatePageSize();
  static size_t CommitPageSize();
};
}  // namespace base
}  // namespace v8

namespace {

// Every V8 CHECK/UNREACHABLE lands in V8_Fatal, which calls this BEFORE it writes its own text to
// stderr and aborts (src/base/logging.cc:168-214). fd 1 is the channel the emulator's log has
// demonstrably carried, so the account takes it. A release build passes file="" and line=0
// (logging.cc:168 drops both); the message is then the whole account -- "Check failed: <expr>."
// names the invariant, which is what the fix needs.
void ReportBaseFatal(const char* file, int line, const char* message) {
  printf("TN_PS4_E4 v8_fatal %s:%d %s\n", file, line, message);
  fflush(stdout);
}

// The emulator reports a signal and its own guess at the faulting PC. V8's own account is more
// specific when it has one, so it goes to stdout (which reaches the log) before the abort.
void ReportFatal(const char* location, int line, const char* message) {
  printf("TN_PS4_E4 fatal at %s:%d: %s\n", location, line, message);
  fflush(stdout);
}

bool ReportException(v8::Isolate* isolate, v8::TryCatch* try_catch) {
  v8::String::Utf8Value msg(isolate, try_catch->Exception());
  fprintf(stderr, "V8 error: %s\n", *msg ? *msg : "(no message)");
  return false;
}

}  // namespace

// The guest's allocator, not libc's, is why this file no longer wraps posix_memalign: ps4-malloc.c
// links dlmalloc 2.8.6 over libc.a's malloc, so the address V8 receives for its Isolate is handed
// out by code whose chunk headers are always its own. The one number that override measured -- a
// 0x106B8-byte Isolate sold from a 0x4000-byte mapping (Isolate::New moves 0x106B8 straight into
// the size argument, e4-v8-hello.elf+0x1f6b61) -- is pinned; the leak it caused is what the
// allocator change fixes.

// The fact the allocator rests on, measured before it is ever entered: a fresh anonymous guest
// mmap reads as zero. shadPS4 backs a guest anon flex mapping with a window onto its own memfd (src/core/address_space.cpp:775-791:
// MAP_FIXED|MAP_SHARED at the guest address, over a file ftruncate'd to zeros) and memsets a
// flexible range again when it is released (src/core/memory.cpp:979-981), so both shapes are
// expected to read zero -- and "expected" is the word that shipped the last red. Two numbers, the
// same 64 KiB the guest libc groups on:
//   fresh-mmap  the first window this run is given
//   reuse-mmap  a second window, after 64 KiB of 0xA5 was written into the first and munmap'd:
//               the case a heap actually meets, and the one that says whether released pages come
//               back clean.
void ProbeFreshMmap() {
  constexpr size_t kBytes = 64 * 1024;
  auto non_zero = [](void* p) {
    unsigned count = 0;
    const auto* bytes = static_cast<const unsigned char*>(p);
    for (size_t i = 0; i < kBytes; ++i) count += bytes[i] != 0;
    return count;
  };
  const int prot = PROT_READ | PROT_WRITE;
  const int anon = MAP_PRIVATE | MAP_ANONYMOUS;
  void* fresh = mmap(nullptr, kBytes, prot, anon, -1, 0);
  if (fresh == MAP_FAILED) {
    printf("TN_PS4_E4 fresh-mmap nonzero=-1\n");
    fflush(stdout);
    return;
  }
  printf("TN_PS4_E4 fresh-mmap nonzero=%u at=%p\n", non_zero(fresh), fresh);
  memset(fresh, 0xA5, kBytes);
  munmap(fresh, kBytes);
  void* reused = mmap(nullptr, kBytes, prot, anon, -1, 0);
  if (reused == MAP_FAILED) {
    printf("TN_PS4_E4 reuse-mmap nonzero=-1\n");
  } else {
    printf("TN_PS4_E4 reuse-mmap nonzero=%u at=%p\n", non_zero(reused), reused);
    munmap(reused, kBytes);
  }
  fflush(stdout);
}

#ifdef TN_PS4_E4_TRACE
// Everything the last red needed to be believed, and nothing a green run should pay for. Build the
// guest with -DTN_PS4_E4_TRACE=1 (e4-build.sh does when TN_PS4_E4_TRACE is set) to get the abort
// account in full: the symbolised walk, the map the abort came from, and the page signature of the
// window around it.
constexpr uintptr_t kTextStart = 0x4000;
constexpr uintptr_t kTextEnd = 0x1101780;  // the R E LOAD segment (readelf -l)

_Unwind_Reason_Code PrintFrame(_Unwind_Context* context, void* depth) {
  uintptr_t ip = static_cast<uintptr_t>(_Unwind_GetIP(context));
  if (ip >= kTextStart && ip < kTextEnd) {
    printf(" ra=%p", reinterpret_cast<void*>(ip));
  }
  return ++*static_cast<int*>(depth) > 24 ? _URC_END_OF_STACK : _URC_NO_REASON;
}

// Two facts about Isolate read out of e4-v8-hello.elf rather than assumed: the ThreadDataTable sits
// at Isolate+0x105E0 (Isolate::Enter, 0x1fc105: `leaq 0x105e0(%r14), %r15`), and sizeof(Isolate)
// is 0x106B8. So the table pointer __rehash still holds names the Isolate base by subtraction.
constexpr uintptr_t kThreadDataTableOffset = 0x105E0;
constexpr uintptr_t kIsolateBytes = 0x106B8;

unsigned NonZeroQwords(uintptr_t from, uintptr_t bytes) {
  unsigned non_zero = 0;
  const uint64_t* words = reinterpret_cast<const uint64_t*>(from);
  for (uintptr_t i = 0; i < bytes / sizeof(uint64_t); ++i) {
    if (words[i] != 0) ++non_zero;
  }
  return non_zero;
}

// A constructed Isolate is 17 near-full pages; memory the emulator handed out twice, or never
// wrote, is zero. Printing the page signature of the window the isolate should occupy separates
// "the ctor ran somewhere else" from "these pages were replaced after it ran" in one line each.
void DumpPages(uintptr_t from, uintptr_t to) {
  for (uintptr_t page = from; page < to; page += 0x1000) {
    const uint64_t* words = reinterpret_cast<const uint64_t*>(page);
    unsigned non_zero = 0;
    unsigned one_float = 0;
    for (unsigned i = 0; i < 0x1000 / sizeof(uint64_t); ++i) {
      if (words[i] != 0) ++non_zero;
      // max_load_factor 1.0f, at the table's 0x20 -- the one value the Isolate ctor provably
      // stores (ThreadDataTable's own initialiser).
      if (words[i] == 0x3f800000ull || words[i] == 0x3f80000000000000ull) ++one_float;
    }
    if (non_zero != 0 || one_float != 0) {
      printf("TN_PS4_E4 dump page=%p nz=%u f1=%u q0=%p q1=%p\n",
             reinterpret_cast<void*>(page), non_zero, one_float,
             reinterpret_cast<void*>(words[0]), reinterpret_cast<void*>(words[1]));
    }
  }
  printf("TN_PS4_E4 dump end=%p\n", reinterpret_cast<void*>(to));
  fflush(stdout);
}
#endif  // TN_PS4_E4_TRACE

// Guest override of libc's abort(): libc.a only supplies abort() when nothing else defines it, so
// this one wins and names the caller in one line. The frame in full is TN_PS4_E4_TRACE's job, and
// this program only reaches abort() when it is already red.
extern "C" _Noreturn void abort(void) {  // NOLINT
  // Reached only from libc++'s __hash_table::__rehash, which calls abort() instead of throwing
  // when the bucket count it was handed exceeds the pointer allocator's max_size (exceptions are
  // off). __rehash keeps `this` in rbx and the bucket count in r14; the table's layout is
  // __bucket_list_ (ptr, count) at 0x0/0x8, __p1_.first at 0x10, size at 0x18, the
  // max_load_factor float at 0x20.
#ifdef TN_PS4_E4_TRACE
  // libc++'s __rehash keeps `this` in rbx and the bucket count in r14; the table's layout is
  // __bucket_list_ (ptr, count) at 0x0/0x8, __p1_.first at 0x10, size at 0x18, the
  // max_load_factor float at 0x20.
  uintptr_t table = 0;
  uintptr_t buckets = 0;
  __asm__ volatile("movq %%rbx, %0\n\tmovq %%r14, %1" : "=r"(table), "=r"(buckets));
  const uintptr_t* words = reinterpret_cast<const uintptr_t*>(table);
  float load = 0.0f;
  __builtin_memcpy(&load, &words[4], sizeof(load));
  printf(
      "TN_PS4_E4 abort table=%p buckets=%p list=%p count=%lu first=%p size=%lu "
      "load=%g around=%p,%p,%p\n",
      reinterpret_cast<void*>(table), reinterpret_cast<void*>(buckets),
      reinterpret_cast<void*>(words[0]), static_cast<unsigned long>(words[1]),
      reinterpret_cast<void*>(words[2]), static_cast<unsigned long>(words[3]),
      static_cast<double>(load), reinterpret_cast<void*>(words[-8]),
      reinterpret_cast<void*>(words[-4]), reinterpret_cast<void*>(words[6]));
  // The table said zero everywhere, so the question is whether these bytes were ever written.
  uintptr_t r12 = 0, r13 = 0, r15 = 0, rdi = 0, rsi = 0;
  __asm__ volatile("movq %%r12, %0\n\tmovq %%r13, %1\n\tmovq %%r15, %2\n\tmovq %%rdi, %3\n\tmovq %%rsi, %4"
                   : "=r"(r12), "=r"(r13), "=r"(r15), "=r"(rdi), "=r"(rsi));
  const uintptr_t isolate = table - kThreadDataTableOffset;
  printf("TN_PS4_E4 isolate=%p nz=%u regs=%p,%p,%p,%p,%p\n",
         reinterpret_cast<void*>(isolate),
         NonZeroQwords(isolate, kIsolateBytes), reinterpret_cast<void*>(r12),
         reinterpret_cast<void*>(r13), reinterpret_cast<void*>(r15),
         reinterpret_cast<void*>(rdi), reinterpret_cast<void*>(rsi));
  // Raw bytes, not counts: the table is four words and the two facts that matter are whether they
  // are zero and what the nearest written words next to them hold.
  printf("TN_PS4_E4 raw isolate");
  for (int i = 0; i < 8; ++i) {
    printf(" %#lx", static_cast<unsigned long>(
                        reinterpret_cast<const uint64_t*>(isolate)[i]));
  }
  printf("\ntable-0x40:");
  for (int i = -8; i < 10; ++i) {
    printf(" %#lx", static_cast<unsigned long>(words[i]));
  }
  printf("\n");
  fflush(stdout);
  // The window the emulator hands the guest allocator starts a mebibyte below the isolate today;
  // every page this reads was mapped read/write by the run's own mmaps before the abort.
  DumpPages(isolate & ~static_cast<uintptr_t>(0xFFFFF), isolate + kIsolateBytes + 0x1000);
  int depth = 0;
  printf("TN_PS4_E4 abort caller=%p", __builtin_return_address(0));
  _Unwind_Backtrace(&PrintFrame, &depth);
  printf("\n");
  // The unwind above is only believable while the stack is intact, and it was not: two builds
  // reported the same "caller", a +0x2c9 offset into a movb that contains no call. So dump the
  // return addresses themselves -- every word of the first 4 KiB of stack that points into the
  // text segment -- and the frame-pointer chain beside it; symbolise both offline against this ELF.
  uintptr_t sp = 0;
  uintptr_t bp = 0;
  __asm__ volatile("movq %%rsp, %0\n\tmovq %%rbp, %1" : "=r"(sp), "=r"(bp));
  printf("TN_PS4_E4 stack rsp=%p rbp=%p\n", reinterpret_cast<void*>(sp),
         reinterpret_cast<void*>(bp));
  printf("TN_PS4_E4 stack text-words");
  for (int i = 0; i < 512; ++i) {
    const uintptr_t word = reinterpret_cast<const uintptr_t*>(sp)[i];
    if (word >= kTextStart && word < kTextEnd) {
      printf(" [%d]=%p", i, reinterpret_cast<void*>(word));
    }
  }
  printf("\n");
  for (int i = 0; i < 16; ++i) {
    if (bp < 0x200000000 || bp >= 0x300000000 || (bp & 7) != 0) break;
    const uintptr_t* frame = reinterpret_cast<const uintptr_t*>(bp);
    const uintptr_t next = frame[0];
    printf("TN_PS4_E4 frame[%d] bp=%p ra=%p\n", i, reinterpret_cast<void*>(bp),
           reinterpret_cast<void*>(frame[1]));
    if (next <= bp) break;
    bp = next;
  }
#else
  printf("TN_PS4_E4 abort caller=%p (rebuild with -DTN_PS4_E4_TRACE=1 for the full account)\n",
         __builtin_return_address(0));
#endif
  fflush(stdout);
  fflush(stderr);
  _exit(134);  // the same abnormal end, minus the guest's abort() re-raise dance
}

// One line per step, flushed: a guest that dies mid-initialise names the last step that worked,
// which is what a red run's log tail shows. Cheap enough to keep.
static void Stage(const char* what) {
  printf("TN_PS4_E4 stage=%s\n", what);
  fflush(stdout);
}

// The allocator's own size query: dlmalloc provides it (ps4-malloc.c) but OpenOrbis' <stdlib.h>
// does not declare it, and this file is the only caller.
extern "C" size_t malloc_usable_size(void* p);  // NOLINT

// The one check this program leaves behind for its allocator: the largest single ask it makes --
// the Isolate, 0x106B8 bytes at 4 KiB (Isolate::New moves that size straight into posix_memalign,
// e4-v8-hello.elf+0x1f6b61) -- comes back with a usable size that covers the whole request and
// survives a full-length write. A red here is the allocator; a green moves the red into V8.
bool CheckAllocator(size_t bytes, size_t align) {
  // The plain allocation is the comparison: same size, no alignment, so the two addresses on one
  // line say whether the aligned block and the plain one came from the same segment.
  void* plain = malloc(bytes);
  const size_t usable_plain = plain != nullptr ? malloc_usable_size(plain) : 0;
  void* block = nullptr;
  const int rc = posix_memalign(&block, align, bytes);
  bool ok = rc == 0 && block != nullptr;
  size_t usable = ok ? malloc_usable_size(block) : 0;
  ok = ok && usable >= bytes;
  if (ok) {
    memset(block, 0x5A, bytes);
    for (size_t i = 0; i < bytes; i += 512) {
      if (static_cast<unsigned char*>(block)[i] != 0x5A) {
        ok = false;
        break;
      }
    }
  }
  printf("TN_PS4_E4 alloc-check bytes=%#zx align=%#zx usable=%#zx ok=%d block=%p plain=%p "
         "usable_plain=%#zx fn=%p,%p\n",
         bytes, align, usable, ok, block, plain, usable_plain,
         reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(&malloc)),
         reinterpret_cast<void*>(reinterpret_cast<uintptr_t>(&posix_memalign)));
  fflush(stdout);
  free(plain);
  free(block);
  return ok;
}

thread_local unsigned tls_probe = 0x5a17c0de;
__attribute__((noinline)) unsigned TlsProbe() { return tls_probe; }

int main(int argc, char* argv[]) {
  setvbuf(stdout, nullptr, _IONBF, 0);
  // Guest fd 2 reaches the emulator's log as [stderr] (src/core/file_sys/fs.cpp:706-707), so V8's
  // CHECK text would arrive -- but nothing did, and the run prints this probe to prove the channel
  // is live before trusting that silence. Unbuffered, so a fatal never depends on a flush running.
  setvbuf(stderr, nullptr, _IONBF, 0);
  fprintf(stderr, "TN_PS4_E4 probe=stderr\n");
  fflush(stderr);
  // Before anything allocates: whether a fresh guest mmap reads as zero, twice (see ProbeFreshMmap).
  ProbeFreshMmap();
  // Both page sizes V8 uses for its own alignment CHECKs, next to the one the guest libc reports:
  // --no-freeze-flags-after-init already dodged an aligned-4-KiB-vs-16-KiB-page CHECK
  // (src/base/platform/platform-posix.cc:539), so a mismatch here is the first thing to rule out.
  printf("TN_PS4_E4 pages libc=%lu v8_allocate=%lu v8_commit=%lu\n",
         static_cast<unsigned long>(sysconf(_SC_PAGESIZE)),
         static_cast<unsigned long>(v8::base::OS::AllocatePageSize()),
         static_cast<unsigned long>(v8::base::OS::CommitPageSize()));
  v8::base::SetFatalFunction(&ReportBaseFatal);
  // Below V8, on purpose: if libc++'s own hash table cannot insert one int on this target, the
  // Isolate's map is not the problem. One line, before anything V8 allocates.
  {
    std::unordered_map<int, int> probe;
    probe[1] = 1;
    printf("TN_PS4_E4 pages map_probe=%lu\n", static_cast<unsigned long>(probe.size()));
  }
  // V8 keeps its per-thread assert scopes in an initialised thread_local (all allowed); a TLS
  // initial image the loader never copied reads 0 and fails AllowHeapAllocation at first alloc.
  printf("TN_PS4_E4 tls probe=0x%x (want 0x5a17c0de)\n", TlsProbe());
  Stage("flags");
  // jitless: no executable memory is ever written on the PS4 (and the run must not depend on it).
  // single-threaded: the platform below has one thread, so V8 must not ask for workers.
  // no-freeze-flags-after-init: V8 mprotects v8_flags read-only, but it only aligns them to
  // kMinimumOSPageSize (4 KiB, src/base/build_config.h:100) while a PS4 page is 16 KiB, so
  // OS::SetDataReadOnly's alignment CHECK (src/base/platform/platform-posix.cc:539) aborts
  // before the heap exists. Honest page size, no flag hardening -- the isolation is the emulator.
  v8::V8::SetFlagsFromString("--jitless --single-threaded --no-freeze-flags-after-init");
  v8::V8::SetFatalErrorHandler(&ReportFatal);
  printf("TN_PS4_E4 version=%s\n", v8::V8::GetVersion());
  fflush(stdout);

  std::unique_ptr<v8::Platform> platform =
      v8::platform::NewSingleThreadedDefaultPlatform();
  if (platform == nullptr) {
    fprintf(stderr, "NewSingleThreadedDefaultPlatform failed\n");
    return 1;
  }
  Stage("platform");
  v8::V8::InitializePlatform(platform.get());
  Stage("initialize");
  if (!v8::V8::Initialize()) {
    fprintf(stderr, "V8::Initialize failed\n");
    return 1;
  }

  {
    Stage("isolate");
    Stage(CheckAllocator(0x106B8, 0x1000) ? "alloc-ok" : "alloc-BAD");
    v8::Isolate::CreateParams params;
    params.array_buffer_allocator =
        v8::ArrayBuffer::Allocator::NewDefaultAllocator();
    v8::Isolate* isolate = v8::Isolate::New(params);
    Stage("context");
    {
      v8::Isolate::Scope isolate_scope(isolate);
      v8::HandleScope handle_scope(isolate);
      v8::Local<v8::Context> context = v8::Context::New(isolate);
      v8::Context::Scope context_scope(context);
      v8::TryCatch try_catch(isolate);
      Stage("compile");

      const char* source_text = "'TN_PS4_E4 ' + (6*7)";
      v8::Local<v8::String> source =
          v8::String::NewFromUtf8(isolate, source_text).ToLocalChecked();
      v8::Local<v8::Script> script;
      if (!v8::Script::Compile(context, source).ToLocal(&script)) {
        return ReportException(isolate, &try_catch) ? 0 : 1;
      }
      v8::Local<v8::Value> result;
      Stage("run");
      if (!script->Run(context).ToLocal(&result)) {
        return ReportException(isolate, &try_catch) ? 0 : 1;
      }
      v8::String::Utf8Value utf8(isolate, result);
      printf("%s mode=jitless\n", *utf8 ? *utf8 : "(null)");
      fflush(stdout);
    }
    isolate->Dispose();
    delete params.array_buffer_allocator;
  }

  v8::V8::Dispose();
  v8::V8::DisposePlatform();
  return 0;
}
