#pragma once

// A game's RenderTarget (scene/render_target.h) drawn and read by the renderer: the target keeps its
// own renderer on the main renderer's device (Renderer::sibling) and its own render database, as a
// reflector pass does. A render into it draws the linear HDR scene colour, before post and the output
// transform (no tone mapping, no colour-space conversion), which is what three r185 writes into a
// render target, and that colour is what a material sampling `target.texture` reads.

#include "engine/renderer/renderer.h"
#include "engine/scene/render_target.h"

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace tn::engine {

class Camera;
class Object3D;

/**
 * Draws `root` (a Scene or any Object3D) through `camera` into `target`, clearing to `clear`, with
 * shadow maps when `shadowMap` (three's renderer.shadowMap.enabled). Returns what the target's render
 * refused or skipped by name (empty when it drew).
 */
std::vector<std::string> renderToTarget(Renderer& main, RenderTarget& target, Object3D& root, Camera& camera,
                                        std::array<double, 4> clear, bool shadowMap);

/** The colour view a material samples for `target`, drawing an empty frame first if it never rendered. */
WGPUTextureView renderTargetView(Renderer& main, RenderTarget& target);

/**
 * The region [x, y, width, height] of the target's last render, as tightly packed RGBA16Float rows
 * (8 bytes a pixel, top row first), delivered from poll(). OutOfRange for a region outside the
 * target, InvalidHandle for a target that never rendered.
 */
GpuStatus readRenderTarget(RenderTarget& target, uint32_t x, uint32_t y, uint32_t width, uint32_t height,
                           ReadbackCallback done);

}  // namespace tn::engine
