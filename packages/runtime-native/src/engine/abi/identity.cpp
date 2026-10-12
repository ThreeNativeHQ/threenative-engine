#include "engine/abi/identity.h"

#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <sstream>

#include "threenative/abi/tn_abi.h"

namespace tn::abi {

namespace {

const char* const kKeys[] = {"engine-revision", "engine-abi", "compatibility-contract", "scene", "shader-package",
                             "capability-count", "capability-digest", "compiler", "architecture", "gpu-backend"};

const char* diagnosticName(uint32_t code) {
    switch (code) {
        case TN_DIAG_ENGINE_ABI_MISMATCH: return "TN_DIAG_ENGINE_ABI_MISMATCH";
        case TN_DIAG_CONTRACT_MISMATCH: return "TN_DIAG_CONTRACT_MISMATCH";
        case TN_DIAG_SCENE_MISMATCH: return "TN_DIAG_SCENE_MISMATCH";
        case TN_DIAG_SHADER_PACKAGE_MISMATCH: return "TN_DIAG_SHADER_PACKAGE_MISMATCH";
        case TN_DIAG_CAPABILITY_MISMATCH: return "TN_DIAG_CAPABILITY_MISMATCH";
        default: return "TN_DIAG_UNKNOWN";
    }
}

bool number(const std::string& text, uint64_t& out, int base = 10) {
    if (text.empty()) return false;
    char* end = nullptr;
    out = std::strtoull(text.c_str(), &end, base);
    return end != nullptr && *end == '\0';
}

}  // namespace

std::string_view buildArchitecture() {
#if defined(__EMSCRIPTEN__)
    return "wasm32";
#elif defined(__x86_64__) || defined(_M_X64)
    return "x86_64";
#elif defined(__aarch64__) || defined(_M_ARM64)
    return "aarch64";
#else
    return "unknown";
#endif
}

std::string writeIdentity(const IdentityExtras& extras) {
    const tn_version_info_t v = tn_engine_version();
    char digest[19];
    std::snprintf(digest, sizeof digest, "0x%016" PRIx64, v.capability_digest);
    std::ostringstream out;
    out << "engine-revision " << (extras.engineRevision.empty() ? "unknown" : extras.engineRevision) << "\n"
        << "engine-abi " << v.engine_abi << "\n"
        << "compatibility-contract " << v.compatibility_contract << "\n"
        << "scene " << v.scene << "\n"
        << "shader-package " << v.shader_package << "\n"
        << "capability-count " << v.capability_count << "\n"
        << "capability-digest " << digest << "\n"
        << "compiler " << (extras.compiler.empty() ? "none" : extras.compiler) << "\n"
        << "architecture " << buildArchitecture() << "\n"
        << "gpu-backend " << (extras.gpuBackend.empty() ? "unknown" : extras.gpuBackend) << "\n";
    return out.str();
}

std::string checkIdentity(std::string_view manifest) {
    std::map<std::string, std::string> fields;
    std::istringstream lines{std::string(manifest)};
    std::string line;
    while (std::getline(lines, line)) {
        if (line.empty()) continue;
        const size_t space = line.find(' ');
        if (space == std::string::npos || space == 0 || space + 1 == line.size())
            return "TN_ARTIFACT_IDENTITY_MALFORMED: '" + line + "' is not 'key value'";
        const std::string key = line.substr(0, space);
        if (!fields.emplace(key, line.substr(space + 1)).second)
            return "TN_ARTIFACT_IDENTITY_MALFORMED: " + key + " appears twice";
    }
    for (const char* key : kKeys) {
        if (fields.find(key) == fields.end()) return std::string("TN_ARTIFACT_IDENTITY_MALFORMED: no ") + key;
    }
    uint64_t abi = 0, contract = 0, scene = 0, shader = 0, count = 0, digest = 0;
    const std::string& digestText = fields["capability-digest"];
    if (!number(fields["engine-abi"], abi) || !number(fields["compatibility-contract"], contract) ||
        !number(fields["scene"], scene) || !number(fields["shader-package"], shader) ||
        !number(fields["capability-count"], count) || digestText.rfind("0x", 0) != 0 ||
        !number(digestText.substr(2), digest, 16))
        return "TN_ARTIFACT_IDENTITY_MALFORMED: a version field is not a number";
    tn_version_info_t module{};
    module.engine_abi = static_cast<uint32_t>(abi);
    module.compatibility_contract = static_cast<uint32_t>(contract);
    module.scene = static_cast<uint32_t>(scene);
    module.shader_package = static_cast<uint32_t>(shader);
    module.capability_count = static_cast<uint32_t>(count);
    module.capability_digest = digest;
    tn_diagnostic_t diagnostic{nullptr, 0};
    if (tn_version_handshake(&module, nullptr, &diagnostic) != TN_OK) {
        const std::string refusal = std::string("TN_ARTIFACT_VERSION_MISMATCH: ") + diagnosticName(diagnostic.code) +
                                    (diagnostic.message ? std::string(" (") + diagnostic.message + ")" : "");
        tn_diagnostic_release(&diagnostic);
        return refusal;
    }
    tn_diagnostic_release(&diagnostic);
    if (fields["architecture"] != buildArchitecture())
        return "TN_ARTIFACT_ARCHITECTURE_MISMATCH: built for " + fields["architecture"] + ", running on " +
               std::string(buildArchitecture());
    return {};
}

}  // namespace tn::abi
