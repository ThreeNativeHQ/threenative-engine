import {
  Break,
  Fn,
  If,
  Loop,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  int,
  length,
  max,
  min,
  mix,
  normalize,
  positionWorld,
  select,
  sqrt,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
// Ported from Ultra Elements src/vfx/Volumes.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
import {
  BackSide,
  BoxGeometry,
  type BufferGeometry,
  type Camera,
  Group,
  IcosahedronGeometry,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  type PerspectiveCamera,
  Quaternion,
  Vector3,
  Vector4,
} from "three/webgpu";
import type { Node } from "three/webgpu";
import { Q } from "../engine/quality.js";
import {
  FX_BLENDING,
  type IMat3Rows,
  U,
  closestOnSegment,
  fxOut,
  hgPhase,
  mat3Rows,
  mulMat3Rows,
  sceneViewZ,
  setMat3Rows,
  spellLight,
  spellLightScatter,
} from "./common.js";

type F = Node<"float">;
type V3 = Node<"vec3">;

// Raymarched hero volumes (PLAN 2.5 "Volumes"). Each volume is a proxy mesh in the fx scene whose
// BACK faces are drawn (so the camera can be inside) with the depth test off (a back face behind the
// floor must not hide the part of the volume in front of it); the shader intersects the true shape
// analytically and marches from entry to min(exit, scene depth).
//
// Spells supply the medium:
//   void volumeSample(vec3 pw, vec3 pl, out float sigma, out vec3 albedo, out vec3 emission)
//     pw world position, pl local position (-1..1 over the shape's half extents)
//     sigma    extinction (1/m)
//     albedo   single-scattering albedo
//     emission emitted radiance per metre (HDR); integrated as T * E * (1 - exp(-sigma dt)) / sigma
// with COMMON, NOISE (noise3/fbm3/blackbody), ARENA and LIGHTS GLSL available, plus the uniforms
// below (uVolScale etc.).
// TSL: volumeSample(pw, pl, sigma, albedo, emission, V) with sigma/albedo/emission var nodes to assign
// and V the scope GLSL had: this volume's uniforms (V.uVolRot as rows: mulMat3Rows(V.uVolRot, v)), the
// spell's own uniforms, and V.gVolDt.
//
// Integration is per-slab energy conserving (Hillaire 2015). Lighting per occupied sample:
//   sun     HG phase (g), shadowed by ONE extra density tap towards the sun (optical depth =
//           trapezoid over the tap), plus a 0.25-strength wide lobe standing in for multiple
//           scattering (after Wrenninge's octaves)
//   ambient uAmbient, dimmed by the sun tap's optical depth
//   spells  spellLightScatter (no capsule shadows: gLightNoShadow), all attenuated by one tap
//           towards the brightest spell light (light 0; packWorld sorts brightest first), so smoke
//           over a fireball is lit from below and dark on top
// Lighting is evaluated on every 2nd occupied sample and held in between (it varies much more
// slowly than density); the two shadow taps alternate, so each refreshes every 4th sample. That
// keeps the march at ~1.5 density evaluations per step. Samples with zero albedo (pure fire, soot)
// skip lighting entirely.
// Step count = clamp(radiusPx / 5, 8, min(maxSteps, Q.volumeSteps * Q.auto.steps)), radiusPx in
// FX-target pixels, set per frame by update(). Samples are combined as trapezoid slabs (sigma,
// albedo and emission averaged over each slab's two ends), which removes the step banding; there is
// NO per-pixel jitter: at half res without TAA any jitter turns into a fixed dither pattern ("grid of
// dots") on high-frequency media. gVolDt (this ray's step) lets volumeSample fade noise octaves the
// march can't resolve.

// Every lookup in a march is LOD 0 (the noise, curl and blackbody textures have no mips anyway):
// common.ts samples them with level 0 throughout (upstream's NO_GRADIENTS define).

const ownUniforms = () => ({
  uVolCenter: uniform(new Vector3()),
  uVolRot: mat3Rows(), // world -> shape axes
  uVolScale: uniform(new Vector3(1, 1, 1)), // half extents (m)
  uVolSteps: uniform(8),
  uVolLight: uniform(new Vector4(0.3, 0.3, 1, 1)), // HG g, sun tap distance (m), ambient gain, sun gain
});
type IOwnUniforms = ReturnType<typeof ownUniforms>;
export interface IVolumeScope extends IOwnUniforms {
  // this ray's step length (m), readable from volumeSample: fade noise octaves finer than ~2 steps
  // (they can't be resolved and only turn into per-pixel grain)
  readonly gVolDt: F;
  // the spell's own uniforms (Volumes.add({ uniforms }))
  readonly [uniform: string]: unknown;
}
export type VolumeSample = (
  pw: V3,
  pl: V3,
  sigma: F,
  albedo: V3,
  emission: V3,
  V: IVolumeScope,
) => void;

// entry/exit distances along a unit ray in shape space (rotated, unscaled, so t is metres)
function volumeHitFor(shape: number, uVolScale: V3) {
  if (shape === 0) {
    return Fn(([o, d]: [V3, V3]) => {
      // ellipsoid
      const out = vec2(1.0, -1.0).toVar();
      const oc = o.div(uVolScale);
      const rd = d.div(uVolScale);
      const a = dot(rd, rd);
      const b = dot(oc, rd);
      const c = dot(oc, oc).sub(1.0);
      const h = b.mul(b).sub(a.mul(c));
      If(h.greaterThanEqual(0.0), () => {
        const hs = sqrt(h);
        out.assign(vec2(b.negate().sub(hs), b.negate().add(hs)).div(a));
      });
      return out;
    });
  }
  if (shape === 1) {
    return Fn(([o, d]: [V3, V3]) => {
      // box
      const dd = vec3(
        select(d.x.abs().lessThan(1e-6), float(1e-6), d.x),
        select(d.y.abs().lessThan(1e-6), float(1e-6), d.y),
        select(d.z.abs().lessThan(1e-6), float(1e-6), d.z),
      );
      const m = vec3(1.0).div(dd);
      const n = m.mul(o);
      const k = m.abs().mul(uVolScale);
      const t1 = n.negate().sub(k);
      const t2 = n.negate().add(k);
      return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
    });
  }
  // capsule along y: radius uVolScale.x, half length uVolScale.y including the caps.
  // Near hit after Inigo Quilez (MIT); the far hit is the near hit of the reversed ray.
  const capsuleNear = Fn(([ro, rd, hy, ra]: [V3, V3, F, F]) => {
    const res = float(-1.0).toVar();
    const ba = vec3(0.0, hy.mul(2.0), 0.0);
    const oa = ro.sub(vec3(0.0, hy.negate(), 0.0));
    const baba = dot(ba, ba);
    const bard = dot(ba, rd);
    const baoa = dot(ba, oa);
    const rdoa = dot(rd, oa);
    const oaoa = dot(oa, oa);
    const a = baba.sub(bard.mul(bard));
    const b = baba.mul(rdoa).sub(baoa.mul(bard));
    const c = baba.mul(oaoa).sub(baoa.mul(baoa)).sub(ra.mul(ra).mul(baba));
    const h = b.mul(b).sub(a.mul(c));
    If(h.greaterThanEqual(0.0), () => {
      const t = b.negate().sub(sqrt(h)).div(a);
      const y = baoa.add(t.mul(bard));
      If(y.greaterThan(0.0).and(y.lessThan(baba)), () => {
        res.assign(t);
      }).Else(() => {
        const oc = select(y.lessThanEqual(0.0), oa, ro.sub(vec3(0.0, hy, 0.0)));
        const b2 = dot(rd, oc);
        const c2 = dot(oc, oc).sub(ra.mul(ra));
        const h2 = b2.mul(b2).sub(c2);
        If(h2.greaterThan(0.0), () => {
          res.assign(b2.negate().sub(sqrt(h2)));
        });
      });
    });
    return res;
  });
  return Fn(([o, d]: [V3, V3]) => {
    const out = vec2(1.0, -1.0).toVar();
    const ra = uVolScale.x;
    const hy = max(uVolScale.y.sub(ra), 1e-4);
    const far = length(o).add(uVolScale.y.add(ra).mul(2.0));
    const tb = capsuleNear(o.add(d.mul(far)), d.negate(), hy, ra);
    If(tb.greaterThanEqual(0.0), () => {
      const qy = o.y.sub(clamp(o.y, hy.negate(), hy));
      const q = vec3(o.x, qy, o.z);
      out.assign(
        vec2(
          select(dot(q, q).lessThan(ra.mul(ra)), float(0.0), capsuleNear(o, d, hy, ra)),
          far.sub(tb),
        ),
      );
    });
    return out;
  });
}

// engine: GLSL read the camera's forward axis from viewMatrix; set once per frame by update()
const uCamForward = uniform(new Vector3(0, 0, -1));

function volumeMain(
  shape: number,
  own: IOwnUniforms,
  extra: Record<string, unknown>,
  volumeSample: VolumeSample,
) {
  const { uVolCenter, uVolRot, uVolScale, uVolSteps, uVolLight } = own;
  const volumeHit = volumeHitFor(shape, uVolScale);
  return Fn(() => {
    // gLightNoShadow = true: spellLightScatter(..., noShadow) below
    const out = vec4(0.0).toVar();
    const rd = normalize(positionWorld.sub(cameraPosition)).toVar();
    const o = mulMat3Rows(uVolRot, cameraPosition.sub(uVolCenter)).toVar();
    const d = mulMat3Rows(uVolRot, rd).toVar();
    const hit = volumeHit(o, d).toVar();
    const cosV = dot(rd, uCamForward).toVar();
    const t0 = max(hit.x, 0.0).toVar();
    const t1 = min(hit.y, sceneViewZ().div(cosV)).toVar();
    If(t1.greaterThan(t0), () => {
      // else discard
      const steps = int(uVolSteps).toVar();
      const dt = t1.sub(t0).div(float(steps)).toVar();
      const gVolDt = dt.toVar();
      const V: IVolumeScope = { ...extra, ...own, gVolDt };
      // samples sit at t0 + (i + j) dt; slabs run between them (trapezoid), plus a j dt slab in
      // front of the first sample and a (1 - j) dt one behind the last, so [t0, t1] is covered exactly
      const j = 0.5;
      const t = t0.add(dt.mul(j)).toVar();
      const len = dt.mul(j).toVar();
      const tap = uVolLight.y;
      const tapS = mulMat3Rows(uVolRot, U.uSunDir).mul(tap);
      const sunPhase = hgPhase(dot(U.uSunDir, rd), uVolLight.x).mul(4.0 * Math.PI);
      const sun = U.uSunColor.mul(uVolLight.w).mul(sunPhase);
      const amb = U.uAmbient.mul(uVolLight.z);
      const scat = vec3(0.0).toVar();
      const emit = vec3(0.0).toVar();
      const Lin = vec3(0.0).toVar();
      const T = float(1.0).toVar();
      const zSum = float(0.0).toVar();
      const wSum = float(0.0).toVar();
      const odSun = float(0.0).toVar();
      const odL = float(0.0).toVar();
      const s2 = float(0.0).toVar();
      const a2 = vec3(0.0).toVar();
      const e2 = vec3(0.0).toVar();
      const sP = float(0.0).toVar();
      const aP = vec3(0.0).toVar();
      const eP = vec3(0.0).toVar(); // previous sample
      const hasLight = U.uWorldCounts.x.greaterThan(0.5);
      const lit = int(0).toVar();
      const sigma = float(0.0).toVar();
      const albedo = vec3(0.0).toVar();
      const e = vec3(0.0).toVar();
      Loop({ start: 0, end: 64, type: "int", condition: "<=" }, ({ i }: { i: Node<"int"> }) => {
        If(i.greaterThan(steps).or(T.lessThan(0.01)), () => {
          Break();
        });
        sigma.assign(sP);
        albedo.assign(aP);
        e.assign(eP);
        If(i.lessThan(steps), () => {
          const ps = o.add(d.mul(t));
          const pw = cameraPosition.add(rd.mul(t));
          volumeSample(pw, ps.div(uVolScale), sigma, albedo, e, V);
          If(sigma.greaterThan(1e-4), () => {
            // lighting on every 2nd occupied sample, held in between; the shadow taps alternate between
            // the sun and the brightest spell light (packWorld sorts it first), both on the first sample
            const k = lit.bitAnd(3);
            If(
              k
                .bitAnd(1)
                .equal(0)
                .and(max(albedo.r, max(albedo.g, albedo.b)).greaterThan(1e-3)),
              () => {
                If(k.equal(0), () => {
                  volumeSample(
                    pw.add(U.uSunDir.mul(tap)),
                    ps.add(tapS).div(uVolScale),
                    s2,
                    a2,
                    e2,
                    V,
                  );
                  odSun.assign(sigma.add(s2).mul(tap));
                });
                If(hasLight.and(k.equal(2).or(lit.equal(0))), () => {
                  const L0 = spellLight(int(0));
                  const lp = select(L0.type.equal(1), closestOnSegment(L0.pos, L0.end, pw), L0.pos);
                  const ld0 = lp.sub(pw);
                  const ll = length(ld0);
                  const dl = min(tap, ll.mul(0.5)); // never tap past the light itself
                  const ld = ld0.mul(dl.div(max(ll, 1e-4)));
                  volumeSample(
                    pw.add(ld),
                    ps.add(mulMat3Rows(uVolRot, ld)).div(uVolScale),
                    s2,
                    a2,
                    e2,
                    V,
                  );
                  odL.assign(sigma.add(s2).mul(dl));
                });
                Lin.assign(
                  sun
                    .mul(exp(odSun.negate()).add(exp(odSun.mul(-0.25)).mul(0.25)))
                    .add(amb.mul(mix(0.35, 1.0, exp(odSun.mul(-0.5)))))
                    .add(
                      spellLightScatter(pw, rd.negate(), uVolLight.x, true).mul(
                        exp(odL.negate()).add(exp(odL.mul(-0.25)).mul(0.25)),
                      ),
                    ),
                );
              },
            );
            lit.addAssign(1);
          });
        }).Else(() => {
          len.assign(dt.mul(1.0 - j));
        });
        // trapezoid slab: the mean of its two end samples, so a density edge between two samples
        // contributes in proportion to where it falls (rectangle slabs turn it into contour bands)
        const first = i.equal(0);
        const sg = select(first, sigma, sigma.add(sP).mul(0.5)).toVar();
        const eg = select(first, e, e.add(eP).mul(0.5)).toVar();
        const ag = select(first, albedo, albedo.add(aP).mul(0.5)).toVar();
        sP.assign(sigma);
        aP.assign(albedo);
        eP.assign(e);
        If(sg.greaterThan(1e-4), () => {
          const Tr = exp(sg.negate().mul(len));
          const a = T.mul(float(1.0).sub(Tr));
          scat.addAssign(ag.mul(Lin).mul(a));
          emit.addAssign(eg.div(sg).mul(a));
          zSum.addAssign(t.sub(len.mul(0.5)).mul(a));
          wSum.addAssign(a);
          T.mulAssign(Tr);
        }).Else(() => {
          emit.addAssign(eg.mul(T).mul(len));
        });
        t.addAssign(dt);
        len.assign(dt);
      });
      const alpha = float(1.0).sub(T);
      If(alpha.greaterThanEqual(0.002).or(dot(emit, emit).greaterThanEqual(1e-6)), () => {
        // else discard
        const z = select(wSum.greaterThan(0.0), zSum.div(wSum), t0).mul(cosV);
        out.assign(fxOut(scat.div(max(alpha, 1e-4)), alpha, emit, vec2(0.0), z));
      });
    });
    return out;
  })();
}

const SHAPES = { sphere: 0, box: 1, capsule: 2 };

// icosphere scaled so its faces (not just its vertices) enclose the unit sphere
function sphereProxy(): BufferGeometry {
  const g = new IcosahedronGeometry(1, 2);
  const p = g.attributes.position as unknown as {
    count: number;
    getX(i: number): number;
    getY(i: number): number;
    getZ(i: number): number;
  };
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const n = new Vector3();
  let inner = 1;
  for (let i = 0; i < p.count; i += 3) {
    a.set(p.getX(i), p.getY(i), p.getZ(i));
    b.set(p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1));
    c.set(p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
    n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    inner = Math.min(inner, Math.abs(n.dot(a)));
  }
  return g.scale(1.01 / inner, 1.01 / inner, 1.01 / inner);
}

const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _m = new Matrix4();
const _r = new Matrix3();

export interface IVolumeHandle {
  mesh: Mesh;
  position: Vector3;
  scale: Vector3;
  quaternion: Quaternion;
  uniforms: Record<string, unknown> & IOwnUniforms;
  visible: boolean;
  maxSteps: number;
  g: number; // HG asymmetry (sun and spell lights)
  shadowTap: number; // sun-shadow tap distance, fraction of the smallest half extent
  ambient: number;
  sun: number;
}

export class Volumes {
  readonly group = new Group(); // add once to the fx scene
  readonly list: IVolumeHandle[] = [];
  readonly proxies: Record<keyof typeof SHAPES, BufferGeometry>;

  constructor() {
    const box = new BoxGeometry(2, 2, 2);
    this.proxies = { sphere: sphereProxy(), box, capsule: box };
  }

  // At load only (one program per call). Returns a plain handle; set its fields each frame.
  add({
    shape = "sphere",
    tsl,
    uniforms = {},
    maxSteps = 32,
  }: {
    shape?: keyof typeof SHAPES;
    tsl: VolumeSample;
    uniforms?: Record<string, unknown>;
    maxSteps?: number;
  }): IVolumeHandle {
    const own = ownUniforms();
    const material = new MeshBasicNodeMaterial({
      ...FX_BLENDING,
      depthTest: false,
      side: BackSide,
    });
    material.fog = false;
    material.fragmentNode = volumeMain(SHAPES[shape], own, uniforms, tsl);
    const mesh = new Mesh(this.proxies[shape], material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    this.group.add(mesh);
    const h: IVolumeHandle = {
      mesh,
      position: mesh.position,
      scale: mesh.scale,
      quaternion: mesh.quaternion,
      uniforms: { ...U, ...own, ...uniforms },
      visible: false,
      maxSteps,
      g: 0.3, // HG asymmetry (sun and spell lights)
      shadowTap: 0.3, // sun-shadow tap distance, fraction of the smallest half extent
      ambient: 1,
      sun: 1,
    };
    this.list.push(h);
    return h;
  }

  update(camera: Camera): void {
    camera.getWorldDirection(uCamForward.value);
    const cap = Math.max(4, Math.floor(Math.min(Q.volumeSteps * Q.auto.steps, 64)));
    const pxPerM =
      // biome-ignore lint/style/noNonNullAssertion: upstream Ultra Elements code, copied verbatim
      0.5 * U.uFxResolution.value.y * (camera as PerspectiveCamera).projectionMatrix.elements[5]!;
    for (const h of this.list) {
      const m = h.mesh;
      const u = h.uniforms;
      m.visible = h.visible;
      if (!h.visible) continue;
      m.updateMatrixWorld();
      m.matrixWorld.decompose(_p, _q, _s);
      u.uVolCenter.value.copy(_p);
      u.uVolScale.value.copy(_s);
      setMat3Rows(u.uVolRot, _r.setFromMatrix4(_m.makeRotationFromQuaternion(_q.invert())));
      u.uVolLight.value.set(h.g, h.shadowTap * Math.min(_s.x, _s.y, _s.z), h.ambient, h.sun);
      const r = Math.max(_s.x, _s.y, _s.z);
      const dist = _p.distanceTo(camera.position);
      const px = dist > r ? (r * pxPerM) / dist : Number.POSITIVE_INFINITY;
      u.uVolSteps.value = Math.min(h.maxSteps, cap, Math.max(8, Math.ceil(px / 5)));
    }
  }
}
