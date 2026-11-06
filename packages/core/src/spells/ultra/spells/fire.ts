// Ported from Ultra Elements src/spells/fire.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
//
// Slice 1 runs the Fireball's charge, release and flight (the raymarched ball and its light). The
// impact, explosion and Inferno JS is here verbatim and calls the fx services; until Particles,
// FluidVolume, GroundField, Ribbons and Shockwaves are ported they are main.ts's inert seams, so an
// impact draws nothing yet. HAZE_VERT/HAZE_FRAG (a distortion-only billboard) wait on the distortion
// composite (FxTarget.ts), so `hazes` is empty and every haze path is the upstream null path.
import { Color, MathUtils, Vector3, Vector4 } from "three";
import {
  Fn,
  If,
  clamp,
  float,
  length,
  max,
  mix,
  pow,
  smoothstep,
  sqrt,
  uniform,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";
import type { Fx, IFluidDomain } from "../main.js";
import type { IVolumeHandle, IVolumeScope } from "../vfx/Volumes.js";
import {
  arenaSDFJS as arenaSDF,
  blackbody,
  curl3,
  mulMat3Rows,
  noise3,
  noise3v,
} from "../vfx/common.js";
import { blackbodyRGB } from "../vfx/noise.js";
import type { ICast, Phase } from "./cast.js";

type F = Node<"float">;
type V3 = Node<"vec3">;
type V4 = Node<"vec4">;

// Fire (PLAN 3). Fireball: a raymarched teardrop whose noise streams backwards past the ball and
// is stretched into licking tongues down the tail; fire is emission = sigma * L(T) (hot soot glows,
// cold soot is smoke), so a white-yellow core shows through a thinner orange body, with a dark
// sooty fringe heaviest on the tail. Small fast-cooling flame licks, curling dark smoke, embers
// and a short hot core ribbon trail it. Impact: a pyroclastic volume (billows, vortex-ring roll,
// cools outside-in from white to orange to rolling dark smoke), sparks, glowing debris, a dust
// ring, a shockwave, heat into the ground field (which then grows ground flames by itself).
// Inferno: a roaring column volume swirled by a vortex force, a line light, heat-haze billboard,
// embers and a scorched ring.

// fire radiance at T: blackbody chromaticity, brightness ~ (T / Tref)^4 (Stefan-Boltzmann), and no
// visible glow below ~700 K (Draper point ~800 K): T^4 alone leaves cooled soot glowing dull red, which
// the night exposure (10x dusk) turns into a red veil over the smoke
export const fireL = Fn(([T, Tref]: [F, F]) => {
  const k0 = T.div(Tref);
  const k = k0.mul(k0);
  return blackbody(T).mul(k.mul(k).mul(smoothstep(700.0, 1000.0, T)));
});

// FIREBALL_GLSL
//   uBall      radius m, core temperature K, intensity, time s
//   uBall2     tail length m, flow m/s, soot, seed
//   uBallPos   ball centre (the proxy capsule also covers the tail behind it)
//   uTint
export function FIREBALL(
  pw: V3,
  _pl: V3,
  sigma: F,
  albedo: V3,
  emission: V3,
  V: IVolumeScope,
): void {
  const uBall = V.uBall as V4;
  const uBall2 = V.uBall2 as V4;
  const uBallPos = V.uBallPos as V3;
  const uTint = V.uTint as V3;
  sigma.assign(0.0);
  albedo.assign(vec3(0.0));
  emission.assign(vec3(0.0));
  const R = uBall.x;
  const time = uBall.w;
  const L = uBall2.x;
  const q = mulMat3Rows(V.uVolRot, pw.sub(uBallPos)); // y = flight direction, metres
  const u = q.y.negate().div(L);
  const uc = clamp(u, 0.0, 1.0); // 0 at the centre .. 1 at the tail tip
  // teardrop: a sphere ahead, a tapering tail behind
  const d0 = R.mul(sqrt(max(float(1.0).sub(uc.mul(0.9)), 0.0))).sub(
    length(vec3(q.x, max(q.y, 0.0), q.z)),
  );
  const amp = R.mul(uc.mul(0.7).add(0.32));
  // if (d0 < -amp || u > 1.3) return;
  If(d0.greaterThanEqual(amp.negate()).and(u.lessThanEqual(1.3)), () => {
    // flames stream backwards past the ball (noise scrolls along -y), stretched a little into
    // tongues down the tail. Band-limited on purpose: the baked noise's finest octaves sit far below
    // the march step and would only alias into grain, so the frequency stays low and the detail
    // octave fades out as the step grows (gVolDt).
    const s = float(0.34).div(R);
    const np0 = vec3(q.x, q.y.mul(mix(1.0, 0.6, uc)).add(uBall2.y.mul(time)), q.z).mul(s);
    const np = np0
      .add(curl3(np0.mul(0.4).add(vec3(0.0, time.mul(0.1), uBall2.w))).mul(0.3))
      .add(uBall2.w);
    const n1 = noise3(np);
    const n2 = noise3(np.mul(1.9).add(vec3(0.37, s.mul(time).mul(0.5), 0.11)));
    const detail = float(1.0).sub(smoothstep(0.35, 0.9, V.gVolDt.div(R)));
    const d = d0
      .add(n1.sub(0.5).mul(2.0).mul(amp))
      .add(n2.sub(0.5).mul(0.7).mul(amp).mul(detail))
      .sub(R.mul(uc).mul(0.3));
    const tail = float(1.0).sub(smoothstep(0.8, 1.25, u));
    const body = smoothstep(0.0, R.mul(0.5), d).mul(tail);
    // boiling cells (Worley, riding the flow): the burning surface breaks into dense, hot cells with
    // thin, cooler, sooty folds between them, so the white core shows through in pockets
    const cell = mix(
      0.5,
      noise3v(np.mul(1.5).add(vec3(0.0, s.mul(time).mul(0.35), 0.0))).b,
      detail,
    );
    const fold = float(1.0).sub(cell);
    const heat = clamp(
      pow(clamp(d.div(R), 0.0, 1.0), 1.15)
        .mul(1.9)
        .mul(float(1.0).sub(uc.mul(0.55)))
        .add(n2.sub(0.5).mul(0.2))
        .add(cell.sub(0.5).mul(0.45)),
      0.0,
      1.0,
    );
    const T = mix(760.0, uBall.y.mul(1.45), heat);
    const sf = body.mul(cell.mul(cell).mul(4.0).add(1.0)).div(R);
    // soot: where the tongues cool on the trailing side and in the folds, patchy, nothing ahead
    const soot = smoothstep(R.mul(-0.3), R.mul(0.2), d)
      .mul(float(1.0).sub(smoothstep(0.0, 0.45, heat)))
      .mul(max(smoothstep(0.42, 0.75, n2), fold.mul(fold).mul(0.7)))
      .mul(smoothstep(-0.25, 0.7, u))
      .mul(tail);
    const ss = soot.mul(uBall2.z).mul(8.0).div(R);
    sigma.assign(sf.add(ss));
    emission.assign(fireL(T, uBall.y).mul(sf).mul(uTint).mul(uBall.z));
    albedo.assign(vec3(0.02, 0.018, 0.016).mul(ss.div(max(sigma, 1e-4))));
  });
}

// flame-ish kinds: [kind, hot x T, cold x T]; recoloured when temperature or tint change
const HOT_KINDS: [string, number, number][] = [
  ["flame", 1.25, 0.38],
  ["ember", 1.1, 0.5],
  ["spark", 1.45, 0.6],
];

interface IFireData {
  light: ReturnType<Fx["lights"]["acquire"]>;
  ball: IVolumeHandle | null;
  home: Vector3;
  fl: IFluidDomain | null;
  trail: ReturnType<Fx["trails"]["acquire"]>;
  vortex: ReturnType<Fx["forces"]["acquire"]>;
  haze: IHaze | null;
  age: number;
  nextSplat: number;
  dimmed: boolean;
}
interface IHaze {
  visible: boolean;
}

export default {
  id: "fire",
  name: "Fire",
  key: "2",
  hue: "#ff7a1a",
  shape: "projectile",
  forms: ["Fireball", "Inferno"],
  radius: 0.35,
  params: {
    size: 1,
    speed: 18,
    temperature: 1900,
    intensity: 1,
    soot: 1,
    embers: 1,
    smoke: 1,
    haze: 1,
    scorch: 1,
    height: 1,
    tint: "#ffffff",
  },
  ranges: {
    size: [0.3, 3, 0.01],
    speed: [4, 40, 0.1],
    temperature: [900, 6500, 10],
    intensity: [0, 3, 0.01],
    soot: [0, 3, 0.01],
    embers: [0, 3, 0.01],
    smoke: [0, 3, 0.01],
    haze: [0, 3, 0.01],
    scorch: [0, 2, 0.01],
    height: [0.4, 2, 0.01],
  },
  presets: {
    hellfire: { temperature: 1500, tint: "#ff6a4a", smoke: 1.6, soot: 1.6, intensity: 1.2 },
    "blue flame": { temperature: 6500, tint: "#8fb8ff", smoke: 0.3, soot: 0.15 },
    soulfire: { temperature: 2600, tint: "#3cff9a", smoke: 0.5, soot: 0.5 },
  },
  timing: { charge: 0.7, impact: 0.25, linger: 5, sustain: 2.6 },
  kinds: {
    // small fast-cooling licks: they ride off the ball, curl, erode away and turn to soot
    flame: {
      style: "media",
      drag: 3.6,
      buoyancy: 3.8,
      curl: 3.2,
      curlScale: 0.6,
      life: [0.16, 0.36],
      size: [0.09, 0.32],
      sizePow: 0.6,
      emissive: 1.3,
      temp: [2375, 720],
      toSmokeAt: 0.5,
      smokeAlbedo: 0.04,
      alpha: [0.75, 0],
      density: 9,
      distortion: 0.6,
      erosion: 1.6,
      fadeIn: 0.06,
      fadeOut: 0.3,
    },
    ember: {
      style: "glow",
      drag: 0.6,
      buoyancy: 1.7,
      gravity: 1.2,
      curl: 2.8,
      curlScale: 0.5,
      life: [1.0, 2.6],
      size: [0.028, 0.01],
      stretch: 0.025,
      emissive: 4,
      temp: [2090, 950],
      restitution: 0.3,
      friction: 0.4,
      paints: "char",
      paintAmount: 0.05,
    },
    spark: {
      style: "glow",
      drag: 0.35,
      gravity: 9.8,
      restitution: 0.4,
      friction: 0.3,
      life: [0.4, 1.3],
      size: [0.03, 0.01],
      stretch: 0.035,
      emissive: 6,
      temp: [2750, 1140],
      paints: "heat",
      paintAmount: 0.04,
    },
    smoke: {
      style: "media",
      emissive: 0,
      drag: 1.3,
      buoyancy: 1.6,
      curl: 1.7,
      curlScale: 0.32,
      life: [2.2, 4.5],
      size: [0.35, 2.0],
      sizePow: 0.55,
      color: ["#15120f", "#2e2b28"],
      alpha: [0.62, 0],
      density: 2.6,
      erosion: 0.8,
      fadeIn: 0.12,
      fadeOut: 0.45,
    },
    dust: {
      style: "media",
      emissive: 0,
      drag: 3.2,
      buoyancy: 0.15,
      curl: 0.6,
      life: [0.8, 1.8],
      size: [0.35, 1.4],
      color: ["#463c34", "#36302b"],
      alpha: [0.38, 0],
      density: 1.4,
      erosion: 0.6,
    },
    debris: {
      style: "debris",
      mesh: "rock",
      drag: 0.25,
      gravity: 9.8,
      restitution: 0.3,
      friction: 0.6,
      life: [1.6, 3.2],
      size: [0.085, 0.085],
      color: ["#2a2220", "#ff5a10"],
      alpha: [1, 0.9],
      spin: 7,
      fadeOut: 0.15,
      paints: "heat",
      paintAmount: 0.08,
    },
  },

  create(fx: Fx) {
    const S = this;
    const P = fx.particles;
    const lick = P.emitter("fire.flame", {
      shape: "shell",
      radius: 0.32,
      spread: 0.9,
      radial: 1.3,
    });
    const flame = P.emitter("fire.flame", { shape: "sphere", radius: 0.2, spread: 0.5 });
    const muzzle = P.emitter("fire.flame", {
      shape: "cone",
      radius: 0.15,
      spread: 0.6,
      radial: 7,
      cone: 0.5,
    });
    const pillar = P.emitter("fire.flame", {
      shape: "disk",
      radius: 1.0,
      spread: 0.7,
      radial: -0.6,
    });
    const blast = P.emitter("fire.flame", {
      shape: "sphere",
      radius: 0.6,
      spread: 2.2,
      radial: 5,
      life: 2.6,
    });
    const ember = P.emitter("fire.ember", { shape: "sphere", radius: 0.25, spread: 1.2 });
    const spark = P.emitter("fire.spark", { shape: "sphere", radius: 0.3, spread: 8, radial: 4 });
    const smoke = P.emitter("fire.smoke", { shape: "sphere", radius: 0.5, spread: 0.6 });
    const dust = P.emitter("fire.dust", { shape: "ring", radius: 0.8, spread: 0.3, radial: 7 });
    const debris = P.emitter("fire.debris", { shape: "sphere", radius: 0.4, spread: 4, radial: 6 });
    // ground flames wherever the field is hot (the same flame kind, a little bigger and slower)
    P.fieldEmitter("fire.flame", {
      slots: 1536,
      a: [1, 0, 0, 0],
      threshold: 0.35,
      rate: 5,
      up: 0.8,
      lifeScale: 1.8,
      sizeScale: 1.4,
    });

    // the shared combustion fluid: the explosion and the inferno column are simulated fire
    // (upstream: FluidVolume.get(fx); here the fx service seam)
    const fluid = fx.fluid;

    // flight: one raymarched fireball per live cast
    const tint = new Vector3(1, 1, 1);
    const balls: IVolumeHandle[] = [];
    for (let i = 0; i < 3; i++) {
      const v = fx.volumes.add({
        shape: "capsule",
        tsl: FIREBALL,
        maxSteps: 32,
        uniforms: {
          uTint: uniform(tint),
          uBall: uniform(new Vector4()),
          uBall2: uniform(new Vector4()),
          uBallPos: uniform(new Vector3()),
        },
      });
      v.visible = false;
      v.g = 0.35;
      balls.push(v);
    }
    const ballU = (v: IVolumeHandle) =>
      v.uniforms as unknown as {
        uBall: { value: Vector4 };
        uBall2: { value: Vector4 };
        uBallPos: { value: Vector3 };
      };
    // where each cast's ball forms: in front of the caster's orb, towards the target (one per cast record)
    const homes = Array.from({ length: 16 }, () => new Vector3());
    const isFree = (v: { visible: boolean }) => !v.visible;
    const take = <T extends { visible: boolean }>(list: T[]) => list.find(isFree) ?? null;

    // heat-haze billboards (inferno column, explosion): HAZE_VERT/HAZE_FRAG not ported yet (see top)
    const hazes: IHaze[] = [];

    const col = new Color();
    const tintCol = new Color();
    const lightColor = (T: number, out: Color) => {
      blackbodyRGB(T, out);
      return out.multiply(tintCol);
    };
    const _a = new Vector3();
    const _b = new Vector3();
    const _vd = new Vector3();
    const _Y = new Vector3(0, 1, 0);
    const _down = new Vector3(0, -1, 0);
    const _shC = new Vector3();
    // biome-ignore lint/style/useNamingConvention: upstream Ultra Elements code, copied verbatim
    const SPLAT = {};
    const shock: Record<string, unknown> & { pos: Vector3 } = { pos: new Vector3() };
    // biome-ignore lint/style/useNamingConvention: upstream Ultra Elements code, copied verbatim
    const SRC = {
      pos: new Vector3(),
      vel: new Vector3(),
      radius: 1,
      fuel: 0,
      temp: 0,
      soot: 0,
      radial: 0,
      noise: 0,
      noiseScale: 1,
      seed: 0,
      coupling: 0,
      burst: false,
    };
    let lastT = -1;
    let lastTint = "";
    // kind patches, reused (retint runs from phases)
    const hot = HOT_KINDS.map(([k, a, b]) => ({
      name: `fire.${k}`,
      a,
      b,
      white: { temp: [0, 0] },
      tinted: { temp: null, color: [new Color(), new Color()] },
    }));
    // biome-ignore lint/style/useNamingConvention: upstream Ultra Elements code, copied verbatim
    const DEBRIS = { color: [new Color("#2a2220"), new Color()] };

    // particle kinds follow temperature and tint: blackbody ramps when untinted, else tinted
    // blackbody colours (the kind table has no tint), written as texels (no recompile)
    function retint() {
      const p = S.params;
      if (p.temperature === lastT && p.tint === lastTint) return;
      lastT = p.temperature;
      lastTint = p.tint;
      tintCol.set(p.tint);
      tint.set(tintCol.r, tintCol.g, tintCol.b);
      const white = tintCol.r > 0.97 && tintCol.g > 0.97 && tintCol.b > 0.97;
      for (const h of hot) {
        if (white) {
          h.white.temp[0] = p.temperature * h.a;
          h.white.temp[1] = p.temperature * h.b;
          P.setKind(h.name, h.white);
        } else {
          blackbodyRGB(p.temperature * h.a, h.tinted.color[0] as Color).multiply(tintCol);
          blackbodyRGB(p.temperature * h.b, h.tinted.color[1] as Color)
            .multiply(tintCol)
            .multiplyScalar((h.b / h.a) ** 3);
          P.setKind(h.name, h.tinted);
        }
      }
      // glowing debris: tinted blackbody at 0.8 T, normalised to a peak channel of 1 (#ff5a10 at 1900 K)
      const e = blackbodyRGB(p.temperature * 0.8, DEBRIS.color[1] as Color).multiply(tintCol);
      e.multiplyScalar(1 / Math.max(e.r, e.g, e.b, 1e-4));
      P.setKind("fire.debris", DEBRIS);
    }
    retint();

    function splat(
      x: number,
      z: number,
      radius: number,
      heat: number,
      char: number,
      pattern: string,
      seed: number,
      width = 0,
    ) {
      Object.assign(SPLAT, { x, z, radius, heat, char, pattern, seed, width });
      fx.ground.splat(SPLAT);
    }

    // look shared by both fluid forms (spell params -> domain look)
    function lookFluid(f: IFluidDomain, p: typeof S.params) {
      f.temperature = p.temperature;
      f.tint.copy(tintCol);
      f.emission = 6.5 * p.intensity;
      f.sootDensity = 3.2;
      f.flameDensity = 0.9;
      f.sootYield = 0.75 * p.soot;
      f.sootColor.setRGB(0.09, 0.085, 0.08);
    }

    // one emitter record, reused
    function src(
      f: IFluidDomain,
      x: number,
      y: number,
      z: number,
      radius: number,
      fuel: number,
      temp: number,
      soot: number,
      burst: boolean,
      noise: number,
      noiseScale: number,
      seed: number,
      vx: number,
      vy: number,
      vz: number,
      radial: number,
      coupling: number,
    ) {
      SRC.pos.set(x, y, z);
      SRC.radius = radius;
      SRC.fuel = fuel;
      SRC.temp = temp;
      SRC.soot = soot;
      SRC.burst = burst;
      SRC.noise = noise;
      SRC.noiseScale = noiseScale;
      SRC.seed = seed;
      SRC.vel.set(vx, vy, vz);
      SRC.radial = radial;
      SRC.coupling = coupling;
      f.emit(SRC);
    }

    // capsule proxy along the flight direction: front cap around the ball, body over the tail
    function placeBall(
      v: IVolumeHandle,
      pos: Vector3,
      vel: Vector3,
      R: number,
      I: number,
      time: number,
      tail: number,
      flow: number,
      seed: number,
    ) {
      const p = S.params;
      const sp = vel.length();
      if (sp > 1e-4) _vd.copy(vel).divideScalar(sp);
      else _vd.set(0, 1, 0);
      const front = R * 1.45;
      const back = tail + R * 0.35;
      const ra = R * 1.5;
      v.quaternion.setFromUnitVectors(_Y, _vd);
      v.scale.set(ra, Math.max((front + back) * 0.5, ra), ra);
      v.position.copy(pos).addScaledVector(_vd, (front - back) * 0.5);
      ballU(v).uBall.value.set(R, p.temperature, I, time);
      ballU(v).uBall2.value.set(tail, flow, p.soot, seed);
      ballU(v).uBallPos.value.copy(pos);
    }

    function freeHaze() {
      return hazes.find(isFree) ?? null;
    }
    function placeHaze(
      _m: IHaze,
      _x: number,
      _y: number,
      _z: number,
      _halfWidth: number,
      _height: number,
      _strength: number,
    ) {
      // uHazeA / uHazeB: set on the haze material once HAZE_FRAG is ported
    }
    const data = (c: ICast) => c.data as unknown as IFireData;

    return {
      onParam(k: string) {
        if (k === "tint" || k === "temperature") retint();
      },

      // Fireball flies like any projectile; Inferno erupts at the target with no flight
      travel(c: ICast, dt: number) {
        if (c.form === "Inferno") {
          c.pos.copy(c.to);
          return true;
        }
        c.pos.addScaledVector(c.vel, dt);
        c.travelled += c.vel.length() * dt;
        const passed = _a.subVectors(c.to, c.pos).dot(c.dir) <= 0;
        const hit =
          (c.travelled > 1 && arenaSDF(c.pos) < S.radius) || passed || c.t > c.durations.travel;
        if (hit && passed && c.t <= c.durations.travel) c.pos.copy(c.to);
        return hit;
      },

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upstream Ultra Elements code, copied verbatim
      phase(c: ICast, name: Phase) {
        const p = S.params;
        const d = data(c);
        retint();
        if (name === "charge") {
          d.light = fx.lights.acquire();
          if (d.light) {
            d.light.range = 9;
            d.light.intensity = 0;
            d.light.shadow = true;
            d.light.type = 0;
            lightColor(p.temperature, d.light.color);
          }
          d.ball = c.form === "Fireball" ? take(balls) : null;
          // biome-ignore lint/style/noNonNullAssertion: upstream Ultra Elements code, copied verbatim
          d.home = homes[c.index % 16]!.copy(c.from)
            .addScaledVector(c.dir, 0.6 * p.size)
            .setY(c.from.y + 0.12 * p.size);
          if (d.ball) {
            d.ball.visible = true;
            placeBall(d.ball, d.home, _down, 0.01, 0, 0, 0.02, 2, c.seed % 89);
          }
          d.fl = null;
          d.trail = null;
          d.vortex = null;
          d.haze = null;
          d.age = 0;
          d.nextSplat = 0;
          d.dimmed = false;
        } else if (name === "release") {
          fx.rig.shake(0.12, 10);
          if (c.form === "Fireball") {
            // it leaves from where it formed; the orb that fed it lights back up
            c.pos.copy(d.home);
            fx.arena.setFocus(fx.arena.focus.color, 2.5);
            d.dimmed = false;
            d.trail = fx.trails.acquire();
            const t = d.trail;
            if (t) {
              t.width = 0.09 * p.size;
              t.intensity = 2.5 * p.intensity;
              t.glow = 3;
              t.glowIntensity = 0.22;
              t.fadeTime = 0.14;
              t.distortion = 0.1 * p.haze;
              lightColor(p.temperature * 1.15, t.color);
            }
            muzzle.pos.copy(c.pos);
            muzzle.p.copy(c.dir);
            muzzle.vel.copy(c.dir).multiplyScalar(3);
            muzzle.size = p.size;
            muzzle.burst(70 * p.size);
          }
        } else if (name === "impact") {
          if (d.ball) {
            d.ball.visible = false;
            d.ball = null;
          }
          d.trail?.release();
          d.trail = null;
          if (c.form === "Fireball") explode(c, p, d);
          else erupt(c, p, d);
        } else if (name === "done") {
          if (d.dimmed) {
            d.dimmed = false;
            fx.arena.setFocus(fx.arena.focus.color, 2.5);
          } // cut short while charging
          d.light?.release();
          d.light = null;
          d.vortex?.release();
          d.vortex = null;
          d.trail?.release();
          d.trail = null;
          d.fl?.release();
          d.fl = null;
          if (d.ball) d.ball.visible = false;
          if (d.haze) d.haze.visible = false;
          d.ball = d.haze = null;
        }
      },

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upstream Ultra Elements code, copied verbatim
      update(c: ICast, dt: number) {
        const p = S.params;
        const d = data(c);
        const L = d.light;
        const flick =
          0.8 +
          0.2 * Math.sin(c.age * 31 + c.seed) * Math.sin(c.age * 13.7) +
          0.06 * Math.sin(c.age * 71);
        if (c.phase === "charge") {
          const k = c.t / c.durations.charge;
          const at = c.form === "Fireball" ? d.home : c.pos;
          if (d.ball) {
            // the ball boils up out of nothing in front of the orb, which pours itself into it
            const e = MathUtils.smoothstep(k, 0, 0.8);
            placeBall(
              d.ball,
              at,
              _down,
              0.4 * p.size * (0.15 + 0.85 * e),
              6 * p.intensity * (0.4 + 0.6 * e),
              c.age,
              0.42 * p.size * (0.5 + e),
              2.8,
              c.seed % 89,
            );
            fx.arena.setFocus(fx.arena.focus.color, 2.5 * (1 - 0.8 * e));
            d.dimmed = true;
          }
          flame.pos.copy(at);
          flame.vel.set(0, 0.6, 0);
          flame.size = p.size * 0.5;
          flame.rate(140 * p.size, dt);
          // embers spiral in from a ring around the focus
          ember.pos
            .copy(at)
            .addScaledVector(_a.set(Math.sin(c.age * 9), 0.3, Math.cos(c.age * 9)), 0.9);
          ember.vel
            .subVectors(at, ember.pos)
            .multiplyScalar(2.5)
            .addScaledVector(_a.set(Math.cos(c.age * 9), 0, -Math.sin(c.age * 9)), 2);
          ember.rate(180 * p.embers, dt);
          if (L) {
            L.pos.copy(at);
            L.intensity = 14 * k * flick * p.intensity;
          }
          if (c.form === "Inferno") {
            // the ground at the target heats up in a ring before the eruption
            if (c.t >= d.nextSplat) {
              d.nextSplat = c.t + 0.15;
              splat(
                c.to.x,
                c.to.z,
                1.7 * p.size * (0.6 + 0.4 * k),
                0.3 * p.scorch,
                0.2,
                "ring",
                c.seed + c.t,
                0.35 * p.size,
              );
            }
            ember.pos.set(c.to.x, 0.15, c.to.z);
            ember.vel.set(0, 1.5, 0);
            ember.rate(90 * p.embers * k, dt);
          }
        } else if (c.phase === "travel") {
          const R = 0.4 * p.size;
          const sp = c.vel.length();
          if (d.ball)
            placeBall(
              d.ball,
              c.pos,
              c.vel,
              R,
              4.5 * p.intensity,
              c.age,
              R * 2.8,
              3 + 0.4 * sp,
              c.seed % 89,
            );
          lick.pos.copy(c.pos);
          lick.radius = 0.8 * R;
          lick.vel.copy(c.vel).multiplyScalar(0.42);
          lick.size = p.size;
          lick.rate(1600 * p.size, dt);
          smoke.pos.copy(c.pos).addScaledVector(c.dir, -1.2 * R);
          smoke.radius = 0.3 * p.size;
          smoke.vel.set(0, 0.7, 0).addScaledVector(c.vel, 0.04);
          smoke.size = 0.6 * p.size;
          smoke.rate(75 * p.smoke, dt);
          ember.pos.copy(c.pos);
          ember.vel.copy(c.vel).multiplyScalar(0.2);
          ember.rate(200 * p.embers, dt);
          d.trail?.push(c.pos);
          if (L) {
            L.pos.copy(c.pos);
            L.intensity = 18 * flick * p.intensity;
          }
        } else if (c.form === "Fireball") updateExplosion(c, p, d, dt, flick);
        else updateInferno(c, p, d, dt, flick);
      },
    };

    // --- Fireball impact: a fluid fireball ------------------------------------------------
    // Reference: gasoline / fuel-air fireballs (film pyro, high-speed footage): a fuel cloud
    // ignites and expands violently, its surface boils into turbulent white-yellow lobes, buoyancy
    // turns it into a rolling vortex ring that climbs and mushrooms, the burning shell cools to
    // orange and red and is swallowed by black soot, which rises sunlit on top, dark underneath.
    // the radius of a formed Aegis over the target (its centre in _shC) that the ball met from outside; 0: none
    function shieldAt(c: ICast) {
      const arcane = fx.spells.arcane?.inst as
        | { shieldOver?(x: number, z: number, out: Vector3): number }
        | undefined;
      const r = arcane?.shieldOver?.(c.to.x, c.to.z, _shC) ?? 0;
      return r > 0 && _shC.distanceToSquared(c.from) > r * r ? r : 0;
    }

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upstream Ultra Elements code, copied verbatim
    function explode(c: ICast, p: typeof S.params, d: IFireData) {
      const pos = c.pos;
      const s = p.size;
      // an Aegis takes the blast on its shell (the ball stopped there: the dome is an occluder). It goes
      // off just outside it, within the shield's 0.9 m hit reach so the shell still ripples, and the dome
      // is a solid in the fire's sim: the fireball splashes on it and rolls up and over it instead of
      // filling it and hiding the hit
      const shR = shieldAt(c);
      if (shR > 0) {
        _a.subVectors(pos, _shC);
        if (_a.lengthSq() < 1e-6) _a.subVectors(c.from, _shC).setY(0);
        pos.copy(_shC).addScaledVector(_a.normalize(), shR + Math.min(0.8 * s, 0.85));
      }
      // biome-ignore lint/suspicious/noAssignInExpressions: upstream Ultra Elements code, copied verbatim
      const f = (d.fl = fluid.acquire({ size: [8.5 * s, 10 * s, 8.5 * s] }));
      if (f) {
        if (shR > 0) f.obstacle.set(_shC.x, _shC.y, _shC.z, shR);
        f.position.set(pos.x, 0.5 * f.size.y - f.h, pos.z);
        lookFluid(f, p);
        Object.assign(f, {
          ignition: 0.25,
          burnRate: 2.6,
          heatPerFuel: 0.5,
          expansion: 1.2,
          cooling: 0.35,
          radiative: 0.5,
          sootYield: 0.7 * p.soot,
          sootDensity: 3.6,
          flameDensity: 3.5,
          sootDecay: 0.06,
          fuelDecay: 0.2,
          buoyancy: 8,
          sootWeight: 0.35,
          vorticity: 7,
          damping: 0.25,
          forceCoupling: 0.6,
          turbulence: 14,
          turbulenceFreq: 0.45 / s,
          sootCool: 0.9,
          detailFreq: 0.4 / s,
          detailErode: 0.3,
          detailHeat: 0.4,
          emptyBelow: 0.05, // the invisible veil round the smoke is skipped (~0.1 ms)
        });
        f.detailCenter.copy(pos);
      } else {
        // pool full: a particle fireball
        blast.pos.copy(pos);
        blast.radius = 0.6 * s;
        blast.vel.set(0, 1.5, 0);
        blast.size = 2.2 * s;
        blast.burst(300 * s);
        smoke.pos.copy(pos).setY(pos.y + 0.8 * s);
        smoke.radius = 1.0 * s;
        smoke.vel.set(0, 0.6, 0);
        smoke.size = 1.25 * s;
        smoke.burst(140 * p.smoke);
      }
      spark.pos.copy(pos);
      spark.vel.set(0, 1, 0);
      spark.burst(380 * p.embers);
      debris.pos.copy(pos);
      debris.vel.set(0, 3, 0);
      debris.size = s;
      debris.burst(70 * s);
      ember.pos.copy(pos);
      ember.vel.set(0, 2, 0);
      ember.burst(160 * p.embers);
      dust.pos.copy(pos).setY(0.15);
      dust.size = 0.8 * s;
      dust.burst(45 * s);
      shock.radius0 = 0.3;
      shock.radius1 = 7 * s;
      shock.duration = 0.5;
      shock.thickness = 0.8;
      shock.distortion = 0.035 * p.haze;
      shock.intensity = 0;
      shock.ground = false;
      shock.pos.copy(pos);
      fx.shocks?.spawn(shock);
      splat(pos.x, pos.z, 2.6 * s * p.scorch, 0.45, 0.9, "noise", c.seed);
      fx.impacts.add("scorch", pos, 3.2 * s, 0.6, 9, lightColor(p.temperature, col));
      if (d.light) {
        d.light.intensity = 60 * p.intensity;
        d.light.range = 16 * s;
        d.light.pos.copy(pos).setY(pos.y + 0.6);
      }
      d.haze = freeHaze();
      if (d.haze) d.haze.visible = true;
      fx.flash(0.2 * p.intensity);
      fx.rig.shake(0.5, 12);
      if (!fx.reduced) {
        fx.rig.punch(3, 0.08);
        fx.rig.hitstop(0.05);
      }
      for (const dm of fx.dummies) {
        const dist = Math.hypot(dm.pos.x - pos.x, dm.pos.z - pos.z);
        if (shR > 0 && (dm.pos.x - _shC.x) ** 2 + (dm.pos.z - _shC.z) ** 2 < shR * shR) continue; // sheltered
        if (dist < 3 * s) {
          dm.status.burn = Math.max(dm.status.burn, 1 - dist / (3 * s) + 0.3);
          dm.hit(_a.subVectors(dm.pos, pos).setY(0).normalize(), 1 - dist / (3 * s));
        }
      }
    }

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upstream Ultra Elements code, copied verbatim
    function updateExplosion(
      c: ICast,
      p: typeof S.params,
      d: IFireData,
      dt: number,
      flick: number,
    ) {
      // biome-ignore lint/suspicious/noAssignInExpressions: upstream Ultra Elements code, copied verbatim
      const a = (d.age += dt);
      const s = p.size;
      const f = d.fl;
      const pos = c.pos;
      const sd = (c.seed % 97) * 0.37;
      if (f) {
        const r = shieldAt(c); // the dome stays solid while it stands
        f.obstacle.set(_shC.x, _shC.y, _shC.z, r);
        if (a <= dt + 1e-4) {
          // the fuel cloud: one lumpy core and three off-centre lobes, all igniting at once and
          // thrown outwards; the noise makes the surface uneven from the first frame
          src(
            f,
            pos.x,
            pos.y,
            pos.z,
            1.3 * s,
            2.0,
            1.05,
            0.05,
            true,
            0.85,
            2.2 / s,
            sd,
            0,
            0,
            0,
            7 * s,
            400,
          );
          for (let i = 0; i < 3; i++) {
            const ang = sd * 3 + i * 2.1;
            const r = 0.75 * s;
            _b.set(Math.cos(ang) * r, (i - 1) * 0.35 * s, Math.sin(ang) * r);
            src(
              f,
              pos.x + _b.x,
              Math.max(pos.y + _b.y, 0.45 * s),
              pos.z + _b.z,
              0.85 * s,
              1.8,
              1.0,
              0.05,
              true,
              0.8,
              2.6 / s,
              sd + i * 1.7,
              _b.x * 5.5,
              _b.y * 5.5 + 1.5,
              _b.z * 5.5,
              3 * s,
              200,
            );
            // a fuel-rich, barely lit pocket outside each lobe: dark soot laced over the fire from the first frame
            const r2 = 1.55 * s;
            const a2 = ang + 1.05;
            _b.set(Math.cos(a2) * r2, (1 - i) * 0.45 * s + 0.35 * s, Math.sin(a2) * r2);
            src(
              f,
              pos.x + _b.x,
              Math.max(pos.y + _b.y, 0.4 * s),
              pos.z + _b.z,
              0.55 * s,
              0.6,
              0.45,
              0.7,
              true,
              0.9,
              3 / s,
              sd + 4 + i * 2.3,
              _b.x * 3,
              _b.y * 3 + 1,
              _b.z * 3,
              1.5 * s,
              200,
            );
          }
        } else if (a < 0.16) {
          // fuel keeps pouring out of the core for a few frames: the fireball keeps growing
          src(
            f,
            pos.x,
            pos.y,
            pos.z,
            0.8 * s,
            9,
            0.8,
            0,
            false,
            0.5,
            1.4 / s,
            sd + 5,
            0,
            1,
            0,
            5 * s,
            30,
          );
        }
        // the soot erodes late, thin edges first, so the billows stay sharp until the cloud is gone (~5 s)
        f.sootErode = 1.6 * MathUtils.smoothstep(a, 1.5, 4.4);
        // the flash: the first few frames run hotter than the settled burn
        f.emission = (3.6 + 4 * Math.exp(-a / 0.18)) * p.intensity;
        // the cell pattern rides the gas: it climbs with the fireball and grows as it expands
        const grow = 1 - Math.exp(-a / 0.45);
        f.detailCenter.set(pos.x, pos.y + 1.1 * s * Math.min(a, 3), pos.z);
        f.detailFreq = 0.4 / (s * (0.75 + 0.75 * grow));
        if (a > 5.2) {
          f.release();
          d.fl = null;
        }
      }
      // fluid heat drives the light; it climbs with the fireball
      const heat = f ? f.heat : 3 * Math.exp(-a * 1.5);
      if (d.haze) {
        d.haze.visible = a < 3.5;
        placeHaze(
          d.haze,
          pos.x,
          Math.max(0, pos.y - 0.5),
          pos.z,
          2.6 * s,
          6 * s,
          0.07 * p.haze * Math.min(1, heat / 2),
        );
      }
      if (!f && c.phase === "linger" && c.t < 2) {
        smoke.pos.copy(pos).setY(pos.y + 2.4 * s + 1.2 * c.t);
        smoke.radius = 0.9 * s;
        smoke.vel.set(0, 1.2, 0);
        smoke.size = 1.4 * s;
        smoke.rate(4 * p.smoke, dt);
      }
      const L = d.light;
      if (L) {
        L.pos.set(pos.x, pos.y + 0.6 + Math.min(2.5 * s, a * 1.4 * s), pos.z);
        L.intensity = Math.min(70, 16 * heat) * p.intensity * (0.85 + 0.15 * flick);
        L.range = 16 * s;
      }
    }

    // --- Inferno: a fluid fire column --------------------------------------------------------
    // Reference: a large pool / gasoline fire: a white-yellow base hugging the ground, flames
    // necking in and tearing into licking tongues with clear gaps, orange-red tips, and black
    // smoke rolling off the top.
    function erupt(c: ICast, p: typeof S.params, d: IFireData) {
      const x = c.to.x;
      const z = c.to.z;
      const s = p.size;
      const H = 8.5 * s * p.height;
      // biome-ignore lint/suspicious/noAssignInExpressions: upstream Ultra Elements code, copied verbatim
      const f = (d.fl = fluid.acquire({
        size: [4.2 * s, H, 4.2 * s],
        res: Math.round(fluid.res * 1.25),
      }));
      if (f) {
        f.position.set(x, 0.5 * f.size.y - f.h, z);
        lookFluid(f, p);
        Object.assign(f, {
          ignition: 0.2,
          burnRate: 4.5,
          heatPerFuel: 0.85,
          expansion: 0.15,
          cooling: 1.0,
          radiative: 0.6,
          sootDecay: 0.18,
          fuelDecay: 0.6,
          buoyancy: 6.5,
          sootWeight: 0.25,
          vorticity: 9,
          damping: 0.2,
          forceCoupling: 0.15,
          // resolved turbulence and boiling cells: tongues with gaps, mottled burning surfaces
          turbulence: 9,
          turbulenceFreq: 0.6 / s,
          sootCool: 1,
          detailFreq: 0.55 / s,
          detailErode: 0.25,
          detailHeat: 0.35,
        });
        f.sootYield = 0.45 * p.soot;
        f.detailCenter.set(x, 0, z);
        // the eruption: a lumpy slug of burning fuel thrown straight up out of the ground
        src(
          f,
          x,
          0.6 * s,
          z,
          0.8 * s,
          2.0,
          1.0,
          0.05,
          true,
          0.85,
          2.4 / s,
          (c.seed % 83) * 0.41 + 7,
          0,
          11 * s,
          0,
          0,
          300,
        );
      } else {
        pillar.pos.set(x, 0.1, z);
        pillar.radius = 0.95 * s;
        pillar.vel.set(0, 3.5, 0);
        pillar.size = 1.3 * s;
        pillar.burst(300 * s);
      }
      d.haze = freeHaze();
      if (d.haze) d.haze.visible = true;
      d.vortex = fx.forces.acquire();
      if (d.vortex) {
        const v = d.vortex;
        v.type = 1;
        v.p[0] = 0.9 * s;
        v.p[1] = 9 * s;
        v.p[2] = 5;
        v.p[3] = 1.2;
        v.w = 7 * s * p.height;
        v.pos.set(x, 0, z);
        v.dir.set(0, 1, 0);
      }
      splat(x, z, 2.4 * s, 0.5 * p.scorch, 0.7, "noise", c.seed);
      splat(x, z, 2.1 * s, 0.25 * p.scorch, 1.1 * p.scorch, "ring", c.seed + 1, 0.45 * s); // the scorched ring
      fx.impacts.add("scorch", _a.set(x, 0.8, z), 2.6 * s, 0.6, 8, lightColor(p.temperature, col));
      spark.pos.set(x, 0.4, z);
      spark.vel.set(0, 4, 0);
      spark.burst(260 * p.embers);
      dust.pos.set(x, 0.15, z);
      dust.size = s;
      dust.burst(70 * s);
      shock.radius0 = 0.5;
      shock.radius1 = 6 * s;
      shock.duration = 0.6;
      shock.thickness = 0.7;
      shock.distortion = 0.03 * p.haze;
      shock.intensity = 0;
      shock.ground = true;
      shock.pos.set(x, 0, z);
      fx.shocks?.spawn(shock);
      if (d.light) {
        d.light.type = 1;
        d.light.range = 12 * s;
        d.light.shadow = true;
      }
      fx.flash(0.12 * p.intensity);
      fx.rig.shake(0.35, 9);
    }

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upstream Ultra Elements code, copied verbatim
    function updateInferno(c: ICast, p: typeof S.params, d: IFireData, dt: number, flick: number) {
      // biome-ignore lint/suspicious/noAssignInExpressions: upstream Ultra Elements code, copied verbatim
      const a = (d.age += dt);
      const x = c.to.x;
      const z = c.to.z;
      const s = p.size;
      const f = d.fl;
      const sd = (c.seed % 83) * 0.41;
      const burn = S.timing.sustain;
      const die = MathUtils.smoothstep(a, burn, burn + 1.3);
      const on = 1 - die;
      const R = 0.95 * s;
      if (f) {
        if (a < 0.3) {
          // the jet keeps feeding the eruption for a moment
          const k = 1 - a / 0.3;
          src(
            f,
            x,
            0.4,
            z,
            0.75 * R,
            10 * k,
            1.0 * k,
            0,
            false,
            0.8,
            2 / s,
            sd + 5 + a,
            0,
            11 * s,
            0,
            0,
            25,
          );
        }
        // the boiling cells climb with the gas
        f.detailCenter.set(x, 2.2 * s * a, z);
        if (on > 0.02) {
          // the jet first; the pool of burning fuel spreads in under it from the centre
          const ramp = MathUtils.smoothstep(a, 0.05, 0.75) * on;
          // a flickering pool of burning fuel at the base, its patches drifting up through it
          src(
            f,
            x,
            0.2,
            z,
            1.25 * R * (0.45 + 0.55 * ramp),
            1.3 * ramp,
            0.55 * ramp,
            0,
            true,
            0.85,
            1.6 / s,
            sd,
            0,
            2.2,
            0,
            -0.6,
            6,
          );
          // a hot core feeding the column
          src(
            f,
            x,
            0.35,
            z,
            0.65 * R,
            1.6 * ramp,
            0.8 * ramp,
            0,
            true,
            0.5,
            2.2 / s,
            sd + 3,
            0,
            4.5,
            0,
            0,
            10,
          );
        }
        f.sootDecay = 0.18 + 0.6 * MathUtils.smoothstep(a, burn + 1.5, burn + 4);
        f.emission = 6.5 * p.intensity;
        if (a > burn + 4.6) {
          f.release();
          d.fl = null;
        }
      }
      const heat = f ? f.heat : 4 * on;
      const H = Math.max(0.6, 6 * s * p.height * Math.min(1, heat / 6));
      if (d.haze) {
        d.haze.visible = a < burn + 2.2;
        placeHaze(d.haze, x, 0, z, 2.2 * s, H * 1.6 + 2, 0.09 * p.haze * (1 - 0.7 * die));
      }
      if (on > 0.01) {
        ember.pos.set(x, 0.5, z);
        ember.radius = R;
        ember.vel.set(0, 2, 0);
        ember.rate(260 * p.embers * on, dt);
        if (Math.floor(a * 4) !== Math.floor((a - dt) * 4))
          splat(x, z, 2 * s, 0.25 * p.scorch, 0.15, "noise", c.seed + a);
        for (const dm of fx.dummies)
          if (Math.hypot(dm.pos.x - x, dm.pos.z - z) < 1.6 * s)
            dm.status.burn = Math.max(dm.status.burn, 0.9);
      }
      if (d.vortex) d.vortex.w = 7 * s * p.height * on;
      const L = d.light;
      if (L) {
        L.pos.set(x, 0.3, z);
        L.end.set(x, Math.max(0.6, H * 0.6), z);
        L.intensity =
          Math.min(40, 5 * heat) * p.intensity * (0.8 + 0.2 * flick) +
          3 * p.intensity * Math.max(0, 1 - c.t / c.durations.linger) * die;
      }
    }
  },
};
