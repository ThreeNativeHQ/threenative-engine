#pragma once

#if defined(__ANDROID__)
#include <android/log.h>
#include <cstdio>
#include <string>
#include <thread>
#include <unistd.h>

namespace mystral::platform {

// stdout and stderr reach nothing on Android: no terminal owns them, so every iostream
// line — and every Rust panic message from wgpu-native, which is exactly how a native
// abort names itself — is lost before it is ever read. A process that dies on a panic
// therefore died silently (PRD-183). Pipe both streams into logcat; unbuffered stderr
// keeps the panic text ahead of the abort that follows it.
inline void redirectStdioToLogcat() {
    int pipeFds[2];
    if (::pipe(pipeFds) != 0) return;

    ::dup2(pipeFds[1], STDOUT_FILENO);
    ::dup2(pipeFds[1], STDERR_FILENO);
    ::close(pipeFds[1]);
    ::setvbuf(stdout, nullptr, _IONBF, 0);
    ::setvbuf(stderr, nullptr, _IONBF, 0);

    std::thread([readFd = pipeFds[0]] {
        char buffer[1024];
        std::string pending;
        ssize_t received;
        while ((received = ::read(readFd, buffer, sizeof(buffer))) > 0) {
            pending.append(buffer, static_cast<size_t>(received));
            // logcat has no stream concept: forward complete lines as they arrive, and the
            // trailing partial line only when more output follows.
            size_t newline = 0;
            size_t start = 0;
            while ((newline = pending.find('\n', start)) != std::string::npos) {
                // __android_log_write, not __android_log_print: the print formatter caps at
                // LOG_BUF_SIZE 1024 (1023 bytes), which truncated TN_FRAME_BUDGET windows.
                const std::string line(pending.data() + start, newline - start);
                __android_log_write(ANDROID_LOG_INFO, "MystralStdio", line.c_str());
                start = newline + 1;
            }
            pending.erase(0, start);
        }
    }).detach();
}

}  // namespace

#endif
