// libFuzzer target (PRD-515 phase 3): arbitrary bytes through the TNPK reader and the hash gate.
#include "engine/assets/package.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    using namespace tn::engine::assets;
    Package package;
    PackageError error;
    if (parsePackage({data, size}, package, error)) {
        verifyPackage(package, ~0u, error);
        for (const PackageEntry& e : package.entries) {
            const auto bytes = package.data(e);
            volatile uint8_t sink = bytes.empty() ? 0 : bytes.back();
            (void)sink;
        }
    }
    return 0;
}
