// Transcribed once by Three.js's own GLSL to TSL transpiler from tools/tempest-bloom.frag, and maintained
// here by hand since: `tools/generate-shaders.mjs` regenerates only the coast and cloud shaders.
// Keep the .frag in step when you change this file.
//
// The demo's exact bloom: a 5x5 gaussian at twice the input texel size, masked by a soft-knee
// luminance threshold and normalised by the weight it actually accumulated — not by 25, so the
// frame's corners, where the kernel hangs off the target, cannot dim. Rendered at quarter
// resolution: see src/render/postprocessing.ts.
import { DataTexture, Vector2, Vector3, Vector4 } from "three";
import {
  Fn,
  Loop,
  exp,
  float,
  frameGroup,
  int,
  max,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";

// Uniforms the shader reads. Values are assigned by src/render/world.ts and src/render/clouds.ts,
// which own the camera basis and the weather; the generated module only holds the nodes.
const uScenePlaceholder = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
uScenePlaceholder.needsUpdate = true;
export let uScene: TextureNode = texture(uScenePlaceholder).setGroup(frameGroup);
export function setScene(value: TextureNode): void {
  uScene = value;
}
export const uRes = uniform(new Vector2(), "vec2").setGroup(frameGroup);

// Three.js Transpiler r185

export const tempestBloom = /*@__PURE__*/ Fn(([vUv]: [Node<"vec2">]) => {
  const c = vec3(0).toVar();
  const w = float(0).toVar();

  Loop(
    { start: int(-2), end: int(2), condition: "<=" },
    { start: int(-2), end: int(2), condition: "<=" },
    ({ i, j }) => {
      const wt = exp(
        float(j.mul(j).add(i.mul(i)))
          .negate()
          .mul(0.32),
      ).toVar();
      // `vUv` is the bloom quad's own geometry uv, bottom-up; the scene it reads is a render target
      // whose first row is the top of the frame. Unflipped, every highlight blooms mirrored about
      // the horizon — the lamp's glow hung in the sky above it.
      const s = uScene
        .sample(vec2(vUv.x, vUv.y.oneMinus()).add(vec2(float(j), float(i)).div(uRes).mul(2)))
        .rgb.toVar();
      const l = max(s.r, max(s.g, s.b)).toVar();
      c.addAssign(s.mul(smoothstep(0.7, 1.6, l)).mul(wt));
      w.addAssign(wt);
    },
  );

  return vec4(c.div(w), 1);
});
