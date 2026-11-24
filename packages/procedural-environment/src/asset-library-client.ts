// The procedural source's browser half for the shared Asset Library (PRD-915): Outcrop's rock
// material over the maps a bake wrote, the `_WIND` sway, the stylized kits built in the page, their
// lighting and backdrops, and the Toybox post stack. Everything else is the shell's.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import type {
  IAssetBake,
  IAssetElement,
  IAssetLibraryClient,
  IAssetLoaded,
  IAssetViewContext,
} from "../../create-threenative/src/asset-library/types.js";
import Outcrop from "../vendor/outcrop.js";
import {
  createStylizedAsset,
  sky as makeStylizedSky,
  stylizedMaterials,
  stylizedUniforms,
  toyboxPush,
} from "./stylized.js";

type StylizedPreview = ReturnType<typeof createStylizedAsset>;
interface IRockBake extends IAssetBake {
  readonly rock?: { readonly tile: number };
  readonly rockMaps?: { readonly detail: string; readonly normal: string };
}

const sharedMaterials = new Set<unknown>(Object.values(stylizedMaterials));
let stylizedSky: ReturnType<typeof makeStylizedSky> | undefined;
let preview: StylizedPreview | undefined;
const fog = (ctx: IAssetViewContext) => ctx.scene.fog as THREE.Fog;
const skyOf = (ctx: IAssetViewContext) => {
  if (!stylizedSky) {
    stylizedSky = makeStylizedSky();
    stylizedSky.visible = false;
    ctx.scene.add(stylizedSky);
  }
  return stylizedSky;
};

// ── wind: a GLB that carries a _WIND vec4 (x trunk, y branch, z flutter, w phase) sways ──
const wind = { uTime: { value: 0 }, uWind: { value: new THREE.Vector3(0.8, 0.6, 1) } };
function addWind(material: THREE.Material): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, wind);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute vec4 _wind;
uniform float uTime;
uniform vec3 uWind;
vec3 sway(vec3 p, vec3 n) {
  vec3 o = modelMatrix[3].xyz;
  vec3 wd = normalize(vec3(uWind.x, 0.0, uWind.y));
  float t = uTime, ph = o.x * 0.071 + o.z * 0.053;
  float gust = 0.55 + 0.45 * sin(t * 0.43) * sin(t * 0.17 + ph);
  float bp = _wind.w * 6.2832 + ph;
  vec3 d = wd * ((0.45 + sin(t * 0.9 + ph) * 0.6) * _wind.x * gust);
  d += (wd * (0.3 + sin(t * 1.9 + bp)) * 0.6 + vec3(0.0, sin(t * 2.7 + bp * 1.3) * 0.45, 0.0)) * (_wind.y * gust);
  float fp = dot(p, vec3(3.1, 2.3, 2.7)) + bp;
  d += (n * sin(t * 9.0 + fp * 3.0) + wd * (0.6 + sin(t * 2.4 + fp)) * 1.6) * (_wind.z * (0.4 + 0.6 * gust));
  return p + d * uWind.z;
}`,
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\ntransformed = sway(transformed, objectNormal);",
      );
  };
  material.customProgramCacheKey = () => "asset-library-wind";
}

// ── a bake with rock maps: Outcrop's own triplanar material over the maps the bake wrote ──
const bitmaps = new THREE.ImageBitmapLoader().setOptions({
  imageOrientation: "flipY",
  premultiplyAlpha: "none",
});
const maps = new Map<string, Promise<THREE.Texture>>();
function mapOf(url: string): Promise<THREE.Texture> {
  if (!maps.has(url))
    maps.set(
      url,
      bitmaps.loadAsync(url).then((image) => {
        const texture = new THREE.Texture(image as ImageBitmap);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.flipY = false;
        texture.anisotropy = 8;
        texture.needsUpdate = true;
        return texture;
      }),
    );
  return maps.get(url) as Promise<THREE.Texture>;
}

/** The look of Outcrop's page: `createRockMaterial`, reading the GLB's `_ROCK`, `_COVER` and `_WET`. */
async function rockMaterial(mesh: THREE.Mesh, baked: IRockBake, wire: boolean): Promise<void> {
  if (!baked.rock || !baked.rockMaps) return;
  const [detail, normal] = await Promise.all([
    mapOf(baked.rockMaps.detail),
    mapOf(baked.rockMaps.normal),
  ]);
  const geometry = mesh.geometry;
  for (const [from, to] of [
    ["_rock", "aRock"],
    ["_cover", "aCover"],
    ["_wet", "aWet"],
  ] as const) {
    const attribute = geometry.getAttribute(from);
    if (attribute) geometry.setAttribute(to, attribute);
  }
  (mesh.material as THREE.Material).dispose();
  mesh.material = Outcrop.createRockMaterial({
    textures: { detail, normal },
    tile: baked.rock.tile,
  });
  (mesh.material as THREE.MeshStandardMaterial).wireframe = wire;
}

/** The light of an Outcrop biome's `environment` row: sky, ground, sun colour and angle. */
function biomeLight(ctx: IAssetViewContext, outcropBiome?: string): void {
  // A rock story takes the page's own light (hemisphere 1.1, sun 3.2, exposure 1.05, no environment
  // map): the room environment on top of it washed every rock to near white beside the page.
  const rock = outcropBiome !== undefined;
  const { renderer, scene, sun, hemi, ground, grid } = ctx;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  sun.shadow.normalBias = 0;
  ctx.sunShadow(2048, 1);
  scene.environmentIntensity = 1;
  ctx.camera.fov = 40;
  ground.visible = true;
  grid.visible = ctx.toggled("grid");
  skyOf(ctx).visible = false;
  scene.environment = rock ? null : ctx.roomEnvironment;
  hemi.intensity = rock ? 1.1 : 0.35;
  sun.intensity = rock ? 3.2 : 3;
  renderer.toneMappingExposure = rock ? 1.05 : 1.1;
  const env = (Outcrop.BIOMES[outcropBiome ?? ""] ?? Outcrop.BIOMES.hills)?.environment as
    | Record<string, string | number>
    | undefined;
  if (!env) return;
  ctx.backgroundColor.set(env.skyHorizon as string);
  fog(ctx).color.set(env.skyHorizon as string);
  hemi.color.set(env.skyTop as string).lerp(new THREE.Color("#ffffff"), 0.55);
  hemi.groundColor.set(env.ground as string).multiplyScalar(0.7);
  sun.color.set(env.sun as string);
  (ground.material as THREE.MeshStandardMaterial).color.set(env.ground as string);
  ctx.sky.elevation = env.elevation as number;
  ctx.sky.azimuth = env.azimuth as number;
}

/**
 * The Toybox frame: ambient occlusion darkens joints and contact lines, and bloom lifts the
 * glows and sunlit highlights, over the same scene render. The other kits render directly.
 */
let toyboxPost: EffectComposer | undefined;
function toyboxComposer(ctx: IAssetViewContext): EffectComposer {
  if (toyboxPost) return toyboxPost;
  const composer = new EffectComposer(ctx.renderer);
  composer.renderTarget1.samples = composer.renderTarget2.samples = 4;
  const size = ctx.renderer.getDrawingBufferSize(new THREE.Vector2());
  composer.addPass(new RenderPass(ctx.scene, ctx.camera));
  const occlusion = new GTAOPass(ctx.scene, ctx.camera, size.x, size.y);
  occlusion.updateGtaoMaterial({
    radius: 0.55,
    distanceExponent: 1.3,
    thickness: 1.2,
    scale: 1.15,
    samples: 16,
    screenSpaceRadius: false,
  });
  occlusion.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2 });
  occlusion.blendIntensity = 0.85;
  composer.addPass(occlusion);
  composer.addPass(new UnrealBloomPass(size, 0.3, 0.45, 1.25));
  composer.addPass(new OutputPass());
  toyboxPost = composer;
  return composer;
}

/** Each Toybox backdrop once: its sky panorama, and the environment prefiltered from it. */
const backdrops = new Map<string, { texture: THREE.Texture; env?: THREE.Texture }>();
function useBackdrop(ctx: IAssetViewContext): void {
  const url = ctx.route.kind === "toybox" ? preview?.backdrop : undefined;
  if (!url) return;
  let entry = backdrops.get(url);
  if (!entry) {
    const created: { texture: THREE.Texture; env?: THREE.Texture } = {
      texture: new THREE.TextureLoader().load(url, () => {
        const pmrem = new THREE.PMREMGenerator(ctx.renderer);
        created.env = pmrem.fromEquirectangular(created.texture).texture;
        pmrem.dispose();
        if (preview?.backdrop === url) ctx.scene.environment = created.env;
        ctx.invalidate();
      }),
    };
    created.texture.colorSpace = THREE.SRGBColorSpace;
    created.texture.mapping = THREE.EquirectangularReflectionMapping;
    entry = created;
    backdrops.set(url, entry);
  }
  ctx.scene.background = entry.texture;
  skyOf(ctx).visible = false;
  if (entry.env) ctx.scene.environment = entry.env;
}

/**
 * Fits the sun's shadow frustum to the parts of `model` that cast shadows, so a scene and a single
 * coin both get sharp shadows, and an open sea to the horizon does not blur them.
 */
function fitSunShadow(
  ctx: IAssetViewContext,
  model: THREE.Object3D,
  dir: [number, number, number],
): void {
  const box = new THREE.Box3();
  model.traverse((node) => {
    if (node instanceof THREE.Mesh && node.castShadow) box.expandByObject(node, false);
  });
  if (box.isEmpty()) return;
  const { center, radius } = box.getBoundingSphere(new THREE.Sphere());
  const reach = Math.max(2, radius);
  const { sun } = ctx;
  sun.target.position.copy(center);
  sun.position
    .set(...dir)
    .normalize()
    .multiplyScalar(reach * 3)
    .add(center);
  const shadow = sun.shadow.camera;
  shadow.left = shadow.bottom = -reach;
  shadow.right = shadow.top = reach;
  shadow.near = reach;
  shadow.far = reach * 5;
  shadow.updateProjectionMatrix();
  sun.shadow.normalBias = Math.max(0.012, reach * 0.0012);
}

function stylizedLighting(ctx: IAssetViewContext, shown?: StylizedPreview): void {
  const env = shown?.env;
  const { renderer, scene, sun, hemi } = ctx;
  renderer.toneMapping = THREE.NeutralToneMapping;
  // Toybox surfaces are PBR (clearcoat plastic, metal): they take the room environment until the
  // story's own sky panorama loads (useBackdrop), and get a larger, softer shadow map.
  const toybox = ctx.route.kind === "toybox";
  const [intensity, exposure, map, blur] = toybox ? [0.8, 0.92, 4096, 3] : [1, 1, 2048, 1];
  scene.environment = toybox ? ctx.roomEnvironment : null;
  scene.environmentIntensity = intensity;
  renderer.toneMappingExposure = exposure;
  ctx.sunShadow(map, blur);
  hemi.color.set(env?.hemi.sky ?? 0xd6e4ff);
  hemi.groundColor.set(env?.hemi.ground ?? 0x7f93c4);
  hemi.intensity = env?.hemi.intensity ?? 1.9;
  sun.color.set(env?.sun.color ?? 0xfff3dc);
  sun.intensity = env?.sun.intensity ?? 3;
  ctx.sky.elevation = 49;
  ctx.sky.azimuth = -54;
  ctx.backgroundColor.set(env?.horizon ?? 0xb7c6e6);
  fog(ctx).color.set(env?.horizon ?? 0xb7c6e6);
  if (shown?.view) ctx.ground.visible = ctx.grid.visible = false;
  if (!env) return;
  const sky = skyOf(ctx);
  sky.visible = true;
  sky.material.uniforms.uTop?.value.set(env.skyTop);
  sky.material.uniforms.uHorizon?.value.set(env.horizon);
  fog(ctx).near = env.fog[1];
  fog(ctx).far = env.fog[2];
  sun.target.position.set(0, 0, 0);
  sun.position
    .set(...env.sun.dir)
    .normalize()
    .multiplyScalar(env.shadow * 3);
  const shadow = sun.shadow.camera;
  shadow.left = shadow.bottom = -env.shadow;
  shadow.right = shadow.top = env.shadow;
  shadow.near = 1;
  shadow.far = env.shadow * 6;
  shadow.updateProjectionMatrix();
  sun.shadow.normalBias = Math.max(0.02, env.shadow * 0.0012);
  if (toybox && shown) fitSunShadow(ctx, shown.group, env.sun.dir);
  useBackdrop(ctx);
}

const runtime = (ctx: IAssetViewContext) => ctx.catalog.kinds?.[ctx.route.kind]?.runtime === true;

function create(element: IAssetElement, ctx: IAssetViewContext): IAssetLoaded {
  const start = performance.now();
  const variant = ctx.touched.get("variant");
  const options = {
    ...(variant === undefined ? {} : { variant: Number(variant) - 1 }),
    ...(ctx.state.seed === undefined ? {} : { seed: ctx.state.seed }),
  };
  const built = createStylizedAsset(element.id, options);
  preview = built;
  const args = [JSON.stringify(element.id)];
  if (Object.keys(options).length) args.push(JSON.stringify(options));
  const imports = built.update ? "createStylizedAsset, stylizedUniforms" : "createStylizedAsset";
  const call = `import { ${imports} } from "@threenative/procedural-environment/stylized";

const { group${built.update ? ", update" : ""} } = createStylizedAsset(${args.join(", ")});${built.update ? "\n\n// In your animation loop, using elapsed time in seconds:\nstylizedUniforms.uTime.value = elapsedSeconds;\nupdate?.(elapsedSeconds);" : ""}`;
  const bounds = new THREE.Box3().setFromObject(built.group);
  let triangles = 0;
  built.group.traverse((node) => {
    const mesh = node as THREE.Mesh & THREE.InstancedMesh;
    if (!mesh.isMesh) return;
    triangles +=
      ((mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0) / 3) *
      (mesh.isInstancedMesh ? mesh.count : 1);
  });
  if (triangles === 0) throw new Error(`No triangles in ${element.name}`);
  return {
    model: built.group,
    animated: built.animated,
    ...(built.view ? { view: built.view } : {}),
    report: {
      bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
      triangles: Math.round(triangles),
      ms: Math.round(performance.now() - start),
      call,
    },
  };
}

const client: IAssetLibraryClient = {
  create,
  async dress(model, baked, ctx) {
    preview = undefined;
    const meshes: THREE.Mesh[] = [];
    let windy = false;
    model.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshes.push(mesh);
      const swaying = Boolean(mesh.geometry.getAttribute("_wind"));
      if (swaying) for (const material of [mesh.material].flat()) addWind(material);
      windy ||= swaying;
    });
    await Promise.all(meshes.map((mesh) => rockMaterial(mesh, baked as IRockBake, ctx.state.wire)));
    return windy;
  },
  light(element, ctx, loaded) {
    if (runtime(ctx)) {
      stylizedLighting(ctx, loaded ? preview : undefined);
      return;
    }
    preview = undefined;
    const kind = element?.kind ?? ctx.route.kind;
    const biome =
      ctx.touched.get("biome") ??
      ctx.catalog.controls?.[kind]?.find((c) => c.key === "biome")?.default;
    biomeLight(
      ctx,
      biome === undefined
        ? undefined
        : (ctx.catalog.biomes?.find((b) => b.id === biome)?.rock ?? String(biome)),
    );
  },
  background(ctx) {
    if (runtime(ctx)) useBackdrop(ctx);
    else if (stylizedSky) stylizedSky.visible = false;
  },
  tick(dt, ctx) {
    if (!runtime(ctx)) {
      wind.uTime.value += dt;
      return;
    }
    stylizedUniforms.uTime.value += dt;
    const t = stylizedUniforms.uTime.value;
    if (ctx.route.kind === "toybox")
      ctx.content.traverse((node) => node.userData.animate?.(node, t));
    else preview?.update?.(t);
  },
  render(dt, ctx) {
    if (ctx.route.kind !== "toybox") return false;
    toyboxComposer(ctx).render(dt);
    return true;
  },
  resize(width, height) {
    toyboxPost?.setSize(width, height);
  },
  pointer(hit, ctx) {
    // Toybox grass and leaves part around the pointer, as they would round a player (toyboxPush).
    if (ctx.route.kind !== "toybox") return;
    if (hit) toyboxPush(0, hit.x, hit.y, hit.z, 0.7);
    else toyboxPush(0, 0, -1e4, 0, 0);
  },
  shared: (material) => sharedMaterials.has(material),
};

export default client;
