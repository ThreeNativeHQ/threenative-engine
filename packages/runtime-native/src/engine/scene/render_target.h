#pragma once

// three r185's RenderTarget (src/core/RenderTarget.js): a size and the colour texture a render draws
// into and a material samples. This layer holds only that state; the renderer keeps what it builds
// for the target in `gpu` (renderer/render_target_pass.h), so the bindings never depend on it.

#include "engine/scene/event.h"
#include "engine/scene/texture.h"

#include <algorithm>
#include <cstdint>
#include <memory>
#include <vector>

namespace tn::engine {

class RenderTarget : public std::enable_shared_from_this<RenderTarget>, public EventDispatcher {
public:
    /**
     * `type` is three's texture type constant (UnsignedByteType, HalfFloatType, FloatType). `count` is three's
     * MRT texture count (`textures`, the first is `texture`); `depth` above 1 makes each an array of that many
     * layers, which a draw takes one at a time (three's `setRenderTarget(target, layer)`).
     */
    static std::shared_ptr<RenderTarget> make(uint32_t width, uint32_t height, uint16_t type, uint32_t count = 1,
                                              uint32_t depth = 1) {
        auto target = std::shared_ptr<RenderTarget>(new RenderTarget());
        target->depth = std::max<uint32_t>(depth, 1);
        for (uint32_t i = 0; i < std::max<uint32_t>(count, 1); ++i) {
            auto texture = i == 0 ? target->texture : std::make_shared<Texture>();
            texture->type = type;
            texture->minFilter = static_cast<uint16_t>(TextureFilter::Linear);
            texture->flipY = false;  // three's render target textures are not flipped
            texture->generateMipmaps = false;
            texture->array = target->depth > 1;
            texture->depth = target->depth;
            texture->renderTarget = std::weak_ptr<void>(target);
            if (i > 0) target->textures.push_back(std::move(texture));
        }
        target->setSize(width, height);
        return target;
    }

    /** three's setSize: the next render draws at the new extent (zero clamps to 1). */
    void setSize(uint32_t w, uint32_t h) {
        width = std::max<uint32_t>(w, 1);
        height = std::max<uint32_t>(h, 1);
        for (const auto& each : textures) {
            each->width = width;
            each->height = height;
        }
        if (depthTexture && (depthTexture->width != width || depthTexture->height != height)) {
            depthTexture->width = width; depthTexture->height = height; depthTexture->needsUpdate();
        }
    }
    /**
     * three's dispose: the GPU state goes, the target can render again and rebuilds it, and `dispose`
     * is dispatched on the target (then each texture's own `dispose`, as three does).
     */
    void dispose() {
        gpu.reset();
        Event event{"dispose"};
        dispatchEvent(event);
        for (const auto& each : textures) each->dispose();
    }
    /** The index of `sampled` in `textures` (three's MRT attachment), or -1 when the target does not own it. */
    int attachmentOf(const Texture& sampled) const {
        for (std::size_t i = 0; i < textures.size(); ++i)
            if (textures[i].get() == &sampled) return int(i);
        return -1;
    }
    /** True when a draw writes array layers or more than one attachment, not the one scene colour (render_target_pass.cpp). */
    bool layered() const { return depth > 1 || textures.size() > 1; }

    uint32_t width = 1, height = 1;
    std::shared_ptr<Texture> depthTexture;
    /** Array layers of each texture (three's `depth`); 1 is a plain 2D target. */
    uint32_t depth = 1;
    /** A layered target's textures carry a full mip chain: three allocates one at initRenderTarget for a texture made
     *  with `generateMipmaps`, and keeps it while a caller turns generation off for the draws before the last. */
    bool mipmapChain = false;
    std::shared_ptr<Texture> texture = std::make_shared<Texture>();
    /** three's `textures`: `texture` first, then one per further MRT attachment. */
    std::vector<std::shared_ptr<Texture>> textures{texture};
    /** The renderer's state for this target (its own renderer and render database); empty until drawn. */
    std::shared_ptr<void> gpu;
    /** True when this FloatType target is stored as half float because the device lacks float32-blendable; set when the target first draws. */
    bool halfPrecision = false;

private:
    RenderTarget() = default;
};

}  // namespace tn::engine
