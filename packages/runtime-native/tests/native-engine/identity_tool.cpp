// The artifact identity manifest (PRD-530): a packager writes it beside the binary, startup checks it.
//   tn-native-engine-identity --write <file> [--revision R] [--compiler C] [--backend B]
//   tn-native-engine-identity --check <file>     exit 0 when it matches this engine, 1 with the refusal
#include "engine/abi/identity.h"

#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

int main(int argc, char** argv) {
    tn::abi::IdentityExtras extras;
    std::string write, check;
    for (int i = 1; i + 1 < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--write") write = argv[++i];
        else if (a == "--check") check = argv[++i];
        else if (a == "--revision") extras.engineRevision = argv[++i];
        else if (a == "--compiler") extras.compiler = argv[++i];
        else if (a == "--backend") extras.gpuBackend = argv[++i];
    }
    if (!write.empty()) {
        std::ofstream(write) << tn::abi::writeIdentity(extras);
        return 0;
    }
    if (check.empty()) return std::fprintf(stderr, "usage: --write <file> | --check <file>\n"), 2;
    std::ifstream in(check);
    if (!in) return std::fprintf(stderr, "TN_ARTIFACT_IDENTITY_MISSING: %s\n", check.c_str()), 1;
    std::stringstream text;
    text << in.rdbuf();
    const std::string refusal = tn::abi::checkIdentity(text.str());
    if (!refusal.empty()) return std::fprintf(stderr, "%s\n", refusal.c_str()), 1;
    std::puts("TN_ARTIFACT_IDENTITY_OK");
    return 0;
}
