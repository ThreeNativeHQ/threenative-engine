// A standalone driver for the libFuzzer targets (PRD-515 phase 3) where the toolchain has no
// libFuzzer (gcc): every seed file runs as is, then a deterministic stream of mutations of the seeds
// — bit flips, byte overwrites with boundary values, truncations, duplicated and removed spans,
// splices of two seeds — for TN_FUZZ_ITERATIONS inputs (default 20000). The sanitizers come from
// the build (the ASan/UBSan lane); this driver only feeds the target and reports what ran.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <random>
#include <string>
#include <vector>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size);

namespace {

std::vector<uint8_t> readFile(const char* path) {
    std::ifstream in(path, std::ios::binary);
    return std::vector<uint8_t>(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

void mutate(std::vector<uint8_t>& input, const std::vector<std::vector<uint8_t>>& seeds, std::mt19937& rng) {
    const auto pick = [&](std::size_t n) { return n == 0 ? std::size_t{0} : std::size_t(rng() % n); };
    static const uint8_t kBoundary[] = {0x00, 0x01, 0x7f, 0x80, 0xff, 0xfe, 0x20, 0x22, 0x5b, 0x7b};
    switch (rng() % 6) {
        case 0: // flip one bit
            if (!input.empty()) input[pick(input.size())] ^= uint8_t(1u << (rng() % 8));
            break;
        case 1: // a boundary byte (and JSON's own punctuation)
            if (!input.empty()) input[pick(input.size())] = kBoundary[pick(sizeof kBoundary)];
            break;
        case 2: // truncate
            input.resize(pick(input.size() + 1));
            break;
        case 3: { // duplicate a span
            if (input.empty()) break;
            const std::size_t at = pick(input.size()), length = 1 + pick(std::min<std::size_t>(64, input.size() - at));
            input.insert(input.begin() + long(at), input.begin() + long(at), input.begin() + long(at + length));
            break;
        }
        case 4: { // remove a span
            if (input.empty()) break;
            const std::size_t at = pick(input.size()), length = 1 + pick(std::min<std::size_t>(64, input.size() - at));
            input.erase(input.begin() + long(at), input.begin() + long(at + length));
            break;
        }
        default: { // splice another seed's tail
            const std::vector<uint8_t>& other = seeds[pick(seeds.size())];
            if (other.empty()) break;
            const std::size_t cut = pick(input.size() + 1), from = pick(other.size());
            input.resize(cut);
            input.insert(input.end(), other.begin() + long(from), other.end());
            break;
        }
    }
}

} // namespace

int main(int argc, char** argv) {
    std::vector<std::vector<uint8_t>> seeds;
    for (int i = 1; i < argc; ++i) {
        seeds.push_back(readFile(argv[i]));
        if (seeds.back().empty()) {
            std::printf("FAIL: seed %s is missing or empty\n", argv[i]);
            return 1;
        }
    }
    if (seeds.empty()) {
        std::printf("FAIL: no seed files\n");
        return 1;
    }
    const char* budget = std::getenv("TN_FUZZ_ITERATIONS");
    const long iterations = budget ? std::strtol(budget, nullptr, 10) : 20000;
    std::mt19937 rng(0x7f4a7c15u);
    long inputs = 0;
    for (const auto& seed : seeds) {
        LLVMFuzzerTestOneInput(seed.data(), seed.size());
        ++inputs;
    }
    for (long i = 0; i < iterations; ++i) {
        std::vector<uint8_t> input = seeds[rng() % seeds.size()];
        for (unsigned n = 1 + rng() % 4; n > 0; --n) mutate(input, seeds, rng);
        LLVMFuzzerTestOneInput(input.data(), input.size());
        ++inputs;
    }
    std::printf("fuzz: %ld inputs from %zu seeds, no crash\nPASS\n", inputs, seeds.size());
    return 0;
}
