import { Vector3 } from "three";
// Ported from Ultra Elements src/vfx/FluidVolume.glsl.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
//
// Shaders for FluidVolume.ts (see its header for the design). Every sim pass is one fullscreen
// draw over a 2D atlas holding a 3D grid; all lookups are explicit LOD 0 (implicit-gradient
// samples inside data-dependent loops make ANGLE's FXC unroll them).
//
// TSL: the shader revisions FluidVolume.js patches over these base sources at load (REACT's turbulence,
// soot cooling and erosion; the whole RENDER_BODY) are written in place here, each marked "patch:".
// Grid is a plain object of nodes (a struct as a Fn argument fails on the engine), GLSL `out`
// parameters are var nodes the caller passes in, and each GLSL `uniform sampler2D` is one texture()
// node per pass whose `.value` the JS swaps (upstream: `u.uV.value = ...`).
// ADVECT, CORRECT, REACT and PROJECT write (oV, oS): each builder takes `out` ("V" or "S") and builds
// the part of the same maths that reaches that output; the pass hands both to the material's mrtNode.
import {
  Break,
  Discard,
  Fn,
  If,
  Loop,
  PI,
  abs,
  cameraPosition,
  clamp,
  cross,
  dot,
  exp,
  float,
  floor,
  int,
  ivec2,
  length,
  max,
  min,
  mix,
  mod,
  normalize,
  positionWorld,
  pow,
  screenCoordinate,
  select,
  smoothstep,
  type texture,
  textureLoad,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import {
  U,
  blackbody,
  curl3,
  forceAccel,
  fxOut,
  hgPhase,
  noise3,
  noise3v,
  sceneViewZ,
} from "./common.js";

type F = Node<"float">;
type V2 = Node<"vec2">;
type V3 = Node<"vec3">;
type V4 = Node<"vec4">;
type I = Node<"int">;
type Iv3 = V3; // a whole-number voxel index (see gridTexel)
type B = Node<"bool">;
export type TexNode = ReturnType<typeof texture>;
type Out = "V" | "S";

export const MAX_SRC = 8;

// engine: GLSL read the camera's forward axis from viewMatrix; FluidVolume.update sets it per frame
export const uCamFwd = uniform(new Vector3(0, 0, -1));

// 3D grid in a 2D atlas: slice k is tile (k % tiles.x, k / tiles.x), each tile dim.xy texels.
// Voxel centres sit at i + 0.5 in voxel units.
export interface IGrid {
  dim: V3;
  tiles: V2;
  inv: V2;
}
// ENGINE-GAP: no ivec3 on the Wasm engine. A voxel index is a vec3 of whole numbers (exact in f32 at
// these sizes) and only the atlas texel becomes an ivec2; the tile maths is upstream's.
function gridTexel(g: IGrid, v0: Iv3) {
  const v = clamp(v0, vec3(0.0), g.dim.sub(1.0)).toVar();
  const tx = g.tiles.x;
  const row = floor(v.z.add(0.5).div(tx)).toVar(); // v.z / tx
  return ivec2(vec2(v.z.sub(row.mul(tx)).mul(g.dim.x).add(v.x), row.mul(g.dim.y).add(v.y))); // v.z % tx
}
const gridFetch = (t: TexNode, g: IGrid, v: Iv3): V4 =>
  textureLoad(t as Parameters<typeof textureLoad>[0], gridTexel(g, v), int(0)) as unknown as V4;
function sliceOrigin(g: IGrid, k: F): V2 {
  const row = floor(k.add(0.5).div(g.tiles.x));
  return vec2(k.sub(row.mul(g.tiles.x)), row).mul(g.dim.xy);
}
// trilinear: hardware bilinear inside two slices, lerp between them (clamped so tiles never bleed)
function gridSample(t: TexNode, g: IGrid, p: V3): V4 {
  const q = clamp(p, vec3(0.5), g.dim.sub(0.5)).toVar();
  const z = q.z.sub(0.5).toVar();
  const k0 = floor(z).toVar();
  const f = z.sub(k0);
  const k1 = min(k0.add(1.0), g.dim.z.sub(1.0));
  const a = t.sample(sliceOrigin(g, k0).add(q.xy).mul(g.inv)).level(float(0)) as unknown as V4;
  const b = t.sample(sliceOrigin(g, k1).add(q.xy).mul(g.inv)).level(float(0)) as unknown as V4;
  return mix(a, b, f);
}
// out v; returns false past the last slice
function gridVoxel(g: IGrid, v: Iv3): B {
  const p = floor(screenCoordinate.xy).toVar();
  const d = g.dim.xy;
  const tile = floor(p.div(d)).toVar();
  v.assign(vec3(p.sub(tile.mul(d)), tile.y.mul(g.tiles.x).add(tile.x)));
  return v.z.lessThan(g.dim.z);
}

// transfer function shared by the light pass and the raymarch
//   temperature th: 0 ambient, 1 = uLook1.x kelvin (the spell's flame temperature)
export interface ILook {
  uLook0: V4; // emission gain, soot extinction (1/m per unit), flame extinction (1/m), absorb (black flame)
  uLook1: V4; // kelvin at th = 1, ambient kelvin, fuel extinction (1/m per unit), chroma (render only)
  uTint: V3;
}
const kelvinOf = (L: ILook, th: F): F => L.uLook1.y.add(L.uLook1.x.sub(L.uLook1.y).mul(th));
const flameOf = (th: F): F => smoothstep(0.12, 0.5, th);
// Kirchhoff: hot soot and flame gas emit as much as they absorb, emission = sigma_abs * B(T). An
// opaque hot region therefore shows its own surface temperature (a blackbody), cooled soot is
// black smoke, and a thin flame sheet is a faint, see-through glow. B(T) in the visible band
// follows Planck's ~exp(-hc / (lambda k T)) at lambda ~ 600 nm (softened 2x for the display range):
// far steeper than T^4, so 1000 K soot is a dull red ember and 2400 K is ~4x the reference.
function glowOf(L: ILook, th: F): F {
  const T = kelvinOf(L, th);
  const k = exp(
    float(12000.0)
      .div(L.uLook1.x)
      .sub(float(12000.0).div(max(T, 400.0))),
  ).toVar();
  return k.div(k.mul(0.08).add(1.0)).mul(smoothstep(0.08, 0.25, th));
}
const sigmaHot = (L: ILook, s: V4): F =>
  L.uLook0.y.mul(max(s.b, 0.0)).add(L.uLook0.z.mul(flameOf(s.r)));
const sigmaOf = (L: ILook, s: V4): F =>
  sigmaHot(L, s)
    .mul(float(1.0).add(L.uLook0.w.mul(6.0).mul(flameOf(s.r))))
    .add(L.uLook1.z.mul(max(s.g, 0.0)));
function emitOf(L: ILook, s: V4): V3 {
  const th = max(s.r, 0.0).toVar();
  const g = glowOf(L, th)
    .mul(sigmaHot(L, s))
    .mul(L.uLook0.x)
    .mul(float(1.0).sub(L.uLook0.w))
    .toVar();
  return select(g.greaterThan(1e-4), blackbody(kelvinOf(L, th)).mul(g).mul(L.uTint), vec3(0.0));
}

// SIM_HEAD
export interface ISim {
  uDim: V3;
  uTiles: V2;
  uInv: V2;
  uOrigin: V3; // world position of the grid's min corner
  uH: F; // voxel size (m)
  uSimDt: F;
  uShift: V3; // how far the domain moved this step (voxels): new origin - old origin
  uObst: V4; // a solid sphere (an Aegis dome): centre in voxels minus half a voxel, radius in voxels (0: none)
}
const G = (su: ISim): IGrid => ({ dim: su.uDim, tiles: su.uTiles, inv: su.uInv });
// cells below the arena floor, and inside the sphere, are solid
function solid(su: ISim, v: Iv3): B {
  const o = vec3(v).sub(su.uObst.xyz);
  return v.y
    .add(0.5)
    .lessThan(su.uOrigin.y.negate().div(su.uH))
    .or(su.uObst.w.greaterThan(0.0).and(dot(o, o).lessThan(su.uObst.w.mul(su.uObst.w)))); // (uniform: no sphere, no cost)
}
const outside = (su: ISim, v: Iv3): B =>
  v.x
    .lessThan(0)
    .or(v.y.lessThan(0))
    .or(v.z.lessThan(0))
    .or(v.x.greaterThanEqual(su.uDim.x))
    .or(v.y.greaterThanEqual(su.uDim.y))
    .or(v.z.greaterThanEqual(su.uDim.z));
// open boundary: still air outside the box (one-voxel fade)
function sampleOpen(su: ISim, t: TexNode, p: V3): V4 {
  const o = max(max(p.negate(), p.sub(su.uDim)), 0.0);
  const w = clamp(float(1.0).sub(max(o.x, max(o.y, o.z))), 0.0, 1.0).toVar();
  return select(w.greaterThan(0.0), gridSample(t, G(su), p).mul(w), vec4(0.0));
}

// 1. semi-Lagrangian advection of velocity and scalars (RK2 backtrace), in the moving frame
export function ADVECT(su: ISim, { uV, uS }: { uV: TexNode; uS: TexNode }, out: Out) {
  return Fn(() => {
    const o = vec4(0.0).toVar();
    const v = vec3(0).toVar();
    If(gridVoxel(G(su), v), () => {
      const p = vec3(v).add(0.5).add(su.uShift).toVar(); // this cell's world point, in the previous grid
      const k = su.uSimDt.div(su.uH).toVar();
      const u1 = sampleOpen(su, uV, p).xyz.toVar();
      const u2 = sampleOpen(su, uV, p.sub(u1.mul(k.mul(0.5)))).xyz.toVar();
      const q = p.sub(u2.mul(k)).toVar();
      o.assign(sampleOpen(su, out === "V" ? uV : uS, q));
    });
    return o;
  })();
}

// 2. MacCormack correction (Selle et al. 2008), clamped to the old field's extrema around the
// departure point, so it never overshoots
export function CORRECT(
  su: ISim,
  own: { uV: TexNode; uS: TexNode; uVf: TexNode; uSf: TexNode; uMacCormack: F },
  out: Out,
) {
  const X = out === "V" ? own.uV : own.uS;
  const Xf = out === "V" ? own.uVf : own.uSf;
  return Fn(() => {
    const o = vec4(0.0).toVar();
    const v = vec3(0).toVar();
    If(gridVoxel(G(su), v), () => {
      const vf = gridFetch(own.uVf, G(su), v).toVar();
      const xf = out === "V" ? vf : gridFetch(Xf, G(su), v).toVar();
      If(own.uMacCormack.lessThan(0.5), () => {
        o.assign(xf);
      }).Else(() => {
        const k = su.uSimDt.div(su.uH).toVar();
        const c = vec3(v).add(0.5).toVar();
        const r = c.add(vf.xyz.mul(k));
        const xb = gridSample(Xf, G(su), r);
        const x0 = sampleOpen(su, X, c.add(su.uShift));
        const xn = xf.add(x0.sub(xb).mul(0.5)).toVar();
        const i0 = floor(c.add(su.uShift).sub(vf.xyz.mul(k)).sub(0.5)).toVar();
        const lo = vec4(1e4).toVar();
        const hi = vec4(-1e4).toVar();
        for (let n = 0; n < 8; n++) {
          const on = i0.add(vec3(n & 1, (n >> 1) & 1, n >> 2)).toVar();
          const a = vec4(0.0).toVar();
          If(outside(su, on).not(), () => {
            a.assign(gridFetch(X, G(su), on));
          });
          lo.assign(min(lo, a));
          hi.assign(max(hi, a));
        }
        o.assign(clamp(xn, lo, hi));
      });
    });
    return o;
  })();
}

// 3. vorticity w = curl u (rgb) and |w| (a)
export function CURL(su: ISim, { uV }: { uV: TexNode }) {
  return Fn(() => {
    const oC = vec4(0.0).toVar();
    const v = vec3(0).toVar();
    If(gridVoxel(G(su), v), () => {
      const at = (o: Iv3) => gridFetch(uV, G(su), o).xyz.toVar();
      const L = at(v.sub(vec3(1, 0, 0)));
      const R = at(v.add(vec3(1, 0, 0)));
      const D = at(v.sub(vec3(0, 1, 0)));
      const Up = at(v.add(vec3(0, 1, 0)));
      const Bk = at(v.sub(vec3(0, 0, 1)));
      const Fr = at(v.add(vec3(0, 0, 1)));
      const w = vec3(
        Up.z.sub(D.z).sub(Fr.y.sub(Bk.y)),
        Fr.x.sub(Bk.x).sub(R.z.sub(L.z)),
        R.y.sub(L.y).sub(Up.x.sub(D.x)),
      )
        .mul(float(0.5).div(su.uH))
        .toVar();
      oC.assign(vec4(w, length(w)));
    });
    return oC;
  })();
}

export interface IReactOwn {
  uV: TexNode;
  uS: TexNode;
  uC: TexNode;
  uSrcP: V4[]; // world centre, radius m
  uSrcA: V4[]; // fuel, temperature, soot, noise amount 0..1
  uSrcV: V4[]; // velocity m/s, radial speed m/s
  uSrcB: V4[]; // mode (0 per second, 1 at least), noise frequency 1/m, seed, velocity coupling 1/s
  uSrcN: I;
  uBurn: V4; // ignition temperature, burn rate 1/s, heat per fuel, soot per fuel
  uDecay: V4; // cooling 1/s, radiative cooling, soot decay 1/s, fuel decay 1/s
  uForce: V4; // buoyancy m/s2 per th, soot weight m/s2 per unit, vorticity confinement, expansion per fuel
  uFlow: V4; // external force coupling, damping 1/s, -, -
  uTurb: V4; // patch: turbulence m/s2, turbulence frequency tiles/m, soot erosion units/s, soot radiative cooling
}

// 4. sources, combustion, cooling, buoyancy, vorticity confinement, external forces
export function REACT(su: ISim, u: IReactOwn, out: Out) {
  const { uV, uS, uC, uBurn, uDecay, uForce, uFlow, uTurb } = u;
  return Fn(() => {
    const o = vec4(0.0).toVar();
    const v = vec3(0).toVar();
    If(gridVoxel(G(su), v).and(solid(su, v).not()), () => {
      const vel = gridFetch(uV, G(su), v).xyz.toVar();
      const s = gridFetch(uS, G(su), v).rgb.toVar(); // (s.a is rewritten below)
      const pw = su.uOrigin.add(vec3(v).add(0.5).mul(su.uH)).toVar();
      const dt = su.uSimDt;
      for (let i = 0; i < MAX_SRC; i++) {
        If(u.uSrcN.greaterThan(i), () => {
          const P = u.uSrcP[i] as V4;
          const d = pw.sub(P.xyz).toVar();
          const r = length(d).toVar();
          If(r.lessThan(P.w), () => {
            const A = u.uSrcA[i] as V4;
            const Bs = u.uSrcB[i] as V4;
            const W = u.uSrcV[i] as V4;
            const w = float(1.0)
              .sub(smoothstep(P.w.mul(0.3), P.w, r))
              .toVar();
            If(A.w.greaterThan(0.0), () => {
              // lumpy, flickering source: the noise scrolls up through it
              const np = pw
                .mul(Bs.y)
                .add(vec3(Bs.z, Bs.z.mul(0.37).sub(U.uTime.mul(0.8).mul(Bs.y)), Bs.z.mul(0.71)));
              w.mulAssign(mix(1.0, smoothstep(0.3, 0.7, noise3(np.mul(0.25))), A.w));
            });
            If(w.greaterThan(0.0), () => {
              if (out === "V") {
                const target = W.xyz.add(select(r.greaterThan(1e-4), d.div(r), vec3(0.0)).mul(W.w));
                vel.assign(mix(vel, target, w.mul(float(1.0).sub(exp(Bs.w.negate().mul(dt))))));
              }
              If(Bs.x.lessThan(0.5), () => {
                s.addAssign(vec3(A.y, A.x, A.z).mul(w.mul(dt)));
              }).Else(() => {
                s.assign(max(s, vec3(A.y, A.x, A.z).mul(w)));
              });
            });
          });
        });
      }
      // combustion: hot fuel burns into heat and soot, and the gas expands (a divergence source)
      const th = max(s.x, 0.0).toVar();
      const fuel = max(s.y, 0.0).toVar();
      const soot = max(s.z, 0.0).toVar();
      const burn = fuel
        .mul(float(1.0).sub(exp(uBurn.y.negate().mul(dt))))
        .mul(smoothstep(uBurn.x.mul(0.5), uBurn.x, th))
        .toVar();
      fuel.subAssign(burn);
      th.addAssign(burn.mul(uBurn.z));
      soot.addAssign(burn.mul(uBurn.w));
      const expand = burn.div(max(dt, 1e-4)).mul(uForce.w).toVar();
      // Newton cooling, plus radiative loss (exact step of dth/dt = -c th^4)
      th.mulAssign(exp(uDecay.x.negate().mul(dt)));
      // patch: soot radiates its heat away (dark lanes)
      th.divAssign(
        pow(
          float(1.0).add(
            uDecay.y
              .mul(3.0)
              .mul(dt)
              .mul(th)
              .mul(th)
              .mul(th)
              .mul(float(1.0).add(uTurb.w.mul(soot))),
          ),
          1.0 / 3.0,
        ),
      );
      // patch: soot thins by erosion instead of fading as a whole
      soot.assign(max(soot.mul(exp(uDecay.z.negate().mul(dt))).sub(uTurb.z.mul(dt)), 0.0));
      fuel.mulAssign(exp(uDecay.w.negate().mul(dt)));
      if (out === "S") {
        o.assign(vec4(min(th, 4.0), min(fuel, 4.0), min(soot, 8.0), expand));
        return;
      }
      // hot gas rises, soot is heavy
      const acc = vec3(0.0, uForce.x.mul(th).sub(uForce.y.mul(soot)), 0.0).toVar();
      // vorticity confinement (Fedkiw et al. 2001): spin the small eddies back up
      const magAt = (o2: Iv3) => gridFetch(uC, G(su), o2).a;
      const c = gridFetch(uC, G(su), v).toVar();
      const eta = vec3(
        magAt(v.add(vec3(1, 0, 0))).sub(magAt(v.sub(vec3(1, 0, 0)))),
        magAt(v.add(vec3(0, 1, 0))).sub(magAt(v.sub(vec3(0, 1, 0)))),
        magAt(v.add(vec3(0, 0, 1))).sub(magAt(v.sub(vec3(0, 0, 1)))),
      ).toVar();
      const el = length(eta).toVar();
      If(el.greaterThan(1e-4), () => {
        acc.addAssign(cross(eta.div(el), c.xyz).mul(uForce.z.mul(su.uH)));
      });
      // patch: resolved turbulence (a curl-noise force on hot gas)
      If(uTurb.x.greaterThan(0.0), () => {
        acc.addAssign(
          curl3(pw.mul(uTurb.y).add(vec3(0.0, U.uTime.mul(-0.6).mul(uTurb.y), 0.0))).mul(
            uTurb.x.mul(min(th, 1.0)),
          ),
        );
      });
      // the shared force field (wind, vortices, shocks...) pushes the gas like it pushes particles
      const kill = float(0.0).toVar();
      acc.addAssign(forceAccel(pw, vel, kill).mul(uFlow.x));
      vel.assign(vel.add(acc.mul(dt)).mul(exp(uFlow.y.negate().mul(dt))));
      o.assign(vec4(clamp(vel, -60.0, 60.0), 0.0));
    });
    return o;
  })();
}

// 5. divergence minus the combustion expansion (b = h^2 (div u - e)), plus a warm-start pressure
export function DIVERGE(
  su: ISim,
  { uV, uS, uP, uWarm }: { uV: TexNode; uS: TexNode; uP: TexNode; uWarm: F },
) {
  return Fn(() => {
    const oP = vec4(0.0).toVar();
    const v = vec3(0).toVar();
    If(gridVoxel(G(su), v).and(solid(su, v).not()), () => {
      const at = (o: Iv3) => select(solid(su, o), vec3(0.0), gridFetch(uV, G(su), o).xyz);
      const div = at(v.add(vec3(1, 0, 0)))
        .x.sub(at(v.sub(vec3(1, 0, 0))).x)
        .add(at(v.add(vec3(0, 1, 0))).y)
        .sub(at(v.sub(vec3(0, 1, 0))).y)
        .add(at(v.add(vec3(0, 0, 1))).z)
        .sub(at(v.sub(vec3(0, 0, 1))).z)
        .mul(float(0.5).div(su.uH))
        .toVar();
      const e = gridFetch(uS, G(su), v).a;
      const p0 = sampleOpen(su, uP, vec3(v).add(0.5).add(su.uShift)).r.mul(uWarm);
      oP.assign(vec4(p0, su.uH.mul(su.uH).mul(div.sub(e)), 0.0, 0.0));
    });
    return oP;
  })();
}

// pressure neighbours: open air (p = 0) outside the box, Neumann at the floor
const pN = (su: ISim, uP: TexNode, n: Iv3, pc: F): F =>
  select(solid(su, n), pc, select(outside(su, n), float(0.0), gridFetch(uP, G(su), n).r));

// 6. Jacobi iteration
export function JACOBI(su: ISim, { uP }: { uP: TexNode }) {
  return Fn(() => {
    const oP = vec4(0.0).toVar();
    const v = vec3(0).toVar();
    If(gridVoxel(G(su), v), () => {
      const c = gridFetch(uP, G(su), v).toVar();
      If(solid(su, v), () => {
        oP.assign(vec4(0.0, c.g, 0.0, 0.0));
      }).Else(() => {
        const s = pN(su, uP, v.add(vec3(1, 0, 0)), c.r)
          .add(pN(su, uP, v.sub(vec3(1, 0, 0)), c.r))
          .add(pN(su, uP, v.add(vec3(0, 1, 0)), c.r))
          .add(pN(su, uP, v.sub(vec3(0, 1, 0)), c.r))
          .add(pN(su, uP, v.add(vec3(0, 0, 1)), c.r))
          .add(pN(su, uP, v.sub(vec3(0, 0, 1)), c.r));
        oP.assign(vec4(s.sub(c.g).div(6.0), c.g, 0.0, 0.0));
      });
    });
    return oP;
  })();
}

// 7. projection: subtract the pressure gradient; no flow into the floor
export function PROJECT(
  su: ISim,
  { uV, uS, uP }: { uV: TexNode; uS: TexNode; uP: TexNode },
  out: Out,
) {
  return Fn(() => {
    const o = vec4(0.0).toVar();
    const v = vec3(0).toVar();
    If(gridVoxel(G(su), v).and(solid(su, v).not()), () => {
      if (out === "S") {
        o.assign(vec4(gridFetch(uS, G(su), v).rgb, 0.0));
        return;
      }
      const pc = gridFetch(uP, G(su), v).r.toVar();
      const g = vec3(
        pN(su, uP, v.add(vec3(1, 0, 0)), pc).sub(pN(su, uP, v.sub(vec3(1, 0, 0)), pc)),
        pN(su, uP, v.add(vec3(0, 1, 0)), pc).sub(pN(su, uP, v.sub(vec3(0, 1, 0)), pc)),
        pN(su, uP, v.add(vec3(0, 0, 1)), pc).sub(pN(su, uP, v.sub(vec3(0, 0, 1)), pc)),
      ).mul(float(0.5).div(su.uH));
      const vel = gridFetch(uV, G(su), v).xyz.sub(g).toVar();
      If(solid(su, v.sub(vec3(0, 1, 0))), () => {
        vel.assign(vec3(vel.x, max(vel.y, 0.0), vel.z));
      });
      o.assign(vec4(vel, 0.0));
    });
    return o;
  })();
}

// 8. lighting volume at half resolution, one RGBA texel per 2x2x2 block:
//   r  sun optical depth (march to the box exit)    g  sky optical depth (march straight up)
//   b  occupancy: 0 if nothing within ~3 voxels, else 1 + |vorticity| (drives the sub-grid detail)
//   a  fire light: blurred Kirchhoff emission around the cell (the self-illumination source)
export interface ILightOwn extends ILook {
  uS: TexNode;
  uC: TexNode;
  uCDim: V3;
  uCTiles: V2;
  uCInv: V2;
  uLightP: V4; // sun step (voxels), fire-light tap spacing (voxels), fire-light gain, empty below (1/m)
}
export function LIGHT(su: ISim, L: ILightOwn) {
  const { uS, uC, uLightP } = L;
  const inBox = (q: V3): B =>
    q.x
      .greaterThanEqual(0.0)
      .and(q.y.greaterThanEqual(0.0))
      .and(q.z.greaterThanEqual(0.0))
      .and(q.x.lessThanEqual(su.uDim.x))
      .and(q.y.lessThanEqual(su.uDim.y))
      .and(q.z.lessThanEqual(su.uDim.z));
  return Fn(() => {
    const o0 = vec4(0.0).toVar();
    const c = vec3(0).toVar();
    If(gridVoxel({ dim: L.uCDim, tiles: L.uCTiles, inv: L.uCInv }, c), () => {
      const p = vec3(c).add(0.5).mul(2.0).toVar(); // fine voxel units: the centre of this cell's 2x2x2 block
      // 27 taps around the cell: occupancy (dilated) and the fire light
      const pw = float(0.0).toVar();
      const occ = float(0.0).toVar();
      Loop({ start: 0, end: 27, type: "int", condition: "<" }, ({ i: k }: { i: I }) => {
        const kf = float(k);
        const o = vec3(mod(kf, 3.0), mod(floor(kf.div(3.0)), 3.0), floor(kf.div(9.0)))
          .sub(1.0)
          .toVar();
        const st = gridSample(uS, G(su), p.add(o.mul(uLightP.y))).toVar();
        const th = max(st.r, 0.0).toVar();
        occ.assign(max(occ, sigmaOf(L, st).add(th).add(max(st.g, 0.0))));
        pw.addAssign(
          glowOf(L, th)
            .mul(min(sigmaHot(L, st), 4.0))
            .div(float(1.0).add(dot(o, o))),
        );
      });
      const tau = float(0.0).toVar();
      const tauU = float(0.0).toVar();
      occ.assign(select(occ.greaterThan(max(uLightP.w, 1e-3)), occ, float(0.0)));
      If(occ.greaterThan(0.0), () => {
        const st = uLightP.x;
        const q = p.add(U.uSunDir.mul(st.mul(0.5))).toVar();
        Loop({ start: 0, end: 48, type: "int", condition: "<" }, () => {
          If(inBox(q).not(), () => {
            Break();
          });
          tau.addAssign(sigmaOf(L, gridSample(uS, G(su), q)));
          q.addAssign(U.uSunDir.mul(st));
        });
        tau.mulAssign(st.mul(su.uH));
        q.assign(p.add(vec3(0.0, 2.0, 0.0)));
        Loop({ start: 0, end: 10, type: "int", condition: "<" }, () => {
          If(q.y.greaterThan(su.uDim.y), () => {
            Break();
          });
          tauU.addAssign(sigmaOf(L, gridSample(uS, G(su), q)).mul(su.uH.mul(4.0)));
          q.addAssign(vec3(0.0, 4.0, 0.0));
        });
      });
      const vort = gridSample(uC, G(su), p).a;
      o0.assign(
        vec4(
          tau,
          tauU,
          select(occ.greaterThan(0.0), vort.add(1.0), float(0.0)),
          pw.mul(L.uLook0.x.mul(float(1.0).sub(L.uLook0.w)).mul(uLightP.z).div(27.0)),
        ),
      );
    });
    return o0;
  })();
}

// --- render: raymarch the domain box in the FX pass ----------------------------------------
// (RENDER_VERT: the material's own vertex stage; vWorld is positionWorld)
export interface IRenderOwn extends ILook {
  uS: TexNode;
  uL0: TexNode;
  uDim: V3;
  uTiles: V2;
  uInv: V2;
  uCDim: V3;
  uCTiles: V2;
  uCInv: V2;
  uOrigin: V3;
  uH: F;
  uMarch: V4; // step (m), max steps, sub-grid amplitude (voxels), sub-grid frequency (tiles / m)
  uMarch2: V4; // edge fade (voxels), m per FX pixel at 1 m, bottom face open (0/1), near fade 1/m
  uLit: V4; // HG g, sun gain, sky gain, fire-light gain
  uSootColor: V3;
  uDetail: V4; // soot erosion (units), cell pattern frequency (tiles/m, 0 = off), heat chill 0..1, largest empty-space stride
  uDetailC: V3; // pattern centre: it rides the gas
}
// the ray's globals (GLSL gSunPh, gMs, gFire, gKc, gRd)
interface IRay {
  gSunPh: F;
  gMs: F; // multiple-scattering weight from the albedo
  gFire: V3; // fire-light colour (blackbody at a typical flame-edge temperature) x gain
  gKc: V3; // per-channel extinction scale of the light on its way in (coloured gas)
  gRd: V3;
}

// patch (RENDER_BODY): everything from the sampler down
// per metre: extinction, in-scattered radiance (soot only), emitted radiance
// returns false in empty space (nothing within ~3 voxels)
function sampleAt(R: IRenderOwn, g: IRay, pw: V3, sg: F, sc: V3, em: V3): F {
  const Gr: IGrid = { dim: R.uDim, tiles: R.uTiles, inv: R.uInv };
  const cg: IGrid = { dim: R.uCDim, tiles: R.uCTiles, inv: R.uCInv };
  sg.assign(0.0);
  sc.assign(vec3(0.0));
  em.assign(vec3(0.0));
  const occ = float(0.0).toVar(); // engine: no bool(); 0/1
  const p = pw.sub(R.uOrigin).div(R.uH).toVar();
  const l0 = gridSample(R.uL0, cg, p.mul(0.5)).toVar();
  If(l0.b.greaterThan(0.0), () => {
    occ.assign(1.0);
    // sub-grid detail (in the spirit of wavelet turbulence): displace the lookup with band-limited
    // curl noise drifting up with the gas, strongest where the resolved flow is turbulent
    const n = curl3(pw.mul(R.uMarch.w).add(vec3(0.0, U.uTime.mul(-0.28), 0.0))).toVar();
    const s = gridSample(
      R.uS,
      Gr,
      p.add(n.mul(R.uMarch.z.mul(clamp(max(l0.b.sub(1.0), 0.0).mul(0.06).add(0.2), 0.2, 1.0)))),
    ).toVar();
    // fade out towards the open faces so the box never shows
    const e = min(p, R.uDim.sub(p)).toVar();
    const ed = min(
      min(e.x, e.z),
      select(R.uMarch2.z.greaterThan(0.5), min(e.y, R.uDim.y.sub(p.y)), R.uDim.y.sub(p.y)),
    );
    // (the fade distance is jittered by the same noise, so a cloud that reaches a face frays
    // into wisps instead of showing a straight cut)
    const fade = smoothstep(0.5, R.uMarch2.x, ed.add(n.x.add(n.z).mul(1.6))).toVar();
    s.assign(vec4(s.rgb.mul(fade.mul(fade)), s.a));
    If(R.uDetail.y.greaterThan(0.0), () => {
      // Worley fbm from one fetch: f2 cells (big billows), f4 (the lobes on them), f8 (the
      // cauliflower on those). Thin gas erodes harder than the core, so billows keep firm tops
      // while their trailing edges tear into ragged wisps
      const wv = noise3v(pw.sub(R.uDetailC).mul(R.uDetail.y).add(n.mul(0.05))).gba;
      const crease = float(1.0)
        .sub(dot(wv, vec3(0.45, 0.35, 0.2)))
        .toVar();
      const thin = exp(s.b.negate().div(max(R.uDetail.x, 1e-3)));
      s.assign(
        vec4(
          s.r.mul(float(1.0).sub(R.uDetail.z.mul(crease))),
          s.g,
          max(s.b.sub(R.uDetail.x.mul(crease).mul(thin.add(1.0))), 0.0),
          s.a,
        ),
      );
    });
    sg.assign(sigmaOf(R, s));
    em.assign(emitOf(R, s));
    const ss = R.uLook0.y.mul(max(s.b, 0.0)).toVar();
    If(ss.greaterThanEqual(1e-4), () => {
      // sun: single scattering through the precomputed optical depth, plus two wider, weaker octaves
      // standing in for multiple scattering (Wrenninge 2015); sky through the optical depth above
      const t = l0.r;
      // multiple-scattering octaves scale with albedo: dark soot barely scatters twice, so it keeps
      // its form shading (lit tops, near-black undersides) instead of glowing flat
      const tc = g.gKc.mul(t).toVar();
      const sun = U.uSunColor.mul(R.uLit.y).mul(
        exp(tc.negate())
          .mul(g.gSunPh)
          .add(
            exp(tc.mul(-0.5))
              .mul(0.4)
              .add(exp(tc.mul(-0.25)).mul(0.15))
              .mul(g.gMs),
          ),
      );
      const sky = U.uAmbient.mul(R.uLit.z).mul(
        exp(l0.g.mul(-0.7).mul(g.gKc))
          .mul(0.96)
          .add(0.04), // deep cores go near black
      );
      sc.assign(R.uSootColor.mul(ss).mul(sun.add(sky).add(g.gFire.mul(l0.a))));
    });
  });
  return occ;
}

// a sample on the ray, with the near fade applied (all three outputs are linear in density)
function tap(R: IRenderOwn, g: IRay, t: F, sg: F, sc: V3, em: V3): F {
  const o = sampleAt(R, g, cameraPosition.add(g.gRd.mul(t)), sg, sc, em);
  const k0 = clamp(t.mul(R.uMarch2.w), 0.0, 1.0).toVar();
  const k = k0
    .mul(k0)
    .mul(float(3.0).sub(k0.mul(2.0)))
    .toVar();
  sg.mulAssign(k);
  sc.mulAssign(k);
  em.mulAssign(k);
  return o;
}

// the integrator state, and one trapezoid slab (energy conserving) from ta over L
interface IIntegrator {
  gT: F;
  gZs: F;
  gWs: F;
  gScat: V3;
  gEmit: V3;
}
function slab(S0: IIntegrator, ta: F, L: F, sa: F, ca: V3, ea: V3, sb: F, cb: V3, eb: V3): void {
  const s = sa.add(sb).mul(0.5).toVar();
  const Sc = ca.add(cb).mul(0.5).toVar();
  const E = ea.add(eb).mul(0.5).toVar();
  If(s.greaterThan(1e-5), () => {
    const tr = exp(s.negate().mul(L)).toVar();
    const a = S0.gT.mul(float(1.0).sub(tr)).toVar();
    S0.gScat.addAssign(Sc.mul(a.div(s)));
    S0.gEmit.addAssign(E.mul(a.div(s)));
    S0.gZs.addAssign(a.mul(ta.add(L.mul(0.5))));
    S0.gWs.addAssign(a);
    S0.gT.mulAssign(tr);
  }).Else(() => {
    S0.gEmit.addAssign(E.mul(S0.gT).mul(L));
  });
}

export function RENDER(R: IRenderOwn) {
  return Fn(() => {
    const out = vec4(0.0).toVar();
    const rd = normalize(positionWorld.sub(cameraPosition)).toVar();
    const dd = vec3(
      select(abs(rd.x).lessThan(1e-6), float(1e-6), rd.x),
      select(abs(rd.y).lessThan(1e-6), float(1e-6), rd.y),
      select(abs(rd.z).lessThan(1e-6), float(1e-6), rd.z),
    ).toVar();
    const bmin = R.uOrigin;
    const bmax = R.uOrigin.add(R.uDim.mul(R.uH));
    const ta = bmin.sub(cameraPosition).div(dd).toVar();
    const tb = bmax.sub(cameraPosition).div(dd).toVar();
    const lo = min(ta, tb).toVar();
    const hi = max(ta, tb).toVar();
    const t0 = max(max(max(lo.x, lo.y), lo.z), 0.0).toVar();
    const t1 = min(min(hi.x, hi.y), hi.z).toVar();
    const cosV = dot(rd, uCamFwd).toVar();
    t1.assign(min(t1, sceneViewZ().div(cosV)));
    Discard(t1.lessThanEqual(t0));
    const dt = R.uMarch.x;
    const mu = dot(U.uSunDir, rd).toVar();
    const g: IRay = {
      // soot: forward lobe + a weak back lobe, normalised so isotropic = 1
      gSunPh: mix(hgPhase(mu, R.uLit.x), hgPhase(mu, float(-0.25)), 0.25)
        .mul(PI.mul(4.0))
        .toVar(),
      gFire: blackbody(kelvinOf(R, float(0.75)))
        .mul(R.uTint)
        .mul(R.uLit.w)
        .toVar(),
      gMs: clamp(dot(R.uSootColor, vec3(1.0)), 0.0, 1.0).toVar(),
      // chroma > 0: a coloured gas (chlorine) takes its colour from depth, not from its albedo alone.
      // The channels it absorbs (where the albedo is below its brightest) fade faster on the way in,
      // so thin gas scatters near white and deep gas goes yellow-green; 0 = grey extinction
      gKc: float(1.0)
        .add(
          R.uLook1.w.mul(
            float(1.0).sub(
              R.uSootColor.div(max(max(R.uSootColor.r, R.uSootColor.g), max(R.uSootColor.b, 1e-3))),
            ),
          ),
        )
        .toVar(),
      gRd: rd,
    };
    const S0: IIntegrator = {
      gT: float(1.0).toVar(),
      gZs: float(0.0).toVar(),
      gWs: float(0.0).toVar(),
      gScat: vec3(0.0).toVar(),
      gEmit: vec3(0.0).toVar(),
    };
    // the lattice: t0 + i dt, ending in a partial step at t1 (continuous in t0, t1 and dt)
    const t = t0.toVar();
    const sgP = float(0.0).toVar();
    const scP = vec3(0.0).toVar();
    const emP = vec3(0.0).toVar();
    const occP = tap(R, g, t, sgP, scP, emP);
    const empties = select(occP.greaterThan(0.5), float(0.0), float(1.0)).toVar();
    const sg = float(0.0).toVar();
    const sc = vec3(0.0).toVar();
    const em = vec3(0.0).toVar();
    const sgM = float(0.0).toVar();
    const scM = vec3(0.0).toVar();
    const emM = vec3(0.0).toVar();
    const occ = float(0.0).toVar(); // engine: no bool(); 0/1
    Loop({ start: 0, end: 256, type: "int", condition: "<" }, () => {
      If(S0.gT.lessThan(0.03).or(t.greaterThanEqual(t1)), () => {
        Break();
      });
      // stride over empty space (the occupancy is dilated ~3 voxels, so skipped points are empty)
      const stride = clamp(empties.sub(1.0), 1.0, R.uDetail.w).toVar();
      const tn = min(t.add(dt.mul(stride)), t1).toVar();
      occ.assign(tap(R, g, tn, sg, sc, em));
      If(occ.greaterThan(0.5).and(stride.greaterThan(1.0)), () => {
        // landed in gas: back onto the next lattice point
        tn.assign(min(t.add(dt), t1));
        occ.assign(tap(R, g, tn, sg, sc, em));
        empties.assign(0.0);
      });
      const L = tn.sub(t).toVar();
      const w = smoothstep(0.8, 1.6, sg.add(sgP).mul(0.5).mul(L)).toVar();
      If(w.greaterThan(0.0), () => {
        // optically thick (a surface): also integrate it as two half slabs through the midpoint, and
        // blend the two estimates by thickness, so the surface sits where it is, not on the lattice
        const T0 = S0.gT.toVar();
        const z0 = S0.gZs.toVar();
        const w0 = S0.gWs.toVar();
        const s0 = S0.gScat.toVar();
        const e0 = S0.gEmit.toVar();
        tap(R, g, t.add(L.mul(0.5)), sgM, scM, emM);
        slab(S0, t, L.mul(0.5), sgP, scP, emP, sgM, scM, emM);
        slab(S0, t.add(L.mul(0.5)), L.mul(0.5), sgM, scM, emM, sg, sc, em);
        const T2 = S0.gT.toVar();
        const z2 = S0.gZs.toVar();
        const w2 = S0.gWs.toVar();
        const s2 = S0.gScat.toVar();
        const e2 = S0.gEmit.toVar();
        S0.gT.assign(T0);
        S0.gZs.assign(z0);
        S0.gWs.assign(w0);
        S0.gScat.assign(s0);
        S0.gEmit.assign(e0);
        If(w.lessThan(1.0), () => {
          slab(S0, t, L, sgP, scP, emP, sg, sc, em);
        });
        S0.gT.assign(mix(S0.gT, T2, w));
        S0.gZs.assign(mix(S0.gZs, z2, w));
        S0.gWs.assign(mix(S0.gWs, w2, w));
        S0.gScat.assign(mix(S0.gScat, s2, w));
        S0.gEmit.assign(mix(S0.gEmit, e2, w));
      }).Else(() => {
        slab(S0, t, L, sgP, scP, emP, sg, sc, em);
      });
      sgP.assign(sg);
      scP.assign(sc);
      emP.assign(em);
      t.assign(tn);
      empties.assign(select(occ.greaterThan(0.5), float(0.0), empties.add(1.0)));
    });
    // stopped on opacity: the unmarched rest is more of the same gas, so renormalise to opaque
    // (else the last 3% lets a bright HDR sky print its clouds through thick dark smoke)
    If(S0.gT.lessThan(0.03), () => {
      const k = float(1.0).div(float(1.0).sub(S0.gT)).toVar();
      S0.gScat.mulAssign(k);
      S0.gEmit.mulAssign(k);
      S0.gT.assign(0.0);
    });
    const alpha = float(1.0).sub(S0.gT).toVar();
    Discard(alpha.lessThan(0.002).and(dot(S0.gEmit, S0.gEmit).lessThan(1e-6)));
    const z = select(S0.gWs.greaterThan(0.0), S0.gZs.div(S0.gWs), t0).mul(cosV);
    out.assign(fxOut(S0.gScat.div(max(alpha, 1e-4)), alpha, S0.gEmit, vec2(0.0), z));
    return out;
  })();
}
