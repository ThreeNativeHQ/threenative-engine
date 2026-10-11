/**
 * The version this library reports.
 *
 * It read `0.1.0` while the package published `0.2.0`, and `__tests__/build.spec.ts` asserted the
 * stale literal, so the test held the bug in place rather than catching it. A literal is
 * unavoidable here — core is bundled for browsers and cannot read `package.json` at runtime — so
 * the spec now asserts this equals the manifest instead of asserting a number somebody typed.
 */
export const version = "0.3.4";

/**
 * Play a skinned or sprite animation from game code.
 *
 * A locomotion clip's playback rate is matched to the ground the body actually covers, so feet
 * do not skate or spin — on by default, `strideSync: false` to keep the authored rate, and
 * `player.stride` reports the measurement either way. Name the body a game moves as
 * `strideRoot` when the rig is a child of it. Clips authored **in place** — every ActorX and
 * Unreal export, every Mixamo "in place" clip, every stock animal pack — are matched too: their
 * stride is read off the ground a planted foot sweeps, and `stride.inPlace` says so.
 * @situation play an animation on a character
 * @situation switch a character between idle and attack clips
 * @situation stop a walking character's feet from sliding or spinning
 * @situation match a walk or run cycle to how fast a character is moving
 * @situation match an in-place walk cycle with no root motion to the body's speed
 * @situation find out what speed an animation clip was authored for
 * @constraint name the body a game moves as strideRoot when the animated rig is a child of it
 * @constraint a one-shot clip always plays at its authored rate; the matched rate re-times loops only
 * @constraint the matched rate is held inside 0.15x-3x; a speed outside what the clip's own stride supports is clamped, and `stride.rate` says so
 * @override strideSync controls whether the matched rate is applied while stride is still measured
 * @example const player = new AnimationPlayer({ clips, root: rig, strideRoot: body });
 */
export { AnimationPlayer } from "./animation.js";
export type {
  IAnimationPlayerOptions,
  IAnimationPlayOptions,
  IStrideReport,
} from "./animation.js";
/**
 * Compose game-authored locomotion and masked actions on one Three.js mixer.
 * @situation synchronize walk/run/strafe clips with different durations
 * @situation reload with the upper body while locomotion continues
 * @situation apply an additive recoil clip with an explicit reference pose
 * @situation route root motion through collision-aware character movement
 * @constraint one base phase, one masked override, at most two additive layers and eight actions
 * @constraint root motion requires a separate rig below the body; advance, CharacterBody3D.move, finish with observed accepted motion after physics, then existing IK
 * @constraint root motion excludes velocity-driven stride sync; unsupported parent transforms throw
 * @constraint source clips remain immutable; dispose at scene exit
 * @example const animation = new AnimationComposer({ root: rig, clips, samples: ["walk", "run"] });
 * animation.setWeights([0.5, 0.5]); animation.update(dt);
 */
export { AnimationComposer } from "./animation-composition.js";
export type { IAnimationComposerOptions } from "./animation-composition.js";
export type { IAnimationLayer, IAnimationMask } from "./animation-layers.js";
export type {
  IAnimationMotionDelta,
  IAnimationRootMotionOptions,
} from "./animation-root-motion.js";
/**
 * Select finite, normalized locomotion weights from sorted thresholds or a fixed triangulation.
 * @situation calculate 1D walk/run blend weights from speed
 * @situation calculate 2D locomotion weights from forward and strafe intent
 * @constraint duplicate samples, collinear triangles and invalid/incomplete triangulations throw at initialization
 * @constraint outside 2D queries project to the nearest boundary subedge; output is borrowed scratch
 * @example const blend = new BlendSpace1D([0, 2]); animation.setWeights(blend.sample(speed));
 */
export { BlendSpace1D, BlendSpace2D } from "./animation-blend.js";
/**
 * Shared preparation for an imported rigged character.
 *
 * Instances the rig with a skeleton-safe clone, normalises size with skin-aware measurement,
 * validates requested clips against the file and rig at load time, and sets up AnimationPlayer
 * with honest stride-root accounting.
 * @situation put an animated character in the scene
 * @situation my imported character renders deformed
 * @situation instance an imported rigged character
 * @situation validate animation clips on a character rig at load time
 * @situation prepare a skinned character with safe skeleton cloning and stride sync
 * @constraint use strideRoot to name the body moved by game code when the rig is parented under it
 * @constraint requiredClips fails closed at load time if any requested clip is missing or binds 0 tracks
 * @override strideSync controls whether locomotion playback rate matches ground covered
 * @override size normalises the instance to real-world metres with skin-aware measurement
 * @example import { SkeletalMesh3D } from "@threenative/core";
 * const character = new SkeletalMesh3D({
 *   source: gltf.scene, clips: gltf.animations, requiredClips: ["idle", "walk"],
 *   size: { metres: 1.8, axis: "height" }, strideRoot: body,
 * });
 * body.add(character.root); character.play("idle");
 * function update(dt: number): void { character.update(dt); }
 */
export { SkeletalMesh3D } from "./skeletal-mesh.js";
export type { ISkeletalMesh3DOptions } from "./skeletal-mesh.js";
/**
 * Face a game-owned object toward a perspective or orthographic camera.
 * @situation keep a world-space marker or nameplate facing the camera
 * @situation billboard a tree, label, or effect under a rotated parent
 * @constraint call update from the owning scene; no global scene scan is installed
 * @constraint orthographic cameras use their forward direction, and lockAxis restricts world rotation
 * @example const billboard = new Billboard3D(label, { camera });
 * billboard.update();
 */
export { Billboard3D } from "./billboard.js";
export type { BillboardLockAxis, IBillboard3DOptions } from "./billboard.js";
/**
 * Produce a game-authored camera shake offset for a template-owned camera rig.
 * @situation add a hit, explosion, or landing shake to a camera
 * @situation compose a transient camera offset after camera damping
 * @constraint amplitude, rotationAmplitude, frequency, decay, and curve are required game choices
 * @constraint update returns an offset and never writes to a camera
 * @example const shake = new CameraShake({ amplitude, rotationAmplitude, frequency, decay, curve });
 */
export { CameraShake } from "./camera-shake.js";
export type { CameraShakeCurve, ICameraShakeOffset, ICameraShakeOptions } from "./camera-shake.js";
/**
 * Create the portable asset loader a scene also receives as `ctx.assets`.
 * @situation preload models, textures, or audio before a scene enters
 * @situation load assets from a nonstandard base path or a compiled asset manifest
 * @alias different area props
 * @alias first playable screen external assets
 * @constraint reuse the loader handed to scenes as `ctx.assets` instead of building parallel caches
 * @example const assets = createAssetLoader({ basePath: "/assets" });
 * const rock = await assets.texture("rock.png");
 */
export { createAssetLoader } from "./assets.js";
export { onLaunchFailure } from "./launch-diagnostics.js";
export { resetAudioCueLedger } from "./audio.js";
export type { ILaunchFailure, LaunchFailureKind } from "./launch-diagnostics.js";
export type { IAssetLoader, IAssetLoaderOptions, ITextureOptions } from "./assets.js";
export type {
  IAudioBusOptions,
  IAudioCompressorOptions,
  IAudioPlayOptions,
} from "./audio.js";
/**
 * Route effects through a named audio bus.
 * @situation play a sound effect with a volume bus
 * @situation mute or adjust a category of game audio
 * @situation keep a gunshot audible at 20 metres by tuning positional falloff
 * @situation hold a loud mix below clipping with a compressor on the bus
 * @situation play cannon, wave, and ship sound effects
 * @constraint create buses before playing clips and dispose them with the game
 * @constraint refDistance and rolloffFactor tune positional falloff and apply to playAt only
 * @constraint compressor takes threshold, knee, ratio, attack and release from the game and takes effect on the bus sum
 * @supersedes new Audio(
 * @example const effects = new AudioBus({ camera });
 */
export { AudioBus } from "./audio.js";
/**
 * Manage a camera or screen-facing canvas layer.
 * @situation place a HUD layer above the Three.js scene
 * @situation attach a canvas layer to a camera
 * @example const hud = new CanvasLayer(ctx.viewport);
 */
export { CanvasLayer } from "./canvas-layer.js";
export type {
  IThreeNativeAudioConfig,
  IThreeNativeAudioLoop,
  IThreeNativeAudioOverride,
  IThreeNativeAudioSpectrum,
  IThreeNativeBootSplash,
  IThreeNativeConfig,
  IThreeNativeIconVariants,
  IThreeNativeLodConfig,
  IThreeNativeLodGenerationConfig,
  IThreeNativeLodOverride,
  IThreeNativeLodRuntimeConfig,
  IThreeNativeTexturesConfig,
  ThreeNativeBackgroundMode,
  ThreeNativeLodMinTrianglesScope,
  ThreeNativeLodPreset,
  ThreeNativeOrientation,
  ThreeNativeUiRenderer,
} from "./config.js";
/**
 * Create a deterministic random source for portable gameplay.
 * @situation get a seeded deterministic random number generator — the same mulberry32 a game would hand-roll
 * @situation seed enemy patrol choices
 * @situation reproduce the same procedural level in a playtest
 * @constraint use the returned source instead of Math.random for replayable behavior
 * @supersedes Math.random(
 * @example const random = createRandom(42);
 */
export { createRandom } from "./random.js";
export type { IRandom } from "./random.js";
/**
 * Define the portable game entry shared by web and native.
 * @situation start a ThreeNative game from src/game.ts
 * @situation register physics and gameplay plugins
 * @situation let the player zoom the camera with a wheel, pinch, or gamepad axis
 * @situation frame a camera behind the player
 * @alias nearest target crosshair spawns
 * @alias third-person camera
 * @alias restart run without page reload
 * @alias field of view while aiming
 * @constraint keep DOM and React mounting in src/main.ts
 * @constraint bind scroll or pinch and read the intent with ctx.input.axis(name); do not add a window wheel listener
 * @constraint scroll: true uses the DOM wheel sign on browser and native: negative deltaY toward the user is positive intent
 * @example const game = defineGame({ input: { zoom: { scroll: true, pinch: true } }, scenes: { Play }, start: "Play" });
 */
export { defineGame } from "./game.js";
export {
  ATMOSPHERE_LUT_RESOLUTIONS,
  Atmosphere,
  AtmosphereLuts,
  LUT_RESOLUTIONS,
  directionFromSolarPosition,
  directionalTransmittance,
  resolveAtmosphereLutResolutions,
  resolveAtmosphereParameters,
  solarPosition,
  solarPositionAt,
  updateAtmosphereParameters,
  zenithTransmittance,
} from "./atmosphere/index.js";
export type {
  AtmosphereDirection,
  AtmosphereRgb,
  IAtmosphereLutResolution,
  IAtmosphereLutResolutions,
  IAtmosphereOptions,
  IAtmosphereParameterPatch,
  IAtmosphereParameters,
  IAtmosphereScenePass,
  IResolvedAtmosphereParameters,
  ISolarPosition,
  ISolarPositionInput,
} from "./atmosphere/index.js";
/**
 * Register game-owned IComputeDriven objects with the shared compute lifetime.
 * @situation use IComputeDriven for a cloth, fluid, boid, or other GPU simulation
 * @situation run a cloth or fluid simulation with ordered GPU passes
 * @situation keep IComputeDriven kernels warm before the first visible frame
 * @constraint add the object through ctx.add so it attaches, dispatches, and releases with its scene
 * @example const registry = new ComputeDrivenRegistry(); registry.add(cloth, ctx.renderer.raw);
 */
export { ComputeDrivenRegistry } from "./compute-driven.js";
export type { IComputeDriven } from "./compute-driven.js";
export { SoftBody3D } from "./softbody.js";
export type { ISoftBody3DOptions, ISoftBodyCollision } from "./softbody.js";
/**
 * Pack a selected static scene into TSL storage nodes for an upstream BVH ray query.
 * @situation trace thousands of scene rays inside a TSL kernel
 * @situation build a contact-occlusion or visibility query over loaded meshes
 * @constraint call rebuild() after a scene transform or geometry change; the snapshot is static by default
 * @constraint rebuild() is an explicit CPU SAH build proportional to selected triangles; process() is a no-op, and the game pays upstream traversal per shader ray
 * @example const bvh = ctx.add(new GPUSceneBVH(ctx.scene, { include: (object) => object.userData.traceable === true }));
 */
export { GPUSceneBVH, bvhIntersectFirstHit, rayStruct } from "./gpu-scene-bvh.js";
export type {
  GPUSceneBVHTraceFunction,
  IGPUSceneBVHMaterialGroup,
  IGPUSceneBVHOptions,
} from "./gpu-scene-bvh.js";
/**
 * Collapse many copies of one game-authored shape into a single draw, without counting them first.
 *
 * `new InstancedMesh(geometry, material, count)` needs the count before anything is placed, so a
 * procedural builder ends up walking its layout twice or over-allocating. Place as you go and
 * `build()` once; the shape, the surface and every transform stay the game's, and the built mesh
 * is returned so instances can still be animated by the index `place` and `span` hand back.
 * @situation draw hundreds of repeated props without hundreds of draw calls
 * @situation draw thousands of identical instanced blocks or obstacles in one mesh
 * @situation automatically select instanced prop detail from projected screen error using baked AutoLOD chains
 * @situation place repeated props when the count is not known until the layout has been walked
 * @situation build a chain, railing, cable, or tie rod out of point-to-point segments
 * @alias landmarks points of interest
 * @alias obstacles collectibles increasing pace
 * @constraint geometry and material are required and come from the game; the batch chooses neither
 * @constraint span stretches along +Y, so its geometry must be unit-height and centred on the origin
 * @constraint placing after build() throws, and build() returns undefined when nothing was placed
 * @constraint baked AutoLOD chains survive geometry clone/transform preparation and partition instances automatically into spatially bounded draws in the engine frame loop at 4 px projected error; public instance slots remain stable
 * @constraint unavailable authored levels report TN_INSTANCED_LOD_FAILED once naming the batch; a million-triangle batch with no chain reports TN_INSTANCED_LOD_UNAVAILABLE
 * @override autoLod: false leaves selection to the game; autoLod.maxPixelError and hysteresis override the measured-camera budget; lods supplies authored distance/geometry levels and wins over the baked chain
 * @override castShadow and receiveShadow pass through to the built mesh and default to Three.js's own false
 * @example const curbs = new InstancedBatch({ geometry: new BoxGeometry(1, 1, 1), material });
 * curbs.place({ position: [x, 0.08, z], rotation: [0, angle, 0], scale: [length, 0.18, 0.42] });
 * curbs.build({ castShadow: true, name: "curbs", parent: ctx.scene });
 */
export { InstancedBatch } from "./instanced-batch.js";
export type {
  IInstancedBatchBuildOptions,
  IInstancedBatchOptions,
  IInstancedPlacement,
} from "./instanced-batch.js";
/**
 * Merge pieces a game authored out of primitives into one buffer, keeping each piece's own look.
 *
 * `InstancedBatch` collapses many copies of one shape; this collapses many *different* shapes that
 * never move relative to each other — a building, a ship, a character built from boxes, or the
 * static parts of an imported glTF model. Two things go wrong every time and neither is about how
 * any of it looks. `mergeGeometries` hands back `null` on mismatched inputs instead of throwing,
 * and the usual mismatch is invisible: one `ExtrudeGeometry` is non-indexed while every other
 * primitive is indexed, so the merge fails at the first piece and the scene never loads. And a
 * merged buffer draws with one surface, so per-piece colour is gone unless every piece carries a
 * flat `color` attribute written before the merge. Both are mechanical. By default every part is
 * stripped to position and the normals are recomputed from the merged buffer; pass `preserve` to
 * keep authored normals and texture UVs while baking each part's object transform. Geometry,
 * placement, colour and the surface it draws with all stay the game's.
 *
 * @situation bake a building, ship or character authored out of primitives into one draw call
 * @situation merge multiple static Three.js meshes into one mesh per material
 * @situation consolidate the static parts of an imported glTF model into one buffer
 * @situation preserve texture UV coordinates and authored normals while baking object transforms
 * @situation merge many small geometries and keep each piece's own colour
 * @situation stop mergeGeometries from silently returning null on an extruded shape
 * @constraint every part is de-indexed; without preserve it is stripped to position and normals are recomputed from the merged buffer
 * @constraint preserve keeps the listed channels, transforming position and normal by the part's placement matrix while UV values are retained unchanged
 * @constraint a part that does not carry a listed preserve channel throws naming the label, the part and the channel
 * @constraint either every part names a color or none does, and a mix throws
 * @constraint an empty part list throws, and a merge three.js refuses throws naming the label
 * @override color is per part and optional; without it no colour attribute is written and the surface alone decides
 * @override preserve is optional and empty by default: position-only merge with recomputed normals, exactly as before
 * @example const wall = new Mesh(mergeParts(pieces, { label: "gatehouse" }), stone);
 * // pieces are meshes, or { geometry, matrix, color } when the colour is per piece:
 * const banner = mergeParts([{ color: 0x8b2f1a, geometry: cloth, matrix: placement }], { label: "banner" });
 * // keep a model's texture UVs and authored normals while baking its transforms:
 * const hull = mergeParts(hullParts, { label: "hull", preserve: ["uv", "normal"] });
 */
export { mergeParts } from "./merge-parts.js";
export type { IMergePart, IMergePartsOptions } from "./merge-parts.js";
/**
 * Bake a hierarchy's static meshes into one mesh per material, with their transforms baked in.
 *
 * @situation collapse a building or ship of dozens of boxes into one draw call per material
 * @situation consolidate the static parts of a group before adding it to the scene
 * @constraint the material is the game's own instance and the split follows the materials the game
 * already made; nothing here decides appearance
 * @constraint the meshes come back in root's local space and unparented, with the originals still in the
 * tree: add them to root and remove the sources yourself, or both draw
 * @constraint a skinned or instanced mesh, and a mesh with several materials, is left out — its
 * vertices are not its own to bake
 * @constraint a group where only some meshes carry uv throws naming the label rather than losing the
 * texture mapping; a missing normal is recomputed
 * @override skip leaves one mesh out of its group and out of the result
 * @example const [hull, deck] = mergeByMaterial(ship, { label: "ship" });
 * // a piece that must keep moving at run time:
 * const [steady] = mergeByMaterial(ship, { label: "ship", skip: (mesh) => mesh.name === "radar" });
 */
export { mergeByMaterial } from "./merge-parts.js";
export type { IMergeByMaterialOptions } from "./merge-parts.js";
/**
 * Read a debug switch from the URL, or from `TN_DEBUG_*` in the environment on a native launch.
 * @situation read a debug toggle from the URL or an environment variable
 * @constraint a name in camelCase becomes UPPER_SNAKE: `debugFlag("freeCam")` reads `?freeCam` or `TN_DEBUG_FREE_CAM`
 * @constraint `0` and `false` are off, so a saved URL cannot turn a switch back on
 * @example import { debugFlag } from "@threenative/core";
 * if (debugFlag("freeCam")) camera.flyMode = true;
 */
export { debugFlag } from "./debug.js";
/**
 * Publish one game object under `__THREENATIVE__.debug` for a capture script or the console.
 * @situation expose a game object to a capture script or the console in dev builds
 * @constraint development builds only; a production build publishes nothing
 * @example import { exposeDebug } from "@threenative/core";
 * exposeDebug("player", player);
 * // then from the console: __THREENATIVE__.debug.player
 */
export { exposeDebug } from "./debug.js";
/**
 * Draw a model too detailed for the screen to resolve, without submitting the part it cannot.
 *
 * **This is on, and a game does not call it.** Any primitive of 65,536 triangles or more bakes to a
 * cluster DAG in the asset pipeline, the loader returns a `ClusteredMesh` for it, and the engine
 * takes the cut every frame before it renders. Each frame the mesh submits one draw holding only
 * the clusters whose error projects to fewer than `errorPixels` screen pixels; a mesh nothing has
 * cut yet draws in full, so the worst case is an ordinary `Mesh`. Geometry, surface and every
 * appearance parameter stay the game's.
 *
 * @situation draw a model too detailed for the screen to resolve
 * @situation import a scanned or sculpted mesh of millions of triangles and still hold the frame
 * @situation stop a dense rock face or terrain body from costing its full triangle count up close
 * @constraint the bake happens in the asset pipeline, never at run time — there is no runtime flag
 * @constraint the payload costs about 3-4x a baked primitive's bytes; `assets.models.virtual: "none"` opts out and `minSourceTriangles` moves the 65,536 line
 * @constraint needs a perspective camera; a screen-space error has no meaning without one
 * @constraint one shadow cut is chosen at load and does not follow a shadow camera
 * @override errorPixels sets the screen-space error budget, default 1 pixel
 * @override recutDistance sets how far the camera moves before the cut is retaken, default a thousandth of the mesh's radius
 * @example
 * // Nothing to call: the loader returns one of these and the engine cuts it every frame.
 * const face = await ctx.assets.model("quarry-face.glb");
 * ctx.scene.add(face.scene);
 */
export { ClusteredMesh } from "./clustered-mesh.js";
/**
 * Draw many copies of one over-detailed body, each at the detail its own distance earns.
 *
 * `InstancedBatch` collapses repeated props into one draw and gives every copy the same triangles.
 * This gives a copy two hundred metres away a coarser cut than one twelve metres away, and still
 * submits one draw per distance group rather than one per copy — which is what makes four hundred
 * scanned boulders affordable. The shape, the surface and every transform stay the game's.
 *
 * @situation draw hundreds of copies of a scanned or sculpted body without hundreds of draw calls
 * @situation stop distant copies of a dense prop from costing their full triangle count
 * @constraint the body's geometry must carry a cluster table from `assets.models.virtual`
 * @constraint every copy is placed before build(); place() after build() throws
 * @override distanceRatio sets how wide one distance group is, default 1.25
 * @override errorPixels sets the screen-space error budget, default 1 pixel
 * @example
 * const boulders = new ClusteredBatch({ geometry, material, table });
 * boulders.place({ position: [x, y, z], rotation: [0, angle, 0] });
 * boulders.build({ name: "boulders", parent: ctx.scene });
 * // in the scene's update, before the render:
 * boulders.update(ctx.camera, ctx.renderer.domElement.height);
 */
export { ClusteredBatch } from "./clustered-batch.js";
export type {
  IClusteredBatchBuildOptions,
  IClusteredBatchOptions,
  IClusteredPlacement,
} from "./clustered-batch.js";
/**
 * Take every clustered mesh under a root through this frame's cut, before the render.
 *
 * The engine already does this for the scene it renders; reach for it only to cut a subtree the
 * engine does not render, such as one staged for a camera of your own.
 *
 * @situation cut a virtual-geometry subtree the engine does not render itself
 * @example updateClusteredMeshes(stagedRoot, myCamera, ctx.renderer.domElement.height);
 */
export { updateClusteredMeshes } from "./clustered-mesh.js";
// `VirtualGeometryPlugin`, `selectClusterCut` and `pixelsPerUnit` are deliberately not exported: the
// loader registers the plugin itself, and the other two are the rule's internals — a game that had
// to call them would be re-implementing the cut rather than using it.
export type { IClusteredMeshOptions, IClusterTable } from "./clustered-mesh.js";
/**
 * Draw a model at the detail its projected geometric error earns, from a chain the asset cook baked.
 *
 * **This is engine-owned, and a game does not call it.** `assets.lod: {}` opts in — the default-on
 * front door opens after qualification — the `model` pass bakes `TN_discrete_lod` into eligible
 * models, the loader registers the reader, and the engine runs the selection every frame before it
 * renders. Each frame the mesh picks the cheapest baked level whose measured error projects to fewer
 * than the resolved pixel budget, taking the camera's own projection, zoom, viewport and a
 * conservative nearest depth into account. Refinement is immediate; coarsening waits for the
 * resolved hysteresis. A mesh with no baked chain draws its full geometry.
 *
 * @situation draw a vehicle or hull built from many small meshes at distance without its full triangles
 * @situation stop a distant model from costing its authored mesh count and triangle count
 * @situation one source model, right detail by default, no hand-authored LOD files
 * @constraint the chain is baked by the asset cook; there is no runtime generation and no runtime flag
 * @constraint `assets.lod: false` opts out globally and `assets.lod.overrides` per asset, with no runtime controller installed
 * @constraint only static indexed triangles are eligible; skinned, morphed, alpha-blended or authored-LOD meshes keep full detail
 * @constraint the real gate is measured benefit: a level must save at least `minSaving` (20% default) of its predecessor, and a mesh that cannot is skipped, not forced
 * @override `assets.lod.generation.maxLevels`, `.minTriangles`, `.minTrianglesScope`, `.minSaving` and `.errorTargets` move the bake's ceiling, pre-filter, its scope, its saving rule and its error ladder; `assets.lod.runtime.maxPixelError` and `.hysteresis` move the runtime budget and coarsen band; all by project, preset or asset
 * @example
 * // Nothing to call: the loader returns a mesh with the chain and the engine selects every frame.
 * const hull = await ctx.assets.model("hull.glb");
 * ctx.scene.add(hull.scene);
 */
export { updateModelLods } from "./model-lod.js";
/**
 * The full-detail geometry of a mesh the loader gave an automatic LOD chain.
 *
 * Selection swaps `mesh.geometry`, so a ray test or a collision body built from the current geometry
 * would change with the camera. Framework picking and gameplay collide against this instead: the
 * authored LOD0, which never changes as the camera moves.
 *
 * @situation collide or ray-test the authored geometry of a mesh whose render detail changes with distance
 * @example const geometry = baseGeometryOf(mesh);
 */
export { baseGeometryOf } from "./model-lod.js";
/**
 * The screen pixels one world unit covers at `depth` for this camera and viewport.
 *
 * Perspective divides the projected scale by the depth; orthographic has no depth term and uses the
 * frustum height instead. This is the number a level of detail is chosen against: multiply a
 * level's world-space error by it and you have the on-screen error a player can see, which is the
 * comparison `updateModelLods` makes from the baked chain.
 *
 * @situation pick a level of detail from an object's projected size in pixels on screen
 * @situation know how many screen pixels a world-space error covers at a given distance
 * @constraint a non-positive viewport height, a non-positive frustum height or an unprojectable camera throws
 * @constraint a non-positive depth has no projected scale and returns Infinity
 * @example const pixels = lodPixelScale(camera, canvas.clientHeight, mesh.position.distanceTo(camera.position));
 */
export { lodPixelScale } from "./model-lod.js";
/**
 * Keep an object drawn even when the render camera cannot resolve it.
 *
 * The engine's projected-size gate is on by default: an object whose world bounding sphere
 * projects to fewer than 0.5 raster pixels in the camera about to render it is not submitted, per
 * camera. Mark the player's own cockpit, a nameplate, a quest marker, or anything a game never
 * wants to pop out of the frame. `alwaysRender(object, false)` removes the marker. Camera-attached
 * objects and shadow casters are already kept, and the number of marked objects is reported beside
 * the cull in the `TN_PROJECTION` window rather than hidden. The threshold itself is
 * `renderer.minimumProjectedPixels` — a larger number cuts more aggressively, `false` leaves
 * every object drawn while still measuring.
 *
 * @situation keep a small object drawn when the engine would skip it as too far to resolve
 * @situation stop my cockpit, marker or player model popping out at distance
 * @situation a tiny object disappeared at range and I need it always visible
 * @situation widen or narrow the projected-size cull with a named threshold
 * @constraint the marker is per object and is reported as `exemptMarked` in the projection window
 * @constraint `renderer.minimumProjectedPixels: false` leaves the scene drawn and keeps the measurement on
 * @override renderer.minimumProjectedPixels sets the projected-pixel threshold, default 0.5
 * @example import { alwaysRender } from "@threenative/core";
 * alwaysRender(ctx.camera.children[0]); // a camera-attached cockpit stays drawn
 */
export { alwaysRender } from "./render-camera-cull.js";
/**
 * Walk the scene graph's world matrices each frame without recursing into a hidden subtree.
 *
 * On by default as `renderer.matrixWorld: "visible"`. three's `updateMatrixWorld` recurses into
 * every child whatever its `visible` flag, so a hidden LOD body, a merged stand-in and a parked
 * model cost a world-matrix multiply each while nothing under them can draw. This pass mirrors
 * three exactly for every visible node and defers a hidden node's subtree until the frame it shows
 * again. A class that overrides `updateMatrixWorld` (`SkinnedMesh`, `Camera`) runs its own, and a
 * hidden node that holds bones is walked, so no skeleton or view matrix goes stale.
 *
 * @situation update the world matrices of the visible objects each frame instead of the whole scene
 * @situation the per-frame world matrix walk is hot in a profile
 * @situation stop multiplying matrices for hidden models, LOD levels and merged stand-ins
 * @situation a game needs every node walked, exactly as three's own updateMatrixWorld does
 * @constraint a game that reads a hidden object's matrixWorld directly must use getWorldPosition or updateWorldMatrix(true, false) first
 * @constraint `renderer.matrixWorld: "all"` visits every node; `TN_PROJECTION` reports the visited count either way
 * @override renderer.matrixWorld: "all" runs three's full walk instead of the visible-only default
 * @example import { MatrixWorldPass } from "@threenative/core";
 * const pass = new MatrixWorldPass(); // renderer.matrixWorld defaults to "visible"
 */
export { MatrixWorldPass } from "./matrix-world.js";
export type { IMatrixWorldReport, MatrixWorldMode } from "./matrix-world.js";
/**
 * Read where the frame's milliseconds went, per presented frame, on any platform; each
 * `TN_FRAME_BUDGET` window also carries the GPU time per resolved frame and the draw calls and
 * triangles each render pass submitted.
 * @situation show an on-screen frame time meter with p50, p95 and p99 percentiles
 * @situation find out why a game runs slowly on a phone
 * @situation attribute a frame to present wait, simulation, three.js render, or overlay
 * @situation tell whether the GPU is the frame's constraint from a per-frame series, not one lagged timestamp
 * @situation split a frame's draw calls and triangles per render pass (main, shadow, reflection)
 * @situation tell a shadow or reflection pass's cost from the main colour pass
 * @situation retain every asynchronous GPU render frame for a complete paired benchmark
 * @constraint on by default and printed as TN_FRAME_BUDGET; defineGame({ frameBudget: false }) silences the marker, not the measurement
 * @constraint per-pass numbers are attributed to the innermost active render call, so nested shadow and reflection passes do not read as main
 * @constraint GPU is a mean/p50/p95/max series over resolved frames (`gpu`) with `gpuStale` counting frames that had no fresh reading; absent means no timestamps, never zero
 * @constraint `ctx.renderer.observeGpuFrames({ maxFrames, maxQueries })` is opt-in, bounded and fail-closed; `take()` delivers immutable complete render-query groups once, while `status()` reports pending/undrained/queued membership and losses
 * @constraint observation preserves ordinary sampling; a complete benchmark explicitly requests `renderer.gpuTimestampFrameInterval: 1` and joins Three query IDs to actual world renders, including separate overlay IDs
 * @constraint `stop()` fences allocated frames and drains existing resolver work; `dispose()` invalidates late completions, and a failed observation must be disposed before replacement
 * @example defineGame({ frameBudget: { reportEvery: 120 }, scenes: { Play } });
 */
export {
  FRAME_BUDGET_MARKER,
  FRAME_BUDGET_PHASES,
  FRAME_HITCH_MARKER,
  FrameBudget,
} from "./frame-budget.js";
export type {
  FrameBudgetPhase,
  IFrameBudgetOptions,
  IFrameBudgetPassSummary,
  IFrameBudgetSummary,
  IFrameBudgetWindow,
  IFramePhaseSample,
} from "./frame-budget.js";
export type { FramePassKind, IRenderPassSample, MainDrawSource } from "./render-pass-budget.js";
/**
 * Read what frame rate a game gets when its config does not say, and why.
 *
 * `display.maxFps` follows the display — capped at 120 on desktop and web, 60 on mobile — rather
 * than the 60 every template used to ship, and an explicit number still wins with `0` still
 * uncapping. The engine calls this itself; a game calls it when it needs the same number for its
 * own frame-rate-dependent work, and `TN_FRAME_BUDGET` reports the resolved target and its source
 * on every window.
 * @situation my game does frame-rate-dependent work and must not hardcode 60
 * @constraint pass the measured display rate when you have one; without it the answer is the 60 fallback and says so
 * @example resolveTargetFps(config, getPlatform()).targetFps;
 */
export {
  DEFAULT_TARGET_FPS,
  MAX_TARGET_FPS,
  resolveTargetFps,
  snapRefreshRate,
} from "./target-fps.js";
export type { ITargetFps, TargetFpsSource } from "./target-fps.js";
/**
 * Attribute the render phase to 100% with a nested span tree, off unless `TN_FRAME_SPANS` asks.
 * Every non-leaf reports its own time minus the spans inside it, so an unmeasured part shows up as
 * a residual instead of being filed under "other"; a child that outlives its parent reports a
 * negative residual rather than a clamped zero.
 * @situation find out what inside the render phase is actually costing the frame
 * @situation tell a shadow pass's traversal from the main pass's, with the residual computed
 * @situation price an optimisation against a measured part of the phase rather than the whole of it
 * @constraint off by default and installed by `TN_FRAME_SPANS=1`; unset, every call site is one guarded return
 * @constraint the tree is closed against the frame budget's own render phase, so `TN_FRAME_SPANS` and `TN_FRAME_BUDGET` describe the same frames
 * @constraint measurement only: no span changes what is drawn, in what order, or with which renderer
 * @example if (spansRequested()) setSpanRecorder(new SpanRecorder());
 */
export {
  SPANS,
  SPANS_FLAG,
  SPANS_MARKER,
  SPAN_COUNT,
  SPAN_NAMES,
  SpanRecorder,
  addSpan,
  beginSpan,
  endSpan,
  formatSpansWindow,
  setSpanRecorder,
  spanNow,
  spanRecorder,
  spansRequested,
} from "./profiling/Spans.js";
export type { ISpanSummary, ISpanWindow, SpanId } from "./profiling/Spans.js";
/**
 * Attach the span probes to a renderer: three's `render`, `_projectObject`, the render list's
 * `sort`, the per-draw submission, and the scene-graph walk. Installed for you when
 * `TN_FRAME_SPANS` asks; exported so a harness can wrap a renderer it owns.
 * @situation measure which part of three's render path costs the frame
 * @situation attach the span tree to a renderer a test or a tool constructed itself
 * @constraint returns an uninstall that restores every wrapper, asserted by test
 * @constraint a renderer whose internals have moved loses that span rather than throwing, and it is absent from the report rather than zero
 * @constraint only the outermost `_projectObject` opens a span, because three's recurses per child
 * @example const uninstall = installSpanProbes(renderer.raw, scene);
 */
export { installSpanProbes } from "./profiling/span-probes.js";
export type { ISpanProbeTarget } from "./profiling/span-probes.js";
/**
 * Count the frame's host-boundary crossings and the bytes it writes into GPU buffers, off unless
 * `TN_FRAME_SPANS` asks for them. On the frame budget's own window as `counters`, so a crossing
 * count and a millisecond split describe the same frames.
 * @situation decide whether a CPU-bound frame is paying for the V8-to-host boundary
 * @situation measure how many bytes a frame writes into GPU buffers, and how many commands it issues
 * @constraint counts command-encoder and queue methods only; `mapAsync` and the presentation path are named, not folded in
 * @constraint `gpuBytes` is `queue.writeBuffer` exactly, so it reconciles against a driver; texture uploads are not included
 * @constraint `jsAllocBytes` needs `performance.memory` and stays absent where the platform lacks it
 * @example const counters = FrameCounters.install(counterDeviceOf(renderer.raw));
 */
export { FrameCounters, counterDeviceOf } from "./profiling/FrameCounters.js";
export type { ICounterDevice, IFrameCounters } from "./profiling/FrameCounters.js";
/**
 * Warn the agent that built the scene before a human plays it: a frame whose GPU is idle while its
 * JS render phase is longer than the display's own period is a scene-shape problem, and the engine
 * already has the shape. On by default, printed at most once per reported window as
 * `TN_SCENE_WARNING`, and silent on a scene that is honestly GPU-bound.
 * @situation find out whether a slow frame is the scene's shape or the device
 * @situation tell an authoring agent what to reduce before it promises a merge
 * @constraint the rule is derived from the frame's own numbers; the display period comes from the host's presentation cap or the game's declared target, never a constant
 * @constraint no verdict without a measured GPU reading and a pass census — an absent measurement is not evidence
 * @constraint the record carries objects considered, draws per pass, triangles per draw and shadow-exempt casters, so the reader is not dependent on the ranking
 * @example defineGame({ display: { maxFps: 60 }, scenes: { Play } });
 */
export {
  SCENE_WARNING_MARKER,
  describeSceneShape,
  describeSceneWarning,
  displayPeriodMs,
  formatSceneWarning,
  sceneWarning,
} from "./profiling/scene-warning.js";
export type { ISceneShape, ISceneWarning } from "./profiling/scene-warning.js";
/**
 * Tell the agent that built the scene that its imported foliage is drawing with no image-based light:
 * an alpha-cutout `MeshStandardMaterial` (or its Node twin) with `scene.environment` unset and no
 * `envMap` of its own gets a hemisphere fill and one flat dark value, which is cardboard. Printed
 * once per scene entry as `TN_UNLIT_FOLIAGE`, after `enter()`, with the fix in the same line.
 * @situation catch the "why does my forest look like cardboard" question before a human plays it
 * @situation audit a scene a game built from imported GLB foliage
 * @constraint derived from the scene graph, not from a constant: cutout PBR with no environment in the scene and none on the material
 * @constraint it changes nothing and never throws — the environment is appearance, so setting it stays the game's decision
 * @override `material.userData.tnUnlitOk = true` on a material a game deliberately renders unlit (the same `userData.tn*` naming the alpha and impostor conventions use)
 * @example defineGame({ scenes: { Forest } }); // one TN_UNLIT_FOLIAGE line when the forest has no sky
 */
export {
  UNLIT_FOLIAGE_FIX,
  UNLIT_FOLIAGE_MARKER,
  formatUnlitFoliageWarning,
  unlitFoliageWarning,
} from "./profiling/unlit-foliage-warning.js";
export type { IUnlitFoliageWarning } from "./profiling/unlit-foliage-warning.js";
/**
 * Stop recomposing the transforms of a subtree nobody moves. `markStatic(root)` composes the
 * subtree once and freezes it; the engine re-arms a root whose own transform the game changes, and
 * `invalidateStatic(object)` announces a write deeper inside one.
 * @situation cut the per-frame matrix work of terrain, buildings, props and other scenery that never moves
 * @situation keep a frozen subtree correct when the game does move it after all
 * @constraint staticness is authored, never guessed; no heuristic watches gameplay and decides for you
 * @constraint it deletes the local and world matrix composes, not the walk itself — three 0.185 recurses into every child regardless
 * @constraint a write deeper inside a frozen subtree must call `invalidateStatic`; `TN_RENDERLIST_VALIDATE=1` is what proves it happened
 * @example invalidateStatic(drawbridge);
 */
export {
  STATIC_TRANSFORM_MARKER,
  invalidateStatic,
  isStatic,
  refreshStaticTransforms,
  resetStaticTransforms,
  staticTransformCensus,
  unmarkStatic,
} from "./static-transform.js";
/**
 * Freeze a subtree nobody moves: `markStatic(root)` composes its transforms once and stops the
 * per-frame recompose.
 *
 * It is the call a game makes on scenery, terrain, buildings and props. The engine re-arms a root
 * whose own transform the game changes; a write deeper inside a frozen subtree is announced with
 * `invalidateStatic(object)`.
 *
 * @situation freeze a static mesh or subtree so its matrices are not recomputed every frame
 * @situation stop the engine recomposing the transforms of props, terrain and buildings each frame
 * @constraint staticness is authored, never guessed; no heuristic watches gameplay and decides for you
 * @constraint a write deeper inside a frozen subtree must call `invalidateStatic`; `TN_RENDERLIST_VALIDATE=1` is what proves it happened
 * @example markStatic(island); invalidateStatic(drawbridge);
 */
export { markStatic } from "./static-transform.js";
export type { IStaticTransformCensus } from "./static-transform.js";
/**
 * Prove that nothing a cache skipped changed the picture: `TN_RENDERLIST_VALIDATE=1` recomputes
 * every world matrix the long way, every frame, and throws on the first element that disagrees
 * with what the frame is about to draw.
 * @situation prove a static freeze did not leave a stale transform on screen
 * @situation gate a scene in CI against silent transform divergence
 * @constraint off by default and expensive by construction — it does the work it is checking, twice
 * @constraint it throws on the first divergence rather than logging; a validation mode that continues is one nobody reads
 * @constraint it proves the frames it ran on and nothing else
 * @example if (renderListValidationRequested()) console.log(formatValidationReport(report));
 */
export {
  RENDERLIST_VALIDATE_FLAG,
  RENDERLIST_VALIDATE_MARKER,
  RenderListValidator,
  formatValidationReport,
  renderListValidationRequested,
  validateWorldMatrices,
} from "./profiling/render-list-validate.js";
export type { IValidationReport } from "./profiling/render-list-validate.js";
export {
  GEOMETRY_CAPTURE_DEFAULT_LIMIT,
  GEOMETRY_CAPTURE_MAX_LIMIT,
  GEOMETRY_CAPTURE_SORTS,
  GEOMETRY_CAPTURE_TIMEOUT_MS,
  GEOMETRY_CAPTURE_WALK_CAP,
  GEOMETRY_ASSET_KEY,
} from "./geometry-capture.js";
export type {
  GeometryCaptureSort,
  IGeometryCaptureAsset,
  IGeometryCaptureMesh,
  IGeometryCapturePass,
  IGeometryCaptureReport,
  IGeometryCaptureRequest,
  IGeometryCaptureRow,
} from "./geometry-capture.js";
/**
 * Register work that reads a body or camera after physics has moved it and before this frame draws.
 * The engine owns the phase ordering; a callback cannot be misplaced by plugin-array order.
 * @situation read a body after physics has moved it
 * @situation place a camera or aim from the solved character transform
 * @constraint register from a scene context; callbacks are cleared when that scene exits
 * @example afterPhysics(ctx, (dt) => camera.position.copy(player.mesh.position));
 */
export { afterPhysics } from "./loop.js";
export type { AfterPhysicsCallback } from "./loop.js";
/**
 * Compose game-provided render nodes in a measured, fail-closed chain. Authored stages use an
 * opaque id and anchor before or after a built-in or another supplied stage; the engine does not
 * need to know the effect's visual vocabulary.
 * @situation compose screen-space effects in a canonical order
 * @situation insert a game-authored post stage into the measured render chain
 * @situation report which render tier and velocity route actually ran
 * @constraint stage factories own colour, strength, and all other appearance choices
 * @constraint authored stages declare exactly one before or after anchor
 * @example const chain = new RenderChain(renderer, { input: colour, stages, request: { stages: ["bloom"], tier: "auto" } });
 */
export {
  RENDER_CHAIN_MARKER,
  RENDER_CHAIN_STAGE_ORDER,
  RENDER_CHAIN_TIERS,
  RenderChain,
  readRenderChainObservation,
  readRenderChainReport,
} from "./render/chain.js";
export type {
  IRenderChainApplied,
  IRenderChainBudgetWindow,
  IRenderChainDroppedStage,
  IRenderChainOptions,
  IRenderChainRenderer,
  IRenderChainRequest,
  IRenderChainStage,
  IRenderChainStageContext,
  IRenderChainVelocityMeasurement,
  IRenderChainVelocityResult,
  IRenderChainVelocityReport,
  IRenderChainVelocityRequest,
  RenderChainSource,
  RenderChainStageId,
  RenderChainStageName,
  RenderChainTier,
  RenderChainTierRequest,
  RenderChainVelocitySource,
} from "./render/chain.js";
/**
 * Bake static diffuse irradiance that reaches surfaces from outside the camera view.
 * @situation light bouncing from a room I cannot see
 * @situation light a wall with an off-screen emitter
 * @alias readable world lighting
 * @constraint request a bake after static geometry and lights are authored; this is static-lighting-first, not fully dynamic relighting
 * @constraint add the volume with ctx.add() so its incremental work is measured in the render phase
 * @constraint call sample() or sampleNode() from a game-owned material before screen-space GI; the volume owns no light, material, or colour
 * @override density, bounds, bakeBudgetMs, and bounces are game-owned choices
 * @example const probes = new ProbeVolume({ bounds, density: 0.5 }); ctx.add(probes); void probes.requestBake(scene);
 */
export {
  ATLAS_PADDING,
  PROBE_VOLUME_MARKER,
  ProbeVolume,
} from "./render/probe-volume.js";
/**
 * Read the most recent observation from a probe volume.
 * @situation inspect the latest probe bake observation
 * @constraint the returned observation is a measurement; it does not own lighting or materials
 * @example const observation = readProbeVolumeObservation(probes);
 */
export { readProbeVolumeObservation } from "./render/probe-volume.js";
export type {
  IProbeVolumeBakeProgress,
  IProbeVolumeCoefficient,
  IProbeVolumeObservation,
  IProbeVolumeOptions,
  ProbeVolumeDensity,
} from "./render/probe-volume.js";
/**
 * Provision screen-space motion data for temporal nodes and keep per-instance history at the
 * frame boundary.
 * @situation keep a skinned character or instanced crowd stable in a temporal stage
 * @situation add the velocity output to a Three.js scene pass
 * @constraint call `VelocityTracker.update()` before the render and `commit()` after it
 * @constraint a pass is only given a velocity target when a temporal stage consumes it
 * @example
 * const scenePass = pass(scene, camera);
 * ensureVelocityOutput(scenePass);
 * renderer.setOutputNode(scenePass);
 * const tracker = new VelocityTracker();
 * tracker.update(scene);
 * renderer.render(scene, camera);
 * tracker.commit(scene);
 */
export {
  VELOCITY_OUTPUT_NAME,
  VELOCITY_PREVIOUS_BONE_MATRICES,
  VELOCITY_PREVIOUS_INSTANCE_MATRICES,
  VELOCITY_PREVIOUS_WORLD_MATRIX,
  VelocityTracker,
  ensureVelocityOutput,
  readVelocityPreviousBoneMatrices,
  readVelocityPreviousMatrices,
  readVelocityPreviousWorldMatrix,
  velocityTexture,
  withVelocityContext,
} from "./render/velocity.js";
export type { IVelocityRenderPass } from "./render/velocity.js";
/**
 * One directional shadow for a whole open world: camera-centred clip levels, each snapped to its
 * own texel grid and re-rendered only when its window moves. Tracked casters draw into a
 * per-level mover map every frame, so animated casters do not invalidate the cached levels after
 * the one refresh caused by tracking or untracking them.
 * Plugs into three's own `light.shadow.shadowNode` slot, so every material receives it.
 * @situation crisp shadows close to the player across a large outdoor level
 * @situation shadow map too coarse over a big terrain
 * @situation one directional light shadow for a whole open world
 * @situation shadows shimmer when the camera moves
 * @constraint the light must be a DirectionalLight with `castShadow` and a target in the scene
 * @constraint clipExtents are half-widths in world units, finest first, strictly increasing
 * @constraint movers sort themselves: a layer-0 caster whose world matrix, instance matrix or deformation changed draws through the mover maps and leaves the cached levels, and returns to them after `staticAfterFrames` quiet frames; the cache redraws only the region it left
 * @constraint `trackCaster(object)` is the override that pins an object as a mover for good (it enables layer `VIRTUAL_SHADOW_MOVER_LAYER` on the object and its descendants), and `pinStatic(object)` opts an object out of detection; tracking or untracking refreshes only that object's region
 * @constraint call `object.layers.set(VIRTUAL_SHADOW_CASTER_LAYER)` for a mesh that exists only to cast; the level cameras already render that layer and the main camera never does
 * @override bias, biasNode, normalBias, intensity, radius, blurSamples, mapType and filterNode stay on `light.shadow`; mapSize and the other options here have defaults, and `marker: false` silences the TN_VIRTUAL_SHADOW line, not the measurement
 * @example
 * const sun = new DirectionalLight(0xffffff, 3);
 * sun.castShadow = true;
 * sun.shadow.shadowNode = new VirtualShadowNode(sun, { clipExtents: [12, 40, 120] });
 */
export {
  VIRTUAL_SHADOW_CASTER_LAYER,
  VIRTUAL_SHADOW_MARKER,
  VIRTUAL_SHADOW_MOVER_LAYER,
  VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
  VirtualShadowNode,
} from "./render/virtual-shadow.js";
export { readVirtualShadowMarker } from "./render/virtual-shadow.js";
/**
 * An outdoor daylight rig: physical sky, one sun with open-world shadows that follow the eye,
 * hemisphere fill, sky-coloured haze and the AgX tone curve. Every value is the game's.
 *
 * @situation daytime sky, sun and shadows for a large outdoor map
 * @situation distant terrain should fade into the sky instead of a coloured wall
 * @situation match a Blender look-dev scene's sun, sky and exposure in the game
 * @constraint every value is required; there is no default sun, sky, haze or exposure
 * @constraint `skySize` must keep the sky box's corners inside the camera's far plane
 * @constraint shadowExtents follow `VirtualShadowNode`: half-widths, finest first, strictly increasing
 * @override sky uniforms stay live on `daylight.sky`; the light and fill are `daylight.sun` and `daylight.fill`
 * @example
 * const daylight = new Daylight({ follow: ctx.camera, sunDirection, sunColor, sunIntensity: 4, shadowExtents: [24, 96, 320], sky: { turbidity: 3, rayleigh: 1.4, mieCoefficient: 0.004, mieDirectionalG: 0.8 }, fill: { sky, ground, intensity: 1.1 }, haze: { color: horizon, density: 0.0011 }, exposure: 2 ** -0.6, skySize: 1600 });
 * ctx.add(daylight);
 */
export { Daylight } from "./render/daylight.js";
export type { IDaylightOptions } from "./render/daylight.js";
export type { IVirtualShadowOptions, IVirtualShadowStats } from "./render/virtual-shadow.js";
/**
 * Attach hundreds of built objects to the scene in slices, presenting a frame between each.
 * @situation add hundreds of built objects to the scene without one multi-second frame
 * @situation stream a detail tier in behind a loading curtain without the page looking hung
 * @constraint the objects, and where each one goes, stay the game's; this decides only when each joins the graph
 * @constraint input order is the attach order and cannot be changed
 * @constraint a false `while` stops the run and is reported as `stopped`, never thrown
 * @override a slice ends on an 8 ms budget unless the game gives `sliceSize`, and the reported sliceSize is then the measured average; `marker: false` silences the TN_ADD_SLICES line, not the report
 * @example const report = await addInSlices(objects, (object) => ctx.add(object), {
 *   onProgress: ({ added, total }) => setProgress(added / total),
 *   while: () => generation.live,
 * });
 */
export { addInSlices } from "./streaming.js";
export type {
  IAddInSlicesOptions,
  IAddInSlicesProgress,
  IAddInSlicesReport,
} from "./streaming.js";
/**
 * Load a list with bounded concurrency, returning results in the input's order.
 * @situation load many models or textures in parallel instead of one at a time
 * @situation keep a loading screen moving while a list of assets downloads
 * @constraint results are written to each item's own index and never appended, so a positional lookup finds the same asset on every load
 * @constraint the first rejection rejects the call and no lane starts a load it had not begun
 * @override concurrency defaults to 6; `marker: false` silences the TN_LOAD_ALL line, not onProgress
 * @example const species = await loadAll(names, (name) => ctx.assets.model(`flora/${name}.glb`));
 */
export { loadAll } from "./streaming.js";
export type { ILoadAllOptions, ILoadAllProgress } from "./streaming.js";
export { warmUpScene } from "./warmup.js";
export type {
  IWarmUpCacheOptions,
  IWarmUpOptions,
  IWarmUpProgress,
  IWarmUpRenderer,
  IWarmUpReport,
  IWarmUpObservation,
  WarmUpCacheStatus,
  WarmUpObservationStatus,
} from "./warmup.js";
export type {
  IGame,
  IGameObservationContribution,
  IGameObservationSampleRequest,
  IGamePluginHooks,
  IGamePluginRuntime,
  IGamePlatformSource,
} from "./game.js";
/**
 * Simulate a spectral ocean — cascaded wave spectra inverse-transformed on the GPU each frame.
 * @situation make an ocean whose surface is the view rather than a background
 * @situation float a boat on waves the GPU is drawing
 * @situation drive a water material from a wave simulation without writing an FFT
 * @situation sail a ship on simulated ocean waves with buoyancy
 * @constraint it draws nothing; the game supplies the mesh, the material and every colour
 * @constraint CPU height is a throttled copy carrying staleFrames, never this frame and never exact
 * @constraint an exact free CPU height needs an analytic wave field instead; that is a different contract
 * @constraint cascades are ordered largest patchSize first and every tuning number is required
 * @example const sea = ctx.add(new SpectralOcean(oceanOptions));
 */
export { SpectralOcean } from "./ocean/spectral.js";
export type {
  ISpectralOceanCascade,
  ISpectralOceanHeight,
  ISpectralOceanOptions,
} from "./ocean/spectral.js";
/**
 * Copy a GPU buffer back to the CPU on a throttle, and report how old each sample is.
 * @situation read a GPU simulation on the CPU without stalling the frame
 * @situation float a body on a wave field whose height only exists on the GPU
 * @situation count GPU-side survivors for a diagnostic without blocking drawing
 * @situation keep a ship floating on simulated ocean waves
 * @constraint the copy is asynchronous, so every sample carries staleFrames and is never this frame
 * @constraint WebGPU only; the seam throws on a WebGL2 renderer rather than returning nothing
 * @constraint one copy is in flight at a time and requests made during one are dropped, not queued
 * @example const heights = new GPUReadback({ attribute: field.value, everyFrames: 4 });
 */
export { GPUReadback } from "./gpu-readback.js";
export type { IGPUReadbackOptions, IGPUReadbackSample } from "./gpu-readback.js";
/**
 * Dispatch a game-owned particle surface and process function through a pooled system.
 * @situation emit sparks, smoke, or other transient effects
 * @situation update many small visual particles
 * @situation trail dust, exhaust, or spray behind a moving object
 * @situation emit cannon smoke and muzzle flash particles
 * @situation fire a cannonball projectile with cannon smoke particles
 * @situation splash spray droplets with lifetime and gravity
 * @situation spawn water droplets, mist, or foam bubbles above a fluid surface
 * @situation falling snowflakes, rain or ash around the player that thicken into a windy storm or blizzard
 * @situation kick up a spray of powder snow or dust where a foot or a ball lands
 * @constraint geometry, color, and timing remain supplied by the game
 * @example const particles = new GPUParticles3D(particleOptions);
 */
export { GPUParticles3D } from "./particles.js";
/**
 * Simulate a deterministic 2D velocity-and-dye field on the GPU while exposing its data to game-owned rendering.
 * @situation simulate smoke, fire, fog, wind, or fluid response on a grid
 * @situation inject a touch, pointer, or gameplay impulse into a fluid field
 * @situation sample fluid dye or velocity in a game-owned render node
 * @situation simulate ocean currents and wind affecting a sailing ship
 * @situation simulate ocean fluid dynamics and currents that affect a ship
 * @constraint add the field through `ctx.add` so renderer attachment, fixed-step dispatch, and release are automatic
 * @constraint `dye` and `velocity` are numeric samplers; appearance stays in the game's `src/render/` code
 * @constraint the conformance sample measures mean absolute velocity divergence at 0.001732 after four 32² steps with pressureIterations 2, below the 0.0025 threshold
 * @override pressureIterations, viscosity, vorticity, and splatRadius tune the solver without changing its pass order
 * @example const field = new FluidField2D({ resolution: 256, pressureIterations: 20 });
 * ctx.add(field);
 * field.splat({ x: 0.5, y: 0.5 }, { x: 0.2, y: 0 }, 1);
 */
export { FluidField2D } from "./fluid-field.js";
export type { IFluidFieldOptions, IFluidFieldSampler, IFluidFieldVector2 } from "./fluid-field.js";
/**
 * Simulate liquid as GPU particles (pour, splash, dam break, waterfall) and expose positions, a density volume and a surface height while the game owns every look.
 * @situation pour, splash, or dam-break water that fills a container and flows around obstacles
 * @situation simulate water or another liquid as particles in a fluid simulation
 * @situation drop a ball or box into liquid and let it displace and float on the water
 * @situation emit a stream or waterfall of particle fluid and drain it somewhere else
 * @situation sample particle-fluid density or surface height in a game-owned render node
 * @constraint add the fluid through `ctx.add` so renderer attachment, fixed-step dispatch, and release are automatic
 * @constraint a renderer without WebGPU compute throws a named error at attach; it never draws nothing
 * @constraint `emit` recycles the oldest slot once `capacity` slots have been used; `fill` stops at capacity
 * @constraint `sample` and `stats` read a throttled GPU copy and report `staleFrames`; they are never live
 * @override iterations, viscosity, cohesion, vorticity, gravity and maxSpeed tune the solver without changing its pass order
 * @example const water = new FluidParticles3D({ capacity: 6000 });
 * ctx.add(water);
 * water.fill([-2.8, 0.1, -1.5], [-0.6, 3, 1.5]);
 */
export { FluidParticles3D } from "./fluid-particles.js";
export type {
  IFluidBounds,
  IFluidCollider,
  IFluidParticlesOptions,
  IFluidParticlesStats,
} from "./fluid-particles.js";
/**
 * Propagate a disturbance across a patch of water surface and let it fade.
 * @situation make a splash or explosion ripple outward across water
 * @situation show the sea reacting to a bomb, shell, or torpedo hitting it
 * @situation leave a foam trail behind something moving through water
 * @situation disturb a water surface the player can see respond
 * @situation spread and drift foam on a water surface over time
 * @constraint it draws nothing; the game supplies the mesh, the material and every colour
 * @constraint add its height to an analytic swell, never in place of one
 * @constraint the patch is finite and its rim absorbs; call recenter to keep it over the action
 * @constraint there is no obstacle mask, because a mask is only correct for a body that never moves
 * @override speed, damping, foamHalfLife, current, step and maxSteps tune the solve; the default
 * step is 1/60s or the CFL stability limit for the given resolution and speed, whichever is smaller
 * @example const ripples = new RippleField({ resolution: 128, size: 400 });
 * ripples.impulse(hit.x, hit.z, 6, -40, 0.5);
 * ripples.advance(dt);
 * const lift = ripples.heightAt(boat.x, boat.z);
 */
export { RippleField } from "./ripple-field.js";
export type { IRippleFieldFlow, IRippleFieldOptions } from "./ripple-field.js";
/**
 * Evaluate analytic waves on CPU and displace game-owned vertices with the matching TSL graph.
 * @situation float a boat on waves
 * @situation make water move
 * @situation find the water surface height at a point
 * @constraint supply every wave amplitude, wavelength, direction, speed and warp value
 * @constraint call setTime for the default graph clock when the game advances its own time
 * @constraint sample allocates a result and a normal vector; ask heightAt when only the height is
 * wanted, and the warp jacobian, every slope and both allocations are skipped
 * @example const field = new WaveField({ waves });
 * const { height, normal } = field.sample(x, z, elapsed);
 * const lift = field.heightAt(x, z, elapsed);
 */
export { WaveField } from "./wave-field.js";
export type {
  IWaveFieldDomainWarp,
  IWaveFieldGraphOptions,
  IWaveFieldOptions,
  IWaveFieldSample,
  IWaveFieldWave,
  WaveDirection,
} from "./wave-field.js";
/**
 * Give a horizontal water surface the world mirrored in it, the world beneath it, and the metres
 * of water between them.
 * @situation reflect the sky and the shoreline in a lake, pond or river
 * @situation see the bed through the water and have the shallows fade at the shore
 * @situation know how deep the water is under a pixel without a second render pass
 * @situation stop a water surface repeating in visible bands or stripes
 * @situation keep a crowd of small actors out of the water's reflection so the frame can afford it
 * @situation stop the water reflection redrawing the whole world every frame
 * @situation automatically reflect terrain and large casters without redrawing instanced small props
 * @constraint it draws nothing; the game supplies the mesh, the material and every colour
 * @constraint the material must be transparent so the frame beneath it is already drawn
 * @constraint thickness is metres, saturating at maxThickness; sky behind the surface reads deep
 * @constraint one reflection is a second draw of the world; resolutionScale is its pixels only
 * @constraint omitted reflection.layers automatically reflects terrain-sized surfaces and large non-instanced casters, excluding instanced/skinned props; TN_WATER_REFLECTION_DEFAULT reports the set once
 * @override reflection.layers is an explicit Three Layers mask and wins over automatic filtering, including layer-0 mask 1; reflection.minSize overrides the default 10 metre minimum extent
 * @constraint reflection.refreshInterval is in presented frames; 1 is every frame, and the default
 * @constraint the mirror plane is level, from level alone; do not parent target to a scaled mesh
 * @example const surface = new WaterSurface3D({ level: 0, maxThickness: 3, reflection: { resolutionScale: 0.5 } });
 * material.colorNode = mix(surface.refractionAt(offset), surface.reflectionAt(offset), fresnel);
 */
export { WaterSurface3D } from "./water-surface.js";
export type { IWaterReflectionOptions, IWaterSurfaceOptions } from "./water-surface.js";
/**
 * Build a soft round sprite as pixel data instead of painting a canvas.
 * @situation give smoke, flash, or glow sprites a radial alpha falloff
 * @situation generate sprite images that render identically under every backend
 * @constraint canvas-painted images sample black under WebGPURenderer; write sprites as pixel data there
 * @example const puff = softCircleDataTexture(64, 0.25);
 */
export { softCircleDataTexture } from "./textures.js";
/**
 * Pool travelling bullet-streak meshes for hitscan shots.
 * @situation show where a hitscan round went
 * @situation show each round a weapon fires, one tracer per trigger press
 * @situation draw incoming fire without spawning projectiles
 * @constraint the surface comes from the game; pooling, travel, and fading belong to the engine
 * @constraint update once per frame and dispose with the owning scene
 * @example const tracers = new TracerPool3D(ctx.scene, tracerOptions);
 * tracers.spawn(muzzle, shotDirection, hit.distance);
 */
export { TracerPool3D } from "./tracers.js";
export type { ITracerPool3DOptions, ITracerSpawnOptions } from "./tracers.js";
/**
 * Move an object along a Three.js curve with Godot-style path following.
 * @situation move an enemy or prop along a patrol path
 * @situation sample a racing line from a curve
 * @example const follower = new PathFollow3D({ points: patrolPoints, loop: true, speed: 3 });
 */
export { PathFollow3D } from "./path-follow.js";
/**
 * Keep a rendered model's feet on a surface while preserving an auditable override.
 * @situation keep a character's feet on the floor
 * @situation correct visual grounding after an animation update
 * @constraint import from `@threenative/core`; this moves the rendered model, not its physics collider
 * @override enabled controls whether correction is applied while clearance is still measured
 * @example import { GroundSnap } from "@threenative/core";
 * const snap = new GroundSnap(character, { enabled: true });
 */
export { GroundSnap } from "./grounding.js";
/**
 * Fly a fixed-wing aircraft with a real force balance instead of a steered velocity.
 * @situation fly an airplane with lift, drag, stall and control authority
 * @situation launch an aircraft off a moving carrier deck
 * @situation apply component damage or a loadout to an aircraft's performance
 * @constraint every mass, area, power and inertia value comes from the game's airframe
 * @constraint damage, stores and configuration arrive as the game's own modifier sample
 * @example const model = new FlightModel({ airframe: sbd, state: aircraft, wind: seaWind });
 * model.step(1 / 60, { turn: -1, pitch: 0.4 });
 */
export {
  FlightModel,
  NEUTRAL_FLIGHT_MODIFIERS,
  aerodynamicCoefficients,
  airDensity,
  aircraftMass,
  attitudeAxes,
  gearClearance,
  setAttitude,
} from "./flight.js";
export type {
  IAircraftAirframe,
  IFlightAxes,
  IFlightControls,
  IFlightDeck,
  IFlightEnvironment,
  IFlightForces,
  IFlightModelOptions,
  IFlightModifiers,
  IFlightQuaternion,
  IFlightState,
  IFlightVector3,
} from "./flight.js";
export type { IGroundSnapOptions } from "./grounding.js";
/**
 * Measure a Three.js pose for grounded or attachment-aware checks.
 * @situation inspect a skinned model's posed bounds
 * @situation verify a character's visual pose
 * @constraint precise per-vertex measurement is opt-in and not for frame loops
 * @example const measurement = measureThreePose(model);
 */
export { measureThreePose, posedBounds } from "./pose-measure.js";
export type {
  IMeasureThreePoseOptions,
  IThreePoseBounds,
  IThreePoseMeasurement,
  ThreePoseQuaternion,
  ThreePoseVector,
} from "./pose-measure.js";
export type {
  IPathFollow3DOptions,
  IPathFollow3DProjection,
  IPathFollow3DSample,
} from "./path-follow.js";
/**
 * Dispatch portable pointer events from the game surface to registered Three.js objects.
 * @situation let the player click on a thing in the world
 * @situation show a 3D object while a pointer hovers over it
 * @situation handle touch and mouse taps on a loaded model without naming its child meshes
 * @situation drag a crate or prop with the mouse or a finger
 * @constraint listeners are side-table registrations; Three.js prototypes are never patched
 * @constraint one raycast serves each active pointer and no raycast runs when nothing is registered
 * @example ctx.pointer.on(tile, "tapped", (event) => place(event.point));
 */
export { PointerEvents3D } from "./pointer-events.js";
export type {
  IPointerDragHandle,
  IPointerEvent3D,
  IPointerEvents3D,
  IPointerEvents3DOptions,
  IPointerEvents3DPicker,
  IPointerState,
  PointerEvent3DListener,
  PointerEvent3DType,
} from "./pointer-events.js";
/**
 * Read the host platform without reaching for browser globals.
 * @situation branch a portable game on web or native
 * @situation choose touch controls for a mobile device
 * @situation can I raytrace on native
 * @constraint only use the returned platform facts; native globals are host-owned
 * @constraint ray tracing is unavailable on native until buffer-to-texture copy-out interop exists; `mystralRT.traceRays` refuses instead of resolving success without a readable result
 * @example if (isMobile()) showTouchControls();
 */
export { getPlatform, isMobile, isNative, isTouchscreenAvailable, isWeb } from "./platform.js";
export type {
  IPlatformInfo,
  PlatformFormFactor,
  PlatformOS,
  PlatformRuntime,
} from "./platform.js";
/**
 * Raycast the game scene using the framework's picker.
 * @situation select an object under the pointer
 * @situation interact with the first collider or mesh hit
 * @supersedes new Raycaster(
 * @example const picker = new ScenePicker({ camera: ctx.camera, scene: ctx.scene, pointer: () => ctx.input.raw.pointer, viewport: ctx.viewport });
 */
export { ScenePicker } from "./picking.js";
export type { IRaycastOptions, IScenePickerOptions } from "./picking.js";
/**
 * Record or replay deterministic game input and state.
 * @situation reproduce a gameplay bug from recorded input
 * @situation run a deterministic replay in a playtest
 * @alias fixed seed fixed-step simulation
 * @constraint use a seeded random source and fixed-step simulation for meaningful replays
 * @example const driver = createReplayDriver(recording, ctx.renderer.domElement);
 */
export { createReplayDriver, replay } from "./replay.js";
export type { IReplayOptions, Recording } from "./replay.js";
/**
 * Validate and parse a replay recording file.
 * @situation validate a recording before replaying it in another host
 * @constraint recordings are version 1; the parser fails closed with TN_REPLAY_* codes
 * @example const recording = parseReplayRecording(rawRecording);
 */
export { parseReplayRecording } from "./replay-protocol.js";
export type {
  IReplayRecording,
  IReplayRecordingSample,
  ReplayPointer,
} from "./replay-protocol.js";
/**
 * Schedule delayed and repeating callbacks or tween numeric properties with game-owned cleanup.
 * @situation delay an enemy patrol transition
 * @situation run a callback every simulation tick
 * @situation tween a numeric property with a game-owned curve
 * @situation a countdown timer: end the level when its time limit runs out
 * @alias tower defense game
 * @alias spawn waves
 * @constraint dispose returned handles when the owning scene exits
 * @constraint ease receives progress in the range 0 to 1 and its return value is the interpolation factor
 * @example const door = { y: 0 };
 * await ctx.tween(door, { y: 2.4 }, 0.5, { ease: (t) => 1 - (1 - t) ** 3 });
 */
export { Scheduler } from "./schedule.js";
export type { ITweenOptions, ScheduleHandle } from "./schedule.js";
/**
 * Implement a portable Godot-shaped game scene lifecycle.
 * @situation add a playable level or menu scene
 * @situation move scene setup and per-frame gameplay out of the entry point
 * @situation run scene work once per actual world draw, after the frame's last fixed update and before the projection packs
 * @constraint scene code must stay portable across web and native
 * @example class Play extends Scene { update(ctx, dt) {} }
 * @example ctx.beforeRender(() => packBatches()); // cleared on scene change and stop, like ctx.afterPhysics
 */
export { Scene } from "./scene.js";
export type { ICtx, SceneFrame } from "./scene.js";
/**
 * Advance a game-owned non-uniform sprite atlas on the fixed step.
 * @situation play an animated pickup or sprite-sheet effect
 * @situation sequence atlas frames with different authored durations
 * @constraint the game supplies the atlas texture, surface, filtering, layout, and every frame duration
 * @constraint update is driven by the scene fixed step; no wall clock or default frame rate is used
 * @example const animator = new SpriteAnimator3D({ texture: atlas, frames, mode: "pingPong" });
 */
export { SpriteAnimator3D } from "./sprite-animator.js";
export type {
  ISpriteAnimator3DOptions,
  ISpriteFrame3D,
  SpritePlaybackMode,
} from "./sprite-animator.js";
/**
 * Keep transient render surfaces in the renderer's pipeline cache before first use.
 * @situation prewarm a projectile, tracer, particle, or other transient effect
 * @situation avoid a long first-use frame for a newly visible effect
 * @constraint keep the surface visible with zero opacity; do not hide it with `visible = false`
 * @supersedes .visible = false
 * @example prewarm(tracerPool);
 */
export { prewarm } from "./renderer.js";
/**
 * Read the renderer's bounded, versioned pipeline capture in a diagnostic or playtest tool.
 * @situation inspect shader and pipeline creation work during a real launch
 * @situation correlate pipeline creation with material, object, pass, and shader identities
 * @constraint the capture is bounded and incomplete when the backend cannot expose an observation
 * @example const capture = game.runtime.pipelineCensus?.();
 * // The game normally reaches this through `runtime.pipelineCensus`; direct construction exists
 * // for renderer adapters and contract tests, not for gameplay.
 */
export {
  DEFAULT_PIPELINE_CENSUS_LIMIT,
  PIPELINE_CENSUS_CAPABILITY,
  PIPELINE_CENSUS_VERSION,
  createPipelineCensus,
  PipelineCensus,
} from "./pipeline-census.js";
export type {
  IPipelineCensus,
  IPipelineCensusCounts,
  IPipelineCensusEvent,
  IPipelineCensusOptions,
  IPipelineProvenance,
  IPipelineShaderObservation,
  PipelineCensusMode,
  PipelineCensusStatus,
} from "./pipeline-census.js";
/**
 * Scale an asset to a real-world measurement and return the applied factor.
 * @situation make a character exactly 1.8 metres tall
 * @situation normalize a prop or weapon to a known longest axis
 * @constraint skinned height uses a crown bone; game-specific asset expectations stay in render code
 * @supersedes new Box3().setFromObject(
 * @example normaliseToMetres(character, { metres: 1.8, axis: "height" });
 */
export { normaliseToMetres } from "./scale.js";
export type { INormaliseToMetresOptions, NormaliseAxis } from "./scale.js";
/**
 * Repair an exported rig whose animation clips are z-mirrored against its own bind pose.
 * @situation find out why a skinned character renders deformed
 * @situation repair an imported character that walks backwards with its spine folded
 * @situation load a rigged GLB through a custom loader and keep the framework's repair
 * @constraint the model loader already applies this automatically; only a game loading GLBs around it needs the call
 * @constraint detection votes per tracked bone and converts only on an overwhelming signature; a file that does not carry it is left byte-identical
 * @example import { reconcileMirroredClips } from "@threenative/core";
 * if (reconcileMirroredClips(gltf.scene, gltf.animations)) console.info("clips were z-mirrored; repaired");
 */
export { reconcileMirroredClips } from "./assets.js";
/**
 * Attach a game-owned object to a named skeleton bone.
 * @situation put a weapon in a character's hand
 * @situation hold a rifle in a character's right hand
 * @situation add an enemy that patrols the level, chases the player when it sees them, and holds a rifle in its right hand
 * @situation attach an accessory to a skinned model
 * @situation equip crew with swords and pistols
 * @situation put a sword or pistol in a crew member's hand
 * @constraint when a request is to hold or attach a weapon to a hand, import and call `attachToBone` from `@threenative/core`; do not manually parent, position, or rotate the rifle
 * @constraint if a stock visual has no skeleton, add a portable Three.js Bone named `RightHand` under the character, then call `attachToBone`; do not replace the helper with manual parenting
 * @example import { attachToBone } from "@threenative/core";
 * attachToBone(character, "RightHand", rifle);
 */
export { attachToBone } from "./skeleton.js";
/**
 * List the names of every bone in a character hierarchy.
 * @situation inspect the available bones before attaching a game-owned object
 * @situation debug a missing skeleton bone name
 * @example import { skeletonBones } from "@threenative/core";
 * const bones = skeletonBones(character);
 */
export { skeletonBones } from "./skeleton.js";
/**
 * Measure whether a named bone reaches the object it is supposed to be touching, in metres.
 * @situation check that a seated character's hands reach the keyboard
 * @situation check that a character's hips meet the chair it is sitting on
 * @situation turn "the character is not touching the prop" into a number a scenario can assert
 * @constraint this walks the target's vertices; call it on a check or a debug sample, not every frame
 * @example import { boneContact } from "@threenative/core";
 * const contact = boneContact(worker, "hand_r", keyboard);
 */
export { boneContact } from "./skeleton.js";
export type { IBoneContactReport } from "./skeleton.js";
/**
 * Score a retargeted clip against the source it came from, per bone, in degrees.
 * @situation find out why a retargeted animation looks wrong on a character
 * @situation tell a fixed retarget from one that merely moved
 * @situation catch a retarget that rolled every limb about its own axis
 * @constraint each bone is compared as a whole quaternion relative to its own rig's bind pose, so the two rigs never have to share a bind convention; a bone-direction check reports zero on the roll this catches
 * @constraint both rigs must face the same way in world space, and both are driven and then restored to the transforms they arrived with
 * @override bones maps one rig's bone names onto the other's when they differ; samples sets how many poses are compared
 * @example import { clipPoseError } from "@threenative/core";
 * const report = clipPoseError({ root: rig, clip: retargeted }, { root: source, clip: original });
 */
export { clipPoseError } from "./clip-audit.js";
/**
 * Report which of a clip's tracks bind to nothing on a character.
 * @situation find out why a character plays its bind pose instead of the animation
 * @situation check that a loaded clip actually drives the model it was written for
 * @constraint the reason is Three.js's own, captured off its console hook so a scenario's console assertions stay clean
 * @example import { clipTrackBindings } from "@threenative/core";
 * const bindings = clipTrackBindings(character, clip);
 */
export { clipTrackBindings } from "./clip-audit.js";
/**
 * Report which bones of a character a clip does not drive.
 * @situation find out why a character keeps the previous animation's hand shape
 * @situation check how much of a rig a clip covers before shipping it
 * @constraint a track that binds nothing counts as driving nothing
 * @example import { clipBoneCoverage } from "@threenative/core";
 * const coverage = clipBoneCoverage(character, clip);
 */
export { clipBoneCoverage } from "./clip-audit.js";
export type {
  IBonePoseError,
  IClipBindingReport,
  IClipCoverageReport,
  IClipPoseErrorOptions,
  IClipPoseErrorReport,
  IClipPoseSubject,
  IClipTrackBinding,
} from "./clip-audit.js";
/**
 * Measure a rig's parent→child bone distances, in world space, as it stands right now.
 * @situation capture a rig's bind-pose bone lengths before any clip plays
 * @situation measure a skeleton for the bone-length invariance check
 * @constraint the baseline and the later comparison must come from the same rig under the same ancestor transform, so a uniform scale cancels
 * @example import { boneLengths } from "@threenative/core";
 * const baseline = boneLengths(character);
 */
export { boneLengths } from "./bone-lengths.js";
/**
 * Compare a rig's bone distances now against a captured snapshot and name every bone that moved.
 * @situation find out why a skinned character renders deformed
 * @situation check that an animated pose keeps the skeleton rigid
 * @situation name the bone that breaks a posed skeleton without taking a screenshot
 * @constraint a rigid skeleton preserves every parent→child distance under any pose; a named bone is a defect with an address
 * @constraint this is a diagnostic — it reports numbers and names; it moves nothing and decides no appearance
 * @example import { boneLengths, boneLengthDeviations } from "@threenative/core";
 * const report = boneLengthDeviations(character, boneLengths(character));
 * if (!report.rigid && report.worst !== null) console.log(report.worst.bone, report.worst.ratio);
 */
export { boneLengthDeviations } from "./bone-lengths.js";
export type {
  IBoneLengthDeviation,
  IBoneLengthDeviationReport,
  IBoneLengthDeviationsOptions,
  IBoneLengthSnapshot,
} from "./bone-lengths.js";
export type {
  ContextMenuPolicy,
  IInputAction,
  IInputGamepad,
  InputBindings,
  InputPlatformSource,
  IRawInputPointer,
  IRawInputPointerEdge,
  IRawInputState,
} from "./input.js";
/**
 * The map a game reads input through: named actions, 2D vectors and scalar axes resolved from
 * keyboard, gamepad, mouse, wheel, pinch and touch.
 *
 * `defineGame({ input })` builds one and hands it to the running game as `ctx.input`, so the usual
 * route is a binding in the config and `ctx.input.axis("move")` in the update. Construct one
 * directly to drive a menu, a replay or a test outside a running game.
 *
 * @situation map WASD keys to a movement axis instead of reading the held key set in the update loop
 * @situation read a jump, a fire or a reload as one named action bound to key, gamepad button and mouse button together
 * @situation read mouse look, wheel zoom or a two-finger pinch as an axis the frame loop already ticks
 * @constraint `buttons` is the gamepad and `mouseButtons` the mouse; `up`/`down`/`left`/`right` are the directions of `vector(name)`, not the keys that press it
 * @constraint scroll, pinch and pointer-relative sources are declared on the binding and read through `axis(name)`; a game adds no window listener of its own
 * @example const game = defineGame({ input: { move: { up: ["KeyW"], down: ["KeyS"], left: ["KeyA"], right: ["KeyD"] } }, scenes: { Play } });
 * // inside the scene, per frame: ctx.input.axis("move") is 0 at rest and 1 at full tilt
 */
export { InputMap } from "./input.js";
/**
 * Lock the pointer to the game's surface: the capture every first-person mouse look needs.
 *
 * A browser grants capture only from a user gesture, so call it from a click or a pointerdown
 * handler. A relative binding such as `look: { pointerRelative: true }` already requests capture on
 * the first canvas click; this is the same request for a game that starts capture from another
 * named gesture, and `ctx.input.captureMouse()` is the map's own way to ask.
 *
 * @situation lock the mouse pointer so first-person mouse look keeps the cursor out of the way
 * @situation stop the cursor leaving the window in the middle of a turn
 * @constraint the browser grants capture only from a user gesture and a refusal is reported, never swallowed
 * @constraint a relative binding requests capture on canvas click unless `captureOnClick: false` opts out
 * @example canvas.addEventListener("click", () => captureMouse(canvas));
 */
export { captureMouse } from "./input.js";
