/**
 * MystralNative Ray Tracing JavaScript Bindings
 *
 * Declares the initialization function for the mystralRT global object.
 * The mystralRT object exposes hardware ray tracing capabilities to JS.
 */

#pragma once

namespace mystral {
namespace js {
class Engine;
}

namespace rt {

/**
 * Initialize ray tracing JavaScript bindings.
 * Creates the mystralRT global object with the following methods:
 *
 * - mystralRT.isSupported(): boolean
 * - mystralRT.getBackend(): string ("dxr", "vulkan", "metal", or "none")
 * - mystralRT.capabilities(): { backend, device, rayBatch, imageOutput, reason, ... }
 * - mystralRT.traceRayBatch({ tlas, rays, hits, rayCount? }): { rayCount, gpuMs, totalMs }
 * - mystralRT.createGeometry(options): RTGeometry
 * - mystralRT.createBLAS(geometries): RTBLAS
 * - mystralRT.createTLAS(instances): RTTLAS
 * - mystralRT.updateTLAS(tlas, instances): void
 * - mystralRT.traceRays(options): void
 * - mystralRT.destroyBLAS(blas): void
 * - mystralRT.destroyTLAS(tlas): void
 *
 * The hardware backend starts on first use of any method that needs it, not here.
 *
 * @param engine The JavaScript engine to register bindings on
 * @return true on success, false on error
 */
bool initializeRTBindings(js::Engine* engine);

/**
 * Clean up ray tracing resources.
 * Should be called during runtime shutdown.
 */
void cleanupRTBindings();

}  // namespace rt
}  // namespace mystral
