// Ported from Ultra Elements src/vfx/GroundField.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
import {
  AdditiveBlending,
  type Camera,
  Color,
  DataTexture,
  FloatType,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  OrthographicCamera,
  RGBAFormat,
  RenderTarget,
  RepeatWrapping,
  Scene,
  type Texture,
  Vector2,
  Vector4,
} from "three";
import {
  Break,
  Fn,
  If,
  Loop,
  abs,
  atan,
  clamp,
  cos,
  dot,
  exp,
  exp2,
  float,
  floor,
  fract,
  int,
  ivec2,
  length,
  log,
  log2,
  max,
  min,
  mix,
  pow,
  screenCoordinate,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  textureLoad,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { type Node, NodeMaterial, QuadMesh, type TextureNode } from "three/webgpu";
import { ARENA, U, groundA, groundB, hash12, hash33, setGroundTexture } from "./common.js";

type F = Node<"float">;
type V2 = Node<"vec2">;
type V4 = Node<"vec4">;
type B = Node<"bool">;
type TexNode = TextureNode<"vec4">;

// Ground reaction field: a floor-aligned 40 x 40 m ping-pong pair (RGBA16F MRT, linear, clamp)
//   A = (heat, char, wet, frost)      B = (crack, acid, corruption, glow)
// The sim pass steps every reaction, applies this frame's splats (uniform-bounded loop) and
// adds this frame's particle paint (paintScene, drawn additively into a cleared paint target).
// Frost, crack and corruption above 1 are "potential": a front advances into a neighbour with
// max(neighbour) - drop, so the initial potential sets the reach. Fronts are gated by a baked
// mask (frost: dendrite tips + noise, crack: voronoi vein network, corruption: warped veins).
// Slow decays use stochastic rounding: fp16 has 10 mantissa bits, so a tau = 25 s decay at
// 144 Hz (0.03% per frame) would otherwise round to no change at all.
//
// Partial update: a 1024^2 MRT pass is bandwidth bound (~0.11 ms on a 3060 even as a plain
// copy), so a frame only touches part of the field. Splats (and touch()) register regions
// that are stepped every frame (up to 4 "fast" boxes clustered from the live regions, padded
// by how far their fronts can reach); the rest is stepped in 32 rotating row bands with each
// band's accumulated dt, so slow decays still run everywhere. Last frame's rects are copied
// so both ping-pong targets stay identical outside what was stepped. Boxes may overlap (an
// overlap is just computed twice, identically). Paint only lands inside the fast boxes:
// spells that paint with particles must touch() their area.
//
// Engine (ThreeNative's C++ engine over WebGPU), each forced and named ENGINE-GAP below:
//  - no multi-target RenderTarget: A and B are two targets each, stepped by two passes (A's
//    reactions read only A, B's only B, so each pass computes its own half);
//  - no scissor on a RenderTarget: each pass draws its whole target once; the shader steps the same
//    fast boxes and band and copies every other texel, so the field is identical, only upstream's
//    bandwidth saving is lost;
//  - no uniform array read at a computed index: the splats and probe points live in small float
//    DataTextures (as common.ts packs the world);
//  - no synchronous readPixels / PBO fences: the fp16 rounding test and the probes read back
//    through readRenderTargetPixelsAsync.

export const MAX_SPLATS = 16,
  MAX_PROBES = 16;
const SPLAT_VEC4 = 5;
const MAX_REGIONS = 32;
const MAX_BOXES = 4;
const BANDS = 32;
const PATTERNS: Record<string, number> = { radial: 0, lichtenberg: 1, ring: 2, noise: 3, line: 4 };
// craters: where a heavy radial crack splat (crack >= 2: a meteor, not a spike's base) landed, so
// the floor draws its fractures radiating from there and concentric between them. (x, z, radius,
// strength fading with the cracks); the arena material reads them by reference.
// ponytail: one field, so module-level; the oldest/weakest of 4 is overwritten
export const CRACK_SOURCES = Array.from({ length: 4 }, () => new Vector4());
// hot line cracks (fissure vents): A = (x, z, x2, z2), B = (half-width, strength, seed, -); the arena
// floor draws the main fissure and en-echelon side cracks along them instead of the cell network
export const FISSURE_A = Array.from({ length: 4 }, () => new Vector4());
export const FISSURE_B = Array.from({ length: 4 }, () => new Vector4());

// particle paint: upstream's RawShaderMaterial (GLSL3) with ...PAINT_BLENDING and PAINT_FRAG_HEAD
// (two outputs), drawn into paintScene with paintCamera (ortho, ground rect). Outputs are per-frame
// increments. ENGINE-GAP: no MRT and no CustomBlending (One, One): a painter adds into A from
// paintScene and into B from paintSceneB, with AdditiveBlending (SrcAlpha, One) and alpha 1.
export const PAINT_BLENDING = {
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: AdditiveBlending,
};

// per-frame helpers live at module level: no closures allocated in update()
const area = (b: Vector4) => (b.z - b.x) * (b.w - b.y);
const decay = (dt: number, tau: number) => Math.exp(-dt / tau);
const G = ARENA.ground;
const P = ARENA.pool;

// --- FIELD_GLSL -------------------------------------------------------------------------
const G_MIN = () => vec2(G.min.x, G.min.y);
const G_SIZE = G.size;
const texelWorld = (fragCoord: V2, n: number): V2 => G_MIN().add(fragCoord.div(n).mul(G_SIZE));
const inPool = (xz: V2): B => {
  const d = abs(xz.sub(vec2(P.center.x, P.center.y)));
  return d.x.lessThan(P.half.x).and(d.y.lessThan(P.half.y));
};
// GLSL mod (x - y * floor(x / y)), spelled out so a negative x wraps the same on every back end
const gmod = (x: F, y: F | number): F => x.sub(floor(x.div(y)).mul(y));
const vnoise = Fn(([x]: [V2]) => {
  const i = floor(x);
  const u0 = fract(x);
  const u = u0.mul(u0).mul(float(3.0).sub(u0.mul(2.0)));
  return mix(
    mix(hash12(i), hash12(i.add(vec2(1, 0))), u.x),
    mix(hash12(i.add(vec2(0, 1))), hash12(i.add(vec2(1, 1))), u.x),
    u.y,
  );
});
const fbm2 = (x: V2): F =>
  vnoise(x)
    .mul(0.5)
    .add(vnoise(x.mul(2.03).add(17.1)).mul(0.3))
    .add(vnoise(x.mul(4.11).add(3.7)).mul(0.2));
// value noise periodic in x (period per) and optionally y (perY > 0); integer periods only
const vnoiseP = (x: V2, per: number, perY: number): F => {
  const i = floor(x);
  const u0 = fract(x);
  const u = u0.mul(u0).mul(float(3.0).sub(u0.mul(2.0)));
  const i0 = vec2(gmod(i.x, per), perY > 0.0 ? gmod(i.y, perY) : i.y);
  const i1 = vec2(gmod(i.x.add(1.0), per), perY > 0.0 ? gmod(i.y.add(1.0), perY) : i.y.add(1.0));
  return mix(
    mix(hash12(i0), hash12(vec2(i1.x, i0.y)), u.x),
    mix(hash12(vec2(i0.x, i1.y)), hash12(i1), u.x),
    u.y,
  );
};

// Static gate mask, baked once at field resolution (world-locked):
//   r frost needles (ridged streaks on hexagonal axes), g crack veins (voronoi edges, 2 scales), b corruption veins (warped), a fbm
// distance to the nearest voronoi edge (F2-F1 bisector distance, Quilez), in cells
const voronoiEdge = Fn(([x, seed]: [V2, F]) => {
  const i = floor(x);
  const fr = fract(x);
  const mg = vec2(0.0).toVar();
  const mr = vec2(0.0).toVar();
  const md = float(8.0).toVar();
  // ponytail: both scans unrolled (9 + 25 cells): a one-time bake, no nested loop names needed
  for (let y = -1; y <= 1; y++)
    for (let k = -1; k <= 1; k++) {
      const g = vec2(k, y);
      const o = hash33(vec3(i.add(g), seed)).xy;
      const r = g.add(o).sub(fr).toVar();
      const d = dot(r, r);
      If(d.lessThan(md), () => {
        md.assign(d);
        mr.assign(r);
        mg.assign(g);
      });
    }
  md.assign(8.0);
  for (let y = -2; y <= 2; y++)
    for (let k = -2; k <= 2; k++) {
      const g = mg.add(vec2(k, y));
      const o = hash33(vec3(i.add(g), seed)).xy;
      const r = g.add(o).sub(fr).toVar();
      If(dot(mr.sub(r), mr.sub(r)).greaterThan(1e-5), () => {
        md.assign(min(md, dot(mr.add(r).mul(0.5), r.sub(mr).normalize())));
      });
    }
  return md;
});

function maskNode(uNeedle: F): V4 {
  const vUv = uv() as unknown as V2;
  const w = G_MIN().add(vUv.mul(G_SIZE));
  // five fbms: crack warp xy, corruption warp xy, frost wobble
  const nv = [0, 1, 2, 3, 4].map((j) => fbm2(w.mul(j < 2 ? 0.9 : j < 4 ? 1.7 : 5.0).add(j * 9.1)));
  const nv4 = nv[4] as F;
  // ice grows needles along its hexagonal axes: thin ridged streaks at 0/60/120 degrees
  // (long along the axis, ~3 cm across), wobbled a little so they aren't ruler-straight
  let frost: F = float(0.0);
  for (let k = 0; k < 3; k++) {
    const an = k * 1.0472;
    // mat2(cos, sin, -sin, cos) * w (column-major)
    const c = Math.cos(an);
    const s = Math.sin(an);
    const q = vec2(w.x.mul(c).sub(w.y.mul(s)), w.x.mul(s).add(w.y.mul(c))).add(
      vec2(0.0, nv4.sub(0.5).mul(0.25)),
    );
    frost = max(
      frost,
      float(1.0).sub(
        abs(
          vnoise(vec2(q.x.mul(1.3), q.y.mul(uNeedle)).add(k * 31.7))
            .mul(2.0)
            .sub(1.0),
        ),
      ),
    );
  }
  const wc = w.add(
    vec2(nv[0] as F, nv[1] as F)
      .sub(0.5)
      .mul(0.6),
  );
  const wv = w.add(
    vec2(nv[2] as F, nv[3] as F)
      .sub(0.5)
      .mul(1.4),
  );
  // edge distance in metres for: crack plates (~1.4 m), sub-cracks (~0.45 m), and corruption's
  // strongly warped ~0.9 m cells (organic tendrils)
  const e = [1.4, 0.45, 0.9].map((cell, l) =>
    voronoiEdge((l === 2 ? wv : wc).div(cell), float(l + 1)).mul(cell),
  ) as [F, F, F];
  // >= 2 texels wide at 1024^2, so a diagonal vein stays 4-connected for the fronts. Noise
  // removes about half the sub-crack edges: cracks fork and dead-end instead of closing cells.
  const gaps = vnoise(w.mul(1.6).add(70.0));
  const crack = max(
    float(1.0)
      .sub(smoothstep(0.02, 0.08, e[0]))
      .mul(smoothstep(0.25, 0.35, gaps)),
    float(1.0)
      .sub(smoothstep(0.01, 0.06, e[1]))
      .mul(0.75)
      .mul(smoothstep(0.5, 0.6, gaps)),
  );
  const corr = float(1.0).sub(smoothstep(0.02, 0.08, e[2]));
  // a: tileable fbm, 60 cells across the field; the sim samples it as splat noise (snoise)
  let a: F = float(0.0);
  let amp = 0.5;
  for (let o = 0; o < 3; o++) {
    const per = 60.0 * (1 << o);
    a = a.add(vnoiseP(vUv.mul(per), per, per).mul(amp));
    amp *= o === 0 ? 0.6 : 0.67;
  }
  return vec4(frost, crack, corr, clamp(a.sub(0.5).mul(1.6).add(0.5), 0.0, 1.0));
}

// SIM_FRAG, split per output (ENGINE-GAP: no MRT)
interface ISimInputs {
  n: number;
  src: TexNode; // uA or uB
  mask: TexNode;
  paint: TexNode; // uPaintA or uPaintB
  splat: TexNode;
  uSplatCount: F;
  uSeed: F;
  uRound: F;
  uK: (F & { value: Vector4 })[];
  uFast: (F & { value: Vector4 })[];
  uBand: F & { value: Vector4 };
  uPaintOn: F;
}

// smooth tileable noise from the mask's fbm channel; x in noise cells (60 per field width).
// ENGINE-GAP: the engine samples a RenderTarget texture clamped whatever its wrapS/wrapT, so the
// repeat the mask's wrap asks for is done here (fract); upstream: texture(uMask, x / 60.0).a
const snoise = (mask: TexNode, x: V2): F =>
  (mask.sample(fract(x.mul(1.0 / 60.0))) as unknown as TexNode).level(float(0)).a;
const splatAt = (s: ISimInputs, i: F, k: number): V4 =>
  textureLoad(s.splat, ivec2(i.mul(SPLAT_VEC4).add(k).toInt(), 0)) as unknown as V4;

// coverage of splat i at world xz w
function splatShape(s: ISimInputs, i: F, w: V2): F {
  const s0 = splatAt(s, i, 0);
  const s3 = splatAt(s, i, 3);
  const s4 = splatAt(s, i, 4);
  const pat = s0.w;
  const R = s0.z;
  const seed = s3.x;
  const m = float(0.0).toVar();
  const ca = cos(s3.y);
  const sa = sin(s3.y);
  const d = w.sub(s0.xy);
  const nd = vec2(ca.mul(d.x).sub(sa.mul(d.y)), sa.mul(d.x).add(ca.mul(d.y)))
    .div(R)
    .toVar();
  const r = length(nd).toVar();
  const n = snoise(s.mask, nd.mul(3.0).add(seed.mul(7.31))).toVar();
  If(pat.equal(4.0), () => {
    // line (x, z) -> (x2, z2), half-width s4.x: jagged, tapered at both ends
    const ab = s3.zw.sub(s0.xy);
    const q = w.sub(s0.xy);
    const L = max(length(ab), 1e-3);
    const t = ab.div(L);
    const along = dot(q, t);
    const off = dot(q, vec2(t.y.negate(), t.x)).add(
      snoise(s.mask, vec2(along.mul(2.2), seed.mul(7.31)))
        .sub(0.5)
        .mul(s4.x)
        .mul(3.0),
    );
    const h = clamp(along.div(L), 0.0, 1.0);
    const hw = s4.x.mul(
      float(0.35).add(sqrt(clamp(min(h, float(1.0).sub(h)).mul(6.0), 0.0, 1.0)).mul(0.65)),
    );
    m.assign(
      smoothstep(hw, hw.mul(0.2), abs(off))
        .mul(float(0.7).add(snoise(s.mask, w.mul(9.0).add(seed)).mul(0.3)))
        .mul(step(hw.negate(), along))
        .mul(step(along, L.add(hw))),
    );
  }).Else(() => {
    If(r.lessThan(1.6), () => {
      If(pat.equal(0.0), () => {
        m.assign(
          smoothstep(1.0, 0.35, r.add(n.sub(0.5).mul(0.45))).mul(float(0.65).add(n.mul(0.5))),
        );
      }).Else(() => {
        If(pat.equal(2.0), () => {
          // ring at R, width s4.x (metres); s4.y > 0: lobed and broken (radius wanders)
          const cs = nd.div(max(r, 1e-3));
          const lob = snoise(s.mask, cs.mul(1.4).add(seed.mul(3.7)))
            .sub(0.5)
            .mul(3.0)
            .mul(s4.y);
          const x = r.sub(1.0).sub(lob).mul(R).div(s4.x).add(n.sub(0.5).mul(1.2));
          m.assign(
            exp(x.mul(x).mul(-2.0))
              .mul(float(0.6).add(n.mul(0.6)))
              .mul(
                mix(
                  1.0,
                  smoothstep(0.3, 0.55, snoise(s.mask, cs.mul(2.7).add(seed.mul(1.9)))),
                  min(s4.y.mul(3.0), 1.0),
                ),
              ),
          );
        }).Else(() => {
          If(pat.equal(3.0), () => {
            m.assign(
              smoothstep(1.0, 0.6, r).mul(
                smoothstep(
                  0.45,
                  0.62,
                  snoise(s.mask, nd.mul(2.2).add(seed.mul(3.1)).add(0.5)).add(
                    float(1.0).sub(r).mul(0.15),
                  ),
                ),
              ),
            );
          }).Else(() => {
            // lichtenberg: polar ridged noise stretched along the radius, so ridges run outward.
            // Angle is periodic (no seam). Each octave doubles the channels, starts further out,
            // wanders more, thins with radius and only shows near its parent channel: a fork.
            const th = atan(nd.y, nd.x).div(6.2831853).add(0.5);
            const lr = log(max(r, 0.03));
            const near = float(1.0).toVar();
            for (let o = 0; o < 4; o++) {
              const fo = o;
              const k = 7.0 * (1 << o);
              const warp = snoise(
                s.mask,
                nd
                  .mul(1.5 + fo)
                  .add(seed)
                  .add(fo * 3.3),
              )
                .sub(0.5)
                .mul(0.25 / k + 0.02); // turns
              const ridge = float(1.0)
                .sub(
                  abs(
                    vnoiseP(
                      vec2(
                        th.add(warp).mul(k),
                        lr
                          .mul(0.6)
                          .add(seed.mul(13.0))
                          .add(fo * 5.1),
                      ),
                      k,
                      0.0,
                    )
                      .mul(2.0)
                      .sub(1.0),
                  ),
                )
                .toVar();
              const reach = smoothstep(0.05 + fo * 0.12, 0.15 + fo * 0.15, r);
              m.assign(
                max(
                  m,
                  pow(
                    ridge,
                    r
                      .mul(1.5)
                      .add(0.5)
                      .mul(30.0 + fo * 12.0),
                  )
                    .mul(near)
                    .mul(reach)
                    .mul(1.0 - fo * 0.1),
                ),
              );
              near.mulAssign(smoothstep(0.2, 0.6, ridge));
            }
            const core = smoothstep(0.32, 0.0, r.add(n.sub(0.5).mul(0.3)));
            m.assign(max(core, m).mul(smoothstep(1.0, 0.55, r.add(n.sub(0.5).mul(0.3)))));
          });
        });
      });
    });
  });
  return m;
}

// the prelude both passes share: the fragment, its step kind and the per-step factors
function simPrelude(s: ISimInputs) {
  const fc = (screenCoordinate as unknown as V2).xy;
  const p = ivec2(floor(fc) as unknown as Node<"ivec2">);
  const inRect = (b: V4): B =>
    fc.x
      .greaterThanEqual(b.x)
      .and(fc.y.greaterThanEqual(b.y))
      .and(fc.x.lessThan(b.z))
      .and(fc.y.lessThan(b.w));
  let fast: B = inRect(s.uFast[0] as unknown as V4);
  for (let i = 1; i < MAX_BOXES; i++) fast = fast.or(inRect(s.uFast[i] as unknown as V4));
  const band = inRect(s.uBand as unknown as V4);
  const K = (i: number): V4 => select(fast, s.uK[i] as unknown as V4, s.uK[i + 7] as unknown as V4);
  const hi = s.n - 1;
  const fl = floor(fc);
  const load = (x: F, y: F): V4 => textureLoad(s.src, ivec2(x.toInt(), y.toInt())) as unknown as V4;
  const xl = max(fl.x.sub(1.0), 0.0);
  const xr = min(fl.x.add(1.0), hi);
  const yd = max(fl.y.sub(1.0), 0.0);
  const yu = min(fl.y.add(1.0), hi);
  return { fc, p, fast, band, K, fl, load, xl, xr, yd, yu };
}

function splatLoop(s: ISimInputs, fast: B, w: V2, apply: (i: F, m: F) => void): void {
  const splats = select(fast, s.uSplatCount, float(0.0)); // splats always lie inside the fast boxes
  Loop(MAX_SPLATS, ({ i }: { i: Node<"int"> }) => {
    const fi = float(i);
    If(fi.greaterThanEqual(splats), () => {
      Break();
    });
    const m = splatShape(s, fi, w).toVar();
    apply(fi, m);
  });
}

// stochastic rounding (1 ulp of dither, placed for how this GPU converts to fp16) keeps the
// tiny per-step decays unbiased; then snap dust to exact zero so idle texels stay 0
function roundOut(v: V4, dither: F, uRound: F): V4 {
  const ulp = exp2(floor(log2(max(v, vec4(6.2e-5)))).sub(10.0));
  const r = v.add(dither.add(uRound).mul(ulp));
  return r.mul(step(vec4(1.0 / 1024.0), r));
}

const simA = (s: ISimInputs) =>
  Fn(() => {
    const { fc, p, fast, band, K, fl, load, xl, xr, yd, yu } = simPrelude(s);
    const a = textureLoad(s.src, p) as unknown as V4;
    const out = vec4(a).toVar();
    // copy: keeps both ping-pong targets identical outside what was stepped
    If(fast.or(band), () => {
      const K0 = K(0);
      const K1 = K(1);
      const K2 = K(2);
      const K5 = K(5);
      const K6 = K(6);
      const aL = load(xl, fl.y);
      const aR = load(xr, fl.y);
      const aD = load(fl.x, yd);
      const aU = load(fl.x, yu);
      // diagonals of frost only: an 8-neighbour count tells a dendrite tip (1) from a flat front (3)
      const fDL = load(xl, yd).w;
      const fDR = load(xr, yd).w;
      const fUL = load(xl, yu).w;
      const fUR = load(xr, yu).w;
      const mask = textureLoad(s.mask, p) as unknown as V4;
      const w = texelWorld(fc, s.n).toVar();
      const rnd = hash33(vec3(fc, s.uSeed)).toVar();

      const heat = a.x.toVar();
      const chr = a.y.toVar();
      const wet = a.z.toVar();
      const frost = a.w.toVar();
      const fVis = min(frost, 1.0).toVar();

      // heat: 5-tap diffusion, decay, water evaporates (latent heat cools), frost melts to wet
      heat.addAssign(aL.x.add(aR.x).add(aD.x).add(aU.x).sub(heat.mul(4.0)).mul(K0.y));
      heat.mulAssign(K0.x);
      const evap = min(wet, K1.x.mul(heat)).toVar();
      wet.subAssign(evap);
      heat.subAssign(evap.mul(0.35));
      // branch-free on purpose here and below: FXC (ANGLE/D3D) compile time grows with every if
      frost.assign(select(heat.greaterThan(0.05), min(frost, 1.0), frost)); // heat kills potential: no spreading into fire
      const melt = min(frost, K1.z.mul(heat)).toVar();
      frost.subAssign(melt);
      wet.addAssign(melt);
      heat.assign(max(heat.sub(melt.mul(0.5)), 0.0));
      // char grows where hot and dry, then fades
      chr.addAssign(K0.z.mul(smoothstep(0.15, 0.7, heat)).mul(float(1.0).sub(min(wet, 1.0))));
      chr.mulAssign(K0.w);
      wet.mulAssign(K1.y);

      // frost front: dendrite tips advance at full rate, flat fronts at a fifth; water freezes
      // freely and with a smaller drop, so puddles and the pool ice over in sheets
      const frozenN = step(0.2, aL.w)
        .add(step(0.2, aR.w))
        .add(step(0.2, aD.w))
        .add(step(0.2, aU.w))
        .add(step(0.2, fDL))
        .add(step(0.2, fDR))
        .add(step(0.2, fUL))
        .add(step(0.2, fUR));
      const fMax = max(
        max(max(aL.w, aR.w), max(aD.w, aU.w)),
        max(max(fDL, fDR), max(fUL, fUR)).sub(K2.y.mul(0.414)),
      );
      const onWater = wet.greaterThan(0.3);
      // New frost nucleates by a Packard-style snowflake rule: where exactly one 8-neighbour is
      // frozen (a tip), flanks (2-3 neighbours) rarely, so fingers stay thin and fork instead of
      // merging into a disc. Inside existing frost the potential flows freely to feed the tips.
      const fGate = select(
        onWater.or(frost.greaterThan(0.2)),
        float(1.0),
        step(K2.z, mask.r).mul(
          select(
            frozenN.lessThan(1.5),
            float(1.0),
            select(frozenN.lessThan(2.5), float(0.02), float(0.001)),
          ),
        ),
      ).toVar();
      // band steps decay the neighbours too (uK6): over its long dt, undecayed neighbours would
      // refill every texel and stall the decay of whole frozen areas. Per frame it's negligible
      // and the fast steps keep the reach the look was tuned with.
      // the drop per texel (so a front's reach) varies over ~3 m patches, x0.55..1.6: frost reaches
      // further where the stone is colder, and a splat's front grows into lobes, never a circle
      const fReach = select(
        onWater,
        K2.w,
        float(0.55).add(
          (
            (s.mask.sample(fract(w.mul(1 / 150))) as unknown as TexNode) // ENGINE-GAP: fract, see snoise
              .level(float(0)) as unknown as V4
          ).a.mul(1.05),
        ),
      ).toVar();
      const fGrow = fMax.mul(K6.x).sub(K2.y.mul(fReach)).toVar();
      const fOld = fVis;
      frost.mulAssign(K1.w);
      frost.assign(max(frost, fGrow.mul(step(rnd.x, K2.x.mul(fGate))).mul(step(heat, 0.05))));
      wet.addAssign(
        max(fOld.sub(min(frost, 1.0)), 0.0)
          .mul(0.8)
          .mul(step(heat, 0.05)),
      ); // natural thaw -> puddle

      // the pool stays full; frost on it is the ice sheet (frost x wet), heat is quenched
      const pool = select(inPool(w), float(1.0), float(0.0));
      wet.assign(max(wet, pool));
      heat.mulAssign(mix(1.0, K5.y, pool));

      const A = vec4(heat, chr, wet, frost).toVar();
      If(fast.and(s.uPaintOn.equal(1.0)), () => {
        A.addAssign(textureLoad(s.paint, p) as unknown as V4);
      });
      splatLoop(s, fast, w, (i, m) => {
        const s1 = splatAt(s, i, 1);
        // potential channels take the max (re-splatting doesn't stack reach); negative erases
        A.assign(
          vec4(
            A.xyz.add(s1.xyz.mul(m)),
            select(s1.w.greaterThanEqual(0.0), max(A.w, s1.w.mul(m)), A.w.add(s1.w.mul(m))),
          ),
        );
      });
      A.assign(clamp(A, vec4(0.0), vec4(2.0, 1.0, 1.0, 4.0)));
      out.assign(roundOut(A, rnd.x, s.uRound));
    });
    return out;
  })();

const simB = (s: ISimInputs) =>
  Fn(() => {
    const { fc, p, fast, band, K, fl, load, xl, xr, yd, yu } = simPrelude(s);
    const b = textureLoad(s.src, p) as unknown as V4;
    const out = vec4(b).toVar();
    If(fast.or(band), () => {
      const K3 = K(3);
      const K4 = K(4);
      const K5 = K(5);
      const K6 = K(6);
      const bL = load(xl, fl.y);
      const bR = load(xr, fl.y);
      const bD = load(fl.x, yd);
      const bU = load(fl.x, yu);
      const mask = textureLoad(s.mask, p) as unknown as V4;
      const w = texelWorld(fc, s.n).toVar();
      const rnd = hash33(vec3(fc, s.uSeed)).toVar();
      const crack = b.x.toVar();
      const acid = b.y.toVar();
      const corr = b.z.toVar();
      const glow = b.w.toVar();

      // crack front along the vein network
      const cMax = max(max(bL.x, bR.x), max(bD.x, bU.x));
      crack.mulAssign(K3.z);
      crack.assign(
        max(
          crack,
          cMax
            .mul(K6.y)
            .sub(K3.y)
            .mul(step(rnd.y, K3.x.mul(step(0.45, mask.g)))),
        ),
      );

      // corruption: spreads as a lobed stain (faster where the fbm is high), falling off with distance
      // from its source; the arena material draws the crack network through it, so the field itself
      // carries no veins (a vein-gated front read as one even tiling of glowing cells)
      const vMax = max(max(bL.z, bR.z), max(bD.z, bU.z));
      corr.mulAssign(K4.z);
      const vGate = float(0.15).add(mask.a.mul(mask.a).mul(0.85));
      corr.assign(
        max(
          corr,
          vMax
            .mul(K6.z)
            .sub(K4.y)
            .mul(step(rnd.z, K4.x.mul(vGate))),
        ),
      );
      corr.assign(max(corr.sub(K5.z.mul(glow)), 0.0)); // holy light burns corruption away

      // acid: slow decay, slight spread; glow: fast decay
      acid.addAssign(bL.y.add(bR.y).add(bD.y).add(bU.y).sub(acid.mul(4.0)).mul(K5.x));
      acid.mulAssign(K3.w);
      glow.mulAssign(K4.w);

      const Bv = vec4(crack, acid, corr, glow).toVar();
      If(fast.and(s.uPaintOn.equal(1.0)), () => {
        Bv.addAssign(textureLoad(s.paint, p) as unknown as V4);
      });
      splatLoop(s, fast, w, (i, m) => {
        const s2 = splatAt(s, i, 2);
        const y = Bv.y.add(s2.y.mul(m));
        const ww = Bv.w.add(s2.w.mul(m));
        Bv.assign(
          vec4(
            select(s2.x.greaterThanEqual(0.0), max(Bv.x, s2.x.mul(m)), Bv.x.add(s2.x.mul(m))),
            y,
            select(s2.z.greaterThanEqual(0.0), max(Bv.z, s2.z.mul(m)), Bv.z.add(s2.z.mul(m))),
            ww,
          ),
        );
      });
      Bv.assign(clamp(Bv, vec4(0.0), vec4(4.0, 1.0, 4.0, 8.0)));
      out.assign(roundOut(Bv, fract(rnd.x.add(0.618)), s.uRound));
    });
    return out;
  })();

// probe pass: per probe two texels (A, B) at the probe's world xz
const probeNode = (probeTex: TexNode) =>
  Fn(() => {
    const x = floor((screenCoordinate as unknown as V2).x);
    const i = floor(x.mul(0.5));
    const xz = (textureLoad(probeTex, ivec2(i.toInt(), 0)) as unknown as V4).xy;
    return select(gmod(x, 2.0).lessThan(0.5), groundA(xz), groundB(xz));
  })();

// what GroundField draws with (three's WebGPURenderer subset)
export interface IFieldRenderer {
  setRenderTarget(target: RenderTarget | null): void;
  getRenderTarget(): RenderTarget | null;
  render(scene: object, camera: Camera): void;
  getClearColor(target: Color): Color;
  getClearAlpha(): number;
  setClearColor(color: Color | number, alpha?: number): void;
  readRenderTargetPixelsAsync(
    target: RenderTarget,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Promise<ArrayLike<number>>;
  // ENGINE-GAP: the Wasm renderer refuses a render() while two frames are still on the GPU and
  // counts it here; a refused field pass would lose its splats (see _step)
  info?: { engine?: { frameGateSkips?: number } };
}

// ENGINE-GAP: no MRT; one ping-pong state is a pair of targets (A, B), read as textures[0] / [1]
interface IFieldTarget {
  a: RenderTarget;
  b: RenderTarget;
  textures: [Texture, Texture];
}

interface IRegion {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  until: number;
}

export interface ISplat {
  x?: number;
  z?: number;
  radius?: number;
  heat?: number;
  char?: number;
  wet?: number;
  frost?: number;
  crack?: number;
  acid?: number;
  corruption?: number;
  glow?: number;
  pattern?: string;
  seed?: number;
  angle?: number;
  x2?: number;
  z2?: number;
  width?: number;
  lobe?: number;
}

export class GroundField {
  readonly renderer: IFieldRenderer;
  readonly size: number;
  readonly partial: boolean;
  readonly targets: [IFieldTarget, IFieldTarget];
  parity = 0;
  // live-tunable rates (world units, seconds); turned into per-step factors in update()
  params = {
    heatTau: 2.5,
    heatDiffusion: 0.012,
    charRate: 1.4,
    charTau: 25,
    evaporation: 0.9,
    wetTau: 45,
    melt: 1.2,
    frostTau: 7,
    frostSpeed: 1.6,
    frostDrop: 0.4,
    frostThreshold: 0.88,
    frostWaterDrop: 0.2,
    crackSpeed: 4,
    crackDrop: 0.6,
    crackTau: 9,
    corruptionSpeed: 1.1,
    corruptionDrop: 0.4,
    corruptionTau: 14,
    acidTau: 14,
    acidSpread: 0.0015,
    glowTau: 1,
    poolQuench: 0.3,
    cleanse: 1.5,
  };
  readonly mask: RenderTarget;
  readonly splatVecs: Vector4[];
  splatCount = 0;
  seed = 0;
  fp16Truncates = false;
  time = 0;
  readonly regions: IRegion[];
  readonly boxes: Vector4[]; // texel rects [x0, y0, x1, y1) stepped this frame
  boxCount = 0;
  band = 0;
  readonly bandDt: Float32Array;
  private _full = true; // next update steps everything (after clear)
  private _q = new Vector4();
  private _u = new Vector4();
  private readonly _k: Vector4[];
  private readonly _bandRect: Vector4;
  private readonly _splatData: Float32Array;
  private readonly _splatTex: DataTexture;
  private readonly _uni: {
    uSplatCount: F & { value: number };
    uSeed: F & { value: number };
    uRound: F & { value: number };
    uPaintOn: F & { value: number };
  };
  private readonly _srcA: TexNode;
  private readonly _srcB: TexNode;
  private readonly _simA: NodeMaterial;
  private readonly _simB: NodeMaterial;
  private readonly _zero: NodeMaterial;
  private readonly _quad: QuadMesh;
  readonly paintTargetA: RenderTarget;
  readonly paintTargetB: RenderTarget;
  private readonly _clearColor = new Color();
  readonly paintScene = new Scene();
  readonly paintSceneB = new Scene();
  readonly paintCamera: OrthographicCamera;
  // probes
  readonly probes = new Float32Array(MAX_PROBES * 8); // per probe: heat, char, wet, frost, crack, acid, corruption, glow
  probeCount = 0; // probes in the last completed read
  private _probeN = 0;
  private readonly _probeXZ: Vector2[];
  private readonly _probeData = new Float32Array(MAX_PROBES * 4);
  private readonly _probeTex: DataTexture;
  readonly probeRT: RenderTarget;
  private readonly _probeMat: NodeMaterial;
  private _probeReading = false;
  private _maskMat: NodeMaterial | null; // ENGINE-GAP: kept until the bake gets past the frame gate

  // partial: false steps the whole field every frame (reference / debugging, ~0.1 ms at 1024^2)
  constructor(renderer: IFieldRenderer, size = 1024, { partial = true } = {}) {
    this.renderer = renderer;
    this.size = size;
    this.partial = partial;
    const opts = {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    };
    // ENGINE-GAP: a RenderTarget takes no wrapS / wrapT / generateMipmaps option: the wraps are set
    // on its texture (ClampToEdge is the default) and a target has no mip chain

    const pair = (): IFieldTarget => {
      const a = new RenderTarget(size, size, opts);
      const b = new RenderTarget(size, size, opts);
      return { a, b, textures: [a.texture, b.texture] };
    };
    this.targets = [pair(), pair()];

    // the sim texelFetches r/g/b; splats sample a (tileable) filtered, so repeat + linear
    this.mask = new RenderTarget(size, size, {
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
    });
    this.mask.texture.wrapS = this.mask.texture.wrapT = RepeatWrapping;
    const maskMat = new NodeMaterial();
    maskMat.fragmentNode = maskNode(float(9 * Math.min(1, size / 1024)));

    this.splatVecs = Array.from({ length: MAX_SPLATS * SPLAT_VEC4 }, () => new Vector4());
    this._splatData = new Float32Array(MAX_SPLATS * SPLAT_VEC4 * 4);
    this._splatTex = new DataTexture(
      this._splatData,
      MAX_SPLATS * SPLAT_VEC4,
      1,
      RGBAFormat,
      FloatType,
    );
    this._splatTex.minFilter = this._splatTex.magFilter = NearestFilter;
    this._splatTex.needsUpdate = true;
    // per-step factors, [0..6] for the fast boxes (this frame's dt), [7..13] for the band (its
    // accumulated dt); layout in simA / simB
    const uK = Array.from(
      { length: 14 },
      () => uniform(new Vector4()) as unknown as F & { value: Vector4 },
    );
    this._k = uK.map((u) => u.value);
    const uFast = Array.from(
      { length: MAX_BOXES },
      () => uniform(new Vector4()) as unknown as F & { value: Vector4 },
    );
    const uBand = uniform(new Vector4()) as unknown as F & { value: Vector4 };
    this._uni = {
      uSplatCount: uniform(0) as unknown as F & { value: number },
      uSeed: uniform(0) as unknown as F & { value: number },
      uRound: uniform(-0.5) as unknown as F & { value: number }, // dither offset in ulps: -0.5 if fp16 writes round to nearest, 0 if they truncate
      uPaintOn: uniform(0) as unknown as F & { value: number },
    };
    // partial-update bookkeeping (world-space regions -> texel rects); all preallocated
    this.regions = Array.from({ length: MAX_REGIONS }, () => ({
      x0: 0,
      z0: 0,
      x1: 0,
      z1: 0,
      until: -1,
    }));
    this.boxes = uFast.map((u) => u.value);
    this._bandRect = uBand.value;
    this.bandDt = new Float32Array(BANDS);

    // particle paint: x right, y = +z (camera below the floor looking up keeps both axes positive).
    // Its own targets, so overlapping fast boxes can't add the same paint twice.
    const paintOpts = { ...opts, minFilter: NearestFilter, magFilter: NearestFilter };
    this.paintTargetA = new RenderTarget(size, size, paintOpts);
    this.paintTargetB = new RenderTarget(size, size, paintOpts);
    this.paintCamera = new OrthographicCamera(
      G.min.x,
      G.min.x + G.size,
      G.min.y + G.size,
      G.min.y,
      0,
      200,
    );
    this.paintCamera.position.set(0, -100, 0);
    this.paintCamera.up.set(0, 0, 1);
    this.paintCamera.lookAt(0, 0, 0);
    this.paintCamera.updateMatrixWorld();

    const t0 = this.targets[0];
    this._srcA = texture(t0.textures[0]) as unknown as TexNode;
    this._srcB = texture(t0.textures[1]) as unknown as TexNode;
    const maskTex = texture(this.mask.texture) as unknown as TexNode;
    const splatTex = texture(this._splatTex) as unknown as TexNode;
    const inputs = (src: TexNode, paint: RenderTarget): ISimInputs => ({
      n: size,
      src,
      mask: maskTex,
      paint: texture(paint.texture) as unknown as TexNode,
      splat: splatTex,
      ...this._uni,
      uK,
      uFast,
      uBand,
    });
    this._simA = new NodeMaterial();
    this._simA.fragmentNode = simA(inputs(this._srcA, this.paintTargetA));
    this._simB = new NodeMaterial();
    this._simB.fragmentNode = simB(inputs(this._srcB, this.paintTargetB));
    this._zero = new NodeMaterial();
    this._zero.fragmentNode = vec4(0.0);
    this._quad = new QuadMesh(maskMat);

    // probes
    this._probeXZ = Array.from({ length: MAX_PROBES }, () => new Vector2());
    this._probeTex = new DataTexture(this._probeData, MAX_PROBES, 1, RGBAFormat, FloatType);
    this._probeTex.minFilter = this._probeTex.magFilter = NearestFilter;
    this._probeTex.needsUpdate = true;
    this.probeRT = new RenderTarget(MAX_PROBES * 2, 1, {
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
    });

    // the bake: the mask once (the sim then reads it)
    this._maskMat = maskMat;
    this._bakeMask();
    // fp16 render-target writes truncate on some GPUs (ANGLE/D3D11 measured: 1 + 0.75 ulp -> 1)
    // and round on others; a truncating GPU with +-0.5 ulp dither decays ~20% too fast
    const roundRT = new RenderTarget(1, 1, opts);
    const roundMat = new NodeMaterial();
    roundMat.fragmentNode = vec4(1.0 + 0.75 / 1024.0);
    this._draw(roundMat, roundRT);
    roundMat.dispose();
    renderer
      .readRenderTargetPixelsAsync(roundRT, 0, 0, 1, 1)
      .then((half) => {
        this.fp16Truncates = half[0] === 0x3c00;
        this._uni.uRound.value = this.fp16Truncates ? 0 : -0.5;
      })
      .finally(() => roundRT.dispose());
    this.clear();
    // after clear(): U.uGroundA/B hold this field's textures, so the probe reads the field
    this._probeMat = new NodeMaterial();
    this._probeMat.fragmentNode = probeNode(texture(this._probeTex) as unknown as TexNode);
  }

  get current(): IFieldTarget {
    return this.targets[this.parity] as IFieldTarget;
  }

  // queue a splat for the next update (<= 16 per frame; extras are dropped)
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upstream Ultra Elements code, copied verbatim
  splat({
    x = 0,
    z = 0,
    radius = 1,
    heat = 0,
    char = 0,
    wet = 0,
    frost = 0,
    crack = 0,
    acid = 0,
    corruption = 0,
    glow = 0,
    pattern = "radial",
    seed = Math.random() * 100,
    angle = 0,
    x2 = x,
    z2 = z,
    width = 0,
    lobe = 0,
  }: ISplat = {}): boolean {
    if (this.splatCount >= MAX_SPLATS) return false;
    const v = this.splatVecs;
    const o = this.splatCount * SPLAT_VEC4;
    (v[o] as Vector4).set(x, z, radius, PATTERNS[pattern] ?? 0);
    (v[o + 1] as Vector4).set(heat, char, wet, frost);
    (v[o + 2] as Vector4).set(crack, acid, corruption, glow);
    (v[o + 3] as Vector4).set(seed % 100, angle, x2, z2);
    const w = width || (pattern === "line" ? radius : radius * 0.18);
    (v[o + 4] as Vector4).set(w, lobe, 0, 0); // line half-width / ring width, ring lobes
    this.splatCount++;
    if (pattern === "radial" && crack >= 2) {
      let i = 0;
      for (let j = 1; j < 4; j++)
        if ((CRACK_SOURCES[j] as Vector4).w < (CRACK_SOURCES[i] as Vector4).w) i = j;
      (CRACK_SOURCES[i] as Vector4).set(x, z, radius, crack);
    }
    if (pattern === "line" && crack >= 1.5 && heat > 0.1 && w >= 0.25) {
      // a growing vent re-splats from the same start every frame: update its slot, else the weakest
      let i = -1;
      let m = 0;
      for (let j = 0; j < 4; j++) {
        const a = FISSURE_A[j] as Vector4;
        if ((FISSURE_B[j] as Vector4).y > 0 && Math.abs(a.x - x) < 0.05 && Math.abs(a.y - z) < 0.05)
          i = j;
        if ((FISSURE_B[j] as Vector4).y < (FISSURE_B[m] as Vector4).y) m = j;
      }
      if (i < 0) {
        i = m;
        (FISSURE_B[i] as Vector4).set(0, 0, 0, 0);
      }
      const fb = FISSURE_B[i] as Vector4;
      (FISSURE_A[i] as Vector4).set(x, z, x2, z2);
      fb.set(Math.max(w, fb.x), Math.max(crack, fb.y), seed % 97, 0);
    }

    // region the splat's effects live in: its footprint, plus how far fronts and heat can
    // travel, for as long as they keep moving (afterwards the bands carry the slow decay)
    const p = this.params;
    const ext = pattern === "line" ? w * 2.5 : radius * 1.6;
    const reach = Math.max(
      frost / p.frostDrop,
      crack / p.crackDrop,
      corruption / p.corruptionDrop,
      0,
    );
    const life = Math.min(
      20,
      Math.max(
        heat > 0 ? 3 * p.heatTau : 0,
        glow > 0 ? 3 * p.glowTau : 0,
        frost > 0 ? (reach / p.frostSpeed) * 1.5 + 1 : 0,
        crack > 0 ? (reach / p.crackSpeed) * 1.5 + 1 : 0,
        corruption > 0 ? (reach / p.corruptionSpeed) * 2 + 1 : 0,
        0.5,
      ),
    );
    const m = ext + reach + (heat > 0 ? 0.6 : 0.1);
    this._region(
      Math.min(x, x2) - m,
      Math.min(z, z2) - m,
      Math.max(x, x2) + m,
      Math.max(z, z2) + m,
      life,
    );
    // ice on the pool spreads in a sheet much further than on stone: keep the whole pool live
    if (
      frost > 0 &&
      Math.abs(x - P.center.x) < P.half.x + m &&
      Math.abs(z - P.center.y) < P.half.y + m
    )
      this._region(
        P.center.x - P.half.x,
        P.center.y - P.half.y,
        P.center.x + P.half.x,
        P.center.y + P.half.y,
        life,
      );
    return true;
  }

  // keep a world area stepped every frame for `seconds` (e.g. where particles paint)
  touch(x: number, z: number, radius: number, seconds = 1): void {
    this._region(x - radius, z - radius, x + radius, z + radius, seconds);
  }

  _region(x0: number, z0: number, x1: number, z1: number, seconds: number): void {
    let r: IRegion | null = null;
    let soonest = this.regions[0] as IRegion;
    for (const q of this.regions) {
      if (q.until < this.time) {
        r = q;
        break;
      }
      if (q.until < soonest.until) soonest = q;
    }
    let until = this.time + seconds;
    if (!r) {
      // ponytail: all slots live -> merge into the soonest-expiring one (a superset, still correct)
      r = soonest;
      // biome-ignore lint/style/noParameterAssign: upstream Ultra Elements code, copied verbatim
      x0 = Math.min(x0, r.x0);
      // biome-ignore lint/style/noParameterAssign: upstream Ultra Elements code, copied verbatim
      z0 = Math.min(z0, r.z0);
      // biome-ignore lint/style/noParameterAssign: upstream Ultra Elements code, copied verbatim
      x1 = Math.max(x1, r.x1);
      // biome-ignore lint/style/noParameterAssign: upstream Ultra Elements code, copied verbatim
      z1 = Math.max(z1, r.z1);
      until = Math.max(until, r.until);
    }
    r.x0 = x0;
    r.z0 = z0;
    r.x1 = x1;
    r.z1 = z1;
    r.until = until;
  }

  update(dt: number): void {
    if (this._maskMat) this._bakeMask();
    this.time += dt;
    const cd = decay(dt, this.params.crackTau);
    for (const c of CRACK_SOURCES) c.w *= cd;
    for (const b of FISSURE_B) b.y *= cd;
    const n = this.size;
    const k = this._k;
    const band = this._bandRect;
    for (const b of this.boxes) b.set(0, 0, 0, 0);
    if (this._full || !this.partial) {
      (this.boxes[0] as Vector4).set(0, 0, n, n);
      this.boxCount = 1;
      band.set(0, 0, 0, 0);
      this._full = false;
    } else {
      this._cluster();
      const h = n / BANDS;
      band.set(0, this.band * h, n, (this.band + 1) * h);
    }
    for (let i = 0; i < BANDS; i++) this.bandDt[i] = (this.bandDt[i] as number) + dt;
    if (band.w === 0) this.bandDt.fill(0); // full step: every band is current
    this._factors(k, 0, dt, false);
    this._factors(k, 7, this.bandDt[this.band] as number, true);
    // ponytail: texels that just left the fast boxes get their band's whole accumulated dt
    // (slightly early decay at a region's edge); per-texel step times would need a channel
    this.bandDt[this.band] = 0;
    this._step();
    this.band = (this.band + 1) % BANDS;
    this._readProbes();
  }

  // live regions -> <= 4 texel boxes (overlap allowed). A region joins a box when the union
  // is cheaper than drawing both, else opens a box; with all 4 open it joins the cheapest.
  // Then boxes whose union is cheaper than the pair are fused.
  // ponytail: greedy, order dependent; fine for a handful of spells, k-means if arenas get busy
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upstream Ultra Elements code, copied verbatim
  _cluster(): void {
    const n = this.size;
    const B = this.boxes;
    const q = this._q;
    const u = this._u;
    const s = n / G.size;
    let nb = 0;
    for (const r of this.regions) {
      if (r.until < this.time) continue;
      q.set(
        Math.round((r.x0 - G.min.x) * s),
        Math.round((r.z0 - G.min.y) * s),
        Math.round((r.x1 - G.min.x) * s),
        Math.round((r.z1 - G.min.y) * s),
      );
      q.clampScalar(0, n);
      if (q.z <= q.x || q.w <= q.y) continue;
      // join the box where the union costs least extra over drawing both; only when that
      // saves texels, unless all boxes are taken
      let best = -1;
      let extra = Number.POSITIVE_INFINITY;
      for (let i = 0; i < nb; i++) {
        const b = B[i] as Vector4;
        u.set(Math.min(b.x, q.x), Math.min(b.y, q.y), Math.max(b.z, q.z), Math.max(b.w, q.w));
        const e = area(u) - area(b) - area(q);
        if ((e < 0 || nb === MAX_BOXES) && e < extra) {
          best = i;
          extra = e;
        }
      }
      if (best < 0) {
        (B[nb++] as Vector4).copy(q);
        continue;
      }
      const b = B[best] as Vector4;
      b.set(Math.min(b.x, q.x), Math.min(b.y, q.y), Math.max(b.z, q.z), Math.max(b.w, q.w));
    }
    for (let i = 0; i < nb; i++)
      for (let j = i + 1; j < nb; j++) {
        const a = B[i] as Vector4;
        const b = B[j] as Vector4;
        u.set(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.z, b.z), Math.max(a.w, b.w));
        if (area(u) >= area(a) + area(b)) continue;
        a.copy(u);
        b.copy(B[--nb] as Vector4);
        (B[nb] as Vector4).set(0, 0, 0, 0);
        j = i; // a grew: recheck it against everything after it
      }
    this.boxCount = nb;
  }

  // per-step factors for a step of length dt into uK[o .. o + 6] (layout in simA / simB):
  //   0 heat decay, heat diffusion alpha, char gain, char decay
  //   1 evaporation, wet decay, melt, frost decay
  //   2 frost advance p, frost drop/texel, frost threshold, frost drop factor on water
  //   3 crack p, crack drop, crack decay, acid decay
  //   4 corruption p, corruption drop, corruption decay, glow decay
  //   5 acid alpha, pool quench, cleanse, dt
  //   6 neighbour decay for the frost, crack, corruption fronts (1 in fast steps), unused
  _factors(k: Vector4[], o: number, dt: number, band: boolean): void {
    const p = this.params;
    const dx = G.size / this.size;
    const adv = dt / dx; // front advance probability = speed * adv
    const K = (i: number) => k[o + i] as Vector4;
    K(0).set(
      decay(dt, p.heatTau),
      Math.min(0.2, (p.heatDiffusion * dt) / (dx * dx)),
      p.charRate * dt,
      decay(dt, p.charTau),
    );
    K(1).set(p.evaporation * dt, decay(dt, p.wetTau), p.melt * dt, decay(dt, p.frostTau));
    K(2).set(Math.min(1, p.frostSpeed * adv), p.frostDrop * dx, p.frostThreshold, p.frostWaterDrop);
    K(3).set(
      Math.min(1, p.crackSpeed * adv),
      p.crackDrop * dx,
      decay(dt, p.crackTau),
      decay(dt, p.acidTau),
    );
    K(4).set(
      Math.min(1, p.corruptionSpeed * adv),
      p.corruptionDrop * dx,
      decay(dt, p.corruptionTau),
      decay(dt, p.glowTau),
    );
    K(5).set(
      Math.min(0.2, (p.acidSpread * dt) / (dx * dx)),
      decay(dt, p.poolQuench),
      p.cleanse * dt,
      dt,
    );
    if (band) K(6).set(K(1).w, K(3).z, K(4).z, 0);
    else K(6).set(1, 1, 1, 0);
  }

  // ENGINE-GAP: frames the Wasm renderer's gate refused so far (0 on renderers without the gate)
  _skips(): number {
    return this.renderer.info?.engine?.frameGateSkips ?? 0;
  }

  _bakeMask(): void {
    const before = this._skips();
    this._draw(this._maskMat as NodeMaterial, this.mask);
    if (this._skips() !== before) return; // refused: the next update() bakes again
    this._maskMat?.dispose();
    this._maskMat = null;
  }

  _step(): void {
    const r = this.renderer;
    const skips = this._skips();
    const u = this._uni;
    const src = this.targets[this.parity] as IFieldTarget;
    const dst = this.targets[this.parity ^ 1] as IFieldTarget;
    this._srcA.value = src.textures[0];
    this._srcB.value = src.textures[1];
    u.uSplatCount.value = this.splatCount;
    u.uSeed.value = this.seed = (this.seed + 1) % 4096;
    if (this.splatCount > 0) {
      for (let i = 0; i < this.splatCount * SPLAT_VEC4; i++)
        (this.splatVecs[i] as Vector4).toArray(this._splatData, i * 4);
      this._splatTex.needsUpdate = true;
    }
    const nb = this.boxCount;
    const painting =
      (this.paintScene.children.length > 0 || this.paintSceneB.children.length > 0) && nb > 0;
    u.uPaintOn.value = painting ? 1 : 0;
    if (painting) {
      r.getClearColor(this._clearColor);
      const ca = r.getClearAlpha();
      r.setClearColor(0x000000, 0);
      // ENGINE-GAP: no MRT; a target draw clears to the clear colour first (upstream: clear, then draw)
      const prev = r.getRenderTarget();
      r.setRenderTarget(this.paintTargetA);
      r.render(this.paintScene, this.paintCamera);
      r.setRenderTarget(this.paintTargetB);
      r.render(this.paintSceneB, this.paintCamera);
      r.setRenderTarget(prev);
      r.setClearColor(this._clearColor, ca);
    }
    // ENGINE-GAP: no RenderTarget scissor. Upstream draws scissored rects over everything stepped
    // now or last frame; the whole target drawn once steps the same texels and copies the rest.
    this._draw(this._simA, dst.a);
    this._draw(this._simB, dst.b);
    // ENGINE-GAP: a pass the frame gate refused left dst stale: keep src, the splats and the
    // ground textures, and step again next frame (upstream draws are never refused)
    if (this._skips() !== skips) return;
    this.splatCount = 0;
    this.parity ^= 1;
    setGroundTexture(U.uGroundA, dst.textures[0]);
    setGroundTexture(U.uGroundB, dst.textures[1]);
  }

  // one fullscreen pass into target (upstream: FullscreenQuad.render)
  _draw(material: NodeMaterial, target: RenderTarget): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    this._quad.material = material;
    r.setRenderTarget(target);
    this._quad.render(r as unknown as Parameters<QuadMesh["render"]>[0]);
    r.setRenderTarget(prev);
  }

  clear(): void {
    for (const t of this.targets) {
      this._draw(this._zero, t.a);
      this._draw(this._zero, t.b);
    }
    this.splatCount = 0;
    for (const c of CRACK_SOURCES) c.set(0, 0, 0, 0);
    for (const b of FISSURE_B) b.set(0, 0, 0, 0);
    for (const q of this.regions) q.until = -1;
    this._full = true;
    // the pool (wet = 1) is restamped by every step; the next update() steps the whole field
    setGroundTexture(U.uGroundA, this.current.textures[0]);
    setGroundTexture(U.uGroundB, this.current.textures[1]);
  }

  // --- probes: async readback (upstream: PBO + fence, UW WaterQuery pattern) ---
  // points: [[x, z], ...] (<= 16). Results land in this.probes a few frames later.
  setProbes(points: readonly (readonly [number, number] | number[])[]): void {
    this._probeN = Math.min(points.length, MAX_PROBES);
    for (let i = 0; i < this._probeN; i++) {
      const pt = points[i] as number[];
      (this._probeXZ[i] as Vector2).set(pt[0] as number, pt[1] as number);
    }
  }

  _readProbes(): void {
    if (!this._probeN || this._probeReading) return;
    for (let i = 0; i < this._probeN; i++)
      (this._probeXZ[i] as Vector2).toArray(this._probeData, i * 4);
    this._probeTex.needsUpdate = true;
    this._draw(this._probeMat, this.probeRT);
    const count = this._probeN;
    this._probeReading = true;
    this.renderer
      .readRenderTargetPixelsAsync(this.probeRT, 0, 0, count * 2, 1)
      .then((px) => {
        for (let i = 0; i < count * 8; i++) this.probes[i] = px[i] as number;
        this.probeCount = count;
      })
      .finally(() => {
        this._probeReading = false;
      });
  }

  dispose(): void {
    for (const t of this.targets) {
      t.a.dispose();
      t.b.dispose();
    }
    this.mask.dispose();
    this.probeRT.dispose();
    this.paintTargetA.dispose();
    this.paintTargetB.dispose();
    this._simA.dispose();
    this._simB.dispose();
    this._probeMat.dispose();
    this._zero.dispose();
    this._splatTex.dispose();
    this._probeTex.dispose();
  }
}
