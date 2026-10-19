// Transcribed once by Three.js's own GLSL to TSL transpiler from tools/tempest-post.frag, and maintained
// here by hand since: `tools/generate-shaders.mjs` regenerates only the coast and cloud shaders.
// Keep the .frag in step when you change this file.
//
// The demo's filmic half in one pass: twelve animated refractive beads near the lens edges, a
// five-tap luma-edge antialias over the warped coordinate, the bloom added, the weather exposure,
// the ACES fit, the cool-shadow/warm-highlight grade, the vignette, gamma 1/2.2 and the dither.
// Nothing here is a framework default; every constant is the demo's.
import { DataTexture, Vector2, Vector3, Vector4 } from "three";
import {
  Continue,
  Fn,
  If,
  Loop,
  abs,
  add,
  clamp,
  depth,
  div,
  dot,
  exp,
  float,
  floor,
  fract,
  frameGroup,
  int,
  length,
  max,
  min,
  mul,
  pow,
  screenCoordinate,
  select,
  sin,
  smoothstep,
  sub,
  texture,
  uniform,
  uv,
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
const uBloomPlaceholder = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
uBloomPlaceholder.needsUpdate = true;
export let uBloom: TextureNode = texture(uBloomPlaceholder).setGroup(frameGroup);
export function setBloom(value: TextureNode): void {
  uBloom = value;
}
export const uRes = uniform(new Vector2(), "vec2").setGroup(frameGroup);
export const uTime = uniform(0, "float").setGroup(frameGroup);
export const uExposure = uniform(0, "float").setGroup(frameGroup);
export const uRain = uniform(0, "float").setGroup(frameGroup);
export const uLens = uniform(0, "float").setGroup(frameGroup);

// Three.js Transpiler r185

// Polyfills

const gl_FragCoord = vec3(screenCoordinate.x, screenCoordinate.y.oneMinus(), depth);

export const hash = /*@__PURE__*/ Fn(([p]: [Node<"vec2">]) => {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453123));
});

export const aces = /*@__PURE__*/ Fn(([x]: [Node<"vec3">]) => {
  return clamp(x.mul(mul(2.51, x).add(0.03)).div(x.mul(mul(2.43, x).add(0.59)).add(0.14)), 0, 1);
});

export const antialias = /*@__PURE__*/ Fn(([uv]: [Node<"vec2">]) => {
  const px = div(1, uRes).toVar();
  const m = uScene.sample(uv).rgb.toVar();
  const nw = uScene.sample(uv.add(vec2(-1, -1).mul(px))).rgb.toVar();
  const ne = uScene.sample(uv.add(vec2(1, -1).mul(px))).rgb.toVar();
  const sw = uScene.sample(uv.add(vec2(-1, 1).mul(px))).rgb.toVar();
  const se = uScene.sample(uv.add(vec2(1, 1).mul(px))).rgb.toVar();
  const lum = vec3(0.299, 0.587, 0.114).toVar();
  const l0 = dot(m, lum).toVar();
  const l1 = dot(nw, lum).toVar();
  const l2 = dot(ne, lum).toVar();
  const l3 = dot(sw, lum).toVar();
  const l4 = dot(se, lum).toVar();
  const dir = vec2(l1.add(l2).sub(l3.add(l4)).negate(), l1.add(l3).sub(l2.add(l4))).toVar();
  const reduce = max(l1.add(l2).add(l3).add(l4).mul(0.03125), 0.0078125).toVar();
  const rcp = div(1, min(abs(dir.x), abs(dir.y)).add(reduce)).toVar();
  dir.assign(clamp(dir.mul(rcp), vec2(-6), vec2(6)).mul(px));
  const a = mul(
    0.5,
    uScene.sample(uv.add(dir.mul(-0.166667))).rgb.add(uScene.sample(uv.add(dir.mul(0.166667))).rgb),
  ).toVar();
  const b = a
    .mul(0.5)
    .add(
      mul(
        0.25,
        uScene.sample(uv.sub(dir.mul(0.5))).rgb.add(uScene.sample(uv.add(dir.mul(0.5))).rgb),
      ),
    )
    .toVar();
  const lb = dot(b, lum).toVar();
  const lo = min(l0, min(min(l1, l2), min(l3, l4))).toVar();
  const hi = max(l0, max(max(l1, l2), max(l3, l4))).toVar();

  return select(lb.lessThan(lo).or(lb.greaterThan(hi)), a, b);
});

export const tempestPost = /*@__PURE__*/ Fn(([vUv]: [Node<"vec2">]) => {
  const uv = vUv.toVar();
  const warp = vec2(0).toVar();
  const dropHighlight = float(0).toVar();

  // Sparse refractive beads near the lens edges, not a full-screen blur.

  If(uLens.greaterThan(0.5), () => {
    Loop({ start: int(0), end: 12 }, ({ i }) => {
      const f = float(i).toVar();
      const p = vec2(hash(vec2(f, 3)), hash(vec2(f, 7))).toVar();
      p.y.assign(fract(p.y.sub(uTime.mul(add(0.008, hash(vec2(f, 11)).mul(0.01))))));

      If(p.x.greaterThan(0.18).and(p.x.lessThan(0.82)), () => {
        Continue();
      });

      const d = uv
        .sub(p)
        .mul(vec2(uRes.x.div(uRes.y), 1))
        .toVar();
      const rad = add(0.008, hash(vec2(f, 9)).mul(0.006)).toVar();
      const dist = length(d.mul(vec2(1, 0.75))).toVar();
      const mask = sub(1, smoothstep(rad.mul(0.7), rad, dist)).toVar();
      warp.addAssign(d.mul(mask).mul(uRain).mul(0.5));
      dropHighlight.addAssign(
        pow(max(0, sub(1, abs(dist.sub(rad.mul(0.8))).div(rad.mul(0.1)))), 4)
          .mul(0.017)
          .mul(uRain),
      );
    });
  });

  const col = antialias(clamp(uv.add(warp), 0, 1)).toVar();
  const bloom = vec3(0).toVar();
  const wt = float(0).toVar();

  Loop({ start: int(-3), end: int(3), condition: "<=" }, ({ i }) => {
    const w = exp(float(i.mul(i)).negate().mul(0.26)).toVar();
    bloom.addAssign(uBloom.sample(uv.add(vec2(0, float(i).mul(3)).div(uRes))).rgb.mul(w));
    wt.addAssign(w);
  });

  col.addAssign(bloom.div(wt).mul(0.22));
  col.mulAssign(uExposure);
  col.assign(aces(col));

  // Cool shadow / warm practical-light grade, retaining neutral highlights.

  col.assign(pow(max(col, vec3(0)), vec3(1.015, 1, 0.975)));
  const vign = sub(1, mul(0.28, pow(length(uv.sub(0.5).mul(vec2(1.05, 1))), 1.65))).toVar();
  col.mulAssign(vign);
  col.assign(pow(col, vec3(1 / 2.2)));
  col.addAssign(
    hash(gl_FragCoord.xy.add(floor(uTime.mul(24))))
      .sub(0.5)
      .mul(0.005)
      .add(dropHighlight),
  );

  return vec4(clamp(col, 0, 1), 1);
});
