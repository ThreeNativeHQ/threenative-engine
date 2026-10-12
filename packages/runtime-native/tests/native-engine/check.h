#pragma once

#include <cstdio>
#include <cstring>

// The engine tests' whole harness: a failed CHECK prints its line and fails the case.
inline int tn_check_failures = 0;
#define CHECK(condition)                                                                   \
    do {                                                                                   \
        if (!(condition)) {                                                                \
            std::fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #condition); \
            ++tn_check_failures;                                                           \
        }                                                                                  \
    } while (0)

// Runs the case named by argv[1]; an unknown or missing name fails, so ctest cannot pass a typo.
#define TN_TEST_MAIN(...)                                                                  \
    int main(int argc, char** argv) {                                                      \
        struct Case { const char* name; void (*run)(); };                                  \
        const Case cases[] = {__VA_ARGS__};                                                \
        if (argc < 2) return std::fprintf(stderr, "usage: %s <case>\n", argv[0]), 2;      \
        for (const Case& c : cases) {                                                      \
            if (std::strcmp(c.name, argv[1]) != 0) continue;                               \
            c.run();                                                                       \
            if (tn_check_failures == 0) std::printf("PASS %s\n", c.name);                 \
            return tn_check_failures == 0 ? 0 : 1;                                         \
        }                                                                                  \
        return std::fprintf(stderr, "unknown case %s\n", argv[1]), 2;                      \
    }
