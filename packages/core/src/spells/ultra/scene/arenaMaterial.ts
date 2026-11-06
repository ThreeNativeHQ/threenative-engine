// Ported from Ultra Elements src/scene/arenaMaterial.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
//
// Only the ground-field half of the arena floor: the baked stone noise, the STATE block (impacts and
// the ground field) and the RESPONSES a fire spell leaves (char, wet, heat glow, holy glow). The
// arena's own surfaces, lighting, frost, acid, electric, corruption and crack responses are not
// ported: a game's floor material keeps its own surface and the engine's lighting, and takes the
// albedo, roughness, metalness and emission groundShade() returns.
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RGBAFormat,
  RepeatWrapping,
} from "three";
import {
  Break,
  Fn,
  If,
  Loop,
  clamp,
  dot,
  float,
  fwidth,
  int,
  length,
  max,
  mix,
  pow,
  select,
  smoothstep,
  step,
  texture,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import {
  MAX_IMPACTS,
  U,
  blackbody,
  groundA,
  groundB,
  groundUV,
  worldTexel,
} from "../vfx/common.js";

type F = Node<"float">;
type V2 = Node<"vec2">;
type V3 = Node<"vec3">;
type V4 = Node<"vec4">;

// --- baked noise: 256^2 RGBA8, tileable, mipmapped ---------------------------------------
// r, g: value-noise fbm (two seeds), b: voronoi F2-F1 (0 on cell edges, 12 cells per tile;
// cracks, veins), a: fine fbm (grain, specks). Generated once in JS (~30 ms), no assets.
function hashi(x: number, y: number, s: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upstream Ultra Elements code, copied verbatim
function bakeStoneNoise(N = 256): DataTexture {
  const data = new Uint8Array(N * N * 4);
  const vnoise = (x: number, y: number, P: number, s: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % P) + P) % P;
    const y0 = ((yi % P) + P) % P;
    const x1 = (x0 + 1) % P;
    const y1 = (y0 + 1) % P;
    const a = hashi(x0, y0, s);
    const b = hashi(x1, y0, s);
    const c = hashi(x0, y1, s);
    const d = hashi(x1, y1, s);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  const fbm = (u: number, v: number, base: number, oct: number, s: number) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let o = 0; o < oct; o++) {
      const f = base << o;
      sum += amp * vnoise(u * f, v * f, f, s + o * 31);
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
  const C = 12;
  const pts: number[] = [];
  for (let j = 0; j < C; j++)
    for (let i = 0; i < C; i++)
      pts.push(i + 0.1 + 0.8 * hashi(i, j, 91), j + 0.1 + 0.8 * hashi(i, j, 92));
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      const o = (y * N + x) * 4;
      const cx = u * C;
      const cy = v * C;
      const ix = Math.floor(cx);
      const iy = Math.floor(cy);
      let f1 = 9;
      let f2 = 9;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const gi = ix + di;
          const gj = iy + dj;
          const wi = ((gi % C) + C) % C;
          const wj = ((gj % C) + C) % C;
          const px = (pts[(wj * C + wi) * 2] as number) + (gi - wi);
          const py = (pts[(wj * C + wi) * 2 + 1] as number) + (gj - wj);
          const d = Math.hypot(px - cx, py - cy);
          if (d < f1) {
            f2 = f1;
            f1 = d;
          } else if (d < f2) f2 = d;
        }
      data[o] = fbm(u, v, 4, 5, 1) * 255;
      data[o + 1] = fbm(u, v, 4, 5, 7) * 255;
      data[o + 2] = Math.min(f2 - f1, 1) * 255;
      data[o + 3] = fbm(u, v, 32, 2, 13) * 255;
    }
  const t = new DataTexture(data, N, N, RGBAFormat);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 2; // low-frequency taps: 8x bought ~0.02 ms of nothing at 3.3 MP
  t.needsUpdate = true;
  return t;
}

// Shared by every arena material: the stone noise (the rest of upstream's arenaUniforms belongs to
// the arena's own surfaces and lighting, not ported)
let stoneNoise: ReturnType<typeof texture> | undefined;
const uStoneNoise = (uv: V2): V4 => {
  stoneNoise ??= texture(bakeStoneNoise());
  return stoneNoise.sample(uv) as unknown as V4;
};

// IMPACT_FN_GLSL: spherical impact "volume decals", weights per type at p. wa, wb, glowColor: var
// nodes it assigns. ENGINE-GAP: a TSL Fn cannot assign its `out` arguments (common.ts impactWeights
// is that Fn), so this is plain JS inlined at the call. The bit-mask prefilter (NEXT_BIT) is one loop.
function arenaImpacts(p: V3, wa: V4, wb: V4, glowColor: V3): void {
  wa.assign(vec4(0.0));
  wb.assign(vec4(0.0));
  glowColor.assign(vec3(0.0));
  const n = int(U.uWorldCounts.z);
  Loop({ start: 0, end: MAX_IMPACTS, type: "int", condition: "<" }, ({ i }: { i: Node<"int"> }) => {
    If(i.greaterThanEqual(n), () => {
      Break();
    });
    const a = worldTexel(int(2), i.mul(4)) as unknown as V4;
    const d = p.sub(a.xyz);
    If(dot(d, d).lessThan(a.w.mul(a.w)), () => {
      const b = worldTexel(int(2), i.mul(4).add(1)) as unknown as V4;
      const w = b.z.mul(smoothstep(1.0, 0.55, length(d).div(a.w)));
      const t = b.x;
      const lane = (k: number) => select(t.equal(k), float(1.0), float(0.0));
      wa.addAssign(vec4(lane(0), lane(1), lane(2), lane(3)).mul(w));
      wb.addAssign(vec4(lane(4), lane(5), lane(6), lane(7)).mul(w));
      glowColor.addAssign((worldTexel(int(2), i.mul(4).add(2)) as unknown as V4).rgb.mul(w));
    });
  });
}

export interface IGroundSurface {
  albedo: V3;
  rough: F;
  metal: F;
  /** 0..1: grout, grooves, cracks the heat glows through */
  crevice?: F;
}

// STATE (ARENA_FLOOR) then the char, wet, heat and holy-glow RESPONSES, at world position wp.
// Upstream gates RESPONSES behind "anything there?" so most pixels skip it; so does this.
function shade(wp: V3, s: IGroundSurface) {
  const albedo = vec3(s.albedo).toVar();
  const rough = float(s.rough).toVar();
  const metal = float(s.metal).toVar();
  const crevice = (s.crevice ?? float(0.0)).toVar();
  const emit = vec3(0.0).toVar();
  const sp2 = wp.xz;
  const fwp = fwidth(wp);
  const px = max(max(fwp.x, fwp.y), fwp.z);
  const gHeatOpen = -1.0; // where heat glows through (>= 0 overrides crevice: the floor's grout barely glows)
  const gVent = 0.0; // craterNear(): no crater or fissure source drawn by this floor

  // STATE: impacts, mapped onto the field's channels so one set of responses serves both
  const wa = vec4(0.0).toVar();
  const wb = vec4(0.0).toVar();
  const gc = vec3(0.0).toVar();
  arenaImpacts(wp, wa, wb, gc);
  const wsum = dot(wa, vec4(1.0)).add(dot(wb, vec4(1.0)));
  const stGlow = gc.div(max(wsum, 1e-4)).toVar();
  // scorch: char + a little heat while fresh; magma: heat in fresh cracks
  const stA = vec4(wa.x.mul(wa.x).mul(0.3).add(wa.w), wa.x, wa.z, wa.y).toVar();
  const stB = vec4(wa.w.mul(0.6), wb.x, wb.z, wb.y).toVar();
  const stElec = wb.w;
  const guv = groundUV(sp2);
  const gw = guv.x
    .greaterThan(0.0)
    .and(guv.y.greaterThan(0.0))
    .and(guv.x.lessThan(1.0))
    .and(guv.y.lessThan(1.0));
  If(gw, () => {
    stA.assign(max(stA, groundA(sp2)));
    stB.assign(max(stB, groundB(sp2)));
  });

  // RESPONSES (responses to the state (a = heat, char, wet, frost; b = crack, acid, corruption,
  // glow); at most two noise taps on top of the surface's)
  If(
    stA.x
      .greaterThan(0.004)
      .or(stA.y.greaterThan(0.004))
      .or(stA.z.greaterThan(0.004))
      .or(stB.y.greaterThan(0.004))
      .or(stB.w.greaterThan(0.004))
      .or(stElec.greaterThan(0.004)),
    () => {
      const nS = uStoneNoise(sp2.mul(0.11).add(0.31));
      // char: soot, uneven
      const ch = clamp(stA.y.mul(nS.r.mul(0.5).add(0.75)), 0.0, 1.0);
      albedo.mulAssign(float(1.0).sub(ch.mul(0.85)));
      rough.assign(mix(rough, 0.9, ch));
      metal.mulAssign(float(1.0).sub(ch));
      // wet: darker, glossy film; on the floor it pools where the noise is low
      const wt = clamp(stA.z, 0.0, 1.0);
      const puddle = smoothstep(0.35, 0.7, wt.mul(nS.g.mul(0.8).add(0.6))); // flat_: the floor
      albedo.mulAssign(float(1.0).sub(wt.mul(0.4)));
      rough.assign(mix(rough, 0.04, max(wt.mul(0.75), puddle)));
      crevice.mulAssign(float(1.0).sub(puddle));
      // heat: hot stone glows only where it is open (thermal cracks that open with heat, the field's
      // own cracks, pores) through a dark char crust; grout barely. Temperature follows the field
      // heat, radiance ~T^4 above the Draper point, so the glow dies off well inside the hot area
      // instead of ending in a disc; the crust itself only goes dull red right at the centre.
      const ht = clamp(stA.x, 0.0, 1.0);
      If(ht.greaterThan(0.01), () => {
        const nH = uStoneNoise(sp2.mul(0.55).add(vec2(0.71, 0.23))); // 1.8 m tile: ~15 cm crack cells, 6 cm pores
        const crust = smoothstep(0.04, 0.45, ht);
        albedo.mulAssign(float(1.0).sub(crust.mul(0.8)));
        rough.assign(mix(rough, 0.88, crust));
        metal.mulAssign(float(1.0).sub(crust));
        // local temperature: the field heat broken into hot and cooler patches (a plateau of saturated
        // field heat must not read as one uniform disc)
        const hl = clamp(
          ht.mul(nH.r.mul(0.55).add(0.6)).mul(nS.g.mul(0.3).add(0.85)),
          0.0,
          1.0,
        ).toVar();
        // fractures across the slabs (~75 cm cells, the tap the responses already made), segment by
        // segment as the heat rises; a fine crackle (~15 cm) only in the hottest patches
        // (thin and coverage-preserving: a crack narrower than a pixel dims instead of aliasing; width and
        // glow vary along each crack, which also breaks the network into segments)
        const bw = hl.mul(0.014).add(0.005).mul(nH.r.mul(1.2).add(0.4));
        const fb = fwidth(nS.b);
        const big = float(1.0)
          .sub(smoothstep(bw.mul(0.3), bw.add(fb), nS.b))
          .mul(bw.div(bw.add(fb.mul(0.75))))
          .mul(smoothstep(0.25, 0.55, hl))
          .mul(smoothstep(0.42, 0.62, nH.g.add(hl.mul(0.12))));
        const fw = hl.mul(0.012).add(0.006);
        const ff = fwidth(nH.b);
        const fine = float(1.0)
          .sub(smoothstep(fw.mul(0.3), fw.add(ff), nH.b))
          .mul(fw.div(fw.add(ff.mul(0.75))))
          .mul(smoothstep(0.72, 0.95, hl))
          .mul(smoothstep(0.45, 0.6, nH.g));
        const tc = max(big, fine.mul(0.7))
          .mul(1.0 - gVent)
          .toVar(); // round a crater the glow comes out of its fractures (gHeatOpen) alone
        const op = max(tc, gHeatOpen >= 0.0 ? float(gHeatOpen) : crevice);
        albedo.mulAssign(float(1.0).sub(tc.mul(0.7)));
        const pore = smoothstep(0.8, 0.86, nH.a).mul(smoothstep(0.55, 0.9, hl)); // a few open vesicles, hottest patches only
        const Tc = hl.mul(1250.0).add(620.0);
        const Ts = Tc.sub(200.0);
        const Rc = pow(Tc.div(1500.0), 4.0).mul(smoothstep(760.0, 1050.0, Tc));
        const Rs = pow(Ts.div(1500.0), 4.0).mul(smoothstep(760.0, 1100.0, Ts));
        emit.addAssign(
          blackbody(Tc)
            .mul(Rc.mul(3.2).mul(op))
            .add(
              blackbody(Ts).mul(
                Rs.mul(
                  pore
                    .mul(0.35)
                    .add(smoothstep(0.75, 1.0, hl).mul(0.08))
                    .add(tc.mul(tc).mul(0.12)),
                ),
              ),
            ),
        );
      });
      // holy glow: gold-white light pouring out of the joints, a soft sheen on the surface
      const gl = clamp(stB.w, 0.0, 1.0);
      const gcol = mix(vec3(1.0, 0.8, 0.48), stGlow, step(1e-3, dot(stGlow, stGlow)).mul(0.5));
      emit.addAssign(gcol.mul(gl).mul(crevice.mul(3.0).add(0.35)).mul(2.5));
    },
  );
  return { albedo, rough, metal, emit };
}

/**
 * The arena floor's response to the ground field and the impacts, for a game's own floor material:
 * `{ color, roughness, metalness, emissive }` nodes from the surface's own albedo / roughness /
 * metalness, at world position `wp`. Build the GroundField first (common.ts setGroundTexture).
 */
export function groundShade(wp: V3, surface: IGroundSurface) {
  // two calls, each packing what one material slot set reads (a TSL Fn returns one value)
  const a = Fn(() => {
    const r = shade(wp, surface);
    return vec4(r.albedo, r.rough);
  })() as unknown as V4;
  const b = Fn(() => {
    const r = shade(wp, surface);
    return vec4(r.emit, r.metal);
  })() as unknown as V4;
  return { color: a.xyz, roughness: a.w, metalness: b.w, emissive: b.xyz };
}
