import {
  DataTexture,
  DoubleSide,
  type Material,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  type Texture,
  TextureLoader,
  Vector4,
} from "three";
import { uniforms } from "../../vendor/stylized-biome-kit/core.js";

/**
 * Toybox materials: realistic PBR surfaces on vertex-coloured toy shapes. Rock, soil, wood and metal
 * take a world-space triplanar detail and normal map (scans/toybox_*), so pieces need no UVs and
 * stacked modules share one continuous texture. Grass and leaves sway in the wind and bend away
 * from up to four pushers (a player, a ball, a bounce); glows pulse and water flows on the kit clock.
 */

const neutral = (r: number, g: number, b: number) => {
  const t = new DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
};
const scans: Record<string, { detail: { value: Texture }; normal: { value: Texture } }> = {};
for (const id of ["rock", "soil", "planks", "metal"])
  scans[id] = {
    detail: { value: neutral(128, 128, 128) },
    normal: { value: neutral(128, 128, 255) },
  };

/** Points the triplanar maps at the vendored scans; browser only (no-op without a DOM). */
export function loadToyboxScans(url: (file: string) => string): void {
  if (typeof document === "undefined") return;
  const loader = new TextureLoader();
  for (const [id, slot] of Object.entries(scans))
    for (const kind of ["detail", "normal"] as const)
      loader.load(url(`toybox_${id}-${kind}.webp`), (texture) => {
        texture.wrapS = texture.wrapT = RepeatWrapping;
        texture.anisotropy = 8;
        slot[kind].value = texture;
      });
}

/** Up to four spheres (xyz centre, w radius) that push grass and leaves aside; w = 0 is off. */
export const toyboxPushers = Array.from({ length: 4 }, () => new Vector4(0, -1e4, 0, 0));

/** Set pusher `index` (0 to 3) to a sphere at x, y, z of `radius` metres; radius 0 turns it off. */
export function toyboxPush(index: number, x: number, y: number, z: number, radius: number): void {
  const p = toyboxPushers[index];
  if (!p) throw new Error(`Toybox pusher index ${index} is outside 0..3`);
  p.set(x, y, z, radius);
}

const WORLD = `varying vec3 vToyPos;
varying vec3 vToyNormal;`;

function triplanar(
  material: MeshStandardMaterial,
  id: string,
  scale: number,
  amount: number,
  bump: number,
) {
  const slot = scans[id];
  if (!slot) throw new Error(`No toybox scan "${id}"`);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.tToyDetail = slot.detail;
    shader.uniforms.tToyNormal = slot.normal;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${WORLD}`)
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vToyPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vToyNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
${WORLD}
uniform sampler2D tToyDetail;
uniform sampler2D tToyNormal;
vec3 toyWeights() { vec3 w = pow(abs(vToyNormal), vec3(4.0)); return w / (w.x + w.y + w.z); }`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
{
  vec3 w = toyWeights();
  vec3 p = vToyPos * ${scale.toFixed(3)};
  float d = texture2D(tToyDetail, p.zy).r * w.x + texture2D(tToyDetail, p.xz).r * w.y + texture2D(tToyDetail, p.xy).r * w.z;
  diffuseColor.rgb *= mix(1.0, 2.0 * d, ${amount.toFixed(2)});
}`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
{
  vec3 w = toyWeights();
  vec3 p = vToyPos * ${scale.toFixed(3)};
  vec3 n = normalize(vToyNormal);
  vec2 tx = (texture2D(tToyNormal, p.zy).xy * 2.0 - 1.0) * ${bump.toFixed(2)};
  vec2 ty = (texture2D(tToyNormal, p.xz).xy * 2.0 - 1.0) * ${bump.toFixed(2)};
  vec2 tz = (texture2D(tToyNormal, p.xy).xy * 2.0 - 1.0) * ${bump.toFixed(2)};
  vec3 world = normalize(vec3(tx + n.zy, n.x).zyx * w.x + vec3(ty + n.xz, n.y).xzy * w.y + vec3(tz + n.xy, n.z) * w.z);
  normal = normalize((viewMatrix * vec4(world, 0.0)).xyz);
}`,
      );
  };
  material.customProgramCacheKey = () => `toy-${id}-${scale}-${amount}-${bump}`;
  return material;
}

/** Wind sway plus pushers, weighted by the `sway` attribute (0 rooted, 1 free). */
function bend(material: MeshStandardMaterial, gust: number, key: string) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uToyTime = uniforms.uTime;
    shader.uniforms.uToyPush = { value: toyboxPushers };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uToyTime;\nuniform vec4 uToyPush[4];\nattribute float sway;",
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
{
  vec3 world = (modelMatrix * vec4(transformed, 1.0)).xyz;
  float s = sway * sway;
  float g = sin(uToyTime * 1.7 + world.x * 0.7 + world.z * 0.5) * 0.6 + sin(uToyTime * 3.3 + world.z * 1.9) * 0.3;
  vec3 offset = vec3(g, 0.0, 0.7 * cos(uToyTime * 2.1 + world.x * 1.3)) * ${gust.toFixed(3)} * s;
  for (int i = 0; i < 4; i++) {
    vec3 away = world - uToyPush[i].xyz;
    float d = length(away.xz);
    float r = uToyPush[i].w;
    float k = r > 0.0 ? clamp(1.0 - d / r, 0.0, 1.0) * clamp(1.0 - abs(away.y) / (r + 0.5), 0.0, 1.0) : 0.0;
    vec2 dir = d > 1e-4 ? away.xz / d : vec2(0.0);
    offset.xz += dir * k * s * r * 0.55;
    offset.y -= k * s * r * 0.3;
  }
  transformed += (inverse(mat3(modelMatrix)) * offset);
}`,
      );
  };
  material.customProgramCacheKey = () => key;
  return material;
}

// Glows emit above white (up to 2.3 times their colour), so a bloom pass picks them up; the
// renderer's tone mapping brings them back into range.
const glow = new MeshBasicMaterial({ name: "Toybox glow", vertexColors: true });
// `pulse` is (depth, phase, speed): 0 depth holds steady, 1 breathes fully.
glow.onBeforeCompile = (shader) => {
  shader.uniforms.uToyTime = uniforms.uTime;
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      "#include <common>\nuniform float uToyTime;\nattribute vec3 pulse;\nvarying float vPulse;",
    )
    .replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\nvPulse = 1.0 - pulse.x * (0.5 - 0.5 * sin(uToyTime * pulse.z + pulse.y));",
    );
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nvarying float vPulse;")
    .replace(
      "#include <color_fragment>",
      "#include <color_fragment>\ndiffuseColor.rgb *= 0.6 + 1.7 * vPulse;",
    );
};

const water = new MeshPhysicalMaterial({
  name: "Toybox water",
  vertexColors: true,
  roughness: 0.04,
  metalness: 0,
  clearcoat: 1,
  transparent: true,
  opacity: 0.86,
  // no depth: a shore foam strip drawn first would hide the sea under its clear parts
  depthWrite: false,
});
// `flow` > 0 scrolls foam streaks down (a falling sheet); 0 rocks a gentle wave normal (a pool or sea).
water.onBeforeCompile = (shader) => {
  shader.uniforms.uToyTime = uniforms.uTime;
  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>\n${WORLD}\nattribute float flow;\nvarying float vFlow;`,
    )
    .replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\nvToyPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvToyNormal = normalize(mat3(modelMatrix) * objectNormal);\nvFlow = flow;",
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>\n${WORLD}\nuniform float uToyTime;\nvarying float vFlow;`,
    )
    .replace(
      "#include <color_fragment>",
      `#include <color_fragment>
if (vFlow > 0.0) {
  // long strands of white water that slide down, broken by faster ripples
  float x = vToyPos.x + vToyPos.z * 0.6;
  float strand = pow(0.5 + 0.5 * sin(x * 29.0 + sin(x * 8.0) * 2.5 + sin(vToyPos.y * 1.4 + uToyTime * vFlow * 1.6) * 0.7), 2.0);
  float ripple = 0.5 + 0.5 * sin(vToyPos.y * 9.0 + uToyTime * vFlow * 7.0 + sin(x * 17.0) * 3.0);
  float gust = 0.5 + 0.5 * sin(vToyPos.y * 2.2 + uToyTime * vFlow * 3.0 + x * 4.0);
  float foam = clamp(strand * (0.45 + 0.55 * ripple) + 0.35 * gust * strand, 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb * 0.85, vec3(1.0), foam * 0.85);
  diffuseColor.a = mix(diffuseColor.a, 1.0, foam);
} else if (vFlow < 0.0) {
  // shore foam: a white lap line at the shore and bands that roll in, broken up along the coast
  float d = -vFlow;
  float coast = sin(vToyPos.x * 1.3 + vToyPos.z * 1.1) * 1.5;
  float roll = 0.5 + 0.5 * sin(d * 16.0 - uToyTime * 2.4 + coast);
  float lap = 1.0 - smoothstep(0.02 + 0.06 * sin(uToyTime * 1.7 + coast), 0.2, d);
  float lace = 0.55 + 0.45 * sin(vToyPos.x * 9.0 - vToyPos.z * 7.0 + uToyTime * 0.9) * sin(vToyPos.z * 8.0 + uToyTime * 0.6);
  float foam = clamp(lap + smoothstep(0.6, 0.92, roll) * lace * (1.0 - smoothstep(0.15, 0.85, d)), 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), foam);
  diffuseColor.a = 0.95 * foam * (1.0 - smoothstep(0.6, 1.0, d));
} else {
  // open water: deep and shallow patches drifting, and a web of sunlit caustics that fades with distance
  vec2 q = vToyPos.xz;
  float drift = sin(q.x * 0.31 + q.y * 0.17 + uToyTime * 0.15) * sin(q.y * 0.27 - q.x * 0.13 - uToyTime * 0.12);
  float r1 = sin(q.x * 1.9 + sin(q.y * 1.3 + uToyTime * 1.1) * 1.6 + uToyTime * 1.4);
  float r2 = sin(q.y * 2.3 + sin(q.x * 1.1 - uToyTime * 0.9) * 1.8 - uToyTime * 1.5);
  float web = pow(1.0 - abs(r1 * r2), 16.0) * (0.4 + 0.6 * max(0.0, drift)) * (1.0 - smoothstep(6.0, 22.0, distance(vToyPos, cameraPosition)));
  diffuseColor.rgb *= 0.85 + 0.22 * drift;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 1.0, 0.98), web * 0.1);
}`,
    )
    .replace(
      "#include <normal_fragment_maps>",
      `#include <normal_fragment_maps>
if (vFlow <= 0.0) {
  // rolling swell from three directions plus a fast chop: the sky glints off the slopes
  vec2 q = vToyPos.xz;
  vec2 slope = vec2(0.0);
  for (int i = 0; i < 3; i++) {
    float a = float(i) * 2.1 + 0.4;
    vec2 k = vec2(cos(a), sin(a)) * (0.9 + float(i) * 0.55);
    slope += k * cos(dot(q, k) + uToyTime * (1.2 + float(i) * 0.35)) * 0.07;
  }
  slope += vec2(cos(q.x * 6.1 + q.y * 2.3 + uToyTime * 3.1), cos(q.y * 5.3 - q.x * 1.7 + uToyTime * 2.7)) * 0.035;
  normal = normalize((viewMatrix * vec4(normalize(vec3(-slope.x, 1.0, -slope.y)), 0.0)).xyz);
}`,
    );
};
water.customProgramCacheKey = () => "toy-water";

export const toyboxMaterials = {
  plastic: new MeshPhysicalMaterial({
    name: "Toybox plastic",
    vertexColors: true,
    roughness: 0.22,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    sheen: 0.3,
  }),
  metal: triplanar(
    new MeshStandardMaterial({
      name: "Toybox metal",
      vertexColors: true,
      metalness: 0.8,
      roughness: 0.38,
    }),
    "metal",
    0.9,
    0.6,
    0.6,
  ),
  gold: new MeshPhysicalMaterial({
    name: "Toybox gold",
    color: 0xffffff,
    vertexColors: true,
    metalness: 1,
    roughness: 0.16,
    clearcoat: 0.6,
    clearcoatRoughness: 0.05,
  }),
  rock: triplanar(
    new MeshStandardMaterial({ name: "Toybox rock", vertexColors: true, roughness: 0.88 }),
    "rock",
    0.45,
    0.85,
    1,
  ),
  // cast stone: the rock scan, finer and fainter, for collars and trim
  stone: triplanar(
    new MeshStandardMaterial({ name: "Toybox stone", vertexColors: true, roughness: 0.62 }),
    "rock",
    1.1,
    0.3,
    0.35,
  ),
  soil: triplanar(
    new MeshStandardMaterial({ name: "Toybox soil", vertexColors: true, roughness: 0.95 }),
    "soil",
    0.9,
    0.9,
    0.8,
  ),
  wood: triplanar(
    new MeshStandardMaterial({ name: "Toybox wood", vertexColors: true, roughness: 0.7 }),
    "planks",
    0.5,
    0.8,
    0.7,
  ),
  grass: bend(
    new MeshStandardMaterial({
      name: "Toybox grass",
      vertexColors: true,
      roughness: 0.78,
      side: DoubleSide,
    }),
    0.05,
    "toy-grass",
  ),
  leaf: bend(
    new MeshStandardMaterial({
      name: "Toybox leaves",
      vertexColors: true,
      roughness: 0.62,
      side: DoubleSide,
    }),
    0.12,
    "toy-leaf",
  ),
  glow,
  glass: new MeshPhysicalMaterial({
    name: "Toybox glass",
    vertexColors: true,
    roughness: 0.03,
    clearcoat: 1,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
  }),
  water,
} satisfies Record<string, Material>;

export type Finish = keyof typeof toyboxMaterials;
