#pragma once

#include <cstddef>
#include <cstdint>

namespace mystral {
namespace host {

/** The finished frame a capture source copied out, as the GPU context maps it. */
struct FrameCaptureView {
    void* buffer = nullptr;  // WGPUBuffer
    size_t size = 0;
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t bytesPerRow = 0;
    uint32_t format = 0;  // WGPUTextureFormat
};

/**
 * Whoever records frames (today the scripting bindings) implements this; the GPU context only
 * reads it, so the context links with no scripting state.
 */
class IFrameCaptureSource {
public:
    virtual ~IFrameCaptureSource() = default;
    virtual void request() = 0;
    virtual bool ready() const = 0;
    virtual void clearReady() = 0;
    virtual FrameCaptureView view() const = 0;
};

}  // namespace host
}  // namespace mystral
