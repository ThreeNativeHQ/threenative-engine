// Ported from Ultra Elements src/vfx/Shockwaves.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
import {
  Color,
  DoubleSide,
  Float32BufferAttribute,
  type InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  Vector3,
} from "three";
import {
  Discard,
  Fn,
  abs,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cross,
  dot,
  exp,
  float,
  length,
  max,
  normalize,
  positionGeometry,
  screenUV,
  select,
  sqrt,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MeshBasicNodeMaterial, type Node } from "three/webgpu";
import { instanced } from "./Ribbons.js";
import { FX_DISTORT_BLENDING, U, fxOutDistort, softFade } from "./common.js";

type F = Node<"float">;
type V2 = Node<"vec2">;
type V3 = Node<"vec3">;
type V4 = Node<"vec4">;

// Expanding shock shells and ground rings in the fx pass: a radial screen-space distortion
// proportional to how much shell the view ray crosses (so the rim reads as a lens), plus optional
// emission. Fire and forget: spawn() and the pool (16, one instanced draw) ages them out.
//   sphere: camera-facing quad perpendicular to the view axis, sized to the shell's silhouette cone;
//           the profile is the exact chord through the shell, normalised to 1 at its peak (rho = inner radius)
//   ground: a flat quad hugging pos.y; ring profile with a sharp leading edge and a soft wake
// Radius follows a blast-wave curve r0 + (r1 - r0) x^0.4 (Sedov-Taylor r ~ t^0.4); emission decays
// as (1 - x)^3 (a flash), distortion as (1 - x)^1.5 after a 5% attack. distortion is metres of
// apparent displacement at the shell's depth.
// Engine: the distortion and the emission composite through fxOutDistort (common.ts), FX_DISTORT_BLENDING.

// projectionMatrix[1][1]
const proj11 = (): F =>
  (cameraProjectionMatrix as unknown as { element(i: number): V4 }).element(1).y;

function shockNodes() {
  const aS0 = attribute("aS0", "vec4") as unknown as V4; // centre, ground
  const aS1 = attribute("aS1", "vec4") as unknown as V4; // radius, thickness, progress (< 0: dead), -
  const aS2 = attribute("aS2", "vec4") as unknown as V4; // emission rgb, distortion (m), envelopes applied
  const position = positionGeometry as unknown as V3;

  // VERT
  const c = aS0.xyz;
  const R = aS1.x.add(aS1.y.mul(0.75));
  const toC = c.sub(cameraPosition);
  const D = length(toC);
  // ponytail: a camera inside a sphere shell just loses it (ground rings still draw)
  const dead = aS1.z.lessThan(0.0).or(aS0.w.lessThan(0.5).and(D.lessThan(R.mul(1.05))));
  const f = toC.div(D);
  const r = normalize(
    cross(f, select(abs(f.y).lessThan(0.99), vec3(0.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0))),
  );
  const u = cross(r, f);
  const pSphere = c.add(
    r
      .mul(position.x)
      .add(u.mul(position.y))
      .mul(R.div(sqrt(float(1.0).sub(R.div(D).mul(R.div(D)))))),
  );
  const pGround = c.add(vec3(position.x.mul(R), 0.03, position.y.mul(R)));
  const p = select(aS0.w.greaterThan(0.5), pGround, pSphere);
  const cc = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(c, 1.0)) as unknown as V4;
  const view = cameraViewMatrix.mul(vec4(p, 1.0)) as unknown as V4;
  const vertexNode = select(
    dead,
    vec4(2.0, 2.0, 2.0, 1.0),
    cameraProjectionMatrix.mul(view) as unknown as V4,
  );
  const vWorld = varying(p) as unknown as V3;
  const vViewZ = varying(view.z.negate()) as unknown as F;
  const vS0 = varying(aS0) as unknown as V4;
  const vS1 = varying(aS1) as unknown as V4;
  const vS2 = varying(aS2) as unknown as V4;
  const vCentre = varying(cc.xy.div(cc.w).mul(0.5).add(0.5).mul(U.uFxResolution)) as unknown as V2; // projected centre, fx pixels

  // FRAG
  const fragmentNode = Fn(() => {
    const cF = vS0.xyz;
    const rF = vS1.x;
    const th = vS1.y;
    // sharp leading edge, soft wake behind it
    const x = length(vWorld.xz.sub(cF.xz)).sub(rF).div(th.mul(0.5));
    const profGround = exp(
      x
        .mul(x)
        .negate()
        .mul(select(x.greaterThan(0.0), float(6.0), float(0.8))),
    );
    const rd = normalize(vWorld.sub(cameraPosition));
    const oc = cF.sub(cameraPosition);
    const tc = dot(oc, rd);
    const rho2 = max(dot(oc, oc).sub(tc.mul(tc)), 0.0);
    const ro = rF.add(th.mul(0.5));
    const ri = max(rF.sub(th.mul(0.5)), 0.0);
    const chord = sqrt(max(ro.mul(ro).sub(rho2), 0.0)).sub(sqrt(max(ri.mul(ri).sub(rho2), 0.0)));
    const profSphere = chord.div(sqrt(max(ro.mul(ro).sub(ri.mul(ri)), 1e-6)));
    const prof = select(vS0.w.greaterThan(0.5), profGround, profSphere).toVar();
    Discard(prof.lessThan(1e-3));
    // gl_FragCoord in fx pixels, GL orientation (y up)
    const frag = vec2(screenUV.x, screenUV.y.oneMinus()).mul(U.uFxResolution);
    const dir0 = frag.sub(vCentre);
    const dir = select(dot(dir0, dir0).greaterThan(1e-6), normalize(dir0), vec2(0.0));
    const h = proj11().mul(0.5).div(max(vViewZ, 1e-3));
    const s = softFade(vViewZ, 0.3).mul(prof);
    // sample nearer the centre: the background bulges outward under the rim
    const dist = dir
      .negate()
      .mul(vec2(h.mul(U.uFxResolution.y).div(U.uFxResolution.x), h))
      .mul(vS2.w)
      .mul(s);
    // emission hugs the rim (seen through, the shell's two walls would otherwise glow as a dome)
    const p2 = prof.mul(prof);
    return fxOutDistort(
      vS2.rgb.mul(p2).mul(p2).mul(softFade(vViewZ, 0.3)),
      dist,
      vec3(0.0),
      float(0.0),
    );
  })();
  return { vertexNode, fragmentNode };
}

export interface IShock {
  index: number;
  active: boolean;
  age: number;
  pos: Vector3;
  radius0: number;
  radius1: number;
  duration: number;
  thickness: number;
  distortion: number;
  color: Color;
  intensity: number;
  ground: boolean;
}

export class Shockwaves {
  readonly attrs: InstancedBufferAttribute[];
  readonly geometry: InstancedBufferGeometry;
  readonly uniforms = { ...U };
  readonly mesh: Mesh;
  readonly slots: IShock[];

  constructor({ max = 16 } = {}) {
    const geo = new InstancedBufferGeometry();
    geo.setAttribute(
      "position",
      new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    );
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.attrs = ["aS0", "aS1", "aS2"].map((n) => instanced(geo, n, max));
    geo.instanceCount = 0;
    this.geometry = geo;
    const material = new MeshBasicNodeMaterial({ ...FX_DISTORT_BLENDING, side: DoubleSide });
    material.fog = false;
    const nodes = shockNodes();
    material.vertexNode = nodes.vertexNode;
    material.fragmentNode = nodes.fragmentNode;
    this.mesh = new Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 10;
    this.slots = Array.from({ length: max }, (_, index) => ({
      index,
      active: false,
      age: 0,
      pos: new Vector3(),
      radius0: 0.2,
      radius1: 6,
      duration: 0.6,
      thickness: 0.6,
      distortion: 0.12,
      color: new Color(1, 1, 1),
      intensity: 0,
      ground: false,
    }));
  }

  // pos: Vector3, color: THREE.Color (both copied). Full pool: the most advanced wave is replaced.
  spawn({
    pos,
    radius0 = 0.2,
    radius1 = 6,
    duration = 0.6,
    thickness = 0.6,
    distortion = 0.12,
    color,
    intensity = 0,
    ground = false,
  }: {
    pos: Vector3;
    radius0?: number;
    radius1?: number;
    duration?: number;
    thickness?: number;
    distortion?: number;
    color?: Color;
    intensity?: number;
    ground?: boolean;
  }): IShock {
    let s = this.slots[0] as IShock;
    for (const x of this.slots) {
      if (!x.active) {
        s = x;
        break;
      }
      if (x.age / x.duration > s.age / s.duration) s = x;
    }
    s.pos.copy(pos);
    Object.assign(s, {
      active: true,
      age: 0,
      radius0,
      radius1,
      duration,
      thickness,
      distortion,
      intensity,
      ground,
    });
    if (color) s.color.copy(color);
    else s.color.setRGB(1, 1, 1);
    return s;
  }

  update(dt: number): void {
    const a0 = this.attrs[0]?.array as Float32Array;
    const a1 = this.attrs[1]?.array as Float32Array;
    const a2 = this.attrs[2]?.array as Float32Array;
    let top = 0;
    for (const s of this.slots) {
      const o = s.index * 4;
      if (s.active) {
        s.age += dt;
        if (s.age >= s.duration) s.active = false;
      }
      if (!s.active) {
        a1[o + 2] = -1;
        continue;
      }
      top = s.index + 1;
      const x = s.age / s.duration;
      const k = 1 - x;
      const e = s.intensity * k * k * k;
      const d = s.distortion * k ** 1.5 * Math.min(1, x / 0.05);
      a0[o] = s.pos.x;
      a0[o + 1] = s.pos.y;
      a0[o + 2] = s.pos.z;
      a0[o + 3] = s.ground ? 1 : 0;
      a1[o] = s.radius0 + (s.radius1 - s.radius0) * x ** 0.4;
      a1[o + 1] = s.thickness * (0.5 + 0.5 * x);
      a1[o + 2] = x;
      a2[o] = s.color.r * e;
      a2[o + 1] = s.color.g * e;
      a2[o + 2] = s.color.b * e;
      a2[o + 3] = d;
    }
    for (const a of this.attrs) a.needsUpdate = true;
    this.geometry.instanceCount = top;
    this.mesh.visible = top > 0;
  }
}
