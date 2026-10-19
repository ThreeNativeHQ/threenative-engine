// GENERATED FILE — do not edit it. Every line below is the output of Three.js's own GLSL to
// TSL transpiler, run over tools/tempest-clouds.frag. That .frag file
// is the source of truth; change it and the generator, never this file.
//
//   node tools/generate-shaders.mjs
//
// The shader is the storm ceiling: a raymarched volume between 145 and 815 metres, lit by a
// five-tap march toward the sun and filled from a procedural 64³ noise volume. It is one full-screen
// pass into a render target the coast samples — see src/render/clouds.ts.
import { Data3DTexture, Vector2, Vector3, Vector4 } from "three";
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  add,
  clamp,
  depth,
  dot,
  exp,
  float,
  floor,
  fract,
  frameGroup,
  int,
  length,
  mat2,
  max,
  min,
  mix,
  mul,
  normalize,
  pow,
  screenCoordinate,
  smoothstep,
  sub,
  texture3D,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node, TextureNode } from "three/webgpu";

// Uniforms the shader reads. Values are assigned by src/render/world.ts and src/render/clouds.ts,
// which own the camera basis and the weather; the generated module only holds the nodes.
export const uTime = uniform(0, "float").setGroup(frameGroup);
export const uCloud = uniform(0, "float").setGroup(frameGroup);
export const uWind = uniform(0, "float").setGroup(frameGroup);
export const uFlash = uniform(0, "float").setGroup(frameGroup);
export const uAspect = uniform(0, "float").setGroup(frameGroup);
export const uTan = uniform(0, "float").setGroup(frameGroup);
export const uCam = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uForward = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uRight = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uUp = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uStrike = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uSunDir = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uSkyLow = uniform(new Vector3(), "vec3").setGroup(frameGroup);
export const uSkyHigh = uniform(new Vector3(), "vec3").setGroup(frameGroup);
const uNoisePlaceholder = new Data3DTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, 1);
uNoisePlaceholder.needsUpdate = true;
export let uNoise: TextureNode = texture3D(uNoisePlaceholder).setGroup(frameGroup);
export function setNoise(value: TextureNode): void {
  uNoise = value;
}
export const uSteps = uniform(0, "int").setGroup(frameGroup);

// Three.js Transpiler r185

// Polyfills

const gl_FragCoord = vec3(screenCoordinate.x, screenCoordinate.y.oneMinus(), depth);

// The look, owned by src/render/{sky,lighting}.ts and set from there every run.

export const hash12 = /*@__PURE__*/ Fn(([p]: [Node<"vec2">]) => {
  const p3 = fract(vec3(p.xyx).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));

  return fract(p3.x.add(p3.y).mul(p3.z));
});

export const hash13 = /*@__PURE__*/ Fn(([p_immutable]: [Node<"vec3">]) => {
  const p = p_immutable.toVar();
  p.assign(fract(p.mul(0.1031)));
  p.addAssign(dot(p, p.zyx.add(31.32)));

  return fract(p.x.add(p.y).mul(p.z));
});

export const noise2 = /*@__PURE__*/ Fn(([p]: [Node<"vec2">]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  f.assign(f.mul(f).mul(sub(3, mul(2, f))));

  return mix(
    mix(hash12(i), hash12(i.add(vec2(1, 0))), f.x),
    mix(hash12(i.add(vec2(0, 1))), hash12(i.add(1)), f.x),
    f.y,
  );
});

export const fbm2 = /*@__PURE__*/ Fn(([p_immutable]: [Node<"vec2">]) => {
  const p = p_immutable.toVar();
  const v = mul(0.5, noise2(p)).toVar();
  p.assign(mat2(0.8, 0.6, -0.6, 0.8).mul(p).mul(2.03).add(19.1));
  v.addAssign(mul(0.25, noise2(p)));
  p.assign(p.mul(2.02).add(9.3));
  v.addAssign(mul(0.125, noise2(p)));

  return v.add(mul(0.0625, noise2(p.mul(2.01).add(17))));
});

export const ray = /*@__PURE__*/ Fn(([uv]: [Node<"vec2">]) => {
  const q = uv.mul(2).sub(1).toVar();

  return normalize(
    uForward.add(uRight.mul(q.x).mul(uAspect).mul(uTan)).add(uUp.mul(q.y).mul(uTan)),
  );
});

export const project = /*@__PURE__*/ Fn(([p]: [Node<"vec3">]) => {
  const v = p.sub(uCam).toVar();
  const d = dot(v, uForward).toVar();

  return vec4(
    dot(v, uRight).div(uAspect.mul(uTan)),
    dot(v, uUp).div(uTan),
    mul(1.00012, d).sub(0.300018),
    d,
  );
});

export const density = /*@__PURE__*/ Fn(([p]: [Node<"vec3">]) => {
  // One value, one return, for the reason given in the coast's `baseColor`: the transpiler turns a
  // GLSL early return into a JavaScript return that only leaves the `If` callback the node graph is
  // being built inside, so the branch would never be assigned. The guard is kept as a guard, so a
  // clear sky still costs one comparison and no noise fetches.

  const res = float(0).toVar();

  If(uCloud.greaterThanEqual(0.005), () => {
    const drift = vec3(uTime.mul(add(2, uWind.mul(13))), 0, uTime.mul(1.2)).toVar();
    const q = p.add(drift).mul(0.00105).toVar();
    q.y.mulAssign(1.4);
    const n = uNoise.sample(q).toVar();
    const broad = n.r
      .mul(0.76)
      .add(uNoise.sample(q.mul(2.07).add(vec3(0.1, 0.3, 0.7))).r.mul(0.24))
      .toVar();

    // Flattened condensation base with turbulent billows above it.

    const h = p.y.sub(145).div(670).toVar();
    const base = smoothstep(0, 0.09, h)
      .mul(sub(1, smoothstep(0.68, 1, h)))
      .toVar();
    const shape = broad.add(uCloud.mul(0.3)).sub(0.72).toVar();
    const edge = uNoise.sample(q.mul(3.81)).b.sub(0.5).mul(0.12).toVar();
    res.assign(clamp(shape.sub(edge).mul(5.1), 0, 1).mul(base));
  });

  return res;
});

export const lightAt = /*@__PURE__*/ Fn(([p_immutable, l]: [Node<"vec3">, Node<"vec3">]) => {
  const p = p_immutable.toVar();
  const sum = float(0).toVar();
  const stepLen = float(28).toVar();

  Loop({ start: int(0), end: 5 }, ({ i }) => {
    p.addAssign(l.mul(stepLen));
    sum.addAssign(density(p).mul(stepLen));
    stepLen.mulAssign(1.7);
  });

  return exp(sum.negate().mul(0.015));
});

export const tempestClouds = /*@__PURE__*/ Fn(([vUv]: [Node<"vec2">]) => {
  const rd = ray(vUv).toVar();
  rd.y.assign(abs(rd.y));
  rd.assign(normalize(rd));
  const sunDir = uSunDir.toVar();
  const mu = dot(rd, sunDir).toVar();
  const sky = mix(uSkyLow, uSkyHigh, pow(clamp(rd.y, 0, 1), 0.62)).toVar();
  sky.addAssign(vec3(0.31, 0.27, 0.205).mul(pow(max(mu, 0), 14)));
  sky.addAssign(vec3(0.7, 0.57, 0.37).mul(pow(max(mu, 0), 140)));
  sky.addAssign(uFlash.mul(vec3(0.14, 0.22, 0.36)));
  const t0 = max(0, sub(145, uCam.y).div(max(rd.y, 0.008))).toVar();
  const t1 = min(10500, sub(815, uCam.y).div(max(rd.y, 0.008))).toVar();
  const col = vec4(sky, 1).toVar();

  If(t0.lessThan(t1), () => {
    const dt = t1.sub(t0).div(float(uSteps)).toVar();
    const jitter = hash12(gl_FragCoord.xy).mul(0.75).add(0.12).toVar();
    const light = vec3(0).toVar();
    const trans = float(1).toVar();
    const phase = add(0.45, mul(0.65, pow(max(mu, 0), 5))).toVar();

    Loop({ start: int(0), end: 96 }, ({ i }) => {
      If(i.greaterThanEqual(uSteps).or(trans.lessThan(0.008)), () => {
        Break();
      });

      const t = t0.add(float(i).add(jitter).mul(dt)).toVar();
      const p = uCam.add(rd.mul(t)).toVar();
      const d = density(p).toVar();

      If(d.greaterThan(0.002), () => {
        const sun = lightAt(p, sunDir).toVar();
        const height = clamp(p.y.sub(145).div(670), 0, 1).toVar();
        const ambient = mix(vec3(0.035, 0.061, 0.079), vec3(0.19, 0.25, 0.28), height).toVar();

        // A small multiple-scattering/powder approximation prevents crushed cloud cores.

        const c = ambient
          .mul(add(0.7, mul(0.45, sub(1, exp(d.negate().mul(3))))))
          .add(vec3(0.97, 0.94, 0.85).mul(sun).mul(phase).mul(0.7))
          .toVar();
        const glow = exp(
          length(p.sub(uStrike).mul(vec3(1, 0.5, 1)))
            .negate()
            .mul(0.0022),
        ).toVar();
        c.addAssign(vec3(0.85, 1.18, 1.9).mul(uFlash).mul(glow).mul(1.2));
        const absorb = sub(1, exp(d.negate().mul(dt).mul(0.02))).toVar();
        light.addAssign(trans.mul(absorb).mul(c));
        trans.mulAssign(sub(1, absorb));
      });
    });

    const marched = light.add(trans.mul(sky)).toVar();
    const atmospheric = sub(1, exp(t0.negate().mul(0.000075))).toVar();
    marched.assign(mix(marched, sky, atmospheric.mul(0.66)));
    col.assign(vec4(marched, sub(1, trans)));
  });

  return col;
});
