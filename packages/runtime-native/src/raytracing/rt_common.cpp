/**
 * MystralNative Ray Tracing Backend Factory
 *
 * Provides the factory function to create the appropriate RT backend
 * based on platform capabilities.
 *
 * Backend selection order (Windows):
 * 1. DXR (DirectX 12 with ray tracing support)
 * 2. Vulkan RT (fallback if DXR not available)
 * 3. Stub (fallback when no hardware RT available)
 *
 * Backend selection order (macOS):
 * 1. Metal RT (Apple Silicon with macOS 13+/Metal 3)
 * 2. Vulkan RT (MoltenVK fallback)
 * 3. Stub (fallback when no hardware RT available)
 *
 * Backend selection order (Linux):
 * 1. Vulkan RT
 * 2. Stub (fallback when no hardware RT available)
 */

#include "rt_common.h"
#include <iostream>
#include <string>
#include <utility>

#ifdef MYSTRAL_HAS_DXR
#include "dxr_rt.h"
#endif

#ifdef MYSTRAL_HAS_VULKAN_RT
#include "vulkan_rt.h"
#endif

#ifdef MYSTRAL_HAS_METAL_RT
#include "metal_rt.h"
#endif

namespace mystral {
namespace rt {

// ============================================================================
// Stub Backend Implementation
// ============================================================================

/**
 * Stub RT backend for when no hardware RT is available.
 * All methods return error or no-op, isSupported() returns false.
 */
class StubRTBackend : public IRTBackend {
public:
    explicit StubRTBackend(std::string reason) : reason_(std::move(reason)) {
        // Silent construction - logging happens in isSupported() check
    }

    ~StubRTBackend() override = default;

    // ========================================================================
    // Capability Queries
    // ========================================================================

    bool isSupported() override {
        return false;
    }

    RTBackendType getBackendType() override {
        return RTBackendType::None;
    }

    const char* getBackend() override {
        return "none";
    }

    RTCapabilities capabilities() override {
        RTCapabilities found;
        found.reason = reason_;
        return found;
    }

    // ========================================================================
    // Geometry Management
    // ========================================================================

    RTGeometryHandle createGeometry(const RTGeometryDesc& desc) override {
        std::cerr << "[MystralRT] createGeometry: Hardware ray tracing not available" << std::endl;
        return RTGeometryHandle{};
    }

    void destroyGeometry(RTGeometryHandle geometry) override {
        // No-op for stub
    }

    // ========================================================================
    // Acceleration Structure Management
    // ========================================================================

    RTBLASHandle createBLAS(RTGeometryHandle* geometries, size_t count) override {
        std::cerr << "[MystralRT] createBLAS: Hardware ray tracing not available" << std::endl;
        return RTBLASHandle{};
    }

    void destroyBLAS(RTBLASHandle blas) override {
        // No-op for stub
    }

    RTTLASHandle createTLAS(const RTTLASInstance* instances, size_t count) override {
        std::cerr << "[MystralRT] createTLAS: Hardware ray tracing not available" << std::endl;
        return RTTLASHandle{};
    }

    void updateTLAS(RTTLASHandle tlas, const RTTLASInstance* instances, size_t count) override {
        std::cerr << "[MystralRT] updateTLAS: Hardware ray tracing not available" << std::endl;
    }

    void destroyTLAS(RTTLASHandle tlas) override {
        // No-op for stub
    }

    // ========================================================================
    // Ray Tracing Execution
    // ========================================================================

    void traceRays(const TraceRaysOptions& options) override {
        std::cerr << "[MystralRT] traceRays: Hardware ray tracing not available" << std::endl;
    }

private:
    std::string reason_;
};

// ============================================================================
// Factory Implementation
// ============================================================================

std::unique_ptr<IRTBackend> createRTBackend() {
    // Why each backend that was tried gave up, so the stub can say so instead of staying silent
    std::string reasons;

    // Try platform-specific backends in order of preference

#ifdef MYSTRAL_HAS_DXR
    // Try DXR backend first on Windows (native D3D12 ray tracing)
    {
        auto dxr = std::make_unique<DXRBackend>();
        if (dxr->initialize()) {
            std::cout << "[MystralRT] Using DXR backend" << std::endl;
            return dxr;
        }
        std::cout << "[MystralRT] DXR initialization failed, trying Vulkan RT..." << std::endl;
    }
#endif

#ifdef MYSTRAL_HAS_VULKAN_RT
    // Try Vulkan RT backend (cross-platform)
    {
        auto vulkan = std::make_unique<VulkanRTBackend>();
        if (vulkan->initialize()) {
            std::cout << "[MystralRT] Using Vulkan RT backend" << std::endl;
            return vulkan;
        }
        std::cout << "[MystralRT] Vulkan RT initialization failed, trying fallback..." << std::endl;
        reasons += std::string(reasons.empty() ? "" : "; ") + "vulkan: " + vulkan->initError();
    }
#endif

#ifdef MYSTRAL_HAS_METAL_RT
    // Try Metal RT backend (Apple Silicon with macOS 13+)
    {
        auto metal = std::make_unique<MetalRTBackend>();
        if (metal->initialize()) {
            std::cout << "[MystralRT] Using Metal RT backend" << std::endl;
            return metal;
        }
        std::cout << "[MystralRT] Metal RT initialization failed, trying fallback..." << std::endl;
    }
#endif

    // Fallback to stub backend
    std::cout << "[MystralRT] No hardware RT available, using stub backend" << std::endl;
    if (reasons.empty()) {
        reasons = "no ray tracing backend is compiled into this build (TN_ENABLE_RAYTRACING is OFF)";
    }
    return std::make_unique<StubRTBackend>(reasons);
}

}  // namespace rt
}  // namespace mystral
