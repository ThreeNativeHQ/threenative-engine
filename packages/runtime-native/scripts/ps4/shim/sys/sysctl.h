// FreeBSD names its process-pathname query in <sys/sysctl.h>: SDL3's SDL_SYS_GetBasePath asks it
// where the executable lives. The OpenOrbis sysroot has neither that header nor a sysctl() in
// libc.a (it is a musl-style libc over libkernel), so this declares the one FreeBSD call and the
// three MIB names that source uses. A guest that never asks gets no code: the call is only reached
// from SDL_SYS_GetBasePath, and a member of a static archive is linked only when something
// references it. If the call is ever reached it returns -1, which SDL already treats as "no answer,
// try the next branch".
#ifndef PS4_SHIM_SYS_SYSCTL_H_
#define PS4_SHIM_SYS_SYSCTL_H_

#include <sys/types.h>

#define CTL_KERN 1            /* FreeBSD sys/sysctl.h */
#define KERN_PROC 14          /* FreeBSD sys/sysctl.h: process entries */
#define KERN_PROC_PATHNAME 5  /* FreeBSD sys/sysctl.h: the executable's own path */

#ifdef __cplusplus
extern "C" {
#endif
int sysctl(int* name, u_int namelen, void* oldp, size_t* oldlenp, const void* newp, size_t newlen);
#ifdef __cplusplus
}
#endif

#endif  // PS4_SHIM_SYS_SYSCTL_H_
