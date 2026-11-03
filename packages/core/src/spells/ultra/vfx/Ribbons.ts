// Ported from Ultra Elements src/vfx/Ribbons.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
import {
  type BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  RGBAFormat,
  Vector3,
  Vector4,
} from "three";
import {
  Fn,
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cross,
  dot,
  exp,
  float,
  ivec2,
  length,
  max,
  min,
  mix,
  mod,
  normalize,
  positionGeometry,
  select,
  smoothstep,
  texture,
  textureLoad,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MeshBasicNodeMaterial, type Node } from "three/webgpu";
import { FX_ADDITIVE, LINES_BLENDING, U, fxOutDistort, softFade } from "./common.js";

type F = Node<"float">;
type V2 = Node<"vec2">;
type V3 = Node<"vec3">;
type V4 = Node<"vec4">;

// Instanced camera-facing strips (PLAN 2.5 "Ribbons and bolts"). One draw per material for every
// ribbon it owns; nothing is allocated after construction. Strips wind either way depending on
// the path direction, so every strip material is DoubleSide.
//   TrailRibbons     history ribbons: a points x max float texture of head positions, a ring per row
//   AnalyticRibbons  stateless: the centreline is user TSL evaluated per vertex
// Bolts.js builds on STRIP_GLSL too.
//
// Distortion amounts everywhere are metres of apparent displacement at the strip's depth, so a far
// effect bends the background less than a near one.
// Engine: every 'fx' strip composites its emission and distortion through fxOutDistort (common.ts)
// with FX_ADDITIVE; the 'lines' strips keep LINES_BLENDING (additive, alpha 1).

// projectionMatrix[1][1]
const proj11 = (): F =>
  (cameraProjectionMatrix as unknown as { element(i: number): V4 }).element(1).y;
const viewProj = (p: V3): V4 =>
  cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(p, 1.0)) as unknown as V4;

// STRIP_GLSL. Needs projectionMatrix, viewMatrix and cameraPosition.
// Humus "phone-wire" AA: a strip is never drawn thinner than 1.5 px; the width it lacks comes back
// as intensity (aa = trueWidth / clampedWidth), so thin wires fade out instead of breaking into dashes.
// Returns the world half width to expand by.
// ENGINE-GAP: a TSL Fn cannot assign its `out` argument ("assign requires a variable"), so this is
// plain JS that returns [half width, aa] (the vertex graph is built outside any Fn)
export const wireHalfWidth = (width: F, viewZ: F, pxPerM: F): [hw: F, aa: F] => {
  const px = width.mul(pxPerM).div(max(viewZ, 1e-3));
  const clamped = max(px, 1.5);
  return [width.mul(0.5).mul(clamped).div(max(px, 1e-6)), px.div(clamped)];
};
// pixels per metre at view depth 1, for a target resY pixels tall
export const pxPerMetre = Fn(([resY]: [F]) => resY.mul(0.5).mul(proj11()));
// unit side vector of a strip through p with tangent t, facing the camera
export const stripSide = Fn(([p, t]: [V3, V3]) => {
  const s = cross(t, p.sub(cameraPosition));
  const l = length(s);
  return select(l.greaterThan(1e-7), s.div(l), vec3(1.0, 0.0, 0.0));
});
// screen-UV offset of 1 m of apparent displacement along world dir at p (dir ~ perpendicular to the view ray)
export const distortPerMetre = Fn(([p, dir, viewZ, res]: [V3, V3, F, V2]) => {
  const a = viewProj(p);
  const b = viewProj(p.add(dir.mul(viewZ.mul(0.01))));
  const px = b.xy.div(b.w).sub(a.xy.div(a.w)).mul(res);
  const d = select(dot(px, px).greaterThan(1e-12), normalize(px), vec2(1.0, 0.0));
  const h = proj11().mul(0.5).div(max(viewZ, 1e-3)); // metres -> fraction of screen height
  return d.mul(vec2(h.mul(res.y).div(res.x), h));
});

// dead instances / strands: every vertex at one point outside the clip volume
const COLLAPSE = (): V4 => vec4(2.0, 2.0, 2.0, 1.0);

// (count + 1) x 2 vertex strip; position = (x, side, z) with x from xOf(i)
function stripIndex(index: number[], base: number, segments: number): void {
  for (let i = 0; i < segments; i++) {
    const a = base + i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
}

// write 4 floats, report whether anything changed (dirty tracking without allocations)
export function put4(
  arr: Float32Array,
  o: number,
  x: number,
  y: number,
  z: number,
  w: number,
): boolean {
  if (arr[o] === x && arr[o + 1] === y && arr[o + 2] === z && arr[o + 3] === w) return false;
  arr[o] = x;
  arr[o + 1] = y;
  arr[o + 2] = z;
  arr[o + 3] = w;
  return true;
}
const put4v = (arr: Float32Array, o: number, v: Vector4) => put4(arr, o, v.x, v.y, v.z, v.w);

export function instanced(
  geo: BufferGeometry,
  name: string,
  count: number,
  size = 4,
): InstancedBufferAttribute {
  const attr = new InstancedBufferAttribute(new Float32Array(count * size), size);
  attr.setUsage(DynamicDrawUsage);
  geo.setAttribute(name, attr);
  return attr;
}

// --- history ribbons ---------------------------------------------------------------------

// TRAIL_VERT (fx: TRAIL_FX defined) and its two fragment shaders
function trailNodes(tex: DataTexture, P: number, uTrailTime: F, fx: boolean) {
  const uTrailTex = texture(tex); // x = point slot (ring), y = trail row; xyz pos, w push time
  const aTrail = attribute("aTrail", "vec4") as unknown as V4; // row, head slot, point count, fade time
  const aLook = attribute("aLook", "vec4") as unknown as V4; // width, glow (fx width multiplier), taper, distortion (m)
  const aColor = attribute("aColor", "vec4") as unknown as V4; // rgb * intensity, glow intensity (fraction of the core's)
  const position = positionGeometry as unknown as V3;

  const trailPoint = (row: F, head: F, i: F): V4 =>
    textureLoad(
      uTrailTex,
      ivec2(mod(head.sub(i).add(P), float(P)).toInt(), row.toInt()),
    ) as unknown as V4;

  const n = aTrail.z;
  const row = aTrail.x;
  const head = aTrail.y;
  const i = min(position.x, n.sub(1.0));
  const c = trailPoint(row, head, i);
  const tangent = trailPoint(row, head, max(i.sub(1.0), 0.0)).xyz.sub(
    trailPoint(row, head, min(i.add(1.0), n.sub(1.0))).xyz,
  );
  const u = i.div(n.sub(1.0));
  // past the last point the strip folds onto it with zero width (zero-area triangles)
  const alive = select(position.x.greaterThan(n.sub(1.0)), float(0.0), float(1.0));
  const fade0 = clamp(float(1.0).sub(uTrailTime.sub(c.w).div(max(aTrail.w, 1e-3))), 0.0, 1.0);
  const fade = fade0.mul(fade0);
  const view = cameraViewMatrix.mul(vec4(c.xyz, 1.0)) as unknown as V4;
  const viewZ = view.z.negate();
  const side = stripSide(c.xyz, tangent);
  const width = aLook.x.mul(mix(1.0, float(1.0).sub(u), aLook.z)).mul(alive);
  let hw: F;
  let aa: F;
  let color: V3;
  let dist: V2 = vec2(0.0);
  if (fx) {
    // the wide glow would end in a square cap at the head: fade it in over the first two points
    const cap = smoothstep(0.0, 2.0, i);
    [hw, aa] = wireHalfWidth(
      width.mul(aLook.y).mul(mix(0.4, 1.0, cap)),
      viewZ,
      pxPerMetre(U.uFxResolution.y),
    );
    color = aColor.rgb.mul(aColor.a).mul(fade).mul(aa).mul(cap);
    dist = distortPerMetre(c.xyz, side, viewZ, U.uFxResolution).mul(aLook.w).mul(fade);
  } else {
    [hw, aa] = wireHalfWidth(width, viewZ, pxPerMetre(U.uResolution.y));
    color = aColor.rgb.mul(fade).mul(aa);
  }
  const vertexNode = select(
    n.lessThan(2.0),
    COLLAPSE(),
    viewProj(c.xyz.add(side.mul(position.y).mul(hw))),
  );
  const vUv = varying(vec2(u, position.y)) as unknown as V2; // along (0 head .. 1 tail), across (-1..1)
  const vColor = varying(color) as unknown as V3;
  const vViewZ = varying(viewZ) as unknown as F;
  const vDist = varying(dist) as unknown as V2;

  let fragmentNode: V4;
  if (fx) {
    // TRAIL_FX_FRAG
    const v = vUv.y;
    const g = max(exp(v.mul(v).mul(-4.0)).sub(0.0183), 0.0); // gaussian, zero at the strip edge
    // derivative-of-gaussian profile: the centreline acts as a cylindrical lens (pushes outward)
    const d = vDist.mul(v.mul(exp(v.mul(v).mul(-3.0))).mul(2.33));
    fragmentNode = fxOutDistort(vColor.mul(g).mul(softFade(vViewZ, 0.4)), d);
  } else {
    // TRAIL_LINES_FRAG
    const v = float(1.0).sub(vUv.y.mul(vUv.y));
    fragmentNode = vec4(vColor.mul(v).mul(v), 1.0);
  }
  return { vertexNode, fragmentNode };
}

// per-trail look, reset on acquire. spacing: metres between committed points (points * spacing
// caps the trail's length; fadeTime its duration)
const TRAIL_DEFAULTS = {
  width: 0.06,
  intensity: 4,
  glow: 6,
  glowIntensity: 0.3,
  distortion: 0,
  taper: 1,
  fadeTime: 0.4,
  spacing: 0.08,
};

export interface ITrailHandle {
  row: number;
  active: boolean;
  released: boolean;
  head: number;
  count: number;
  lastPush: number;
  last: Vector3;
  color: Color;
  width: number;
  intensity: number;
  glow: number;
  glowIntensity: number;
  distortion: number;
  taper: number;
  fadeTime: number;
  spacing: number;
  push(p: Vector3): void;
  release(): void;
}

export class TrailRibbons {
  readonly max: number;
  readonly points: number;
  time = 0;
  readonly data: Float32Array;
  readonly texture: DataTexture;
  private _ranges: { start: number; count: number }[];
  private _nRanges = 0;
  private _full = false;
  readonly geometry: InstancedBufferGeometry;
  readonly aTrail: InstancedBufferAttribute;
  readonly aLook: InstancedBufferAttribute;
  readonly aColor: InstancedBufferAttribute;
  readonly uniforms: typeof U & {
    uTrailTex: { value: DataTexture };
    uTrailTime: F & { value: number };
  };
  readonly lines: Mesh;
  readonly fx: Mesh;
  readonly trails: ITrailHandle[];

  constructor({ max = 64, points = 48 } = {}) {
    this.max = max;
    this.points = points;
    this.data = new Float32Array(points * max * 4);
    const tex = new DataTexture(this.data, points, max, RGBAFormat, FloatType);
    this.texture = tex;
    tex.minFilter = tex.magFilter = NearestFilter;
    tex.needsUpdate = true;
    // one texel per push; preallocated so pushing into texture.updateRanges allocates nothing
    this._ranges = Array.from({ length: max * 4 }, () => ({ start: 0, count: 0 }));

    const geo = new InstancedBufferGeometry();
    const pos: number[] = [];
    const index: number[] = [];
    for (let i = 0; i < points; i++) pos.push(i, -1, 0, i, 1, 0);
    stripIndex(index, 0, points - 1);
    geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
    geo.setIndex(index);
    this.aTrail = instanced(geo, "aTrail", max);
    this.aLook = instanced(geo, "aLook", max);
    this.aColor = instanced(geo, "aColor", max);
    geo.instanceCount = 0;
    this.geometry = geo;

    const uTrailTime = uniform(0) as unknown as F & { value: number };
    this.uniforms = { ...U, uTrailTex: { value: tex }, uTrailTime };
    const make = (blending: object, fx: boolean): Mesh => {
      const material = new MeshBasicNodeMaterial({ ...blending, side: DoubleSide });
      material.fog = false;
      const nodes = trailNodes(tex, points, uTrailTime, fx);
      material.vertexNode = nodes.vertexNode;
      material.fragmentNode = nodes.fragmentNode;
      const mesh = new Mesh(geo, material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 10;
      return mesh;
    };
    this.lines = make(LINES_BLENDING, false);
    this.fx = make(FX_ADDITIVE, true);

    const owner = this;
    this.trails = Array.from(
      { length: max },
      (_, row): ITrailHandle => ({
        row,
        active: false,
        released: false,
        head: 0,
        count: 0,
        lastPush: 0,
        last: new Vector3(),
        color: new Color(1, 1, 1),
        ...TRAIL_DEFAULTS,
        // the newest point follows pos; a new point is committed once it is `spacing` from the last
        push(p: Vector3) {
          if (this.count > 0 && this.last.distanceToSquared(p) >= this.spacing * this.spacing) {
            this.head = (this.head + 1) % owner.points;
            this.count = Math.min(this.count + 1, owner.points);
            this.last.copy(p);
          } else if (this.count === 0) {
            this.count = 1;
            this.last.copy(p);
          }
          owner._write(this.row, this.head, p);
          this.lastPush = owner.time;
        },
        release() {
          this.released = true;
        },
      }),
    );
  }

  // released trails keep drawing until their newest point has faded (fadeTime), then free
  acquire(): ITrailHandle | null {
    for (const t of this.trails) {
      if (t.active) continue;
      Object.assign(t, TRAIL_DEFAULTS);
      t.active = true;
      t.released = false;
      t.head = 0;
      t.count = 0;
      t.color.setRGB(1, 1, 1);
      return t;
    }
    return null;
  }

  _write(row: number, slot: number, p: Vector3): void {
    const i = row * this.points + slot;
    const o = i * 4;
    const d = this.data;
    d[o] = p.x;
    d[o + 1] = p.y;
    d[o + 2] = p.z;
    d[o + 3] = this.time;
    if (this._nRanges < this._ranges.length) {
      const r = this._ranges[this._nRanges++] as { start: number; count: number };
      r.start = o;
      r.count = 4;
    } else this._full = true;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upstream Ultra Elements code, copied verbatim
  update(dt: number): void {
    this.time += dt;
    this.uniforms.uTrailTime.value = this.time;
    const A = this.aTrail.array as Float32Array;
    const B = this.aLook.array as Float32Array;
    const C = this.aColor.array as Float32Array;
    let n = 0;
    for (const t of this.trails) {
      if (!t.active) continue;
      if (t.released && this.time - t.lastPush > t.fadeTime) {
        t.active = false;
        continue;
      }
      const o = n * 4;
      const I = t.intensity;
      A[o] = t.row;
      A[o + 1] = t.head;
      A[o + 2] = t.count;
      A[o + 3] = t.fadeTime;
      B[o] = t.width;
      B[o + 1] = t.glow;
      B[o + 2] = t.taper;
      B[o + 3] = t.distortion;
      C[o] = t.color.r * I;
      C[o + 1] = t.color.g * I;
      C[o + 2] = t.color.b * I;
      C[o + 3] = t.glowIntensity;
      n++;
    }
    this.geometry.instanceCount = n;
    this.lines.visible = this.fx.visible = n > 0;
    if (n) this.aTrail.needsUpdate = this.aLook.needsUpdate = this.aColor.needsUpdate = true;

    // texel uploads: only what was pushed. Ranges still queued from a frame that never drew mean
    // the GPU copy is behind, so send the whole texture once (48 KB at 64 x 48).
    // Engine: a texture without updateRanges uploads whole on needsUpdate.
    const tex = this.texture as DataTexture & { updateRanges?: { start: number; count: number }[] };
    const ranges = tex.updateRanges;
    if (ranges === undefined) {
      if (this._nRanges || this._full) tex.needsUpdate = true;
    } else {
      if (ranges.length) this._full = true;
      if (this._full) {
        ranges.length = 0;
        tex.needsUpdate = true;
      } else if (this._nRanges) {
        for (let i = 0; i < this._nRanges; i++)
          ranges.push(this._ranges[i] as { start: number; count: number });
        tex.needsUpdate = true;
      }
    }
    this._full = false;
    this._nRanges = 0;
  }
}

// --- analytic ribbons ------------------------------------------------------------------

// ANALYTIC_HEAD's RibbonFrag; a TSL Fn cannot take a struct here, so the shade is plain JS over nodes
export interface IRibbonFrag {
  uv: V2; // x along 0..1, y across -1..1
  p0: V4;
  p1: V4;
  p2: V4;
  p3: V4;
  color: V3; // colour * intensity
  viewZ: F;
}
// pathGLSL -> path: vec3 ribbonPath(float t, vec4 p0, vec4 p1, vec4 p2, vec4 p3, out float width)   t 0..1
//   ENGINE-GAP: no Fn out arguments, so a path returns { p, width }
export type RibbonPath = (t: F, p0: V4, p1: V4, p2: V4, p3: V4) => { p: V3; width: F };
// shadeGLSL -> shade: vec3 ribbonShade(RibbonFrag r, out vec3 media, out float alpha, out float distortion)
//   returns emission; media/alpha (WBOIT coverage) and distortion only count for target 'fx'.
//   distortion: signed metres along the +uv.y side; make it odd in uv.y (e.g. uv.y * exp(-3 uv.y^2))
//   to push the background away from the centreline.
export type RibbonShade = (r: IRibbonFrag, media: V3, alpha: F, distortion: F) => V3;

// The default shade: a soft additive core in the ribbon's colour.
const DEFAULT_SHADE: RibbonShade = (r, media, alpha, distortion) => {
  media.assign(vec3(0.0));
  alpha.assign(0.0);
  distortion.assign(0.0);
  const v = float(1.0).sub(r.uv.y.mul(r.uv.y));
  return r.color.mul(v).mul(v);
};

// ANALYTIC_VERT + ANALYTIC_LINES_FRAG / ANALYTIC_FX_FRAG
function analyticNodes(segments: number, path: RibbonPath, shade: RibbonShade, fx: boolean) {
  const uSegments = float(segments);
  const aP0 = attribute("aP0", "vec4") as unknown as V4;
  const aP1 = attribute("aP1", "vec4") as unknown as V4;
  const aP2 = attribute("aP2", "vec4") as unknown as V4;
  const aP3 = attribute("aP3", "vec4") as unknown as V4;
  const aColor = attribute("aColor", "vec4") as unknown as V4; // rgb * intensity, on
  const position = positionGeometry as unknown as V3;

  const t = position.x;
  const { p, width: w } = path(t, aP0, aP1, aP2, aP3);
  const h = float(0.5).div(uSegments);
  const tangent = path(min(t.add(h), 1.0), aP0, aP1, aP2, aP3).p.sub(
    path(max(t.sub(h), 0.0), aP0, aP1, aP2, aP3).p,
  );
  const side = stripSide(p, tangent);
  const viewZ = (cameraViewMatrix.mul(vec4(p, 1.0)) as unknown as V4).z.negate();
  const [hw, aa] = fx
    ? wireHalfWidth(w, viewZ, pxPerMetre(U.uFxResolution.y))
    : wireHalfWidth(w, viewZ, pxPerMetre(U.uResolution.y));
  const dist = fx ? distortPerMetre(p, side, viewZ, U.uFxResolution) : vec2(0.0);
  const vertexNode = select(
    aColor.a.lessThanEqual(0.0),
    COLLAPSE(),
    viewProj(p.add(side.mul(position.y).mul(hw))),
  );
  const vUv = varying(vec2(t, position.y)) as unknown as V2;
  const vViewZ = varying(viewZ) as unknown as F;
  const vAA = varying(aa) as unknown as F;
  const vDist = varying(dist) as unknown as V2;
  const r: IRibbonFrag = {
    uv: vUv,
    p0: varying(aP0) as unknown as V4,
    p1: varying(aP1) as unknown as V4,
    p2: varying(aP2) as unknown as V4,
    p3: varying(aP3) as unknown as V4,
    color: varying(aColor.rgb) as unknown as V3,
    viewZ: vViewZ,
  };
  const fragmentNode = Fn(() => {
    const media = vec3(0.0).toVar();
    const alpha = float(0.0).toVar();
    const distortion = float(0.0).toVar();
    const e = shade(r, media, alpha, distortion);
    if (!fx) return vec4(e.mul(vAA), 1.0);
    const s = softFade(vViewZ, 0.3).mul(vAA);
    // ENGINE-GAP: no CustomBlending / MRT, so an 'fx' ribbon composites its emission and distortion
    // additively (fxOutDistort); the shade's media and alpha (WBOIT coverage) are not drawn yet
    return fxOutDistort(e.mul(s), vDist.mul(distortion).mul(s));
  })();
  return { vertexNode, fragmentNode };
}

export interface IAnalyticRibbon {
  index: number;
  active: boolean;
  p0: Vector4;
  p1: Vector4;
  p2: Vector4;
  p3: Vector4;
  color: Color;
  intensity: number;
  release(): void;
}

// path / shade: TSL in place of upstream's pathGLSL / shadeGLSL (see RibbonPath, RibbonShade).
// Either may close over its own uniform nodes (upstream: `uniforms`, kept on this.uniforms).
export class AnalyticRibbons {
  readonly max: number;
  readonly geometry: InstancedBufferGeometry;
  readonly attrs: InstancedBufferAttribute[];
  readonly uniforms: Record<string, unknown>;
  readonly mesh: Mesh;
  readonly ribbons: IAnalyticRibbon[];

  constructor({
    max = 16,
    segments = 64,
    path,
    shade = DEFAULT_SHADE,
    target = "lines",
    uniforms = {},
  }: {
    max?: number;
    segments?: number;
    path: RibbonPath;
    shade?: RibbonShade;
    target?: "lines" | "fx";
    uniforms?: Record<string, unknown>;
  }) {
    this.max = max;
    const geo = new InstancedBufferGeometry();
    const pos: number[] = [];
    const index: number[] = [];
    for (let i = 0; i <= segments; i++) pos.push(i / segments, -1, 0, i / segments, 1, 0);
    stripIndex(index, 0, segments);
    geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
    geo.setIndex(index);
    this.attrs = ["aP0", "aP1", "aP2", "aP3", "aColor"].map((n) => instanced(geo, n, max));
    geo.instanceCount = 0;
    this.geometry = geo;
    this.uniforms = { ...U, ...uniforms, uSegments: { value: segments } };
    const fx = target === "fx";
    const material = new MeshBasicNodeMaterial({
      ...(fx ? FX_ADDITIVE : LINES_BLENDING),
      side: DoubleSide,
    });
    material.fog = false;
    const nodes = analyticNodes(segments, path, shade, fx);
    material.vertexNode = nodes.vertexNode;
    material.fragmentNode = nodes.fragmentNode;
    this.mesh = new Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 10;
    this.ribbons = Array.from({ length: max }, (_, index) => ({
      index,
      active: false,
      p0: new Vector4(),
      p1: new Vector4(),
      p2: new Vector4(),
      p3: new Vector4(),
      color: new Color(1, 1, 1),
      intensity: 1,
      release() {
        this.active = false;
      },
    }));
  }

  acquire(): IAnalyticRibbon | null {
    for (const r of this.ribbons) {
      if (r.active) continue;
      r.active = true;
      r.intensity = 1;
      r.color.setRGB(1, 1, 1);
      r.p0.set(0, 0, 0, 0);
      r.p1.set(0, 0, 0, 0);
      r.p2.set(0, 0, 0, 0);
      r.p3.set(0, 0, 0, 0);
      return r;
    }
    return null;
  }

  // copy handle fields into the instance attributes; upload only if something changed
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upstream Ultra Elements code, copied verbatim
  update(): void {
    let top = 0;
    let dirty = false;
    const X = this.attrs;
    const a0 = X[0]?.array as Float32Array;
    const a1 = X[1]?.array as Float32Array;
    const a2 = X[2]?.array as Float32Array;
    const a3 = X[3]?.array as Float32Array;
    const ac = X[4]?.array as Float32Array;
    for (const r of this.ribbons) {
      const o = r.index * 4;
      const on = r.active && r.intensity > 0;
      if (on) top = r.index + 1;
      dirty =
        put4(
          ac,
          o,
          r.color.r * r.intensity,
          r.color.g * r.intensity,
          r.color.b * r.intensity,
          on ? 1 : 0,
        ) || dirty;
      if (!on) continue;
      dirty = put4v(a0, o, r.p0) || dirty;
      dirty = put4v(a1, o, r.p1) || dirty;
      dirty = put4v(a2, o, r.p2) || dirty;
      dirty = put4v(a3, o, r.p3) || dirty;
    }
    if (dirty) for (const x of this.attrs) x.needsUpdate = true;
    this.geometry.instanceCount = top;
    this.mesh.visible = top > 0;
  }
}
