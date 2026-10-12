#pragma once

// three r185's RenderTarget (src/core/RenderTarget.js): a size and the colour texture a render draws
// into and a material samples. This layer holds only that state; the renderer keeps what it builds
// for the target in `gpu` (renderer/render_target_pass.h), so the bindings never depend on it.

#include "engine/scene/texture.h"

#include <algorithm>
#include <cstdint>
#include <memory>

namespace tn::engine {

class RenderTarget : public std::enable_shared_from_this<RenderTarget> {
public:
    /** `type` is three's texture type constant (UnsignedByteType, HalfFloatType, FloatType). */
    static std::shared_ptr<RenderTarget> make(uint32_t width, uint32_t height, uint16_t type) {
        auto target = std::shared_ptr<RenderTarget>(new RenderTarget());
        target->texture->type = type;
        target->texture->flipY = false;  // three's render target textures are not flipped
        target->texture->generateMipmaps = false;
        target->setSize(width, height);
        target->texture->renderTarget = std::weak_ptr<void>(target);
        return target;
    }

    /** three's setSize: the next render draws at the new extent (zero clamps to 1). */
    void setSize(uint32_t w, uint32_t h) {
        width = std::max<uint32_t>(w, 1);
        height = std::max<uint32_t>(h, 1);
        texture->width = width;
        texture->height = height;
    }
    /** three's dispose: the GPU state goes; the target can render again and rebuilds it. */
    void dispose() { gpu.reset(); }

    uint32_t width = 1, height = 1;
    std::shared_ptr<Texture> texture = std::make_shared<Texture>();
    /** The renderer's state for this target (its own renderer and render database); empty until drawn. */
    std::shared_ptr<void> gpu;

private:
    RenderTarget() = default;
};

}  // namespace tn::engine
