#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace tn::engine::graph {

/** What a transient target is; two transients share memory only when these are equal. */
struct TextureDesc {
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t format = 0;  // WGPUTextureFormat
    uint32_t usage = 0;   // WGPUTextureUsage
    bool operator==(const TextureDesc&) const = default;
};

using ResourceId = uint32_t;
using PassId = uint32_t;

enum class PassKind : uint8_t { Render, Compute };

struct Read {
    ResourceId resource;
    uint32_t expectedFormat = 0;  // 0 accepts any; otherwise a mismatch fails the build
};

struct Diagnostic {
    std::string code;  // TN_GRAPH_CYCLE | TN_GRAPH_MISSING_PRODUCER | TN_GRAPH_FORMAT
    std::string detail;
};

/**
 * One render invocation's pass graph (PRD-523), derived from native state each time: passes
 * declare what they read and write, the build orders them by dependency (declaration order breaks
 * ties), and transients with disjoint lifetimes share one physical allocation.
 */
class RenderGraph {
public:
    /** Lives only inside this invocation; its memory may be shared with another transient. */
    ResourceId transient(std::string name, TextureDesc desc);
    /** Produced outside the graph (the swapchain image, a history read, an uploaded texture). */
    ResourceId external(std::string name, TextureDesc desc);

    PassId pass(std::string name, PassKind kind, std::vector<Read> reads, std::vector<ResourceId> writes);

    struct Compiled {
        std::vector<PassId> order;
        std::vector<int32_t> physicalOf;  // per resource: physical slot, -1 for external
        uint32_t physicalCount = 0;
        std::vector<Diagnostic> errors;
        bool ok() const { return errors.empty(); }
    };
    Compiled compile() const;

    const std::string& resourceName(ResourceId id) const { return resources_[id].name; }
    const std::string& passName(PassId id) const { return passes_[id].name; }

private:
    struct Resource {
        std::string name;
        TextureDesc desc;
        bool external = false;
    };
    struct Pass {
        std::string name;
        PassKind kind;
        std::vector<Read> reads;
        std::vector<ResourceId> writes;
    };
    std::vector<Resource> resources_;
    std::vector<Pass> passes_;
};

}  // namespace tn::engine::graph
