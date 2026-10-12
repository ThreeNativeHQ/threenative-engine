#pragma once

#include <string>
#include <string_view>

namespace tn::abi {

/**
 * The artifact identity manifest (PRD-530, section 13): what an artifact was built against, written
 * by the packager beside the binary and checked at startup before any game code runs. One `key value`
 * per line, so startup needs no JSON parser:
 *
 *   engine-revision <source revision>     engine-abi <n>     compatibility-contract <n>
 *   scene <n>     shader-package <n>     capability-count <n>     capability-digest 0x<16 hex>
 *   compiler <identity, or none>     architecture <x86_64 | aarch64 | wasm32 | ...>
 *   gpu-backend <dawn | wgpu | browser>
 */
struct IdentityExtras {
    std::string engineRevision;  // the source revision the engine was built from
    std::string compiler = "none";  // the AOT compiler and runtime for a native game module
    std::string gpuBackend;
};

/** The manifest of an artifact built against this engine. */
std::string writeIdentity(const IdentityExtras& extras);

/** This build's architecture, as the manifest names it. */
std::string_view buildArchitecture();

/**
 * Empty when `manifest` matches this engine; otherwise the refusal, starting with its code:
 * TN_ARTIFACT_IDENTITY_MALFORMED (a missing, repeated or unreadable key), TN_ARTIFACT_VERSION_MISMATCH
 * with the handshake's TN_DIAG_* name (engine ABI, contract, scene, shader package or capabilities),
 * or TN_ARTIFACT_ARCHITECTURE_MISMATCH.
 */
std::string checkIdentity(std::string_view manifest);

}  // namespace tn::abi
