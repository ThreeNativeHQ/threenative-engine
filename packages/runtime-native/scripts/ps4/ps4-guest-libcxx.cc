// PRD-784 E5: the two C++ runtime entry points libc++.a and libc++abi.a leave for the libc on PS4,
// linked into the engine player's guest (scripts/ps4/e5-build.sh).
//
// OpenOrbis' libc is musl-derived over libkernel and ships neither, but Dawn's own objects and
// libc++'s thread_local support reach for them: without these two, ld.lld reports them undefined
// and nothing links. e3-triangle.cc carries the same pair for the bare Dawn guest; this is the
// engine player's copy (the E3 lane is a scratch experiment and is not edited from here).
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <pthread.h>
#include <stdlib.h>
#include <time.h>

namespace std {
inline namespace __1 {

// <atomic> declares __libcpp_atomic_wait(void const volatile*, __cxx_contention_t, long on x86-64)
// while libc++.a only ships the int overloads, so std::atomic::wait (Dawn's Buffer.cpp waits on a
// buffer state this way) has no definition to reach.
// ponytail: 0.5 ms polling wait -- correct (a notifier's store is always observed) but a sleeper
// burns a scheduler slot; swap for a futex/semaphore if waiting shows up in a profile.
__attribute__((visibility("default"))) void __libcpp_atomic_wait(void const volatile* address,
                                                                long old) {
    while (__atomic_load_n(reinterpret_cast<long const volatile*>(address), __ATOMIC_ACQUIRE) ==
           old) {
        struct timespec pause = {0, 500000};
        nanosleep(&pause, nullptr);
    }
}

}  // namespace __1
}  // namespace std

// libc++abi registers C++11 thread_local destructors through __cxa_thread_atexit_impl, which glibc
// and musl provide and this libc does not.
// ponytail: one fixed, locked table run at process exit, so a worker thread's thread_local
// destructors run at exit, not at thread exit (the player's own TUs hold no such object today). Upgrade path: a per-thread list keyed by
// pthread_key_create, or libkernel's thread-exit callback, when one appears.
extern "C" {

using TnThreadDtor = void (*)(void*);

static TnThreadDtor g_tnDtors[64];
static void* g_tnDtorArgs[64];
static int g_tnDtorCount = 0;

static int TnRegisterThreadDtor(TnThreadDtor dtor, void* object);

static void TnRunThreadDtors() {
    while (g_tnDtorCount > 0) {
        --g_tnDtorCount;
        g_tnDtors[g_tnDtorCount](g_tnDtorArgs[g_tnDtorCount]);
    }
}

int __cxa_thread_atexit_impl(TnThreadDtor dtor, void* object, void* dsoHandle) {
    (void)dsoHandle;
    // Worker threads (the renderer's job pool) register too: one lock keeps two first uses apart.
    static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
    pthread_mutex_lock(&lock);
    const int rc = TnRegisterThreadDtor(dtor, object);
    pthread_mutex_unlock(&lock);
    return rc;
}

static int TnRegisterThreadDtor(TnThreadDtor dtor, void* object) {
    if (g_tnDtorCount == 64) {
        return -1;
    }
    static bool registered = false;
    if (!registered) {
        registered = true;
        atexit(TnRunThreadDtors);
    }
    g_tnDtors[g_tnDtorCount] = dtor;
    g_tnDtorArgs[g_tnDtorCount] = object;
    ++g_tnDtorCount;
    return 0;
}

}  // extern "C"

// clang emits a weak reference to the thread-init wrapper of AnimationMixer::cpuTiming from every
// TU that only sees the declaration (src/engine/animation/mixer.h:207), and no definition anywhere:
// the variable's initialiser is constant (mixer.h:201-207), so it folds into the TLS image and the
// wrapper's dynamic half is empty. ld.lld is happy with a weak undefined; create-fself is not --
// a SELF may not carry one -- so the wrapper gets the empty definition it would have had.
// The other thread_locals in the player (PoseObservation, ProjectedCull::cpuTiming) do keep their
// real definitions; this is the one the compiler dropped.
extern "C" void TnAnimationMixerCpuTimingTlsInit()
    asm("_ZTHN2tn6engine9animation14AnimationMixer9cpuTimingE");
extern "C" void TnAnimationMixerCpuTimingTlsInit() {}

// Every clock id in this guest is musl's Linux numbering (OpenOrbis include/time.h:
// CLOCK_MONOTONIC 1), but clock_gettime resolves to libkernel, which reads FreeBSD numbering: 1 is
// CLOCK_VIRTUAL, the process's user CPU time (shadPS4 kernel/time.cpp maps it to getrusage). So
// std::chrono::steady_clock, V8's monotonic time and the game's dt all followed CPU time and ran
// slow against the wall: E5's box turned at a third of its 1 rad/s and frame_ms read 8.6 ms while
// the flips were 29 ms apart. e5-build.sh links with --wrap=clock_gettime, so every static caller
// (libc++ chrono.cpp, libc, V8, Dawn, the engine) reaches this translation first.
extern "C" {
// Every abort() in the guest (libc, libc++abi, Dawn, OpenGNM, the driver) names its caller first:
// shadPS4 reports only "signal 6" and abort's own address, so a bare abort had no call site
// (PRD-784). llvm-symbolizer on the ELF at `caller - 0x400000` names the function.
[[noreturn]] void __real_abort(void);
[[noreturn]] void __wrap_abort(void) {
    fprintf(stderr, "TN_PS4_ABORT caller=%p\n", __builtin_return_address(0));
    fflush(stderr);
    __real_abort();
}
int __real_clock_gettime(clockid_t, struct timespec*);
int __wrap_clock_gettime(clockid_t id, struct timespec* ts) {
    // Linux id -> FreeBSD/Orbis id (shadPS4 kernel/time.h ORBIS_CLOCK_*).
    static const clockid_t kOrbis[] = {
        0,   // REALTIME
        4,   // MONOTONIC
        15,  // PROCESS_CPUTIME_ID -> PROCTIME
        14,  // THREAD_CPUTIME_ID
        4,   // MONOTONIC_RAW -> MONOTONIC
        10,  // REALTIME_COARSE -> REALTIME_FAST
        12,  // MONOTONIC_COARSE -> MONOTONIC_FAST
        5,   // BOOTTIME -> UPTIME
    };
    const unsigned at = static_cast<unsigned>(id);
    return __real_clock_gettime(at < sizeof kOrbis / sizeof *kOrbis ? kOrbis[at] : id, ts);
}

// Rust std (the native physics staticlib, built for x86_64-unknown-linux-musl) names two glibc/musl
// extensions OpenOrbis does not ship. std treats a failing pthread_getattr_np as "no stack guard
// known" and a thread name as a hint, so both report "not supported".
// OpenOrbis's <pthread.h> renames both to their BSD names by macro, so without the #undef these
// defined pthread_attr_get_np / pthread_set_name_np and the Linux names stayed undefined (the CSS UI
// crate's std reaches both; the physics crate never did).
#undef pthread_getattr_np
#undef pthread_setname_np
int pthread_getattr_np(pthread_t, pthread_attr_t*) { return ENOSYS; }
int pthread_setname_np(pthread_t, const char*) { return 0; }
// std also takes three Linux calls as weak references; left undefined, a weak reference becomes a
// dynamic import that create-fself cannot map to a PS4 library ("missing library for symbol").
int gettid(void) { return -1; }
// ponytail: std seeds HashMap keys (hash-flooding defence, not cryptography) from getrandom, which
// OpenOrbis does not ship; a clock-seeded xorshift fills it. Use the kernel's RNG if a caller needs secrets.
long getrandom(void* buffer, unsigned long length, unsigned) {
    timespec now{};
    clock_gettime(CLOCK_MONOTONIC, &now);
    static unsigned long long state = 0x9e3779b97f4a7c15ull;
    state ^= static_cast<unsigned long long>(now.tv_nsec) ^ (static_cast<unsigned long long>(now.tv_sec) << 32);
    auto* out = static_cast<unsigned char*>(buffer);
    for (unsigned long i = 0; i < length; ++i) {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        out[i] = static_cast<unsigned char>(state);
    }
    return static_cast<long>(length);
}
int pidfd_getpid(int) { errno = ENOSYS; return -1; }
int pidfd_spawnp(int*, const char*, const void*, const void*, char* const[], char* const[]) { errno = ENOSYS; return -1; }

// The Rust archives are built for x86_64-unknown-linux-musl, so their std reads musl's struct layouts
// and passes Linux O_* flags, while OpenOrbis' libc speaks FreeBSD's: a dirent name at offset 8 (musl
// reads 19, so `index-DCvBpG7G.css` arrived as `G7G.css`), a 32-bit dev/ino stat, BSD open flags.
// e5-build.sh points only the Rust archives at these (objcopy --redefine-syms); C/C++ keep libc's.
struct TnMuslDirent { uint64_t ino; int64_t off; uint16_t reclen; uint8_t type; char name[256]; };
static_assert(offsetof(TnMuslDirent, name) == 19, "musl x86_64 dirent");
void* tn_musl_readdir(DIR* dir) {
    static thread_local TnMuslDirent out;
    const dirent* entry = readdir(dir);
    if (entry == nullptr) return nullptr;
    uint32_t fileno;  // <dirent.h> #defines d_fileno to a d_ino the struct does not have: read offset 0
    memcpy(&fileno, entry, sizeof fileno);
    out.ino = fileno;
    out.off = 0;
    out.reclen = sizeof out;
    out.type = entry->d_type;
    const size_t length = entry->d_namlen < sizeof out.name - 1 ? entry->d_namlen : sizeof out.name - 1;
    memcpy(out.name, entry->d_name, length);
    out.name[length] = '\0';
    return &out;
}
struct TnMuslStat {
    uint64_t dev, ino, nlink;
    uint32_t mode, uid, gid, pad0;
    uint64_t rdev;
    int64_t size, blksize, blocks;
    timespec atim, mtim, ctim;
    int64_t unused[3];
};
static_assert(sizeof(TnMuslStat) == 144, "musl x86_64 stat");
static int tnMuslStat(int result, const struct stat& in, TnMuslStat* out) {
    if (result != 0) return result;
    *out = TnMuslStat{};
    out->dev = in.st_dev; out->ino = in.st_ino; out->nlink = in.st_nlink;
    out->mode = in.st_mode; out->uid = in.st_uid; out->gid = in.st_gid;
    out->rdev = in.st_rdev; out->size = in.st_size; out->blksize = in.st_blksize; out->blocks = in.st_blocks;
    out->atim = in.st_atim; out->mtim = in.st_mtim; out->ctim = in.st_ctim;
    return 0;
}
int tn_musl_stat(const char* path, TnMuslStat* out) { struct stat in; return tnMuslStat(stat(path, &in), in, out); }
int tn_musl_lstat(const char* path, TnMuslStat* out) { struct stat in; return tnMuslStat(lstat(path, &in), in, out); }
int tn_musl_fstat(int fd, TnMuslStat* out) { struct stat in; return tnMuslStat(fstat(fd, &in), in, out); }
static int tnMuslFlags(int linux) {
    int flags = linux & 3;  // O_RDONLY / O_WRONLY / O_RDWR agree
    if (linux & 0x40) flags |= O_CREAT;
    if (linux & 0x80) flags |= O_EXCL;
    if (linux & 0x200) flags |= O_TRUNC;
    if (linux & 0x400) flags |= O_APPEND;
    if (linux & 0x800) flags |= O_NONBLOCK;
    if (linux & 0x10000) flags |= O_DIRECTORY;
    if (linux & 0x20000) flags |= O_NOFOLLOW;
    if (linux & 0x80000) flags |= O_CLOEXEC;
    return flags;
}
int tn_musl_open(const char* path, int flags, unsigned mode) { return open(path, tnMuslFlags(flags), mode); }
int tn_musl_openat(int dir, const char* path, int flags, unsigned mode) {
    return openat(dir == -100 ? AT_FDCWD : dir, path, tnMuslFlags(flags), mode);  // Linux AT_FDCWD is -100
}
}  // extern "C"
