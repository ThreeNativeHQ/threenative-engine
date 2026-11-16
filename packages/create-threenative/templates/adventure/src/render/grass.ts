// Generated for you. This is ordinary Three.js TSL — edit or delete it freely.
//
// The vale's grass look: the blade shape and the material that bends, sways, thins and colours it.
// `GrassField3D` (built in `scenes/Play.ts`) owns the streaming, the scatter, the LOD and the
// pushers; everything you see is decided here. Each blade bends along a quadratic Bezier from its
// root: a resting lean, a gust field that scrolls downwind, a per-blade flutter, and the pushers'
// pull, which lays it flat round Wren. Far blades thin out by priority while the ones left widen,
// so the field holds its cover and nothing pops. Lighting is the scene's own (sun, sky, exposure,
// fog), plus light through the blade when the sun is behind it and darker roots.
import { BufferAttribute, BufferGeometry, Color, DoubleSide, type Vector4 } from "three";
import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  cos,
  cross,
  dot,
  float,
  floor,
  fract,
  max,
  min,
  mix,
  modelWorldMatrix,
  normalize,
  positionGeometry,
  positionWorld,
  pow,
  sin,
  smoothstep,
  sqrt,
  time,
  transformNormalToView,
  varying,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MeshStandardNodeMaterial, type Node, type UniformNode } from "three/webgpu";
import { C } from "./palette.js";
import { SUN_DIRECTION } from "./sky.js";

/** Every look value, in one place. Shape and wind are live through the uniforms below. */
export const GRASS = {
  /** Blade segments near, mid and far: each level is one draw range of the same geometry. */
  segments: [4, 2, 1],
  bladeHeight: 0.5,
  /** ± share of `bladeHeight`. */
  heightVariation: 0.4,
  bladeWidth: 0.05,
  /** Higher stays wide longer, then a sharper tip. */
  taper: 1.7,
  /** Resting lean, 0 upright to 1 flat. */
  lean: 0.34,
  leanVariation: 0.2,
  /** Where the bend happens: low arcs from the root, high is a straight stem with a drooping tip. */
  curve: 0.6,
  /** 0 is a uniform lawn, 1 strong tufts. */
  clumpStrength: 0.75,
  /** Widens edge-on blades so they do not alias into lines. */
  viewThicken: 0.55,
  /** Sinks the roots to hide the seam with the floor. */
  rootSink: 0.03,
  /** Each far blade is this many times wider, holding the cover the thinning took. */
  farWidth: 2.8,
  /** Degrees in the ground plane the wind blows toward (0 = +X, 90 = +Z). */
  windDirection: 25,
  /** Gust fronts travel this fast, m/s, and are this big, metres. */
  windSpeed: 4.5,
  gustScale: 26,
  /** Lean added at the peak of a gust, and the per-blade jitter. */
  windStrength: 0.55,
  flutter: 0.07,
  /** Gusts brighten the blades they bend, which makes wind read as waves from afar. */
  gustHighlight: 0.45,
  /** How far a pusher lays the blades over. */
  pushStrength: 1,
  baseColor: C.grassRoot,
  tipColor: C.grassTip,
  /** Broad patches drift toward this colour. */
  dryColor: C.grassDry,
  dryAmount: 0.35,
  patchScale: 22,
  /** Per-tuft brightness spread. */
  colorVariation: 0.4,
  /** Darkening toward the roots. */
  ambientOcclusion: 0.45,
  /** Sunlight through a blade lit from behind. */
  translucency: 0.7,
  /** 0 lights each blade by its own normal, 1 like the ground under it (calmer). */
  terrainNormalBlend: 0.6,
} as const;

const rgb = (hex: number): Node<"vec3"> => {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
};

/** The sun colour the translucency carries, as the key light's colour. */
const SUN_COLOR = new Color(0xffd9a0);

/** The field's uniforms the material reads: what `GrassField3D` hands to `grassMaterial`. */
export interface IGrassFieldUniforms {
  readonly thinStart: UniformNode<"float", number>;
  readonly thinEnd: UniformNode<"float", number>;
  readonly farDensity: UniformNode<"float", number>;
  readonly fadeStart: UniformNode<"float", number>;
  readonly drawDistance: UniformNode<"float", number>;
  readonly pushers: readonly UniformNode<"vec4", Vector4>[];
  push(rootWorld: Node<"vec3">): Node<"vec3">;
}

/** Every LOD of one blade in one geometry, x across (-0.5..0.5) and y along it (0 root, 1 tip). */
export function grassBlade(): {
  geometry: BufferGeometry;
  lods: { start: number; count: number }[];
  reach: number;
} {
  const pos: number[] = [];
  const idx: number[] = [];
  const lods: { start: number; count: number }[] = [];
  for (const seg of GRASS.segments) {
    const base = pos.length / 3;
    const start = idx.length;
    for (let r = 0; r < seg; r++) pos.push(-0.5, r / seg, 0, 0.5, r / seg, 0);
    pos.push(0, 1, 0);
    for (let r = 0; r < seg - 1; r++) {
      const a = base + r * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const a = base + (seg - 1) * 2;
    idx.push(a, a + 1, a + 2);
    lods.push({ start, count: idx.length - start });
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  geometry.setIndex(idx);
  return { geometry, lods, reach: GRASS.bladeHeight * (1 + GRASS.heightVariation) };
}

const hash2 = (p: Node<"vec2">): Node<"float"> => {
  const q = fract(p.mul(vec2(123.34, 456.21)));
  const r = q.add(dot(q, q.add(45.32)));
  return fract(r.x.mul(r.y));
};

/** Smooth value noise, 0..1. */
const noise = Fn(([p]: [Node<"vec2">]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  return mix(
    mix(hash2(i), hash2(i.add(vec2(1, 0))), u.x),
    mix(hash2(i.add(vec2(0, 1))), hash2(i.add(vec2(1, 1))), u.x),
    u.y,
  );
});

/**
 * The blade material for `GrassField3D`: reads the field's instance attributes (`grassRoot`,
 * `grassRand`, `grassClump`) and uniforms. Its thinning uses the field's own ranges, so the CPU
 * trim only drops blades this material already hid.
 */
export function grassMaterial(field: IGrassFieldUniforms): MeshStandardNodeMaterial {
  const g = GRASS;
  const root = attribute("grassRoot", "vec3");
  const rand = attribute("grassRand", "vec4");
  const clump = attribute("grassClump", "vec4");
  const windAngle = (g.windDirection * Math.PI) / 180;
  const wind = vec2(Math.cos(windAngle), Math.sin(windAngle));
  // The blade's own vertex: after `positionNode` moves it, `positionLocal` reads the moved
  // vertex, whose y is the ground height, not the share of the blade.
  const t = positionGeometry.y;
  const side = positionGeometry.x.mul(2);
  const rootWorld = modelWorldMatrix.mul(vec4(root, 1)).xyz;
  const dist = rootWorld.distance(cameraPosition);
  const r0 = fract(sin(rand.z.mul(9871.13).add(0.71)).mul(43758.5453));
  const r1 = fract(r0.mul(57.31).add(rand.x.mul(3.17)));

  // Distance thinning: blades past this distance's priority cut-off shrink away; the far edge sinks.
  const thinT = smoothstep(field.thinStart, field.thinEnd, dist);
  const keepEdge = mix(float(1.1), field.farDensity, thinT);
  const keep = float(1).sub(smoothstep(keepEdge.sub(0.1), keepEdge, rand.z));
  const fadeSpan = field.drawDistance.sub(field.fadeStart);
  const fadeT = smoothstep(
    field.fadeStart,
    field.drawDistance,
    dist.add(r0.mul(fadeSpan).mul(0.5)),
  );
  const grow = rand.w.mul(keep).mul(float(1).sub(fadeT));

  // Facing: random, pulled outward from the tuft centre.
  const a = rand.x.mul(Math.PI * 2);
  const facing = normalize(
    mix(vec2(cos(a), sin(a)), vec2(cos(clump.x), sin(clump.x)), g.clumpStrength * 0.65).add(1e-4),
  );
  const height = float(g.bladeHeight)
    .mul(mix(float(1 - g.heightVariation), float(1 + g.heightVariation), rand.y))
    .mul(mix(float(1), clump.y.add(0.5), g.clumpStrength))
    .mul(grow);

  // Wind: a gust field scrolling downwind, plus per-blade flutter.
  const wuv = rootWorld.xz.sub(wind.mul(time).mul(g.windSpeed)).div(g.gustScale);
  const gust = smoothstep(
    0.25,
    0.8,
    noise(wuv)
      .mul(0.6)
      .add(noise(wuv.mul(2.31).add(17.3)).mul(0.4)),
  );
  const fl = gust.mul(0.6).add(0.4).mul(g.flutter);
  const flutA = sin(time.mul(r0.mul(2.2).add(2.6)).add(r1.mul(Math.PI * 2))).mul(fl);
  const flutB = sin(time.mul(r1.mul(2).add(3.3)).add(r0.mul(Math.PI * 2))).mul(fl);
  const pushed = field.push(rootWorld);
  const press = pushed.z;
  const tipRaw = facing
    .mul(
      max(
        r1
          .sub(0.5)
          .mul(2 * g.leanVariation)
          .add(g.lean),
        0,
      ),
    )
    .add(wind.mul(gust.mul(0.88).add(0.12).mul(g.windStrength).add(flutA)))
    .add(vec2(wind.y.negate(), wind.x).mul(flutB))
    .add(pushed.xy.mul(g.pushStrength));
  const tip = tipRaw.mul(min(1, float(0.96).div(max(tipRaw.length(), 1e-4))));
  const tipY = sqrt(max(float(1).sub(dot(tip, tip)), 0));
  const h = height.mul(float(1).sub(press.mul(0.3)));

  // Quadratic Bezier: root, a control point straight up, the tip.
  const p1 = vec3(0, g.curve, 0);
  const p2 = vec3(tip.x, tipY, tip.y);
  const it = float(1).sub(t);
  const curve = p1.mul(it.mul(t).mul(2)).add(p2.mul(t.mul(t)));
  const tangent = normalize(p1.mul(it.mul(2)).add(p2.sub(p1).mul(t.mul(2))));
  // The flat of the blade turns toward the way it bends.
  const f2 = normalize(facing.mul(0.6).add(tip).add(1e-4));
  const across = vec3(f2.y.negate(), 0, f2.x);
  const bladeNormal = normalize(cross(across, tangent));
  const width = float(g.bladeWidth * 0.5)
    .mul(mix(float(1), float(g.farWidth), thinT))
    .mul(r1.mul(0.5).add(0.75))
    .mul(float(1).sub(pow(t, g.taper)))
    .mul(sqrt(grow));
  // Edge-on blades turn a little toward the camera.
  const toCam = normalize(cameraPosition.sub(rootWorld));
  const edge = float(1).sub(abs(dot(bladeNormal, toCam)));
  const thick = edge.mul(edge).mul(g.viewThicken);
  const local = root
    .add(curve.mul(h))
    .add(across.add(bladeNormal.mul(thick)).mul(side.mul(width)))
    .sub(vec3(0, it.mul(g.rootSink), 0));

  // Per-blade values the fragment stage reads.
  const ground = vec3(
    clump.z,
    sqrt(max(float(1).sub(clump.z.mul(clump.z)).sub(clump.w.mul(clump.w)), 0)),
    clump.w,
  );
  const vNormal = varying(
    normalize(mix(bladeNormal, ground, mix(float(g.terrainNormalBlend), float(1), thinT))),
  );
  const vT = varying(t);
  const vFar = varying(thinT);
  const vTuft = varying(clump.y.mul(0.65).add(r0.mul(0.35)));
  const patchUv = rootWorld.xz.div(g.patchScale);
  const vPatch = varying(
    smoothstep(
      0.3,
      0.8,
      noise(patchUv.add(91.7))
        .mul(0.65)
        .add(noise(patchUv.mul(2.7).add(5.3)).mul(0.35)),
    ),
  );
  const vGust = varying(gust);

  const material = new MeshStandardNodeMaterial({ roughness: 0.75, side: DoubleSide });
  material.name = "GrassBlades";
  material.positionNode = local;
  // The blade's normal, turned to face the viewer: a thin blade is lit on the side you see.
  const view = cameraPosition.sub(positionWorld);
  material.normalNode = transformNormalToView(
    vNormal.mul(dot(vNormal, view).sign().add(0.5).sign()),
  );
  // Far blades converge on one mid colour with little root shade, so the thinned field reads as a surface.
  const tc = mix(vT.mul(vT.mul(0.65).add(0.35)), max(vT, 0.5), vFar.mul(0.8));
  const albedo = mix(rgb(g.baseColor), rgb(g.tipColor), tc);
  const dried = mix(albedo, rgb(g.dryColor), vPatch.mul(g.dryAmount).mul(tc.mul(0.65).add(0.35)));
  const occlusion = mix(
    float(1 - g.ambientOcclusion).add(vFar.mul(0.75 * g.ambientOcclusion)),
    float(1),
    vT,
  );
  material.colorNode = vec4(
    dried
      .mul(vTuft.sub(0.5).mul(g.colorVariation).add(1))
      .mul(vGust.sub(0.4).mul(g.gustHighlight).mul(vT).add(1)),
    1,
  );
  material.aoNode = occlusion;
  // Sun on the far side of the blade: light comes through, warmer and more saturated.
  const sun = vec3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z);
  const back = max(dot(vNormal, sun).negate(), 0);
  const through = pow(max(dot(normalize(view), sun.negate()), 0), 5);
  const sunColor = vec3(SUN_COLOR.r, SUN_COLOR.g, SUN_COLOR.b);
  material.emissiveNode = dried
    .mul(vec3(1.05, 1.2, 0.5))
    .mul(sunColor)
    .mul(back.mul(0.45).add(through.mul(back.mul(0.65).add(0.35)).mul(1.1)))
    .mul(vT.mul(0.7).add(0.3))
    .mul(g.translucency);
  return material;
}

/** A blade's standing height at `(x, z)` as a share of its rest height: the CPU mirror of the bend under a pusher. */
export function grassStandAt(press: number): number {
  const lean = GRASS.lean + press * GRASS.pushStrength;
  const reach = Math.min(lean, 0.96);
  return (1 - 0.3 * press) * Math.sqrt(1 - reach * reach);
}
