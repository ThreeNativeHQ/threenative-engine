// PRD-530: a strict artifact's identity manifest names what it was built against, and startup
// refuses one built against another engine ABI, contract, scene, shader package, capability set or
// architecture, and a manifest with a missing, repeated or unreadable key, each with its code.
#include "check.h"
#include "engine/abi/identity.h"

#include <string>

namespace {

std::string replaced(std::string text, const std::string& key, const std::string& value) {
    const size_t at = text.find(key + " ");
    const size_t end = text.find('\n', at);
    return text.replace(at, end - at, key + " " + value);
}

void identity() {
    const std::string manifest = tn::abi::writeIdentity({"abc123", "tslang v0.0-pre-alpha87", "dawn"});
    CHECK(manifest.find("engine-revision abc123\n") != std::string::npos);
    CHECK(manifest.find("compiler tslang v0.0-pre-alpha87\n") != std::string::npos);
    CHECK(manifest.find("gpu-backend dawn\n") != std::string::npos);
    CHECK(tn::abi::checkIdentity(manifest).empty());

    const auto refused = [&](const std::string& key, const std::string& value, const std::string& code) {
        const std::string refusal = tn::abi::checkIdentity(replaced(manifest, key, value));
        if (refusal.rfind(code, 0) != 0) std::fprintf(stderr, "%s=%s gave '%s'\n", key.c_str(), value.c_str(), refusal.c_str());
        return refusal.rfind(code, 0) == 0;
    };
    CHECK(refused("engine-abi", "999", "TN_ARTIFACT_VERSION_MISMATCH: TN_DIAG_ENGINE_ABI_MISMATCH"));
    CHECK(refused("compatibility-contract", "999", "TN_ARTIFACT_VERSION_MISMATCH: TN_DIAG_CONTRACT_MISMATCH"));
    CHECK(refused("scene", "999", "TN_ARTIFACT_VERSION_MISMATCH: TN_DIAG_SCENE_MISMATCH"));
    CHECK(refused("shader-package", "999", "TN_ARTIFACT_VERSION_MISMATCH: TN_DIAG_SHADER_PACKAGE_MISMATCH"));
    CHECK(refused("capability-digest", "0x0000000000000001", "TN_ARTIFACT_VERSION_MISMATCH: TN_DIAG_CAPABILITY_MISMATCH"));
    CHECK(refused("capability-count", "1", "TN_ARTIFACT_VERSION_MISMATCH: TN_DIAG_CAPABILITY_MISMATCH"));
    CHECK(refused("architecture", "sparc", "TN_ARTIFACT_ARCHITECTURE_MISMATCH"));
    CHECK(refused("engine-abi", "one", "TN_ARTIFACT_IDENTITY_MALFORMED"));
    CHECK(tn::abi::checkIdentity(replaced(manifest, "gpu-backend", "dawn") + "engine-abi 1\n").rfind("TN_ARTIFACT_IDENTITY_MALFORMED", 0) == 0);
    std::string missing = manifest;
    missing.erase(missing.find("compiler "), missing.find('\n', missing.find("compiler ")) + 1 - missing.find("compiler "));
    CHECK(tn::abi::checkIdentity(missing).rfind("TN_ARTIFACT_IDENTITY_MALFORMED: no compiler", 0) == 0);
    CHECK(tn::abi::checkIdentity("").rfind("TN_ARTIFACT_IDENTITY_MALFORMED", 0) == 0);
}

}  // namespace

TN_TEST_MAIN({"identity", identity})
