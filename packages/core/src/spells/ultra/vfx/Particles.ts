// Ported from Ultra Elements src/vfx/Particles.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
import {
  Break,
  Discard,
  Fn,
  If,
  Loop,
  PI,
  abs,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cos,
  dot,
  exp,
  float,
  fract,
  instanceIndex,
  instancedArray,
  int,
  ivec2,
  length,
  max,
  min,
  mix,
  mod,
  normalize,
  positionGeometry,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  textureLoad,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  type ColorRepresentation,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Float32BufferAttribute,
  FloatType,
  FrontSide,
  IcosahedronGeometry,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  NearestFilter,
  type Node,
  PlaneGeometry,
  RGBAFormat,
  Vector2,
  Vector3,
} from "three/webgpu";
import { Q } from "../engine/quality.js";
import {
  ARENA,
  FX_BLENDING,
  LINES_BLENDING,
  U,
  arenaNormal,
  arenaSDF,
  basisFrom,
  blackbody,
  curl3,
  forceAccel,
  fxOut,
  groundUV,
  hash11,
  hash12,
  hash31,
  hash41,
  hgPhase,
  noise3,
  randomInSphere,
  randomOnSphere,
  sceneViewZ,
  spellLightScatter,
} from "./common.js";

type F = Node<"float">;
type V2 = Node<"vec2">;
type V3 = Node<"vec3">;
type V4 = Node<"vec4">;
type I = Node<"int">;

// One GPU particle pool for every spell (PLAN 2.5).
//  - State: three RGBA32F textures, ping-ponged and written by one MRT draw:
//      S0 = (pos.xyz, age)  S1 = (vel.xyz, life)  S2 = (kind + size * 0.1, seed, lastCollideTime, custom)
//    fp16 isn't enough: v * dt drops below fp16 precision at arena scale.
//  - Behaviour lives in a kind table texture (Niagara-style parameters, not code): sliders write
//    texels, nothing recompiles.
//  - Three render styles own row ranges so each draw is homogeneous:
//      glow   full-res additive velocity-stretched sparks / motes (lines scene)
//      media  half-res spherical billboards, weighted-blended OIT (fx scene)
//      debris instanced lit meshes (opaque scene)
//    Each range starts with the field-emitter blocks, then a ring buffer the CPU allocates from.
//  - Emission: per-frame records in a small float texture; texels inside a record respawn from
//    it. Records only exist on frames that emit, and a texel tests the frame's spans first.
//  - Kind morphing on collision replaces GPU sub-emitters (droplet -> splash, ember -> smoulder);
//    field emitters respawn dead texels on the floor where the ground field says so (steam, ground
//    flames, frost mist) with no CPU involvement.
//
// Engine (ThreeNative's C++ engine over WebGPU) differences, each forced:
//  - compute in place of the MRT ping-pong (the brief allows it): the state is three vec4 storage buffers (S0, S1,
//    S2, one element per texel, index = y * W + x) and the sim is one compute kernel over W x H
//    threads with the same per-texel maths in the same order. Every thread reads and writes only
//    its own element, so updating in place is the ping-pong. Kind, emission and field tables are
//    upstream's float DataTextures, read with texelFetch (textureLoad).
//  - no int uniforms or uniform arrays: the int uniforms are float uniforms read through int(), and
//    uSpan[6] is six vec2 uniforms.
//  - no lines / opaque scenes: createFx adds all three styles to its fx group in the world scene;
//    debris draws in the opaque queue, glow and media in the transparent one.
//  - ENGINE-GAP: no multi-target render target and no point size, so painting the ground field
//    (PAINT_VERT / PAINT_FRAG, Points into the ground's two targets) is not ported yet; `paint`
//    stays empty.
//  - the debris material gets the spell lights through the PointLights createFx mirrors them into
//    (common.ts mirrorLights), where upstream added spellLightPBR to reflectedLight.

const KW = 11; // kind table texels per kind
const MAX_KINDS = 1024; // ~120 spells x ~6 kinds; one 10x1024 RGBA32F table (160 KB)
const MAX_REC = 64; // emission records per frame
const REC_W = 5; // texels per record
const MAX_FIELD = 8;
const LOG_N = 2048; // emission log entries per style
const STYLES = ["glow", "media", "debris"] as const;
type Style = (typeof STYLES)[number];
const PAINT_CHANNELS = ["heat", "char", "wet", "frost", "crack", "acid", "corruption", "glow"];
const SHAPES = { sphere: 0, shell: 1, disk: 2, ring: 3, line: 4, cone: 5 };
const MESHES = ["rock", "shard", "leaf"];

const KIND_DEFAULTS = {
  style: "glow" as Style,
  flicker: 0,
  drag: 0.5,
  gravity: 0,
  buoyancy: 0,
  curl: 0,
  curlScale: 0.15,
  forceResponse: 1,
  restitution: -1,
  friction: 0.2,
  life: [1, 1] as number[],
  size: [0.05, 0.05] as number[],
  stretch: 0,
  emissive: 1,
  temp: null as number[] | null,
  color: ["#ffffff", "#ffffff"] as ColorRepresentation[],
  alpha: [1, 0] as number[],
  paints: null as string | null,
  paintAmount: 0.3,
  morph: null as string | number | null,
  killOnCollide: false,
  absorbing: false,
  toSmokeAt: 0,
  smokeAlbedo: 0.12,
  density: 3,
  distortion: 0,
  fadeIn: 0.05,
  fadeOut: 0.3,
  spin: 0,
  sizePow: 1,
  softness: 1,
  lightResponse: 1,
  mesh: "rock",
  erosion: 0.5,
  orbit: false,
};
export type KindDef = typeof KIND_DEFAULTS;

// --- shared GLSL ---------------------------------------------------------------------
// STATE_GLSL: the state buffers and the kind table (one shared texture node, read with texelFetch)
const storageOf = (n: number) => instancedArray(n, "vec4");
type Storage = ReturnType<typeof storageOf>;
const floatU = (v: number) => uniform(v);
type UF = ReturnType<typeof floatU>;
const vec2U = (v: Vector2) => uniform(v);
type UV2 = ReturnType<typeof vec2U>;
const texOf = (t: DataTexture) => texture(t);
type Tex = ReturnType<typeof texOf>;
// a float table (kind / emission / field): RGBA32F DataTexture written from the CPU, read with texelFetch
const tableOf = (data: Float32Array, w: number, h: number) => {
  const t = new DataTexture(data, w, h, RGBAFormat, FloatType);
  t.magFilter = t.minFilter = NearestFilter;
  return t;
};
// texelFetch(tex, ivec2(x, y), 0)
const texelFetch = (tex: Tex, x: I, y: I): V4 =>
  textureLoad(tex as Parameters<typeof textureLoad>[0], ivec2(x, y), int(0)) as unknown as V4;
interface IState {
  uS0: Storage;
  uS1: Storage;
  uS2: Storage;
  uKinds: Tex;
}
const kindTexel = (st: IState, kind: I, i: number): V4 => texelFetch(st.uKinds, int(i), kind);
const stateAt = (b: Storage, idx: I): V4 => b.element(idx) as unknown as V4;

// INDEX_GLSL: instance -> texel: field blocks first, then the live window of the ring
interface IStyleU {
  uStyleStart: UF;
  uStyleCount: UF;
  uFieldCount: UF;
  uRingBase: UF;
}
function particleIndex(su: IStyleU, id: I): I {
  const field = int(su.uFieldCount);
  const ring = int(su.uStyleCount).sub(field);
  // GLSL int %: a - (a / b) * b (int division; TSL's mod is the float one)
  const a = int(su.uRingBase).add(id).sub(field);
  const b = select(ring.lessThan(int(1)), int(1), ring); // max(ring, 1)
  const local = select(id.lessThan(field), id, field.add(a.sub(a.div(b).mul(b))));
  return int(su.uStyleStart).add(local) as I;
}

// LOOK_GLSL: colour / alpha / size over life, shared by every style (struct Look -> plain object)
interface ILook {
  color: V3;
  alpha: F;
  size: F;
  smoke: F;
  emissive: F;
}
function particleLook(st: IState, kind: I, t: F, sizeScale: F): ILook {
  const k2 = kindTexel(st, kind, 2);
  const k3 = kindTexel(st, kind, 3);
  const k4 = kindTexel(st, kind, 4);
  const k5 = kindTexel(st, kind, 5);
  const k7 = kindTexel(st, kind, 7);
  const k8 = kindTexel(st, kind, 8);
  const size = mix(k2.z, k2.w, pow(t, k8.w)).mul(sizeScale);
  const fade = smoothstep(0.0, max(k8.x, 1e-3), t).mul(
    float(1.0).sub(smoothstep(float(1.0).sub(max(k8.y, 1e-3)), 1.0, t)),
  );
  const alpha = mix(k4.a, k5.a, t).mul(fade);
  const emissive = k3.y;
  const T = mix(k3.z, k3.w, t);
  const color = select(
    k3.z.greaterThan(0.0),
    blackbody(T).mul(pow(T.div(max(k3.z, 1.0)), 3.0)), // hot starts bright and cools fast
    mix(k4.rgb, k5.rgb, t),
  );
  const smoke = select(
    k7.x.greaterThan(0.0),
    smoothstep(k7.x, min(k7.x.add(0.25), 1.0), t),
    float(0.0),
  );
  return {
    color: color as V3,
    alpha: alpha as F,
    size: size as F,
    smoke: smoke as F,
    emissive: emissive as F,
  };
}

// --- sim ---------------------------------------------------------------------------------
interface ISimU {
  uEmitTex: Tex;
  uEmitCount: UF;
  uSpan: UV2[];
  uSpanCount: UF;
  uFieldTex: Tex;
  uFieldCount: UF;
  uSimDt: UF;
  uGroundA: Tex;
  uGroundB: Tex;
}

function simKernel(W: number, H: number, st: IState, u: ISimU) {
  // the sim reads the ground field from a compute kernel: level 0 (upstream's fragment derivatives)
  const groundA = (xz: V2): V4 => u.uGroundA.sample(groundUV(xz)).level(float(0)) as unknown as V4;
  const groundB = (xz: V2): V4 => u.uGroundB.sample(groundUV(xz)).level(float(0)) as unknown as V4;
  return Fn(() => {
    const idx = int(instanceIndex).toVar();
    const o0 = vec4(0.0).toVar();
    const o1 = vec4(0.0).toVar();
    const o2 = vec4(0.0).toVar();

    const spawn = (kind: I, pos: V3, vel: V3, lifeScale: F, sizeScale: F, seed: F) => {
      const k2 = kindTexel(st, kind, 2);
      const life = mix(k2.x, k2.y, hash11(seed.mul(7.13))).mul(lifeScale);
      o0.assign(vec4(pos, 0.0));
      o1.assign(vec4(vel, max(life, 1e-3)));
      o2.assign(vec4(float(kind).add(clamp(sizeScale, 0.0, 9.99).mul(0.1)), seed, -1e4, 0.0));
    };

    const tryEmit = () => {
      const emitted = int(0).toVar();
      let inSpan = float(idx).lessThan(-1.0);
      for (let s = 0; s < 6; s++) {
        const span = u.uSpan[s] as UV2;
        inSpan = inSpan.or(
          u.uSpanCount
            .greaterThan(s)
            .and(float(idx).greaterThanEqual(span.x))
            .and(float(idx).lessThan(span.y)),
        );
      }
      If(inSpan, () => {
        Loop({ start: 0, end: MAX_REC, type: "int", condition: "<" }, ({ i: r }: { i: I }) => {
          If(r.greaterThanEqual(int(u.uEmitCount)), () => {
            Break();
          });
          const e0 = texelFetch(u.uEmitTex, int(0), r);
          const j = idx.sub(int(e0.x)).toVar();
          If(j.greaterThanEqual(int(0)).and(j.lessThan(int(e0.y))), () => {
            const e1 = texelFetch(u.uEmitTex, int(1), r);
            const e2 = texelFetch(u.uEmitTex, int(2), r);
            const e3 = texelFetch(u.uEmitTex, int(3), r);
            const e4 = texelFetch(u.uEmitTex, int(4), r);
            const seed = fract(e3.w.add(float(j).mul(0.618034)))
              .mul(1000.0)
              .add(float(j).mul(0.001))
              .toVar();
            const h = hash41(seed).toVar();
            const h2 = hash31(seed.add(17.0)).toVar();
            const shape = int(e0.w).toVar();
            const pos = e1.xyz.toVar();
            const radial = vec3(0.0).toVar();
            If(shape.equal(int(0)), () => {
              const d = randomInSphere(h.xyz).toVar();
              pos.addAssign(d.mul(e1.w));
              radial.assign(normalize(d.add(1e-5)));
            })
              .ElseIf(shape.equal(int(1)), () => {
                const d = randomOnSphere(h.xy).toVar();
                pos.addAssign(d.mul(e1.w));
                radial.assign(d);
              })
              .ElseIf(shape.equal(int(2)).or(shape.equal(int(3))), () => {
                const a = h.x.mul(2.0).mul(PI);
                const rr = select(shape.equal(int(2)), sqrt(h.y), float(1.0));
                radial.assign(vec3(cos(a), 0.0, sin(a)));
                pos.addAssign(radial.mul(rr).mul(e1.w));
              })
              .ElseIf(shape.equal(int(4)), () => {
                const d = randomInSphere(h2).toVar();
                pos.assign(mix(e1.xyz, e3.xyz, h.x).add(d.mul(e1.w)));
                radial.assign(normalize(d.add(1e-5)));
              })
              .Else(() => {
                // cone around e3.xyz, half-angle e4.w
                pos.addAssign(randomInSphere(h2).mul(e1.w));
                const ax = normalize(e3.xyz.add(1e-6));
                const ct = mix(1.0, cos(e4.w), h.x).toVar();
                const stt = sqrt(float(1.0).sub(ct.mul(ct)));
                const ph = h.y.mul(2.0).mul(PI);
                radial.assign(basisFrom(ax).mul(vec3(stt.mul(cos(ph)), stt.mul(sin(ph)), ct)));
              });
            const vel = e2.xyz
              .add(randomInSphere(hash31(seed.add(31.0))).mul(e2.w))
              .add(radial.mul(e4.x).mul(mix(0.6, 1.0, h.w)));
            spawn(int(e0.z), pos, vel as V3, e4.z, e4.y, seed);
            emitted.assign(int(1));
            Break();
          });
        });
      });
      return emitted;
    };

    // field emitters: dead texels in a block respawn on the floor where the ground field qualifies
    const tryField = () => {
      Loop({ start: 0, end: MAX_FIELD, type: "int", condition: "<" }, ({ i: f }: { i: I }) => {
        If(f.greaterThanEqual(int(u.uFieldCount)), () => {
          Break();
        });
        const f0 = texelFetch(u.uFieldTex, int(0), f);
        const j = idx.sub(int(f0.x)).toVar();
        If(j.greaterThanEqual(int(0)).and(j.lessThan(int(f0.y))), () => {
          const wa = texelFetch(u.uFieldTex, int(1), f);
          const wb = texelFetch(u.uFieldTex, int(2), f);
          const f3 = texelFetch(u.uFieldTex, int(3), f);
          const seed = hash12(vec2(float(idx), mod(U.uFrame, 4096.0)))
            .mul(1000.0)
            .toVar();
          const h = hash41(seed).toVar();
          const a = h.x.mul(2.0).mul(PI);
          const r = sqrt(h.y).mul(Number((ARENA.radius - 0.4).toFixed(2)));
          const xz = vec2(cos(a), sin(a)).mul(r).toVar();
          const s = dot(groundA(xz), wa)
            .add(dot(groundB(xz), wb))
            .sub(f0.w)
            .toVar();
          // h.z > s * rate * dt: stays dead this frame
          If(h.z.lessThanEqual(s.mul(f3.x).mul(u.uSimDt)), () => {
            const pos = vec3(xz.x, 0.04, xz.y).toVar();
            const pq = abs(
              xz.sub(
                vec2(
                  Number(ARENA.pool.center.x.toFixed(3)),
                  Number(ARENA.pool.center.y.toFixed(3)),
                ),
              ),
            );
            If(
              pq.x
                .lessThan(Number(ARENA.pool.half.x.toFixed(3)))
                .and(pq.y.lessThan(Number(ARENA.pool.half.y.toFixed(3)))),
              () => {
                pos.y.addAssign(Number(ARENA.pool.water.toFixed(3)));
              },
            );
            const vel = vec3(0.0, f3.w, 0.0).add(randomInSphere(hash31(seed.add(5.0))).mul(0.3));
            spawn(
              int(f0.z),
              pos,
              vel as V3,
              f3.y,
              f3.z.mul(clamp(s.mul(2.0), 0.5, 1.5)) as F,
              seed,
            );
          });
          Break();
        });
      });
    };

    If(idx.lessThan(int(W * H)), () => {
      const s0 = stateAt(st.uS0, idx).toVar();
      const s1 = stateAt(st.uS1, idx).toVar();
      const dead = s0.w.greaterThanEqual(s1.w).toVar();
      If(dead, () => {
        o0.assign(vec4(0.0, -1000.0, 0.0, 1e9));
        o1.assign(vec4(0.0, 0.0, 0.0, 1.0));
        o2.assign(vec4(0.0, 0.0, -1e4, 0.0));
      });
      // a texel re-allocated by the ring this frame restarts even if still alive (pool full: oldest die)
      const emitted = tryEmit();
      If(emitted.equal(int(0)), () => {
        If(dead, () => {
          tryField();
        }).Else(() => {
          const s2 = stateAt(st.uS2, idx).toVar();
          const kind = int(s2.x).toVar();
          const sizeScale = fract(s2.x).mul(10.0).toVar();
          const k0 = kindTexel(st, kind, 0).toVar();
          const k1 = kindTexel(st, kind, 1).toVar();
          const k2 = kindTexel(st, kind, 2).toVar();
          const k6 = kindTexel(st, kind, 6).toVar();
          const dt = u.uSimDt;
          const pos = s0.xyz.toVar();
          const vel = s1.xyz.toVar();
          const age = s0.w.add(dt).toVar();
          const life = s1.w.toVar();
          const t = age.div(life).toVar();
          const kill = float(0.0).toVar();

          const acc = vec3(0.0, k0.z.mul(float(1.0).sub(t.mul(0.6))).sub(k0.y), 0.0).toVar();
          If(k0.w.notEqual(0.0), () => {
            acc.addAssign(
              curl3(
                pos
                  .mul(k1.x)
                  .add(vec3(0.0, U.uTime.mul(0.05), 0.0))
                  .add(s2.y.mul(0.01)),
              ).mul(k0.w),
            );
          });
          If(k1.y.notEqual(0.0), () => {
            acc.addAssign(forceAccel(pos, vel, kill).mul(k1.y));
          });
          vel.addAssign(acc.mul(dt));
          vel.mulAssign(exp(k0.x.negate().mul(dt)));
          const np = pos.add(vel.mul(dt)).toVar();

          // collision with the arena (floor, rim, pillars, dummies, dynamic capsules)
          const custom = s2.w.toVar();
          const collide = s2.z.toVar();
          If(k1.z.greaterThanEqual(0.0), () => {
            const rad = max(mix(k2.z, k2.w, t).mul(sizeScale).mul(0.5), 0.01).toVar();
            const d = arenaSDF(np).toVar();
            If(d.lessThan(rad), () => {
              const n = arenaNormal(np).toVar();
              np.addAssign(n.mul(rad.sub(d)));
              const vn = dot(vel, n).toVar();
              If(vn.lessThan(0.0), () => {
                const vt = vel.sub(n.mul(vn)).toVar();
                vel.assign(vt.mul(float(1.0).sub(k1.w)).sub(n.mul(vn).mul(k1.z)));
              });
              collide.assign(U.uTime);
              const flags = int(k6.w);
              If(flags.bitAnd(int(2)).notEqual(int(0)), () => {
                kill.assign(1.0);
              });
              If(k6.z.greaterThan(0.5), () => {
                // morph into another kind, keeping position and the bounce
                const m = int(k6.z).sub(int(1)).toVar();
                const m2 = kindTexel(st, m, 2);
                kind.assign(m);
                age.assign(0.0);
                life.assign(mix(m2.x, m2.y, hash11(s2.y.mul(3.7))));
              });
              // debris: remember when it came to rest (its spin freezes there)
              If(
                custom
                  .lessThanEqual(0.0)
                  .and(dot(vel, vel).lessThan(0.04))
                  .and(k6.x.greaterThan(2.5)),
                () => {
                  custom.assign(age);
                },
              );
            });
          });
          // orbit hook: keep a Kepler-ish disk tidy (accretion), uses force 'orbit' for speed
          If(kill.greaterThan(0.5), () => {
            age.assign(life);
          });
          o0.assign(vec4(np, age));
          o1.assign(vec4(vel, life));
          o2.assign(vec4(float(kind).add(sizeScale.mul(0.1)), s2.y, collide, custom));
        });
      });
      stateAt(st.uS0, idx).assign(o0);
      stateAt(st.uS1, idx).assign(o1);
      stateAt(st.uS2, idx).assign(o2);
    });
  })().compute(W * H);
}

// upstream's clearState draw: every texel back to zero (age 0 >= life 0 counts as dead)
function clearKernel(W: number, H: number, st: IState) {
  return Fn(() => {
    const idx = int(instanceIndex);
    If(idx.lessThan(int(W * H)), () => {
      stateAt(st.uS0, idx).assign(vec4(0.0));
      stateAt(st.uS1, idx).assign(vec4(0.0));
      stateAt(st.uS2, idx).assign(vec4(0.0));
    });
  })().compute(W * H);
}

// projectionMatrix[1][1] (column 1, row 1)
const projYY = (): F => cameraProjectionMatrix.mul(vec4(0.0, 1.0, 0.0, 0.0)).y as unknown as F;
// gl_Position for a dead instance: outside the clip volume
const OFFSCREEN = () => vec4(2.0, 2.0, 2.0, 1.0);

// --- glow: velocity-stretched additive quads, full res ---------------------------------
function glowMaterial(st: IState, su: IStyleU) {
  const mat = new MeshBasicNodeMaterial({ ...LINES_BLENDING });
  mat.fog = false;
  const idx = particleIndex(su, int(instanceIndex));
  const s0 = stateAt(st.uS0, idx);
  const s1 = stateAt(st.uS1, idx);
  const dead = s0.w.greaterThanEqual(s1.w);
  const s2 = stateAt(st.uS2, idx);
  const kind = int(s2.x);
  const t = s0.w.div(s1.w);
  const l = particleLook(st, kind, t, fract(s2.x).mul(10.0));
  const k3 = kindTexel(st, kind, 3);
  const headV = cameraViewMatrix.mul(vec4(s0.xyz, 1.0)).xyz;
  const tailV = cameraViewMatrix.mul(vec4(s0.xyz.sub(s1.xyz.mul(k3.x)), 1.0)).xyz;
  const viewZ = max(headV.z.negate(), 0.05);
  const pxWorld = viewZ.mul(2.0).div(projYY().mul(U.uResolution.y));
  const size = l.size;
  const w = max(size, pxWorld.mul(1.5));
  const aa = size.div(w); // Humus phone-wire AA: keep energy when clamped to 1.5 px
  const axis = tailV.xy.sub(headV.xy);
  const len = length(axis);
  const dir = select(len.greaterThan(1e-4), axis.div(len), vec2(1.0, 0.0));
  const perp = vec2(dir.y.negate(), dir.x);
  // quad: x in [-1, 1] spans head (-1) .. tail (+1) plus caps, y across
  const position = positionGeometry;
  const off = dir
    .mul(select(position.x.lessThan(0.0), w.negate(), len.add(w)))
    .add(perp.mul(position.y).mul(w));
  const pv = headV.add(vec3(off, 0.0));
  mat.vertexNode = select(dead, OFFSCREEN(), cameraProjectionMatrix.mul(vec4(pv, 1.0)));
  const vUv = varying(vec2(select(position.x.lessThan(0.0), -1.0, 1.0), position.y));
  const vSoft = varying(len.div(len.add(w.mul(2.0)))); // how much of the quad is the stretched body
  const nearFade = smoothstep(0.3, 1.2, viewZ);
  // stretching spreads the same energy over a longer streak (motion-blur conservation)
  const fk = kindTexel(st, kind, 10).x;
  const ph = s2.y.mul(97.0).add(s0.w.mul(mix(9.0, 23.0, fract(s2.y.mul(13.7)))));
  const vColor = varying(
    select(
      dead,
      vec3(0.0),
      l.color
        .mul(l.emissive)
        .mul(l.alpha)
        .mul(aa)
        .mul(nearFade)
        .mul(w.mul(2.0).div(len.add(w.mul(2.0))))
        .mul(
          float(1.0).sub(
            fk.mul(
              float(0.5).add(
                float(0.5)
                  .mul(sin(ph))
                  .mul(sin(ph.mul(0.37).add(1.3))),
              ),
            ),
          ),
        ),
    ),
  );

  // GLOW_FRAG
  mat.fragmentNode = Fn(() => {
    // capsule falloff: distance from the centre segment in quad units
    const x = vUv.x.mul(0.5).add(0.5); // 0 head .. 1 tail
    const ends = float(1.0).sub(vSoft);
    const he = ends.mul(0.5);
    const dx = select(
      x.lessThan(he),
      he.sub(x).div(max(he, 1e-3)),
      select(x.greaterThan(float(1.0).sub(he)), x.sub(1.0).add(he).div(max(he, 1e-3)), float(0.0)),
    );
    const d2 = dx.mul(dx).add(vUv.y.mul(vUv.y));
    const core = exp(d2.negate().mul(4.0));
    const tailFade = mix(1.0, 0.35, x); // brighter at the head
    // engine: LINES_BLENDING is AdditiveBlending (SrcAlpha, One), so alpha 1 is upstream's ONE/ONE
    return vec4(vColor.mul(core).mul(tailFade), 1.0);
  })();
  return mat;
}

// --- media: spherical billboards into the half-res WBOIT pass ---------------------------
// spellLightScatter loops over the lights: a Fn, so the loop has a function to live in (gLightNoShadow)
const mediaScatter = Fn(([p, v]: [V3, V3]) => spellLightScatter(p, v, float(0.35), true));
function mediaMaterial(st: IState, su: IStyleU) {
  const mat = new MeshBasicNodeMaterial({ ...FX_BLENDING });
  mat.fog = false;
  const idx = particleIndex(su, int(instanceIndex));
  const s0 = stateAt(st.uS0, idx);
  const s1 = stateAt(st.uS1, idx);
  const s2 = stateAt(st.uS2, idx);
  const kind = int(s2.x);
  const t = s0.w.div(s1.w);
  const l = particleLook(st, kind, t, fract(s2.x).mul(10.0));
  const k6 = kindTexel(st, kind, 6);
  const k7 = kindTexel(st, kind, 7);
  const k9 = kindTexel(st, kind, 9);
  const cv = cameraViewMatrix.mul(vec4(s0.xyz, 1.0)).xyz;
  const viewZ = cv.z.negate();
  const dead = s0.w.greaterThanEqual(s1.w).or(viewZ.lessThan(0.05));
  // overdraw guard: never wider than 12% of the screen height
  const maxR = viewZ.mul(0.12).div(projYY());
  const r = min(l.size.mul(0.5), maxR);
  const spin = s2.y.add(s0.w.mul(kindTexel(st, kind, 8).z));
  const c = vec2(cos(spin), sin(spin));
  const position = positionGeometry;
  // mat2(c.x, -c.y, c.y, c.x) * position.xy (GLSL mat2 is column-major)
  const q = vec2(
    c.x.mul(position.x).add(c.y.mul(position.y)),
    c.y.negate().mul(position.x).add(c.x.mul(position.y)),
  );
  mat.vertexNode = select(
    dead,
    OFFSCREEN(),
    cameraProjectionMatrix.mul(vec4(cv.add(vec3(q.mul(r), 0.0)), 1.0)),
  );
  const vUv = varying(position.xy);
  const vViewZ = varying(viewZ);
  const vRadius = varying(r);
  const vDensity = varying(k7.z);
  const vErode = varying(k9.z.mul(t)); // erosion grows with age
  const vDistort = varying(k7.w.mul(l.alpha));
  const vNoise = varying(s0.xyz.mul(0.35).add(s2.y));
  const absorbing = int(k6.w).bitAnd(int(1)).notEqual(int(0));
  const smoke = select(absorbing, float(1.0), l.smoke);
  // lighting for the scattering part: sun with forward scattering, sky, spell lights
  // gLightNoShadow = true: spellLightScatter(..., noShadow) below
  const v = normalize(cameraPosition.sub(s0.xyz));
  const g = float(0.35);
  // flames glow; what scatters light is their soot, never their own blackbody colour
  const albedo = select(
    absorbing,
    l.color,
    select(l.emissive.greaterThan(0.0), vec3(k7.y), mix(l.color, vec3(k7.y), smoke)),
  );
  const vSun = varying(
    albedo
      .mul(U.uSunColor)
      .mul(hgPhase(dot(U.uSunDir, v.negate()), g))
      .mul(4.0 * Math.PI * 0.6),
  );
  const vAmb = varying(albedo.mul(U.uAmbient.mul(1.4).add(mediaScatter(s0.xyz, v).mul(k9.x))));
  // sun and up in the sprite's own frame (view space turned back by the spin), so the fragment
  // can shade the billboard as the sphere it stands for
  const sv = cameraViewMatrix.mul(vec4(U.uSunDir, 0.0)).xyz;
  const up = cameraViewMatrix.mul(vec4(0.0, 1.0, 0.0, 0.0)).xyz;
  // unspin = mat2(c.x, c.y, -c.y, c.x)
  const unspin = (p: V2) => vec2(c.x.mul(p.x).sub(c.y.mul(p.y)), c.y.mul(p.x).add(c.x.mul(p.y)));
  const vSunL = varying(vec3(unspin(sv.xy), sv.z));
  const vUpL = varying(vec3(unspin(up.xy), up.z));
  // emission fades as fire turns to smoke
  const vEmit = varying(
    select(
      l.emissive.greaterThan(0.0).and(absorbing.not()),
      l.color.mul(l.emissive).mul(float(1.0).sub(smoke)),
      vec3(0.0),
    ),
  );
  // pure emitters (flames before they smoke) are mostly glow, little occlusion
  const vAlpha = varying(
    select(
      dead,
      float(0.0),
      l.alpha
        .mul(mix(float(0.25).add(smoke.mul(0.75)), 1.0, step(l.emissive, 0.0)))
        .mul(smoothstep(0.2, 1.0, viewZ)),
    ),
  );

  // MEDIA_FRAG
  mat.fragmentNode = Fn(() => {
    If(vAlpha.lessThanEqual(0.001), () => {
      Discard();
    });
    const r2 = dot(vUv, vUv);
    If(r2.greaterThanEqual(1.0), () => {
      Discard();
    });
    // spherical billboard (Umenhoffer et al. 2006): visible thickness of a sphere, cut by the scene
    const h = sqrt(max(float(1.0).sub(r2), 0.0)).mul(vRadius);
    const sceneZ = sceneViewZ();
    const thick = clamp(
      min(vViewZ.add(h), sceneZ).sub(max(vViewZ.sub(h), U.uNearFar.x)),
      0.0,
      h.mul(2.0),
    );
    // eroded by world-space noise so a sprite reads as a lumpy volume; a finer octave rags the edges
    const n = noise3(vNoise.add(vec3(vUv.mul(0.42), 0.0)))
      .mul(0.72)
      .add(noise3(vNoise.mul(2.7).add(vec3(vUv.mul(1.1), 0.0))).mul(0.28));
    const er = smoothstep(vErode, vErode.add(0.35), n.mul(float(1.15).sub(r2.mul(0.6))));
    // billows and gaps from the first frame of a puff's life, not only once it erodes
    const b = smoothstep(0.22, 0.62, n);
    const a = float(1.0)
      .sub(
        exp(
          vDensity
            .negate()
            .mul(thick)
            .mul(float(0.35).add(b.mul(0.65))),
        ),
      )
      .mul(er)
      .mul(vAlpha);
    // shading: a dense puff is a lit sphere with a dark side, a dark core against the sun and billows
    // that shadow each other (noise denser towards the sun = in shadow, one extra tap); thin wisps
    // scatter evenly. Normalised so a front-lit puff keeps about its old mean brightness.
    const N = vec3(vUv, sqrt(max(float(1.0).sub(r2), 0.0)));
    const dense = float(1.0).sub(exp(vDensity.negate().mul(vRadius).mul(2.0)));
    const ns = noise3(vNoise.add(vec3(vUv.add(vSunL.xy.mul(0.3)).mul(0.42), 0.0)));
    const self = clamp(float(0.5).add(n.sub(ns).mul(4.5)), 0.0, 1.0);
    const lam = clamp(dot(N, vSunL).add(0.35).div(1.35), 0.0, 1.0);
    const through = exp(vDensity.negate().mul(thick));
    const sunShade = mix(through, lam, clamp(vSunL.z.mul(0.5).add(0.5), 0.0, 1.0))
      .mul(mix(1.0, self, 0.85))
      .mul(2.2);
    const ambShade = float(0.65)
      .add(dot(N, vUpL).mul(0.35))
      .mul(float(0.5).add(sqrt(r2).mul(0.5)))
      .mul(1.7);
    const vLit = vSun.mul(mix(1.0, sunShade, dense)).add(vAmb.mul(mix(1.0, ambShade, dense)));
    const dist = vec2(
      noise3(vNoise.mul(1.7).add(U.uTime.mul(0.6))),
      noise3(vNoise.zxy.mul(1.7).sub(U.uTime.mul(0.6))),
    )
      .sub(0.5)
      .mul(vDistort)
      .mul(0.02)
      .mul(float(1.0).sub(r2));
    // fire is hottest deep in a billow: thin edges and gaps run redder and much dimmer
    const core = b.mul(float(1.0).sub(r2));
    const emit = vEmit.mul(mix(vec3(0.5, 0.2, 0.08), vec3(1.5, 1.35, 1.2), core.mul(core)));
    return fxOut(vLit, a, emit.mul(a).mul(2.0), dist, vViewZ);
  })();
  return mat;
}

// --- geometry for debris variants -----------------------------------------------------
function rockGeometry() {
  const g = new IcosahedronGeometry(0.5, 1);
  const p = g.attributes.position as BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const n = 0.75 + 0.35 * Math.abs(Math.sin(x * 9.1 + y * 4.3) * Math.cos(z * 7.7 - x * 2.1));
    p.setXYZ(i, x * n, y * n * 0.8, z * n);
  }
  g.computeVertexNormals();
  return g; // polyhedra are already non-indexed, so the normals are faceted
}
function shardGeometry() {
  // hexagonal ice shard: prism with a pointed tip, flat facets
  const g = new CylinderGeometry(0.0, 0.22, 1, 6, 1, false);
  g.translate(0, 0.25, 0);
  const tail = new CylinderGeometry(0.22, 0.12, 0.3, 6, 1, false);
  tail.translate(0, -0.4, 0);
  const merged = mergeTwo(g.toNonIndexed(), tail.toNonIndexed());
  merged.computeVertexNormals();
  return merged;
}
function leafGeometry() {
  const g = new PlaneGeometry(1, 0.6, 2, 1);
  const p = g.attributes.position as BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setZ(i, Math.abs(p.getX(i)) * 0.25);
  g.computeVertexNormals();
  return g.toNonIndexed();
}
function mergeTwo(a: BufferGeometry, b: BufferGeometry) {
  const out = new BufferGeometry();
  for (const name of ["position", "normal", "uv"]) {
    const A = a.attributes[name] as BufferAttribute | undefined;
    const B = b.attributes[name] as BufferAttribute | undefined;
    if (!A || !B) continue;
    const arr = new Float32Array(A.array.length + B.array.length);
    arr.set(A.array);
    arr.set(B.array, A.array.length);
    out.setAttribute(name, new BufferAttribute(arr, A.itemSize));
  }
  return out;
}

// --- JS ------------------------------------------------------------------------------
function colorArr(c: ColorRepresentation) {
  const k = new Color(c);
  return [k.r, k.g, k.b];
}

interface IKind {
  name: string;
  id: number;
  def: KindDef;
}
interface IStyleRange {
  start: number;
  count: number;
  field: number;
  cursor: number;
  log: Float64Array;
  head: number;
  tail: number;
  base: number;
  window: number;
  first: number;
}
interface IFieldDef {
  kind: number;
  count: number;
  wa: number[];
  wb: number[];
  threshold: number;
  rate: number;
  lifeScale: number;
  sizeScale: number;
  up: number;
}
/** what the particle pool calls on the ground field (GroundField.js): touch() widens its live area */
export interface IParticleGround {
  touch?(x: number, z: number, reach: number, life: number): void;
}
/** what the particle pool needs of the renderer: `compute` runs the sim kernel */
export interface IParticleRenderer {
  compute(node: unknown): unknown;
}
export interface IEmitterOptions {
  shape?: keyof typeof SHAPES;
  radius?: number;
  spread?: number;
  radial?: number;
  size?: number;
  life?: number;
  cone?: number;
}
export type IEmitter = ReturnType<Particles["emitter"]>;

// the ground texture before GroundField sets the real one: field emitters stay off until then
const GROUND_PLACEHOLDER = U.uGroundA.value;

export class Particles {
  renderer: IParticleRenderer | null;
  ground: IParticleGround | null;
  W: number;
  H: number;
  kinds: IKind[] = []; // { name, def, id }
  kindIndex = new Map<string, number>();
  fieldDefs: IFieldDef[] = []; // { kind, style, count, wa, wb, threshold, rate, lifeScale, sizeScale, up }
  kindData: Float32Array;
  kindTex: DataTexture;
  emitData: Float32Array;
  emitTex: DataTexture;
  fieldData: Float32Array;
  fieldTex: DataTexture;
  recCount = 0;
  built = false;
  time = 0;
  alive = 0;
  seed = 1;
  glow: Mesh = null as unknown as Mesh; // meshes after build()
  media: Mesh = null as unknown as Mesh;
  debris: Mesh[] = [];
  paint: Mesh[] = [];
  style = {} as Record<Style, IStyleRange>;
  fieldCount = 0;
  spans: UV2[] = [];
  stateU: IState | null = null;
  simU: ISimU | null = null;
  sim: unknown = null;
  clear: unknown = null;
  styleU = {} as Record<Style, IStyleU>;

  constructor(
    renderer: IParticleRenderer | null,
    { ground = null }: { ground?: IParticleGround | null } = {},
  ) {
    this.renderer = renderer;
    this.ground = ground;
    [this.W, this.H] = Q.particles as [number, number];
    this.kindData = new Float32Array(KW * MAX_KINDS * 4);
    this.kindTex = tableOf(this.kindData, KW, MAX_KINDS);
    this.emitData = new Float32Array(REC_W * MAX_REC * 4);
    this.emitTex = tableOf(this.emitData, REC_W, MAX_REC);
    this.fieldData = new Float32Array(4 * MAX_FIELD * 4);
    this.fieldTex = tableOf(this.fieldData, 4, MAX_FIELD);
  }

  // seeded LCG so ?shot / ?bench frames repeat exactly
  rand() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  reseed(n: number) {
    this.seed = n >>> 0 || 1;
  }

  // --- authoring (spell create() at load) ---
  addKind(name: string, def: Partial<KindDef>) {
    if (this.kindIndex.has(name)) return this.kindIndex.get(name) as number;
    if (this.kinds.length >= MAX_KINDS) throw new Error("particle kinds full");
    const id = this.kinds.length;
    // media is lit smoke/dust/mist unless it says it glows (or is a blackbody flame)
    const lit = def.style === "media" && !def.temp && !def.absorbing ? { emissive: 0 } : null;
    const k = { name, id, def: { ...KIND_DEFAULTS, ...lit, ...def } };
    this.kinds.push(k);
    this.kindIndex.set(name, id);
    return id;
  }
  kind(name: string) {
    return this.kindIndex.get(name);
  }

  // live slider edits: no recompile, just texels
  setKind(id: string | number, patch: object) {
    const k = this.kinds[typeof id === "string" ? (this.kindIndex.get(id) as number) : id] as IKind;
    Object.assign(k.def, patch);
    if (this.built) {
      this.writeKind(k);
      this.kindTex.needsUpdate = true;
    }
  }

  // GPU-driven emission from the ground field: weights on (heat, char, wet, frost) and
  // (crack, acid, corruption, glow), minus threshold, times rate = spawn chance per slot per second
  fieldEmitter(
    kind: string | number,
    {
      slots = 1024,
      a = [0, 0, 0, 0],
      b = [0, 0, 0, 0],
      threshold = 0.2,
      rate = 2,
      lifeScale = 1,
      sizeScale = 1,
      up = 0.5,
    } = {},
  ) {
    const id = typeof kind === "string" ? (this.kindIndex.get(kind) as number) : kind;
    this.fieldDefs.push({
      kind: id,
      count: Math.max(64, Math.round(slots * Q.emission)),
      wa: a,
      wb: b,
      threshold,
      rate,
      lifeScale,
      sizeScale,
      up,
    });
  }

  writeKind(k: IKind) {
    const d = k.def;
    const o = k.id * KW * 4;
    const D = this.kindData;
    const [ca, cb] = [
      colorArr(d.color[0] as ColorRepresentation),
      colorArr((d.color[1] ?? d.color[0]) as ColorRepresentation),
    ];
    const style = STYLES.indexOf(d.style);
    const paint = d.paints ? PAINT_CHANNELS.indexOf(d.paints) + 1 : 0;
    const morph =
      d.morph != null
        ? (typeof d.morph === "string" ? (this.kindIndex.get(d.morph) as number) : d.morph) + 1
        : 0;
    const flags = (d.absorbing ? 1 : 0) | (d.killOnCollide ? 2 : 0) | (d.orbit ? 4 : 0);
    D.set(
      [
        d.drag,
        d.gravity,
        d.buoyancy,
        d.curl,
        d.curlScale,
        d.forceResponse,
        d.restitution,
        d.friction,
        d.life[0] as number,
        d.life[1] as number,
        d.size[0] as number,
        (d.size[1] ?? d.size[0]) as number,
        d.stretch,
        d.emissive,
        d.temp ? (d.temp[0] as number) : 0,
        d.temp ? ((d.temp[1] ?? d.temp[0]) as number) : 0,
        ...ca,
        d.alpha[0] as number,
        ...cb,
        (d.alpha[1] ?? d.alpha[0]) as number,
        // debris is 3 + variant / 10 (the sim tests > 2.5, the debris VS reads the variant)
        style === 2 ? 3 + MESHES.indexOf(d.mesh) * 0.1 : style,
        paint,
        morph,
        flags,
        d.toSmokeAt,
        d.smokeAlbedo,
        d.density,
        d.distortion,
        d.fadeIn,
        d.fadeOut,
        d.spin,
        d.sizePow,
        d.lightResponse,
        d.softness,
        d.erosion,
        d.paintAmount,
        d.flicker,
        0,
        0,
        0, // glow only: 0..1 per-particle twinkle (embers)
      ],
      o,
    );
  }

  // --- build once every spell has registered ---
  build() {
    const { W, H } = this;
    for (const k of this.kinds) this.writeKind(k);
    this.kindTex.needsUpdate = true;

    // row ranges: debris rows sized to Q.debris, the rest split glow 55% / media 45%
    const debrisRows = Math.max(1, Math.ceil(Q.debris / W));
    const rest = H - debrisRows;
    const glowRows = Math.round(rest * 0.55);
    const mediaRows = rest - glowRows;
    const rows: Record<Style, [number, number]> = {
      glow: [0, glowRows],
      media: [glowRows, mediaRows],
      debris: [glowRows + mediaRows, debrisRows],
    };
    for (const s of STYLES) {
      const [r0, nr] = rows[s];
      this.style[s] = {
        start: r0 * W,
        count: nr * W,
        field: 0,
        cursor: 0,
        log: new Float64Array(LOG_N * 3),
        head: 0,
        tail: 0,
        base: 0,
        window: 0,
        first: -1,
      };
    }
    // field blocks at the start of their style's range
    let fi = 0;
    for (const fd of this.fieldDefs) {
      const st = this.style[(this.kinds[fd.kind] as IKind).def.style];
      const count = Math.min(fd.count, Math.floor(st.count / 4));
      const o = fi * 4 * 4;
      this.fieldData.set(
        [
          st.start + st.field,
          count,
          fd.kind,
          fd.threshold,
          ...fd.wa,
          ...fd.wb,
          fd.rate,
          fd.lifeScale,
          fd.sizeScale,
          fd.up,
        ],
        o,
      );
      st.field += count;
      fi++;
    }
    this.fieldCount = fi;
    this.fieldTex.needsUpdate = true;

    // compute port: storage buffers in place of the two RGBA32F MRT targets
    const stateU: IState = {
      uS0: storageOf(W * H),
      uS1: storageOf(W * H),
      uS2: storageOf(W * H),
      uKinds: texOf(this.kindTex),
    };
    this.stateU = stateU;
    this.spans = Array.from({ length: 6 }, () => vec2U(new Vector2()));
    this.simU = {
      uEmitTex: texOf(this.emitTex),
      uEmitCount: uniform(0),
      uSpan: this.spans,
      uSpanCount: uniform(0),
      uFieldTex: texOf(this.fieldTex),
      uFieldCount: uniform(this.fieldCount),
      uSimDt: uniform(1 / 60),
      uGroundA: texture(U.uGroundA.value),
      uGroundB: texture(U.uGroundB.value),
    };
    this.sim = simKernel(W, H, stateU, this.simU);
    this.clear = clearKernel(W, H, stateU);
    // initialise every texel dead: the buffers start as zero (age 0 >= life 0 counts as dead)
    this.clearState(false);

    const quad = new InstancedBufferGeometry();
    quad.setAttribute(
      "position",
      new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    );
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    quad.instanceCount = 0;
    const styleU = (s: Style): IStyleU => ({
      uStyleStart: uniform(this.style[s].start),
      uStyleCount: uniform(this.style[s].count),
      uFieldCount: uniform(this.style[s].field),
      uRingBase: uniform(0),
    });
    for (const s of STYLES) this.styleU[s] = styleU(s);

    // glow (lines scene)
    const gq = quad.clone();
    this.glow = new Mesh(gq, glowMaterial(stateU, this.styleU.glow));
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 10;
    this.glow.layers.enable(1); // shows in the floor reflection
    this.glow.name = "ultra-particles-glow";

    // media (fx scene)
    const mq = quad.clone();
    this.media = new Mesh(mq, mediaMaterial(stateU, this.styleU.media));
    this.media.frustumCulled = false;
    this.media.name = "ultra-particles-media";

    // debris (opaque scene): one mesh per variant, each skips instances of other variants
    const debrisU = this.styleU.debris; // shared by the three variant materials
    this.debris = MESHES.map((variant, vi) => {
      const src =
        variant === "rock"
          ? rockGeometry()
          : variant === "shard"
            ? shardGeometry()
            : leafGeometry();
      const g = new InstancedBufferGeometry();
      for (const n of ["position", "normal", "uv"])
        if (src.attributes[n]) g.setAttribute(n, src.attributes[n] as BufferAttribute);
      g.instanceCount = 0;
      const mat = debrisMaterial(stateU, debrisU, vi, variant);
      mat.userData.u = debrisU;
      const m = new Mesh(g, mat);
      m.frustumCulled = false;
      m.layers.enable(1);
      m.name = `ultra-particles-debris-${variant}`;
      return m;
    });

    // paint into the ground field: one Points draw per style window
    // ENGINE-GAP: not ported (Points with gl_PointSize into the ground's MRT); see the header
    this.paint = [];
    this.built = true;
    for (const s of STYLES) this.setDraw(s, 0, 0);
  }

  clearState(dispatch = true) {
    this.recCount = 0;
    const u = this.simU;
    if (u) {
      u.uEmitCount.value = 0;
      u.uSpanCount.value = 0;
      u.uFieldCount.value = 0;
    }
    // the buffers go back to zero: age 0 >= life 0 counts as dead
    if (dispatch && this.clear) this.renderer?.compute(this.clear);
    for (const s of STYLES)
      if (this.style[s])
        Object.assign(this.style[s], { cursor: 0, head: 0, tail: 0, base: 0, window: 0 });
    if (u) u.uFieldCount.value = this.fieldCount ?? 0;
  }

  // --- emitters: reusable handles so continuous emission allocates nothing ---
  emitter(kind: string | number, opts: IEmitterOptions = {}) {
    const id = typeof kind === "string" ? this.kindIndex.get(kind) : kind;
    if (id === undefined) throw new Error(`unknown particle kind ${kind}`);
    const p = this;
    return {
      kind: id,
      shape: SHAPES[opts.shape ?? "sphere"],
      pos: new Vector3(),
      radius: opts.radius ?? 0.1,
      vel: new Vector3(),
      spread: opts.spread ?? 0,
      p: new Vector3(),
      radial: opts.radial ?? 0,
      size: opts.size ?? 1,
      life: opts.life ?? 1,
      cone: opts.cone ?? 0.4,
      acc: 0,
      burst(count: number) {
        p.emit(this, count);
      },
      // continuous: fractional accumulator so low rates still emit
      rate(perSecond: number, dt: number) {
        this.acc += perSecond * dt * Q.emission * Q.auto.emission;
        const n = Math.floor(this.acc);
        if (n > 0) {
          this.acc -= n;
          p.emit(this, n, true);
        }
      },
      setShape(name: keyof typeof SHAPES) {
        this.shape = SHAPES[name];
        return this;
      },
    };
  }

  emit(e: IEmitter, count: number, prescaled = false) {
    if (!this.built) return;
    const st = this.style[(this.kinds[e.kind] as IKind).def.style];
    const ring = st.count - st.field;
    let n = prescaled ? count : Math.round(count * Q.emission * Q.auto.emission);
    n = Math.min(n, ring);
    if (n <= 0) return;
    const def = (this.kinds[e.kind] as IKind).def;
    const life = (def.life[1] as number) * e.life;
    // the ground field only simulates (and accepts paint) where it was touched: cover the reach
    const mk = typeof def.morph === "string" ? this.kindIndex.get(def.morph) : def.morph;
    if ((def.paints || this.kinds[mk as number]?.def.paints) && this.ground?.touch) {
      const reach = Math.min(8, e.radius + 1 + 0.6 * life * (e.spread + e.vel.length()));
      this.ground.touch(e.pos.x, e.pos.z, reach, life);
    }
    let start = st.cursor;
    while (n > 0 && this.recCount < MAX_REC) {
      const take = Math.min(n, ring - start);
      const o = this.recCount * REC_W * 4;
      const D = this.emitData;
      D[o] = st.start + st.field + start;
      D[o + 1] = take;
      D[o + 2] = e.kind;
      D[o + 3] = e.shape;
      D[o + 4] = e.pos.x;
      D[o + 5] = e.pos.y;
      D[o + 6] = e.pos.z;
      D[o + 7] = e.radius;
      D[o + 8] = e.vel.x;
      D[o + 9] = e.vel.y;
      D[o + 10] = e.vel.z;
      D[o + 11] = e.spread;
      D[o + 12] = e.p.x;
      D[o + 13] = e.p.y;
      D[o + 14] = e.p.z;
      D[o + 15] = this.rand();
      D[o + 16] = e.radial;
      D[o + 17] = e.size;
      D[o + 18] = e.life;
      D[o + 19] = e.cone;
      this.recCount++;
      // emission log (ring): entries expire in order, the oldest live one is the draw window base
      const h = (st.head % LOG_N) * 3;
      st.log[h] = start;
      st.log[h + 1] = take;
      st.log[h + 2] = this.time + life;
      st.head++;
      if (st.head - st.tail > LOG_N) st.tail++;
      start = (start + take) % ring;
      n -= take;
    }
    st.cursor = start;
  }

  // once per frame, before rendering. dt is the scaled sim step.
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upstream Ultra Elements code, copied verbatim
  update(dt: number, time: number) {
    if (!this.built) return;
    this.time = time;
    const u = this.simU as ISimU;
    // spans this frame: per style, from the first record start to the cursor (wrapping)
    let sc = 0;
    for (const s of STYLES) this.style[s].first = -1;
    for (let r = 0; r < this.recCount; r++) {
      const o = r * REC_W * 4;
      const st = this.style[(this.kinds[this.emitData[o + 2] as number] as IKind).def.style];
      if (st.first < 0) st.first = this.emitData[o] as number;
    }
    for (const s of STYLES) {
      const st = this.style[s];
      if (st.first < 0) continue;
      const ringStart = st.start + st.field;
      const ring = st.count - st.field;
      const a = st.first;
      const b = ringStart + st.cursor;
      if (b > a) (this.spans[sc++] as UV2).value.set(a, b);
      else {
        (this.spans[sc++] as UV2).value.set(a, ringStart + ring);
        (this.spans[sc++] as UV2).value.set(ringStart, b === ringStart ? ringStart + ring : b);
      }
    }
    u.uSpanCount.value = sc;
    u.uEmitCount.value = this.recCount;
    if (this.recCount) this.emitTex.needsUpdate = true;
    u.uSimDt.value = dt;
    // field emitters read the ground field: off until GroundField has set its texture
    const groundReady = U.uGroundA.value !== GROUND_PLACEHOLDER;
    if (groundReady) {
      u.uGroundA.value = U.uGroundA.value;
      u.uGroundB.value = U.uGroundB.value;
    }
    u.uFieldCount.value = groundReady ? this.fieldCount : 0;
    this.renderer?.compute(this.sim); // the state is read and written in place (see the header)
    this.recCount = 0;

    // live windows: drop expired log entries, base = oldest live start
    this.alive = 0;
    for (const s of STYLES) {
      const st = this.style[s];
      const ring = st.count - st.field;
      const L = st.log;
      while (st.tail < st.head && (L[((st.tail % LOG_N) * 3 + 2) as number] as number) < time)
        st.tail++;
      for (let j = st.tail; j < st.head; j++) this.alive += L[(j % LOG_N) * 3 + 1] as number;
      const live = st.head > st.tail;
      st.base = live ? (L[(st.tail % LOG_N) * 3] as number) : st.cursor;
      st.window = live ? (st.cursor - st.base + ring) % ring || ring : 0;
      this.setDraw(s, st.base, st.field + st.window);
    }
    this.alive = Math.min(this.alive, this.W * this.H);
  }

  setDraw(s: Style, base: number, n: number) {
    const meshes = s === "glow" ? [this.glow] : s === "media" ? [this.media] : this.debris;
    for (const m of meshes) {
      (m.geometry as InstancedBufferGeometry).instanceCount = n;
      this.styleU[s].uRingBase.value = base;
      m.visible = n > 0;
    }
  }

  // everything visible for one warm-up frame (shader variants are built at first draw)
  warm(on: boolean) {
    if (!this.built) return;
    for (const s of STYLES) {
      const st = this.style[s];
      if (on) this.setDraw(s, 0, 1);
      else this.setDraw(s, st.base, st.field + st.window);
    }
  }
}

function debrisMaterial(st: IState, su: IStyleU, variant: number, name: string) {
  const mat = new MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: name === "shard" ? 0.08 : 0.85,
    metalness: 0,
    side: name === "leaf" ? DoubleSide : FrontSide,
  });
  // axisAngle(a, t) as its three GLSL mat3 columns
  const axisAngle = (a: V3, t: F): [V3, V3, V3] => {
    const c = cos(t);
    const s = sin(t);
    const C = float(1.0).sub(c);
    return [
      vec3(
        c.add(a.x.mul(a.x).mul(C)),
        a.y.mul(a.x).mul(C).add(a.z.mul(s)),
        a.z.mul(a.x).mul(C).sub(a.y.mul(s)),
      ),
      vec3(
        a.x.mul(a.y).mul(C).sub(a.z.mul(s)),
        c.add(a.y.mul(a.y).mul(C)),
        a.z.mul(a.y).mul(C).add(a.x.mul(s)),
      ),
      vec3(
        a.x.mul(a.z).mul(C).add(a.y.mul(s)),
        a.y.mul(a.z).mul(C).sub(a.x.mul(s)),
        c.add(a.z.mul(a.z).mul(C)),
      ),
    ] as [V3, V3, V3];
  };
  const mulCols = (m: [V3, V3, V3], v: V3): V3 =>
    m[0].mul(v.x).add(m[1].mul(v.y)).add(m[2].mul(v.z)) as V3;
  const hash3 = Fn(([p]: [F]) => {
    const p3 = fract(vec3(p).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
    p3.addAssign(dot(p3, p3.yzx.add(33.33)));
    return fract(p3.xxy.add(p3.yzz).mul(p3.zyx));
  });
  // debrisSetup()
  const idx = particleIndex(su, int(instanceIndex));
  const s0 = stateAt(st.uS0, idx);
  const s1 = stateAt(st.uS1, idx);
  const s2 = stateAt(st.uS2, idx);
  const kind = int(s2.x);
  const k2 = kindTexel(st, kind, 2);
  const k4 = kindTexel(st, kind, 4);
  const k5 = kindTexel(st, kind, 5);
  const k6 = kindTexel(st, kind, 6);
  const k8 = kindTexel(st, kind, 8);
  const t = s0.w.div(max(s1.w, 1e-4));
  const gDead = s0.w
    .greaterThanEqual(s1.w)
    .or(abs(fract(k6.x).mul(10.0).sub(variant)).greaterThan(0.5));
  const h = hash3(s2.y) as V3;
  const ax = normalize(h.sub(0.5).add(1e-4));
  const spinT = select(s2.w.greaterThan(0.0), s2.w, s0.w);
  const gRot = axisAngle(ax as V3, h.x.mul(6.283).add(k8.z.mul(spinT)) as F);
  const fade = float(1.0).sub(smoothstep(float(1.0).sub(max(k8.y, 1e-3)), 1.0, t));
  const gScale = mix(k2.z, k2.w, t)
    .mul(fract(s2.x))
    .mul(10.0)
    .mul(float(0.6).add(h.y.mul(0.8)))
    .mul(mix(0.0, 1.0, fade))
    .mul(smoothstep(0.0, 0.03, s0.w.add(0.01)));
  const gPos = s0.xyz;
  const vKindColor = varying(k4.rgb.mul(float(0.75).add(h.z.mul(0.5))));
  const vKindEmit = varying(k5.rgb.mul(pow(float(1.0).sub(t), 2.0)));
  const vRough = varying(k5.a);
  // begin_vertex
  mat.positionNode = select(
    gDead,
    vec3(0.0, -1000.0, 0.0),
    mulCols(gRot, positionGeometry).mul(gScale).add(gPos),
  );
  // beginnormal_vertex: objectNormal = gRot * normal. ENGINE-GAP: the Wasm engine has no normalLocal and
  // refuses a normalNode while the post chain reads the normal target, so the normal is the face normal
  // (flatShading). Rock and shard are faceted (non-indexed, computeVertexNormals), so that is the rotated
  // normal exactly; the leaf's two bent facets lose their smoothing.
  mat.flatShading = true;
  // color_fragment: diffuseColor.rgb *= vKindColor
  mat.colorNode = vKindColor;
  // roughnessmap_fragment
  mat.roughnessNode = select(vRough.greaterThan(0.0), vRough, float(mat.roughness));
  // emissivemap_fragment: totalEmissiveRadiance += vKindEmit
  mat.emissiveNode = vKindEmit;
  return mat;
}
