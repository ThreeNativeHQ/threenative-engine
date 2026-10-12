// libFuzzer target (PRD-504): random descriptors and operations against a BufferStore. Any read or
// write the validator accepts must stay inside the storage; ASan/UBSan judge every access.
#include "engine/foundation/buffers.h"

#include <cstdint>
#include <cstring>
#include <vector>

using namespace tn::engine;

namespace {
uint64_t take(const uint8_t*& data, size_t& size) {
    uint64_t value = 0;
    const size_t n = size < 8 ? size : 8;
    std::memcpy(&value, data, n);
    data += n;
    size -= n;
    return value;
}
}  // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    if (size < 2) return 0;
    const auto scalar = static_cast<Scalar>(data[0] % 8);
    BufferStore store(scalar, data[1] % 64);
    data += 2;
    size -= 2;
    std::vector<std::byte> scratch(4096);
    while (size > 0) {
        const uint8_t op = data[0] % 6;
        ++data;
        --size;
        const uint64_t a = take(data, size);
        const uint64_t b = take(data, size);
        switch (op) {
            case 0: store.validate(a, b, a ^ b); break;
            case 1: if (b <= scratch.size()) store.write(a, scratch.data(), b); break;
            case 2: if (b <= scratch.size()) store.read(a, scratch.data(), b); break;
            case 3: store.resize(a % 512); break;
            case 4: (a & 1) ? store.acquireLease() : store.releaseLease(); break;
            case 5: store.addUpdateRange(a, b); store.needsUpdate(); break;
        }
    }
    while (store.leaseCount() > 0) store.releaseLease();
    return 0;
}
