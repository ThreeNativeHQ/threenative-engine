// PRD-784 E5: the two C++ runtime entry points libc++.a and libc++abi.a leave for the libc on PS4,
// linked into the engine player's guest (scripts/ps4/e5-build.sh).
//
// OpenOrbis' libc is musl-derived over libkernel and ships neither, but Dawn's own objects and
// libc++'s thread_local support reach for them: without these two, ld.lld reports them undefined
// and nothing links. e3-triangle.cc carries the same pair for the bare Dawn guest; this is the
// engine player's copy (the E3 lane is a scratch experiment and is not edited from here).
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
}  // extern "C"
