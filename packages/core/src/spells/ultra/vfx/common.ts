// Ported from Ultra Elements src/vfx/common.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
//
// How the GLSL chunks map to TSL, for every module ported after this one:
//   - each GLSL chunk (COMMON_GLSL, NOISE_GLSL, ...) is a set of exported TSL functions with the GLSL
//     function's own name (hash11, noise3, blackbody, spellLightScatter, fxOut, ...). TSL Fns inline at
//     the call site, so a GLSL `out`/`inout` parameter is a var node the caller passes in
//     (`const s = float(0).toVar(); segSegDist(p1, q1, p2, q2, s)`), and a GLSL struct is a plain
//     object of nodes (spellLight(i)).
//   - U keeps upstream's shape: every scalar/vector entry is a TSL uniform node, whose `.value` is the
//     same object upstream's `{ value }` held, so `U.uTime.value = t` is unchanged JS. Texture entries
//     stay `{ value: Texture }` holders read when a material's graph is built (bake noise first).
//   - GLSL globals a shader sets (gLightNoShadow, gVolDt) become build-time arguments or vars.
// What the engine forces (reported, not hidden):
//   - no matrix uniforms: a mat3 uniform is three vec3 row uniforms (Volumes' uVolRot).
//   - no CustomBlending and no multi-target render target: see FX_BLENDING and fxOut below.
//   - uSceneDepth is the engine's viewportDepthTexture() (the frame's depth as drawn before the FX).
import {
  AdditiveBlending,
  Color,
  Data3DTexture,
  DataTexture,
  FloatType,
  type Matrix3,
  NearestFilter,
  NormalBlending,
  RGBAFormat,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import {
  Break,
  Continue,
  Fn,
  If,
  Loop,
  PI,
  abs,
  atan,
  clamp,
  cos,
  cross,
  distance,
  dot,
  exp,
  float,
  fract,
  int,
  ivec2,
  length,
  log,
  mat3,
  max,
  min,
  mix,
  mod,
  normalize,
  pow,
  reflect,
  screenUV,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  texture3D,
  textureLoad,
  uniform,
  vec2,
  vec3,
  vec4,
  viewportDepthTexture,
  viewportSharedTexture,
} from "three/tsl";
import type { Node } from "three/webgpu";

type F = Node<"float">;
type V2 = Node<"vec2">;
type V3 = Node<"vec3">;
type V4 = Node<"vec4">;
type I = Node<"int">;

// The shared world every spell, sim and material sees. One file so the GLSL and its JS mirror
// stay side by side:
//   - ARENA: the fixed layout (floor, rim wall, pillars, dummies, pool, caster focus)
//   - U: uniforms shared by reference across every material ({ ...U, own uniforms })
//   - the world texture: lights, forces, impacts and capsule occluders packed into one 64x4
//     RGBA32F DataTexture, uploaded once per frame and read with texelFetch (no uniform-array
//     limits, no per-material uploads)
//   - GLSL chunks to read all of the above, and arenaSDF()/arenaRaycast() mirrored in JS
//
// Conventions: metres, y up, floor at y = 0, linear HDR. Spells never touch the texture;
// they hold handles from lights/forces/impacts/occluders and set plain fields.

// --- arena layout -------------------------------------------------------------------
const pillarAngles = Array.from({ length: 8 }, (_, i) => ((i + 0.5) * Math.PI) / 4);
export const ARENA = {
  radius: 18, // inner face of the rim wall
  wallThickness: 0.6,
  wallHeight: 1.2,
  pillarRing: 14,
  pillarRadius: 0.6,
  pillarHeight: 6,
  pillars: pillarAngles.map((a) => new Vector3(Math.cos(a) * 14, 0, Math.sin(a) * 14)),
  focus: new Vector3(0, 1.6, 12), // caster's focus orb, on a pedestal
  pedestal: { pos: new Vector3(0, 0, 12), radius: 0.35, height: 1.15 },
  dummies: [new Vector3(0, 0, 2), new Vector3(-3.5, 0, -2), new Vector3(3.5, 0, -6)],
  dummyRadius: 0.35, // capsule (x, 0.35, z) -> (x, 1.55, z)
  dummyHeight: 1.9,
  pool: { center: new Vector2(9.75, 0), half: new Vector2(2.25, 4.5), depth: 0.15, water: -0.03 },
  ground: { min: new Vector2(-20, -20), size: 40 }, // ground field covers this square
};

// --- shared uniforms ----------------------------------------------------------------
export const WORLD_W = 64;
export const MAX_LIGHTS = 16,
  MAX_FORCES = 16,
  MAX_IMPACTS = 16,
  MAX_OCCLUDERS = 32;
const worldData = new Float32Array(WORLD_W * 4 * 4);
const worldTex = new DataTexture(worldData, WORLD_W, 4, RGBAFormat, FloatType);
worldTex.magFilter = worldTex.minFilter = NearestFilter;
worldTex.needsUpdate = true;

const placeholder3D = new Data3DTexture(new Uint8Array([128, 128, 128, 128]), 1, 1, 1);
placeholder3D.needsUpdate = true;
const placeholder2D = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
placeholder2D.needsUpdate = true;

export const U = {
  uTime: uniform(0), // seconds, scaled by time scale, wraps at 3600
  uDt: uniform(1 / 60),
  uFrame: uniform(0),
  uWorld: { value: worldTex },
  uWorldCounts: uniform(new Vector4()), // lights, forces, impacts, occluders
  uNoise3D: { value: placeholder3D }, // noise.js: 128^3 RGBA8 tileable (r perlin-worley fbm, gba worley f2/f4/f8)
  uCurl3D: { value: placeholder3D }, // noise.js: 64^3 RGBA8 tileable curl, rgb = curl * 0.5 + 0.5
  uBlackbody: { value: placeholder2D }, // noise.js: 256x1 RGBA16F, see blackbody() below for the mapping
  // its own placeholder: GroundField moves a holder's shared texture node, so A, B and uBlackbody must not share one
  uGroundA: { value: placeholder2D.clone() }, // GroundField: heat, char, wet, frost
  uGroundB: { value: placeholder2D.clone() }, // GroundField: crack, acid, corruption, glow
  uGroundRect: uniform(
    new Vector4(ARENA.ground.min.x, ARENA.ground.min.y, ARENA.ground.size, 1 / ARENA.ground.size),
  ),
  uSceneDepth: { value: null }, // engine: unused, sceneViewZ() reads viewportDepthTexture()
  uSceneColor: { value: null }, // engine: unused, a refraction material reads viewportSharedTexture()
  uResolution: uniform(new Vector2(1, 1)),
  uFxResolution: uniform(new Vector2(1, 1)),
  uNearFar: uniform(new Vector2(0.1, 400)),
  uSunDir: uniform(new Vector3(0, 1, 0)),
  uSunColor: uniform(new Vector3(1, 1, 1)), // radiance scale, as UW's sky.sunColor
  uAmbient: uniform(new Vector3(0.1, 0.1, 0.12)), // average sky irradiance / pi, for particles
  uSkyCube: { value: null },
  uDebug: uniform(0), // debug view id (0 = off), read by FX materials for overdraw
  // FxTarget.params as fxOut reads them: smoke occludes glow, distortion scale, CA, - (engine: the
  // composite runs inside fxOut, see FX_BLENDING)
  uFxParams: uniform(new Vector4(0.5, 1, 0.35, 0)),
};

// --- GLSL -> TSL ---------------------------------------------------------------------
// COMMON_GLSL
// Hash without Sine (Dave Hoskins, MIT)
export const hash11 = Fn(([p0]: [F]) => {
  const p = fract(p0.mul(0.1031)).toVar();
  p.mulAssign(p.add(33.33));
  p.mulAssign(p.add(p));
  return fract(p);
});
export const hash12 = Fn(([p]: [V2]) => {
  const q = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const p3 = q.add(dot(q, q.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});
export const hash21 = Fn(([p]: [F]) => {
  const q = fract(vec3(p).mul(vec3(0.1031, 0.103, 0.0973)));
  const p3 = q.add(dot(q, q.yzx.add(33.33)));
  return fract(p3.xx.add(p3.yz).mul(p3.zy));
});
export const hash31 = Fn(([p]: [F]) => {
  const q = fract(vec3(p).mul(vec3(0.1031, 0.103, 0.0973)));
  const p3 = q.add(dot(q, q.yzx.add(33.33)));
  return fract(p3.xxy.add(p3.yzz).mul(p3.zyx));
});
export const hash33 = Fn(([p]: [V3]) => {
  const q = fract(p.mul(vec3(0.1031, 0.103, 0.0973)));
  const p3 = q.add(dot(q, q.yxz.add(33.33)));
  return fract(p3.xxy.add(p3.yxx).mul(p3.zyx));
});
export const hash41 = Fn(([p]: [F]) => {
  const q = fract(vec4(p).mul(vec4(0.1031, 0.103, 0.0973, 0.1099)));
  const p4 = q.add(dot(q, q.wzxy.add(33.33)));
  return fract(p4.xxyz.add(p4.yzzw).mul(p4.zywx));
});
// interleaved gradient noise (Jimenez 2014), rotated per frame
export const ign = Fn(([px]: [V2]) => {
  const q = px.add(mod(U.uFrame, 64.0).mul(5.588238));
  return fract(fract(dot(q, vec2(0.06711056, 0.00583715))).mul(52.9829189));
});
export const linearDepth = Fn(([d]: [F]) =>
  U.uNearFar.x.mul(U.uNearFar.y).div(U.uNearFar.y.sub(d.mul(U.uNearFar.y.sub(U.uNearFar.x)))),
);
export const randomInSphere = Fn(([r]: [V3]) => {
  const z = r.x.mul(2.0).sub(1.0);
  const a = r.y.mul(2.0 * Math.PI);
  const s = sqrt(float(1.0).sub(z.mul(z)));
  return vec3(s.mul(cos(a)), z, s.mul(sin(a))).mul(pow(r.z, 1.0 / 3.0));
});
export const randomOnSphere = Fn(([r]: [V2]) => {
  const z = r.x.mul(2.0).sub(1.0);
  const a = r.y.mul(2.0 * Math.PI);
  const s = sqrt(float(1.0).sub(z.mul(z)));
  return vec3(s.mul(cos(a)), z, s.mul(sin(a)));
});
export const basisFrom = Fn(([n]: [V3]) => {
  const t = select(abs(n.y).lessThan(0.99), normalize(cross(n, vec3(0, 1, 0))), vec3(1, 0, 0));
  return mat3(t, cross(t, n), n);
});
export const hgPhase = Fn(([mu, g]: [F, F]) => {
  const g2 = g.mul(g);
  return float(1.0)
    .sub(g2)
    .div(pow(float(1.0).add(g2).sub(g.mul(2.0).mul(mu)), 1.5).mul(4.0 * Math.PI));
});

// NOISE_GLSL. Every lookup is LOD 0 (the noise, curl and blackbody textures have no mips), which is
// also what WGSL needs to sample inside the data-dependent loops of a march.
// Engine: each texture()/texture3D() call is its own binding (a fragment stage holds 16), so every
// texture is one shared node, built on first use, and each lookup is `.sample(uv)` of it (GLSL's
// one `uniform sampler`).
const shared = new Map<object, Node>();
function textureNode(tex: object, make: () => Node): Node {
  let node = shared.get(tex);
  if (node === undefined) {
    node = make();
    shared.set(tex, node);
  }
  return node;
}
const sample3 = (tex: Data3DTexture, p: V3): V4 =>
  (textureNode(tex, () => texture3D(tex)) as ReturnType<typeof texture3D>)
    .sample(p)
    .level(float(0)) as unknown as V4;
const sample2 = (tex: DataTexture, uv: V2, lod = true): V4 => {
  const node = (textureNode(tex, () => texture(tex)) as ReturnType<typeof texture>).sample(uv);
  return (lod ? node.level(float(0)) : node) as unknown as V4;
};
// p in tile units (one tile = one repeat of the texture)
export const noise3v = Fn(([p]: [V3]) => sample3(U.uNoise3D.value, p));
export const noise3 = Fn(([p]: [V3]) => sample3(U.uNoise3D.value, p).r);
export const worley3 = Fn(([p]: [V3]) => sample3(U.uNoise3D.value, p).g);
export const curl3 = Fn(([p]: [V3]) => sample3(U.uCurl3D.value, p).rgb.mul(2.0).sub(1.0));
// two-octave fbm from the baked fbm channel (already 4 octaves deep)
export const fbm3 = Fn(([p]: [V3]) =>
  sample3(U.uNoise3D.value, p)
    .r.mul(0.7)
    .add(sample3(U.uNoise3D.value, p.mul(2.63).add(0.37)).r.mul(0.3)),
);
// Blackbody chromaticity in linear sRGB, normalised to luminance 1. u = log(K / 500) / log(40),
// i.e. 500 K .. 20000 K logarithmically. Intensity is a separate artist curve.
export const blackbody = Fn(
  ([kelvin]: [F]) =>
    sample2(
      U.uBlackbody.value,
      vec2(clamp(log(kelvin.div(500.0)).div(Math.log(40.0)), 0.0, 1.0), 0.5),
    ).rgb,
);

// WORLD_GLSL
export const worldTexel = Fn(([row, i]: [I, I]) =>
  textureLoad(
    textureNode(U.uWorld.value, () => texture(U.uWorld.value)) as Parameters<typeof textureLoad>[0],
    ivec2(i, row),
    int(0),
  ),
);

// ARENA_GLSL: floor (pool recess), rim wall ring, then every capsule in the occluder list
export const sdCapsule = Fn(([p, a, b, r]: [V3, V3, V3, F]) => {
  const pa = p.sub(a);
  const ba = b.sub(a);
  const h = clamp(dot(pa, ba).div(max(dot(ba, ba), 1e-6)), 0.0, 1.0);
  return length(pa.sub(ba.mul(h))).sub(r);
});
export const arenaStatic = Fn(([p]: [V3]) => {
  const pq = abs(p.xz.sub(vec2(ARENA.pool.center.x, ARENA.pool.center.y)));
  const floorY = select(
    pq.x.lessThan(ARENA.pool.half.x).and(pq.y.lessThan(ARENA.pool.half.y)),
    float(ARENA.pool.water),
    float(0.0),
  );
  const d = p.y.sub(floorY);
  const q = vec2(
    abs(length(p.xz).sub(ARENA.radius + ARENA.wallThickness / 2)).sub(ARENA.wallThickness / 2),
    abs(p.y.sub(ARENA.wallHeight / 2)).sub(ARENA.wallHeight / 2),
  );
  return min(d, length(max(q, 0.0)).add(min(max(q.x, q.y), 0.0)));
});
export const arenaSDF = Fn(([p]: [V3]) => {
  const d = arenaStatic(p).toVar();
  const n = int(U.uWorldCounts.w);
  Loop({ start: 0, end: MAX_OCCLUDERS, type: "int", condition: "<" }, ({ i }: { i: I }) => {
    If(i.greaterThanEqual(n), () => {
      Break();
    });
    const a = worldTexel(int(3), i.mul(2));
    const b = worldTexel(int(3), i.mul(2).add(1));
    d.assign(min(d, sdCapsule(p, a.xyz, b.xyz, a.w)));
  });
  return d;
});
export const arenaNormal = Fn(([p]: [V3]) => {
  const e = 0.01;
  return normalize(
    vec3(
      arenaSDF(p.add(vec3(e, 0, 0))).sub(arenaSDF(p.sub(vec3(e, 0, 0)))),
      arenaSDF(p.add(vec3(0, e, 0))).sub(arenaSDF(p.sub(vec3(0, e, 0)))),
      arenaSDF(p.add(vec3(0, 0, e))).sub(arenaSDF(p.sub(vec3(0, 0, e)))),
    ),
  );
});

// LIGHTS_GLSL
// Spell lights: point (type 0), line (1, segment pos -> end), cookie (2, point light with a
// projected pattern: cookie.x = 1 caustic, 2 rune ring; cookie.y scale, cookie.z rotation).
// Karis 2013 windowed inverse-square falloff; line lights use the representative point. The
// first lights flagged shadow (the CPU keeps at most Q.shadowLights of them) get analytic
// capsule shadows from the occluder list (UE4 capsule shadows), penumbra growing with distance.
// gLightNoShadow (set true in volume/media shaders: capsule shadows per step cost too much) is the
// build-time `noShadow` argument here.
export interface ISpellLight {
  pos: V3;
  range: F;
  color: V3;
  type: I;
  end: V3;
  shadow: F;
  cookie: V4;
}
export function spellLight(i: I): ISpellLight {
  const a = worldTexel(int(0), i.mul(4));
  const b = worldTexel(int(0), i.mul(4).add(1));
  const c = worldTexel(int(0), i.mul(4).add(2));
  const d = worldTexel(int(0), i.mul(4).add(3));
  return {
    pos: a.xyz,
    range: a.w,
    color: b.rgb,
    type: int(b.a),
    end: c.xyz,
    shadow: c.w,
    cookie: d,
  };
}
export const lightFalloff = Fn(([d, range]: [F, F]) => {
  const x = d.div(range).toVar();
  x.assign(x.mul(x));
  x.assign(x.mul(x));
  const w = clamp(float(1.0).sub(x), 0.0, 1.0);
  return w.mul(w).div(d.mul(d).add(1.0));
});
export const closestOnSegment = Fn(([a, b, p]: [V3, V3, V3]) => {
  const ab = b.sub(a);
  return a.add(ab.mul(clamp(dot(p.sub(a), ab).div(max(dot(ab, ab), 1e-6)), 0.0, 1.0)));
});
// closest point on segment a-b to the ray o + t*r (t >= 0)
export const closestOnSegmentToRay = Fn(([a, b, o, r]: [V3, V3, V3, V3]) => {
  const ab = b.sub(a);
  const ao = a.sub(o);
  const abr = dot(ab, r);
  const abab = dot(ab, ab);
  const t = dot(ao, r)
    .mul(abr)
    .sub(dot(ao, ab))
    .div(max(abab.sub(abr.mul(abr)), 1e-5));
  return a.add(ab.mul(clamp(t, 0.0, 1.0)));
});
// distance between segments p1-q1 and p2-q2; s = parameter on the first (Ericson 5.1.9). s: out var
export const segSegDist = Fn(([p1, q1, p2, q2, s]: [V3, V3, V3, V3, F]) => {
  const d1 = q1.sub(p1);
  const d2 = q2.sub(p2);
  const r = p1.sub(p2);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  const c = dot(d1, r);
  const b = dot(d1, d2);
  const denom = a.mul(e).sub(b.mul(b));
  s.assign(
    select(denom.greaterThan(1e-6), clamp(b.mul(f).sub(c.mul(e)).div(denom), 0.0, 1.0), float(0.0)),
  );
  const t = b.mul(s).add(f).div(max(e, 1e-6)).toVar();
  If(t.lessThan(0.0), () => {
    t.assign(0.0);
    s.assign(clamp(c.negate().div(max(a, 1e-6)), 0.0, 1.0));
  }).ElseIf(t.greaterThan(1.0), () => {
    t.assign(1.0);
    s.assign(clamp(b.sub(c).div(max(a, 1e-6)), 0.0, 1.0));
  });
  return length(p1.add(d1.mul(s)).sub(p2.add(d2.mul(t))));
});
export const capsuleShadow = Fn(([p0, lp]: [V3, V3]) => {
  const dir = lp.sub(p0);
  const len = length(dir);
  const p = p0.add(dir.mul(min(float(0.15).div(max(len, 1e-3)), 0.5))); // start off the surface (own capsule)
  const vis = float(1.0).toVar();
  const n = int(U.uWorldCounts.w);
  Loop({ start: 0, end: MAX_OCCLUDERS, type: "int", condition: "<" }, ({ i }: { i: I }) => {
    If(i.greaterThanEqual(n), () => {
      Break();
    });
    const a = worldTexel(int(3), i.mul(2));
    const b = worldTexel(int(3), i.mul(2).add(1));
    If(abs(b.w.sub(3.0)).lessThan(0.5), () => {
      Continue();
    }); // shields are glass: they collide but cast no shadow
    // bounding-sphere reject first: most capsules are nowhere near this shadow ray
    const m = a.xyz.add(b.xyz).mul(0.5);
    const q = closestOnSegment(p, lp, m).sub(m);
    const R = length(b.xyz.sub(a.xyz)).mul(0.5).add(a.w).add(0.04).add(len.mul(0.18));
    If(dot(q, q).lessThanEqual(R.mul(R)), () => {
      const s = float(0.0).toVar();
      const d = segSegDist(p, lp, a.xyz, b.xyz, s);
      const pen = s.mul(len).mul(0.18).add(0.04);
      vis.mulAssign(smoothstep(a.w.sub(pen.mul(0.5)), a.w.add(pen), d));
    });
  });
  return vis;
});
// a JS function, not Fn: it takes the SpellLight struct (a plain object of nodes)
export function lightCookie(L: ISpellLight, p: V3): F {
  const out = float(1.0).toVar();
  If(L.cookie.x.greaterThanEqual(0.5), () => {
    const q0 = p.xz.sub(L.pos.xz).mul(L.cookie.y);
    const c = cos(L.cookie.z);
    const s = sin(L.cookie.z);
    // mat2(c, -s, s, c) * q (column-major)
    const q = vec2(c.mul(q0.x).add(s.mul(q0.y)), s.negate().mul(q0.x).add(c.mul(q0.y)));
    If(L.cookie.x.lessThan(1.5), () => {
      // caustic: folded sines, cheap and shimmering
      const w = q
        .mul(3.0)
        .add(
          vec2(sin(q.y.mul(2.1).add(U.uTime.mul(1.3))), cos(q.x.mul(1.7).sub(U.uTime.mul(1.1)))),
        );
      const k = abs(sin(w.x).mul(sin(w.y)));
      out.assign(pow(float(1.0).sub(k), 6.0).mul(2.2).add(0.35));
    }).Else(() => {
      const r = length(q); // rune ring
      const ring = smoothstep(0.06, 0.0, abs(r.sub(1.0))).add(
        smoothstep(0.04, 0.0, abs(r.sub(0.78))),
      );
      const spokes = smoothstep(0.92, 1.0, abs(cos(atan(q.y, q.x).mul(6.0))))
        .mul(step(r, 1.0))
        .mul(step(0.78, r));
      out.assign(clamp(ring.add(spokes), 0.0, 1.0).mul(3.0).add(0.2));
    });
  });
  return out;
}
// light vector + radiance arriving at p from light i (no BRDF). For line lights the point used
// is the closest one to the reflection ray r for specular (pass r) or to p for diffuse (r = 0).
// l, lp: out vars
// a JS function, not Fn: it takes the SpellLight struct
export function spellLightRaw(L: ISpellLight, p: V3, r: V3, l: V3, lp: V3): V3 {
  lp.assign(L.pos);
  If(L.type.equal(1), () => {
    lp.assign(
      select(
        dot(r, r).greaterThan(0.0),
        closestOnSegmentToRay(L.pos, L.end, p, r),
        closestOnSegment(L.pos, L.end, p),
      ),
    );
  });
  const d = lp.sub(p);
  const dist = length(d);
  l.assign(d.div(max(dist, 1e-4)));
  const c = L.color.mul(lightFalloff(dist, L.range)).toVar();
  If(L.type.equal(2), () => {
    c.mulAssign(lightCookie(L, p));
  });
  return c;
}
// shadow only where the light actually arrives (outside its range the falloff is exactly 0)
export function spellLightShadow(L: ISpellLight, p: V3, lp: V3, c: V3, noShadow = false): F {
  if (noShadow) return float(1.0);
  const out = float(1.0).toVar();
  If(L.shadow.greaterThan(0.5).and(dot(c, c).greaterThan(0.0)), () => {
    out.assign(capsuleShadow(p, lp));
  });
  return out;
}
export function spellLightIncoming(L: ISpellLight, p: V3, r: V3, l: V3, noShadow = false): V3 {
  const lp = vec3(0).toVar();
  const c = spellLightRaw(L, p, r, l, lp);
  return c.mul(spellLightShadow(L, p, lp, c, noShadow));
}
// sum of spell-light irradiance / pi on a surface (n) or, with n = 0, omnidirectional (media)
export function spellLightDiffuse(p: V3, n: V3, noShadow = false): V3 {
  const sum = vec3(0.0).toVar();
  const l = vec3(0).toVar();
  const count = int(U.uWorldCounts.x);
  Loop({ start: 0, end: MAX_LIGHTS, type: "int", condition: "<" }, ({ i }: { i: I }) => {
    If(i.greaterThanEqual(count), () => {
      Break();
    });
    const c = spellLightIncoming(spellLight(i), p, vec3(0.0), l, noShadow);
    sum.addAssign(c.mul(select(dot(n, n).greaterThan(0.0), max(dot(n, l), 0.0), float(0.5))));
  });
  return sum;
}
// in-scatter for media / volumes: Henyey-Greenstein phase towards the viewer (v = to camera)
export function spellLightScatter(p: V3, v: V3, g: F, noShadow = false): V3 {
  const sum = vec3(0.0).toVar();
  const l = vec3(0).toVar();
  const count = int(U.uWorldCounts.x);
  Loop({ start: 0, end: MAX_LIGHTS, type: "int", condition: "<" }, ({ i }: { i: I }) => {
    If(i.greaterThanEqual(count), () => {
      Break();
    });
    const c = spellLightIncoming(spellLight(i), p, vec3(0.0), l, noShadow);
    sum.addAssign(c.mul(hgPhase(dot(l, v.negate()), g)).mul(4.0 * Math.PI));
  });
  return sum;
}
// biome-ignore lint/style/useNamingConvention: upstream Ultra Elements code, copied verbatim
export const spellD_GGX = Fn(([nh, a]: [F, F]) => {
  const a2 = a.mul(a);
  const d = nh.mul(nh).mul(a2.sub(1.0)).add(1.0);
  return a2.div(d.mul(d).mul(Math.PI));
});
// biome-ignore lint/style/useNamingConvention: upstream Ultra Elements code, copied verbatim
export const spellV_Smith = Fn(([nv, nl, a]: [F, F, F]) =>
  float(0.5).div(mix(nl.mul(nv).mul(2.0), nl.add(nv), a)),
);
// GGX + Lambert from every spell light; diffuse and specular returned apart (radiance). diffuse,
// specular: out vars
export function spellLightPBR(
  p: V3,
  n: V3,
  v: V3,
  roughness: F,
  f0: V3,
  diffColor: V3,
  diffuse: V3,
  specular: V3,
  noShadow = false,
): void {
  diffuse.assign(vec3(0.0));
  specular.assign(vec3(0.0));
  const a = max(roughness.mul(roughness), 0.002);
  const nv = max(dot(n, v), 1e-4);
  const r = reflect(v.negate(), n);
  const l = vec3(0).toVar();
  const count = int(U.uWorldCounts.x);
  Loop({ start: 0, end: MAX_LIGHTS, type: "int", condition: "<" }, ({ i }: { i: I }) => {
    If(i.greaterThanEqual(count), () => {
      Break();
    });
    const L = spellLight(i);
    const lp = vec3(0).toVar();
    const cd = spellLightRaw(L, p, vec3(0.0), l, lp).toVar();
    If(dot(cd, cd).equal(0.0), () => {
      Continue();
    });
    const sh = spellLightShadow(L, p, lp, cd, noShadow); // one shadow per light: the specular point reuses it
    cd.mulAssign(sh);
    diffuse.addAssign(
      cd
        .mul(diffColor)
        .mul(max(dot(n, l), 0.0))
        .div(Math.PI),
    );
    const cs = cd.toVar();
    If(L.type.equal(1), () => {
      cs.assign(spellLightRaw(L, p, r, l, lp).mul(sh));
    });
    const h = normalize(l.add(v));
    const nl = max(dot(n, l), 0.0);
    const nh = max(dot(n, h), 0.0);
    const vh = max(dot(v, h), 0.0);
    const Fr = f0.add(
      vec3(1.0)
        .sub(f0)
        .mul(pow(float(1.0).sub(vh), 5.0)),
    );
    const aL = select(
      L.type.equal(1),
      min(a.add(float(0.25).div(max(distance(lp, p).mul(2.0), 0.25))), 1.0),
      a,
    ); // line lights are ~0.25 m tubes, not hard streaks
    specular.addAssign(
      cs
        .mul(Fr)
        .mul(
          spellD_GGX(nh, aL)
            .mul(spellV_Smith(nv, nl, aL))
            .mul(nl),
        )
        .mul(a.div(aL)),
    );
  });
}

// FORCES_GLSL
// Forces act on every particle (scaled by its kind's force response) and warp fire volumes.
//   0 wind      t2.xyz dir, t1 = (speed m/s, gustiness, coupling, -)
//   1 vortex    pos = base, t2.xyz axis, t1 = (core R, circulation G, updraft W, inflow), t2.w height
//   2 attractor t1 = (strength, softening, kill radius, range)   (negative strength repels)
//   3 orbit     Kepler disk: t2.xyz axis, t1 = (GM, inner, outer, coupling)
//   4 shock     expanding shell: t1 = (radius, thickness, impulse, -)
//   5 push      cone gust: t2.xyz dir, t1 = (speed, radius, length, coupling)
// kill: inout var
export const forceAccel = Fn(([p, v, kill]: [V3, V3, F]) => {
  const acc = vec3(0.0).toVar();
  const n = int(U.uWorldCounts.y);
  Loop({ start: 0, end: MAX_FORCES, type: "int", condition: "<" }, ({ i }: { i: I }) => {
    If(i.greaterThanEqual(n), () => {
      Break();
    });
    const a = worldTexel(int(1), i.mul(4));
    const k = worldTexel(int(1), i.mul(4).add(1));
    const b = worldTexel(int(1), i.mul(4).add(2));
    const type = int(a.w);
    const d = p.sub(a.xyz);
    If(type.equal(0), () => {
      const gust = k.y
        .mul(sin(U.uTime.mul(1.7).add(dot(p, vec3(0.13, 0.05, 0.11)))))
        .mul(sin(U.uTime.mul(0.53).add(p.x.mul(0.07))))
        .add(1.0);
      acc.addAssign(b.xyz.mul(k.x).mul(gust).sub(v).mul(k.z));
    })
      .ElseIf(type.equal(1), () => {
        const ax = b.xyz;
        const h = dot(d, ax);
        const radial = d.sub(ax.mul(h));
        const r = length(radial);
        If(
          h
            .greaterThan(-0.5)
            .and(h.lessThan(b.w))
            .and(r.lessThan(k.x.mul(6.0))),
          () => {
            const er = radial.div(max(r, 1e-3));
            const et = cross(ax, er);
            const vt = select(
              r.lessThan(k.x),
              k.y
                .div(2.0 * Math.PI)
                .mul(r)
                .div(k.x.mul(k.x)),
              k.y.div(r.mul(2.0 * Math.PI)),
            );
            const up = k.z.mul(exp(r.mul(r).negate().div(k.x.mul(k.x).mul(2.0))));
            const target = et
              .mul(vt)
              .add(ax.mul(up))
              .sub(
                er
                  .mul(k.w)
                  .mul(smoothstep(k.x.mul(6.0), k.x, r))
                  .mul(float(1.0).sub(smoothstep(0.0, 2.0, h).mul(0.6))),
              );
            acc.addAssign(
              target
                .sub(v)
                .mul(3.0)
                .mul(smoothstep(k.x.mul(6.0), k.x.mul(3.0), r)),
            );
          },
        );
      })
      .ElseIf(type.equal(2), () => {
        const r2 = dot(d, d);
        If(r2.lessThan(k.w.mul(k.w)), () => {
          acc.subAssign(
            normalize(d)
              .mul(k.x)
              .div(r2.add(k.y.mul(k.y))),
          );
          If(r2.lessThan(k.z.mul(k.z)), () => {
            kill.assign(1.0);
          });
        });
      })
      .ElseIf(type.equal(3), () => {
        const ax = b.xyz;
        const h = dot(d, ax);
        const radial = d.sub(ax.mul(h));
        const r = length(radial);
        If(r.greaterThan(k.y.mul(0.5)).and(r.lessThan(k.z)), () => {
          const et = cross(ax, radial.div(r));
          const target = et.mul(sqrt(k.x.div(r))).sub(ax.mul(h).mul(4.0));
          acc.addAssign(target.sub(v).mul(k.w));
        });
        If(r.lessThan(k.y), () => {
          kill.assign(max(kill, step(abs(h), 0.5)));
        });
      })
      .ElseIf(type.equal(4), () => {
        const r = length(d);
        const shell = float(1.0).sub(clamp(abs(r.sub(k.x)).div(max(k.y, 1e-3)), 0.0, 1.0));
        acc.addAssign(d.div(max(r, 1e-3)).mul(k.z).mul(shell));
      })
      .ElseIf(type.equal(5), () => {
        const along = dot(d, b.xyz);
        const off = length(d.sub(b.xyz.mul(along)));
        If(along.greaterThan(-0.5).and(along.lessThan(k.z)).and(off.lessThan(k.y)), () => {
          acc.addAssign(
            b.xyz
              .mul(k.x)
              .sub(v)
              .mul(k.w)
              .mul(float(1.0).sub(off.div(k.y))),
          );
        });
      });
  });
  return acc;
});

// IMPACTS_GLSL
// Spherical "volume decals" for surfaces: weights per impact type at p (amount x falloff x fade).
// A: x scorch/heat, y frost, z wet, w magma glow.  B: x acid, y holy glow, z corruption, w electric.
// Each impact also carries a colour (t2.rgb) for the glow types. wa, wb, glowColor: out vars
export const impactWeights = Fn(([p, wa, wb, glowColor]: [V3, V4, V4, V3]) => {
  wa.assign(vec4(0.0));
  wb.assign(vec4(0.0));
  glowColor.assign(vec3(0.0));
  const n = int(U.uWorldCounts.z);
  Loop({ start: 0, end: MAX_IMPACTS, type: "int", condition: "<" }, ({ i }: { i: I }) => {
    If(i.greaterThanEqual(n), () => {
      Break();
    });
    const a = worldTexel(int(2), i.mul(4));
    const b = worldTexel(int(2), i.mul(4).add(1));
    const c = worldTexel(int(2), i.mul(4).add(2));
    const w = b.z.mul(smoothstep(1.0, 0.55, length(p.sub(a.xyz)).div(a.w)));
    If(w.greaterThan(0.0), () => {
      const t = int(b.x);
      // wa[t] += w (t < 4) else wb[t - 4] += w, as a one-hot lane mask
      const lane = (k: number) => select(t.equal(k), float(1.0), float(0.0));
      wa.addAssign(vec4(lane(0), lane(1), lane(2), lane(3)).mul(w));
      wb.addAssign(vec4(lane(4), lane(5), lane(6), lane(7)).mul(w));
      glowColor.addAssign(c.rgb.mul(w));
    });
  });
});

// GROUND_GLSL. uGroundRect: min x, min z, size, 1 / size
export const groundUV = Fn(([xz]: [V2]) => xz.sub(U.uGroundRect.xy).mul(U.uGroundRect.w));
export const groundA = Fn(([xz]: [V2]) => sample2(U.uGroundA.value, groundUV(xz), false)); // heat, char, wet, frost
export const groundB = Fn(([xz]: [V2]) => sample2(U.uGroundB.value, groundUV(xz), false)); // crack, acid, corruption, glow

// --- FX pass (half-res MRT, weighted-blended OIT; McGuire & Bavoil 2013) -------------
// Upstream: every FX-pass material is a RawShaderMaterial (GLSL3) using FX_VERT_HEAD / FX_FRAG_HEAD and
// ...FX_BLENDING, and ends with fxOut(). One blend state for the three attachments:
//   0 media    (w*c*a, a)  -> rgb sum, alpha = revealage product
//   1 weight   (w*a, distortion.xy, a)
//   2 emission (rgb, 0)    -> additive, never occluded by media unless the composite says so
// Engine: no CustomBlending (Normal and Additive only), no multi-target render target, and an
// offscreen pass draws before the frame's depth exists. So FX materials draw in the frame's own
// transparent queue (sorted back to front, which is exact where WBOIT approximates), read the frame's
// depth through viewportDepthTexture(), and fxOut() returns the composite of one layer,
//   scene * rev + accum * (1 - rev) + em * mix(1, rev, smokeOccludesGlow),   rev = 1 - a,
// as NormalBlending's src * a + dst * (1 - a): rgb = col + em * mix(1, 1 - a, k) / a. Exact while
// emission comes with extinction (volumes, media); pure glow (a = 0) uses FX_ADDITIVE and fxOutGlow().
// The distortion output (heat haze, shocks) needs viewportSharedTexture() in that material: open.
export const FX_BLENDING = {
  transparent: true,
  depthWrite: false,
  depthTest: true,
  blending: NormalBlending,
};
// glow-only FX (no coverage): rgb added whatever the alpha
export const FX_ADDITIVE = {
  transparent: true,
  depthWrite: false,
  depthTest: true,
  blending: AdditiveBlending,
};

// FX_OUT_GLSL. viewZ positive distance along the view axis.
// full-res scene depth under this fragment (upstream: the farthest of the half-res pixel's 2x2
// full-res block; the engine draws FX at full res, so the block is the pixel)
export const sceneViewZ = Fn(() => linearDepth(viewportDepthTexture(screenUV).x));
export const softFade = Fn(([viewZ, dist]: [F, F]) =>
  clamp(sceneViewZ().sub(viewZ).div(dist), 0.0, 1.0),
);
export const wboitWeight = Fn(([viewZ, a]: [F, F]) =>
  a.mul(
    clamp(
      float(10.0).div(
        pow(viewZ.div(10.0), 2.0)
          .add(pow(viewZ.div(200.0), 6.0))
          .add(1e-5),
      ),
      0.01,
      30.0,
    ),
  ),
);
// col: lit media colour, a: coverage, emit: additive HDR emission, dist: screen-space UV offset
// (not composited yet, see above). Returns the fragment colour for FX_BLENDING.
export const fxOut = Fn(([col, a0, emit, _dist, _viewZ]: [V3, F, V3, V2, F]) => {
  const a = clamp(a0, 0.0, 0.999); // 0.995 let a bright HDR sky print through opaque soot
  const out = vec4(
    col.add(emit.mul(mix(1.0, float(1.0).sub(a), U.uFxParams.x)).div(max(a, 2e-3))),
    a,
  ).toVar();
  If(U.uDebug.greaterThan(0.5).and(U.uDebug.lessThan(1.5)), () => {
    out.assign(vec4(0.04, 0.012, 0.004, 1.0));
  });
  return out;
});
// for FX_ADDITIVE materials: emission only
export const fxOutGlow = Fn(([emit]: [V3]) => vec4(emit, 1.0));

// full-res additive emissive (sparks, motes, bolt cores, sigils) into the HDR target. Pure
// ONE/ONE on rgb whatever alpha the shader writes (three's AdditiveBlending scales by src alpha),
// destination alpha kept (the planar reflection uses alpha as its 'something drawn' mask).
// Engine: AdditiveBlending (SrcAlpha, One): write alpha 1.
export const LINES_BLENDING = {
  transparent: true,
  depthWrite: false,
  depthTest: true,
  blending: AdditiveBlending,
};

// --- JS side: pools packed into the world texture -------------------------------------
export interface IPoolItem {
  index: number;
  active: boolean;
}
function makePool<T extends object>(n: number, init: () => T) {
  const items = Array.from({ length: n }, (_, i): T & IPoolItem => ({
    index: i,
    active: false,
    ...init(),
  }));
  return {
    items,
    acquire(): (T & IPoolItem) | null {
      const it = items.find((x) => !x.active);
      if (!it) return null;
      Object.assign(it, init(), { active: true });
      return it;
    },
  };
}

// light: pos, range, color (linear), intensity, type 0 point / 1 line / 2 cookie, end (line),
// shadow (wants capsule shadows), cookie [pattern, scale, rotation, 0]
export const lights = makePool(MAX_LIGHTS, () => ({
  pos: new Vector3(),
  range: 8,
  color: new Color(1, 1, 1),
  intensity: 0,
  type: 0,
  end: new Vector3(),
  shadow: false,
  cookie: [0, 1, 0, 0],
  release(this: { active: boolean }) {
    this.active = false;
  },
}));
export type SpellLightHandle = (typeof lights.items)[number];

export const forces = makePool(MAX_FORCES, () => ({
  pos: new Vector3(),
  type: 0,
  p: [0, 0, 0, 0],
  dir: new Vector3(0, 1, 0),
  w: 0,
  release(this: { active: boolean }) {
    this.active = false;
  },
}));

// impacts fade on their own: amount * (1 - age / life), oldest replaced when full
const IMPACT_TYPES: Record<string, number> = {
  scorch: 0,
  frost: 1,
  wet: 2,
  magma: 3,
  acid: 4,
  holy: 5,
  corruption: 6,
  electric: 7,
};
const impactList = Array.from({ length: MAX_IMPACTS }, () => ({
  pos: new Vector3(),
  radius: 1,
  type: 0,
  age: 1e9,
  life: 1,
  amount: 0,
  color: new Color(),
}));
const DEFAULT_IMPACT = new Color(1, 0.4, 0.1);
export const impacts = {
  types: IMPACT_TYPES,
  add(
    type: string | number,
    pos: Vector3,
    radius: number,
    amount = 1,
    life = 6,
    color: Color | null = null,
  ) {
    let it = impactList[0] as (typeof impactList)[number];
    for (const x of impactList) if (x.age / x.life > it.age / it.life) it = x;
    it.pos.copy(pos);
    it.radius = radius;
    it.type = typeof type === "string" ? (IMPACT_TYPES[type] as number) : type;
    it.amount = amount;
    it.life = life;
    it.age = 0;
    it.color.copy(color ?? DEFAULT_IMPACT);
    return it;
  },
  clear() {
    for (const x of impactList) x.age = 1e9;
  },
};

// capsules (a, b, radius); static ones are added once by the arena, dynamic ones (spikes,
// shields) are acquired and released. kind: 0 stone, 1 dummy, 2 spike, 3 shield, 4 pedestal
export interface IOccluder {
  a: Vector3;
  b: Vector3;
  radius: number;
  kind: number;
  release(): void;
}
const occluderList: IOccluder[] = [];
export const occluders = {
  list: occluderList,
  add(a: Vector3, b: Vector3, radius: number, kind = 0): IOccluder | null {
    if (occluderList.length >= MAX_OCCLUDERS) return null;
    const o: IOccluder = {
      a: a.clone(),
      b: b.clone(),
      radius,
      kind,
      release() {
        const i = occluderList.indexOf(o);
        if (i >= 0) occluderList.splice(i, 1);
      },
    };
    occluderList.push(o);
    return o;
  },
};

// The CPU keeps at most `maxLights` lights and `maxShadowed` shadowed ones (the brightest).
const lightOrder: SpellLightHandle[] = [];
export function packWorld(dt: number, { maxLights = MAX_LIGHTS, maxShadowed = 4 } = {}): void {
  const d = worldData;
  d.fill(0);
  // lights, brightest first so a tier cut drops the dim ones
  lightOrder.length = 0;
  for (const l of lights.items) if (l.active && l.intensity > 1e-3) lightOrder.push(l);
  lightOrder.sort((a, b) => b.intensity * b.range - a.intensity * a.range);
  const nl = Math.min(lightOrder.length, maxLights);
  let shadowed = 0;
  for (let i = 0; i < nl; i++) {
    const l = lightOrder[i] as SpellLightHandle;
    const o = (0 * WORLD_W + i * 4) * 4;
    // biome-ignore lint/style/noCommaOperator: upstream Ultra Elements code, copied verbatim
    const sh = l.shadow && shadowed < maxShadowed ? (shadowed++, 1) : 0;
    d.set(
      [
        l.pos.x,
        l.pos.y,
        l.pos.z,
        l.range,
        l.color.r * l.intensity,
        l.color.g * l.intensity,
        l.color.b * l.intensity,
        l.type,
        l.end.x,
        l.end.y,
        l.end.z,
        sh,
        l.cookie[0] as number,
        l.cookie[1] as number,
        l.cookie[2] as number,
        l.cookie[3] as number,
      ],
      o,
    );
  }
  let nf = 0;
  for (const fo of forces.items) {
    if (!fo.active) continue;
    const o = (1 * WORLD_W + nf * 4) * 4;
    d.set(
      [
        fo.pos.x,
        fo.pos.y,
        fo.pos.z,
        fo.type,
        fo.p[0] as number,
        fo.p[1] as number,
        fo.p[2] as number,
        fo.p[3] as number,
        fo.dir.x,
        fo.dir.y,
        fo.dir.z,
        fo.w,
      ],
      o,
    );
    nf++;
  }
  let ni = 0;
  for (const it of impactList) {
    it.age += dt;
    if (it.age >= it.life) continue;
    const o = (2 * WORLD_W + ni * 4) * 4;
    const fade = 1 - it.age / it.life;
    d.set(
      [
        it.pos.x,
        it.pos.y,
        it.pos.z,
        it.radius,
        it.type,
        it.age,
        it.amount * fade * fade,
        0,
        it.color.r,
        it.color.g,
        it.color.b,
        0,
      ],
      o,
    );
    ni++;
  }
  const no = occluderList.length;
  for (let i = 0; i < no; i++) {
    const c = occluderList[i] as IOccluder;
    const o = (3 * WORLD_W + i * 2) * 4;
    d.set([c.a.x, c.a.y, c.a.z, c.radius, c.b.x, c.b.y, c.b.z, c.kind], o);
  }
  U.uWorldCounts.value.set(nl, nf, ni, no);
  worldTex.needsUpdate = true;
}

// Engine: upstream's arena shaded its own surfaces from the world texture (spellLightPBR). Our
// scene is lit by three's lights, so the same lights also drive a fixed set of PointLights, parked
// at intensity 0 (spell-lights.ts: a light count that never moves never recompiles). The radiance
// scale is the same: upstream's c = color * intensity * window / (d^2 + 1), three's color * intensity / d^2.
export function mirrorLights(
  points: readonly { position: Vector3; color: Color; intensity: number; distance: number }[],
): void {
  let n = 0;
  for (const l of lights.items) {
    if (!l.active || l.intensity <= 1e-3 || n >= points.length) continue;
    const p = points[n++] as (typeof points)[number];
    p.position.copy(l.type === 1 ? l.end.clone().add(l.pos).multiplyScalar(0.5) : l.pos);
    p.color.copy(l.color);
    p.intensity = l.intensity;
    p.distance = l.range;
  }
  for (; n < points.length; n++) (points[n] as (typeof points)[number]).intensity = 0;
}

// --- JS mirror of arenaSDF (click targeting, projectile impacts, spawn placement) -----
const _pa = new Vector3();
const _ba = new Vector3();
function sdCapsuleJS(p: Vector3, a: Vector3, b: Vector3, r: number): number {
  _pa.subVectors(p, a);
  _ba.subVectors(b, a);
  const h = Math.min(1, Math.max(0, _pa.dot(_ba) / Math.max(_ba.dot(_ba), 1e-6)));
  return _pa.addScaledVector(_ba, -h).length() - r;
}
export function arenaStaticJS(p: Vector3): number {
  const P = ARENA.pool;
  const inPool = Math.abs(p.x - P.center.x) < P.half.x && Math.abs(p.z - P.center.y) < P.half.y;
  const d = p.y - (inPool ? P.water : 0);
  const qx =
    Math.abs(Math.hypot(p.x, p.z) - (ARENA.radius + ARENA.wallThickness / 2)) -
    ARENA.wallThickness / 2;
  const qy = Math.abs(p.y - ARENA.wallHeight / 2) - ARENA.wallHeight / 2;
  return Math.min(d, Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0));
}
// upstream names this arenaSDF; the TSL function above has the GLSL's name, so the JS mirror is arenaSDFJS.
// Engine scenes differ from upstream's arena: a game replaces the static part with setArenaStatic().
let staticSDF: (p: Vector3) => number = arenaStaticJS;
export function setArenaStatic(fn: (p: Vector3) => number): void {
  staticSDF = fn;
}
export function arenaSDFJS(p: Vector3): number {
  let d = staticSDF(p);
  for (const c of occluderList) d = Math.min(d, sdCapsuleJS(p, c.a, c.b, c.radius));
  return d;
}
const _rp = new Vector3();
// sphere trace; returns distance along dir or -1
export function arenaRaycast(origin: Vector3, dir: Vector3, maxDist = 200): number {
  let t = 0;
  for (let i = 0; i < 256 && t < maxDist; i++) {
    const d = arenaSDFJS(_rp.copy(origin).addScaledVector(dir, t));
    if (d < 0.002) return t;
    t += Math.max(d, 0.01);
  }
  return -1;
}

// a mat3 uniform the engine can bind: three row vectors (GLSL `m * v` = rows dotted with v)
const vec3Uniform = (v: Vector3) => uniform(v);
export type Vec3Uniform = ReturnType<typeof vec3Uniform>;
export interface IMat3Rows {
  x: Vec3Uniform;
  y: Vec3Uniform;
  z: Vec3Uniform;
}
export function mat3Rows(): IMat3Rows {
  return {
    x: vec3Uniform(new Vector3(1, 0, 0)),
    y: vec3Uniform(new Vector3(0, 1, 0)),
    z: vec3Uniform(new Vector3(0, 0, 1)),
  };
}
export function setMat3Rows(rows: IMat3Rows, m: Matrix3): void {
  const e = m.elements;
  rows.x.value.set(e[0] as number, e[3] as number, e[6] as number);
  rows.y.value.set(e[1] as number, e[4] as number, e[7] as number);
  rows.z.value.set(e[2] as number, e[5] as number, e[8] as number);
}
export const mulMat3Rows = (rows: IMat3Rows, v: V3): V3 =>
  vec3(dot(rows.x, v), dot(rows.y, v), dot(rows.z, v));

// --- added for the GroundField, Ribbons and Shockwaves port -------------------------------------
// GroundField ping-pongs U.uGroundA/B between two targets each step. A material's graph holds the
// shared texture node of the texture it was built with, so the node follows the holder to its new
// texture (one node per texture, see textureNode above). So each holder starts on its own placeholder.
export function setGroundTexture(holder: { value: unknown }, tex: object): void {
  const node = shared.get(holder.value as object);
  if (node !== undefined && holder.value !== tex) {
    shared.delete(holder.value as object);
    (node as unknown as { value: object }).value = tex;
    shared.set(tex, node);
  }
  holder.value = tex;
}

// FxTarget's composite distortion and distortion-driven chromatic aberration, for one FX layer:
//   scene = (uScene(suv + ca).r, uScene(suv).g, uScene(suv - ca).b), suv = vUv + dist * distortion
// Engine (see FX_BLENDING): there is no WBOIT target to resolve, so a distorting layer reads the
// frame drawn so far (viewportSharedTexture) and adds the displaced scene minus the scene under it,
// plus its emission, with FX_ADDITIVE into the float HDR target: layers drawn under it stay.
// dist is upstream's screen-UV offset (GL, y up); screenUV runs y down.
const SCENE_COLOR = {};
export const fxOutDistort = Fn(([emit, dist0]: [V3, V2]) => {
  const scene = textureNode(SCENE_COLOR, () => viewportSharedTexture()) as unknown as {
    sample(uv: V2): V4;
  };
  const dist = vec2(dist0.x, dist0.y.negate()).mul(U.uFxParams.y);
  const suv = screenUV.add(dist);
  const ca = dist.mul(U.uFxParams.z.mul(0.6));
  const col = vec3(scene.sample(suv.add(ca)).r, scene.sample(suv).g, scene.sample(suv.sub(ca)).b);
  return vec4(col.sub(scene.sample(screenUV).rgb).add(emit), 1.0);
});
