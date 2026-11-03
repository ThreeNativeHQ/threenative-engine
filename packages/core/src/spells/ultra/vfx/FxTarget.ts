// Ported from Ultra Elements src/vfx/FxTarget.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
import { Group, Vector4 } from "three";
import { U } from "./common.js";

// The half-res FX pass (PLAN 2.5 "FX target"): one MRT with one blend state for every soft
// translucent thing (media, volumes, glows, distortion), never sorted (weighted-blended OIT).
//  1. depth prepass: the FX depth buffer gets the FARTHEST full-res depth of each footprint, so
//     nothing in front of the background is rejected at silhouettes
//  2. the fx scene draws into (media, weight + distortion, emission)
//  3. composite at full res: nearest-depth upsample (a full-res pixel nearer than every FX tap
//     rejects FX, which kills halos at pillar edges), distortion with distortion-driven chromatic
//     aberration, the WBOIT resolve, emission, the void's negative shell, and debug views.
//
// Engine (ThreeNative's C++ engine over WebGPU) differences, each forced:
//  - a RenderTarget has one colour texture (no MRT) and materials blend only None/Normal/Additive
//    (no CustomBlending), so the three-attachment WBOIT accumulation cannot be built;
//  - an offscreen pass (PassNode) draws before the frame's scene pass, so the FX could not read this
//    frame's depth for the prepass, soft fades and the march end, and the post graph
//    (WorldEnvironment's baseColour) can composite textures but cannot draw meshes.
// So `scene` is a Group the game adds to its world scene: FX materials draw in the frame's transparent
// queue (back to front), read viewportDepthTexture() for the depth, and fxOut() writes the
// composite of each layer through NormalBlending (common.ts, FX_BLENDING). Upstream's half-res
// target only sets the volume step counts here (uFxResolution), as upstream's step rule reads it.
// Open: distortion + CA (wt.gb) and the void's invert shell need a material reading
// viewportSharedTexture(); the debug views are not ported.
export const DEBUG_VIEWS = {
  off: 0,
  overdraw: 1,
  emission: 2,
  media: 3,
  distortion: 4,
  "ground A": 5,
  "ground B": 6,
  particles: 7,
};

export class FxTarget {
  readonly scene = new Group(); // upstream's scenes.fx: add once to the world scene
  readonly params = { smokeOccludesGlow: 0.5, distortion: 1, ca: 0.35 };
  readonly invert = new Vector4();
  readonly ratio = { x: 2, y: 2 };

  constructor() {
    this.scene.name = "ultra-fx";
  }

  setSize(w: number, h: number, scale: number): void {
    const fw = Math.max(1, Math.ceil(w * scale));
    const fh = Math.max(1, Math.ceil(h * scale));
    this.ratio.x = w / fw;
    this.ratio.y = h / fh;
    U.uResolution.value.set(w, h);
    U.uFxResolution.value.set(fw, fh);
  }

  // upstream draws the fx scene and composites here; on the engine the frame's own draw does both,
  // so render() only publishes the composite parameters fxOut() reads
  render(): void {
    U.uFxParams.value.set(this.params.smokeOccludesGlow, this.params.distortion, this.params.ca, 0);
  }
}
