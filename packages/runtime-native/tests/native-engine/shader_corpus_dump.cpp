// Writes the shader corpus as WGSL files so an offline validator (Tint, naga) can judge them with
// no GPU or host. shader_emit_test.cpp does the same through a live device, which the CPU-only core
// build does not have. Also fails when two emissions of one program differ.
#include "engine/shader/wgsl.h"
#include "shader_corpus.h"

#include <cstdio>
#include <fstream>
#include <string>

using namespace tn::engine::shader;

int main(int argc, char** argv) {
    if (argc < 2) return std::fprintf(stderr, "usage: %s <output directory>\n", argv[0]), 2;
    for (const auto& [name, build] : corpus::all()) {
        const WgslModule module = WgslEmitter::emit(build());
        if (!module.ok() || module.code != WgslEmitter::emit(build()).code) {
            std::fprintf(stderr, "%s: emission failed or is not stable\n", name);
            return 1;
        }
        std::ofstream(std::string(argv[1]) + "/" + name + ".wgsl") << module.code;
    }
    return 0;
}
