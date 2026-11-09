// PRD-784 E1: the smallest PS4 program that proves the toolchain links and shadPS4 boots it.
// Prints one marker line through libc's printf (guest stdout) and through the libkernel debug
// channel, then idles so the emulator keeps running while the runner reads its log.
#include <stdio.h>
#include <orbis/libkernel.h>

#define E1_MARKER "TN_PS4_E1_MARKER hello"

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);
	printf(E1_MARKER "\n");
	sceKernelDebugOutText(0, E1_MARKER "\n");
	for (;;)
		sceKernelUsleep(1000000);
	return 0;
}
