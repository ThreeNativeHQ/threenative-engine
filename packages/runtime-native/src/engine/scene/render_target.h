#pragma once

// three r185's RenderTarget (src/core/RenderTarget.js): a size and the colour texture a render draws
// into and a material samples. This layer holds only that state; the renderer keeps what it builds
// for the target in `gpu` (renderer/render_target_pass.h), so the bindings never depend on it.
// A target made with `count` > 1 (three's MRT) holds one more target per extra colour texture.

#include "engine/scene/event.h"
#include "engine/scene/texture.h"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <vector>

namespace tn::engine {

class RenderTarget : public std::enable_shared_from_this<RenderTarget>, public EventDispatcher {
public:
    /** `type` is three's texture type constant (UnsignedByteType, HalfFloatType, FloatType). */
    static std::shared_ptr<RenderTarget> make(uint32_t width, uint32_t height, uint16_t type) {
        auto target = std::shared_ptr<RenderTarget>(new RenderTarget());
        target->texture->type = type;
        target->texture->minFilter = static_cast<uint16_t>(TextureFilter::Linear);
        target->texture->flipY = false;  // three's render target textures are not flipped
        target->texture->generateMipmaps = false;
        target->setSize(width, height);
        target->texture->renderTarget = std::weak_ptr<void>(target);
        return target;
    }
    /** three's `new RenderTarget(w, h, { count })`: textures[0] is `texture`, textures[i] is more[i - 1]'s. */
    static std::shared_ptr<RenderTarget> make(uint32_t width, uint32_t height, uint16_t type, uint32_t count) {
        auto target = make(width, height, type);
        for (uint32_t i = 1; i < count; ++i) target->more.push_back(make(width, height, type));
        return target;
    }

    /** three's `textures`: `texture`, then each MRT attachment's. */
    static std::vector<std::shared_ptr<Texture>> texturesOf(const RenderTarget& target) {
        std::vector<std::shared_ptr<Texture>> out{target.texture};
        for (const auto& attachment : target.more) out.push_back(attachment->texture);
        return out;
    }

    /** three's setSize: the next render draws at the new extent (zero clamps to 1). */
    void setSize(uint32_t w, uint32_t h) {
        width = std::max<uint32_t>(w, 1);
        height = std::max<uint32_t>(h, 1);
        texture->width = width;
        texture->height = height;
        for (const auto& attachment : more) attachment->setSize(w, h);
        if (depthTexture && (depthTexture->width != width || depthTexture->height != height)) {
            depthTexture->width = width; depthTexture->height = height; depthTexture->needsUpdate();
        }
    }
    /**
     * three's dispose: the GPU state goes, the target can render again and rebuilds it, and `dispose`
     * is dispatched on the target (then its texture's own `dispose`, as three does), as is every
     * further attachment's.
     */
    void dispose() {
        gpu.reset();
        Event event{"dispose"};
        dispatchEvent(event);
        if (texture) texture->dispose();
        for (const auto& attachment : more) attachment->dispose();
    }

    uint32_t width = 1, height = 1;
    std::shared_ptr<Texture> depthTexture;
    std::shared_ptr<Texture> texture = std::make_shared<Texture>();
    /** The MRT colour attachments after the first, each a target of its own (render_target_pass.cpp draws each). */
    std::vector<std::shared_ptr<RenderTarget>> more;
    /**
     * three's `depth` option: an array target of this many layers, each its own 2D image. A draw names the layer it
     * writes (setRenderTarget(target, layer)), and a material samples every layer through `texture.depth(layer)`.
     */
    uint32_t layers = 1;
    /** The renderer's state for this target (its own renderer and render database); empty until drawn. */
    std::shared_ptr<void> gpu;
    /** True when this FloatType target is stored as half float because the device lacks float32-blendable; set when the target first draws. */
    bool halfPrecision = false;

private:
    RenderTarget() = default;
};

}  // namespace tn::engine
