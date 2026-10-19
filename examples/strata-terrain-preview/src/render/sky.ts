// Game-owned sun, shadows and daylight; atmosphere.ts owns the LUT sky and surface air.
import { Atmosphere, Daylight, type ICtx, VirtualShadowNode } from "@threenative/core";
import { Color, DirectionalLight, Mesh, type Object3D, SphereGeometry, Vector3 } from "three";
import { denoise } from "three/addons/tsl/display/DenoiseNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import {
  abs,
  cameraPosition,
  dot,
  float,
  getViewPosition,
  max,
  mix,
  mrt,
  normalView,
  normalize,
  output,
  pass,
  positionWorld,
  saturation,
  screenSize,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { aerialPerspective, cloudDome, createAtmosphere, skyColour } from "./atmosphere.js";
import { BIOMES, type IBiome } from "./biomes.js";
import { setCanopySun } from "./propMaterials.js";

const omitted = new Set(
  new URLSearchParams(globalThis.location?.search ?? "").get("off")?.split(",") ?? [],
);

/**
 * The sun, in the same units the `L` key swings it: a position, not a direction, so the toggle and
 * the playtest's `sunX` read the same number they always have.
 */
export const SUN = {
  colour: new Color(0xffeed0),
  /** Towards the sun. A 35 degree afternoon sun: high enough to light the meadow, low enough that
   *  every spruce throws a shadow long enough to see the ground between the trees. */
  direction: new Vector3(-180, 150, -120),
  /** Irradiance in three's physical units — the same number a Blender sun strength carries. */
  intensity: 4.6,
} as const;

/**
 * The physical sky, the fill and the haze.
 *
 * The `sky` numbers are Preetham's, as three's `SkyMesh` takes them: low turbidity for clean air,
 * rayleigh near 2.4 for a deep blue zenith, and a small mie coefficient so the sun's halo stays a
 * halo. `haze` is the horizon colour the sky itself fades to and the density the ground fades to it
 * at: a 300 metre ridge is a third hazed, which is the aerial perspective the alpine reference is
 * built on, and the sea's far edge is gone before it reaches its own boundary.
 */
/**
 * The sun's direction as a shader node, for anything in the scene that has to agree with the light:
 * the water's glint and its caustics read this rather than normalising `SUN.direction` a second time,
 * so `L` moves them with the rig.
 */
export const SUN_VECTOR = uniform(SUN.direction.clone().normalize()) as unknown as Node<"vec3">;

const RIG = {
  sky: { turbidity: 2.0, rayleigh: 3.0, mieCoefficient: 0.003, mieDirectionalG: 0.82 },
  /** Blue sky fill preserves detail in shade without cancelling the directional sun. */
  fill: { sky: new Color(0xa8c8e8), ground: new Color(0x464937), intensity: 0.62 },
  /** Near terrain stays clear; kilometre-scale ridges fade gradually into blue air. */
  haze: { color: new Color(0x8ca8ba), density: 0.0008 },
  /** Linear exposure for the AgX curve, as 2^EV. AgX already rolls its highlights off, so this sits
   *  below one: a temperate noon here is a bright sky and green that still has detail in it. */
  exposure: 2 ** -0.38,
  /** Edge of the sky box in metres. The camera's far plane is 5000, and the box's corners are half a
   *  diagonal inside that, so this is as large as the world can carry. */
  skySize: 5000,
  /** Two cached levels retain four bindings; alpine/desert refine the far level to 15.6 cm. */
  shadowExtents: [24, 320],
} as const;

/** The rig, the sun that can be swung, and the one call that moves both. */
export interface IOutdoorSky {
  /** Installed follow, fill, shadows and tone mapping. Add it to the scene. */
  readonly daylight: Daylight;
  /** Add through ctx.add so its LUT kernels warm before the first world draw. */
  readonly atmosphere: Atmosphere;
  /** This game's sun, with the rig's clipmap shadows on it. Add it to the scene. */
  readonly sun: DirectionalLight;
  /** The sun's x in the sun's own metres: what the `L` key swings and the playtest reads. */
  readonly sunX: number;
  setSunX(x: number): void;
}

/** Shared daylight plumbing with game-owned LUT sky, clouds and surface air. */
export function createOutdoorSky(camera: Object3D, biome?: IBiome): IOutdoorSky {
  const direction = biome ? new Vector3(...biome.sun.direction) : SUN.direction;
  const sunColor = biome ? new Color(biome.sun.color) : SUN.colour;
  const rig = biome
    ? {
        ...RIG,
        sky: biome.sky,
        fill: {
          sky: new Color(biome.fill.sky),
          ground: new Color(biome.fill.ground),
          intensity: biome.fill.intensity,
        },
        haze: { color: new Color(biome.haze.color), density: biome.haze.density },
        exposure: biome.exposure,
      }
    : RIG;
  const sun = new DirectionalLight(sunColor, biome?.sun.intensity ?? SUN.intensity);
  sun.name = "temperate-sun";
  sun.castShadow = true;
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = biome?.sun.shadowRadius ?? BIOMES.forest.sun.shadowRadius;
  if (omitted.has("sun")) sun.intensity = 0;
  const farShadows = biome?.world === "alpine" || biome?.world === "desert";
  const shadows = new VirtualShadowNode(sun, {
    clipExtents: [...rig.shadowExtents],
    mapSize: farShadows ? 4096 : 2048,
    ...(farShadows ? { refreshStep: [0.2, 0.125] } : {}),
  });
  // Fade the outer cascade before its cached window ends, including its refresh trail.
  const shadowSetup = shadows.setup.bind(shadows);
  shadows.setup = (builder) => {
    const value = shadowSetup(builder);
    if (!value) return value;
    const right = normalize(SUN_VECTOR.cross(vec3(0, 1, 0)));
    const up = normalize(right.cross(SUN_VECTOR));
    const offset = positionWorld.sub(cameraPosition);
    const distance = max(abs(dot(offset, right)), abs(dot(offset, up)));
    const extent = rig.shadowExtents[rig.shadowExtents.length - 1] ?? 320;
    return mix(
      vec4(value as Node<"vec4">),
      vec4(1),
      smoothstep(extent * 0.65, extent * 0.8, distance),
    );
  };
  sun.shadow.shadowNode = shadows;
  // A fixed world-origin target keeps the L-key direction independent of the following sky.
  sun.position.copy(direction);

  const daylight = new Daylight({
    exposure: rig.exposure,
    fill: rig.fill,
    follow: camera,
    haze: rig.haze,
    shadowExtents: [...rig.shadowExtents],
    sky: rig.sky,
    skySize: RIG.skySize,
    sunColor,
    sunDirection: direction,
    sunIntensity: 0,
    toneMapping: (biome ?? BIOMES.forest).toneMapping,
  });
  const atmosphere = createAtmosphere(biome ?? BIOMES.forest);
  atmosphere.setSunDirection(direction);
  daylight.sky.cloudCoverage.value = 0;
  daylight.sky.material.colorNode = skyColour(atmosphere, SUN_VECTOR, biome ?? BIOMES.forest);
  daylight.sun.visible = false; // engine-override: omit the sun disc while retaining directional lighting
  daylight.add(sun.target);

  const sunDirection = SUN_VECTOR;
  // The deck rides inside the rig's own sky box, so it needs no follow of its own: the box is put
  // back on the eye every frame and the dome is its child. 64 by 32 is enough, because the pattern
  // is per fragment and nothing here is shaded from the dome's own normals.
  const deck = new Mesh(
    new SphereGeometry(1, 64, 32),
    cloudDome(atmosphere, sunDirection, biome ?? BIOMES.forest),
  );
  deck.name = "cumulus-deck";
  deck.scale.setScalar(0.9);
  deck.frustumCulled = false;
  daylight.sky.add(deck);

  function setSunX(x: number): void {
    sun.position.set(x, direction.y, direction.z);
    // The sky's sun disc, its brightest quadrant and the cloud deck's lighting all follow the light.
    daylight.sky.sunPosition.value.copy(sun.position).normalize();
    atmosphere.setSunDirection(sun.position);
    (sunDirection as unknown as { value: Vector3 }).value.copy(sun.position).normalize();
    // And so does the light coming through the needles, which reads the same vector.
    setCanopySun(sun.position);
  }
  setSunX(direction.x);
  return {
    atmosphere,
    daylight,
    get sunX() {
      return sun.position.x;
    },
    setSunX,
    sun,
  };
}

/** Contact-scale occlusion through the installed chain; daylight still owns exposure and tone. */
export function installOutdoorOcclusion(
  ctx: Pick<ICtx, "renderer" | "scene" | "camera">,
  biome?: IBiome,
): () => void {
  const { renderer, scene, camera } = ctx;
  if (renderer.kind !== "webgpu" || renderer.createRenderChain === undefined) return () => {};
  const look = biome ?? BIOMES.forest;
  const previousFog = scene.fogNode;
  const previousClassicFog = scene.fog;
  const atmosphere = scene.getObjectByName("world-atmosphere");
  if (!(atmosphere instanceof Atmosphere))
    throw new Error("Outdoor sky must be added before its air.");
  // Disable the rig's legacy material fog; air is composited once after the lit scene.
  scene.fogNode = null;
  scene.fog = null;
  // AO darkens RGB only; multiplying alpha leaked the backdrop through dark alpine crags.
  // TRAA is the forest's anti-aliasing: sub-pixel blades and needles dither under coverage alone.
  // It copies this pass's depth, which a multisampled target refuses. Other worlds keep MSAA until
  // their own captures are judged.
  const temporal = look.world === "forest" && !omitted.has("traa");
  const world = pass(scene, camera, temporal ? { samples: 0 } : undefined);
  world.setMRT(mrt({ output, normal: normalView }));
  const daylight = scene.children.find((child) => child instanceof Daylight);
  const depth = world.getTextureNode("depth");
  // An uncovered MSAA depth sample must not leave a one-pixel terrain edge against the sky.
  // Single-sampled under TRAA there is no uncovered sample, and the dilation would paint a hard
  // one-pixel seam of surface air along every silhouette against the sky.
  const airDepth = temporal
    ? depth.r
    : depth.r.min(depth.sample(screenUV.add(vec2(0, screenSize.y.reciprocal()))).r);
  const cameraWorld = uniform(camera.matrixWorld);
  const surface = cameraWorld.mul(
    vec4(getViewPosition(screenUV, airDepth, uniform(camera.projectionMatrixInverse)), 1),
  ).xyz;
  const air = aerialPerspective(
    atmosphere,
    SUN_VECTOR,
    look,
    !omitted.has("haze"),
    surface,
    cameraWorld.mul(vec4(0, 0, 0, 1)).xyz,
    world.getTextureNode("output"),
  );
  const airOutput = mix(
    air,
    world.getTextureNode("output"),
    airDepth.greaterThanEqual(1).toFloat(),
  );
  const normals = world.getTextureNode("normal");
  const contact = ao(depth, normals, camera);
  contact.radius.value = 0.85;
  contact.scale.value = 0.8;
  contact.samples.value = 8;
  contact.resolutionScale = 0.5;
  const filtered = denoise(contact.getTextureNode(), depth, normals, camera);
  const occlusion = filtered as unknown as Node<"vec4">;
  const chain = renderer.createRenderChain({
    input: airOutput,
    worldPass: world,
    request: {
      stages: ["ambientOcclusion", ...(temporal ? ["traa"] : []), "grade"].filter(
        (name) => !omitted.has(name),
      ),
      tier: "high",
      // Blades and needles are thinner than a pixel; coverage alone dithers them into speckle.
      ...(temporal ? { velocity: { pass: world } } : {}),
    },
    targetFps: 60,
    stages: [
      {
        name: "ambientOcclusion",
        minimumTier: "medium",
        build: (input) =>
          (input as Node<"vec4">).mul(
            vec4(
              vec3(
                mix(
                  1,
                  occlusion.r,
                  float(0.72).mul(float(1).sub(smoothstep(40, 180, world.getViewZNode().negate()))),
                ),
              ),
              1,
            ),
          ),
      },
      {
        name: "traa",
        minimumTier: "high",
        build: (input, context) =>
          traa(
            input as Node<"vec4">,
            depth,
            // The chain hands the scene-side velocity node; three's declaration asks for a texture node.
            context.velocityNode as never,
            camera,
          ) as unknown as Node,
      },
      {
        name: "grade",
        after: "ambientOcclusion",
        minimumTier: "low",
        build: (input) =>
          vec4(
            saturation(
              (input as Node<"vec4">).rgb,
              mix(
                look.saturation,
                look.skySaturation,
                smoothstep(400, 1500, world.getViewZNode().negate()),
              ),
            ),
            // Opaque frame: cutout edges keep coverage alpha through the chain, and an alpha
            // canvas composited them over the page background (a blue-grey fringe on every blade).
            1,
          ),
      },
    ],
  });
  return () => {
    if (scene.fogNode === null) scene.fogNode = previousFog;
    if (scene.fog === null) scene.fog = previousClassicFog;
    // The example owns these shadow maps. Removing the lights alone retained their targets.
    const sun = scene.getObjectByName("temperate-sun");
    for (const light of [sun, daylight instanceof Daylight ? daylight.sun : undefined]) {
      if (!(light instanceof DirectionalLight)) continue;
      if (light.shadow.shadowNode instanceof VirtualShadowNode) light.shadow.shadowNode.dispose();
      light.dispose();
    }
    chain.dispose();
    world.dispose();
    contact.dispose();
    filtered.dispose();
  };
}
