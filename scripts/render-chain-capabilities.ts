import type { ICapabilityManifestEntry } from "./build-capability-manifest.js";

/**
 * The lighting stages a generated game already has, described in the words someone would use
 * before they know the name.
 *
 * These are not package exports, so nothing puts them in the manifest automatically: they are TSL
 * nodes composed by `src/render/postprocessing.ts`, which is generated source the game owns. The
 * result was that `engine_search_capabilities("light shaft through a window")` returned nothing
 * while the stage had been shipping, tuned, and documented for months — and the cost of that gap
 * is measured in this repo's own history: a scene was built with hand-authored cone geometry for
 * beams the render chain was already drawing.
 *
 * The manifest is the thing an agent searches first, so a stage absent from it does not exist.
 * Each entry therefore carries the situations in plain words, and the constraint that actually
 * bites — for godrays, that the beams and the haze are separated by `godraysFloor`, not by
 * `godraysIntensity`.
 */
function stage(entry: {
  readonly symbol: string;
  readonly importPath: string;
  readonly packageName?: string;
  readonly kind?: ICapabilityManifestEntry["kind"];
  readonly signature?: string;
  readonly summary: string;
  readonly situations: readonly string[];
  readonly constraints: readonly string[];
  readonly example?: string;
}): ICapabilityManifestEntry {
  return {
    symbol: entry.symbol,
    package: entry.packageName ?? "three",
    importPath: entry.importPath,
    kind: entry.kind ?? "class",
    signature: entry.signature ?? `class ${entry.symbol}`,
    summary: entry.summary,
    situations: entry.situations,
    // Every one of these is already wired; the example is the dial, not the constructor.
    example:
      entry.example ??
      "src/render/postprocessing.ts — edit the preset it passes to WorldEnvironment",
    constraints: entry.constraints,
    overrides: [],
    supersedes: [],
  };
}

export const RENDER_CHAIN_MANIFEST_ENTRIES: readonly ICapabilityManifestEntry[] = [
  stage({
    symbol: "godrays",
    importPath: "three/addons/tsl/display/GodraysNode.js",
    kind: "function",
    signature: "godrays(textureNode, light, shadowMap, params)",
    summary:
      "Raymarched shafts of light. Already wired as the `godRays` stage of the render chain; turn it on with `godraysEnabled` in src/render/postprocessing.ts.",
    situations: [
      "draw a visible shaft of light through a window or a hole in a roof",
      "god rays, sun shafts, light beams, crepuscular rays",
      "make sunlight visible in dusty or misty air indoors",
      "light a cave or a hall through an opening above",
      "volumetric lighting without adding cone geometry",
    ],
    constraints: [
      "Needs a shadow-casting DirectionalLight passed as `godraysLight`, and `renderer.shadowMap.enabled = true` — without the shadow map the stage refuses and the whole chain reports it dropped.",
      "`godraysFloor` is what separates beams from fog: it subtracts out-of-beam scatter before `godraysIntensity` multiplies. Raising intensity with a floor near zero brightens the haze over the whole room instead of the beams.",
      "Do not author cone geometry for beams. A hand-built additive cone draws its own silhouette and reads as a plastic tube; this stage is the supported route.",
      "Measured band on an interior scene: density 0.7, floor 0.08, intensity 3.0, maxDensity 0.6. Above ~0.8 density the haze stops being confined to the beams and the room fogs.",
    ],
  }),
  stage({
    symbol: "ao",
    importPath: "three/addons/tsl/display/GTAONode.js",
    kind: "function",
    signature: "ao(scene, camera, resolution, radius, intensity)",
    summary:
      "Ground-truth ambient occlusion. Already wired as the `ambientOcclusion` stage; turn it on with `gtaoEnabled`.",
    situations: [
      "darken the contact where an object meets the floor",
      "stop props looking like they float",
      "ambient occlusion, contact shadows, crevice darkening",
    ],
    constraints: ["Radius is in metres; a radius sized for a room reads as a smudge on a prop."],
  }),
  stage({
    symbol: "bloom",
    importPath: "three/addons/tsl/display/BloomNode.js",
    kind: "function",
    signature: "bloom(node, strength, radius, threshold)",
    summary: "Glow around bright pixels. Already wired as the `bloom` stage.",
    situations: ["make a bright opening or a lamp glow", "bloom, glare, light spill"],
    constraints: [
      "Strength above ~0.3 on an interior washes the mid-tones; the reference-matching band is lower than it looks.",
    ],
  }),
  stage({
    symbol: "WorldEnvironment",
    importPath: "src/render/worldEnvironment.ts",
    summary:
      "The generated file that composes every lighting stage and prints TN_RENDER_CHAIN naming each one as applied or refused with a reason. It is the game's source, not the framework's — edit it.",
    situations: [
      "turn a lighting or post-processing effect on or off",
      "find out why an effect you enabled is not visible",
      "change how the scene is lit, graded, or tonemapped",
      "match a reference image's lighting",
    ],
    constraints: [
      "Read the TN_RENDER_CHAIN line before assuming a stage ran: it names every stage as applied or dropped, with the reason it was dropped.",
      "A stage reported `applied` can still be invisible if its own inputs are wrong — the chain reports whether it built, not whether you can see it.",
      "Appearance belongs here, in generated game source. Nothing in packages/ decides how the scene looks.",
    ],
  }),
  // The `rain` template's generated source. Same reason as the stages above: these are functions in
  // files the game owns (`src/render/`, `src/audio/`), so no package export puts them in the manifest
  // and an agent searching "storm sky" or "thunder distance" had nowhere to land. Ordinary Three.js
  // plus the engine's own `AudioBus`; what the game draws and hears is authored here, not configured
  // from a package. Only what exists today is listed, because a manifest entry is a promise the
  // source keeps.
  stage({
    symbol: "createWeatherWorld",
    importPath: "src/render/world.ts",
    packageName: "template:rain",
    kind: "function",
    signature: "createWeatherWorld(scene: Scene, camera: PerspectiveCamera): IWeatherWorld",
    summary:
      "The raymarched coastal storm as generated source: one screen quad whose TSL shader draws the sky, the sea, the coast, the road, the forest and the lamps, and whose wet ground reflects them, written from the uniforms the game feeds it each frame. The sky it samples is the live cloud pass this call builds, not a stand-in gradient. Returns `{ quad, update(options), dispose() }`.",
    situations: [
      "a procedural storm, sea, coastline or open horizon drawn from maths rather than geometry",
      "rain and wind that change how a scene looks without swapping a mesh",
      "a lightning flash that lights the coast and the sky at once",
      "wet reflections on a ground plane",
      "sky that darkens as cloud cover rises",
    ],
    example:
      "src/render/world.ts — edit the shader there, or the weather it is fed from src/state.ts",
    constraints: [
      "`update` takes `{ elapsed, flash, weather, strike, quality }`: absolute seconds, a flash envelope already gated on the photosensitivity switch by the caller, the bolt's entry point in the cloud deck in metres (what the clouds glow around and the coast is lit from), and a quality name of `performance | balanced | high | ultra`.",
      "The tier's cloud resolution share, march steps and reflection switch come from `STUDY_TIERS` in src/render/quality.ts; `performance` skips the 36-step reflection march, so a low tier loses reflections, not the coast. `clouds()` reads back the cloud target the renderer really drew and its steps.",
      "Its colours and lights are uniforms set once from src/render/palette.ts, sky.ts, lighting.ts and materials.ts; the shader itself is generated from tools/tempest-*.frag by tools/generate-shaders.mjs — edit the .frag, not the generated file.",
      "The engine's `Scene` and `PerspectiveCamera` are injected as arguments; the file holds no engine lifetime of its own. `dispose()` removes the quad and disposes the geometry, material and sky texture — the scene does not do it for you.",
      "The quad has `frustumCulled = false`, because its two-metre bounds would otherwise be culled the moment the camera looks along the coast.",
      "The cloud pass is built first and its texture feeds the world shader (sampled with the render-target flip); `update` also drives the clouds. Rain streaks and the bolt are separate draws: `createStormRain`, `createStormLightning`.",
      "This entry describes the Rain starter scaffold's own generated `src/render/world.ts`, not a `@threenative/` or three export — there is no installed package to import it from. Appearance lives in that source with no package import at all; nothing in packages/ decides how this storm looks.",
    ],
  }),
  stage({
    symbol: "createNoiseVolume",
    importPath: "src/render/noise-volume.ts",
    packageName: "template:rain",
    kind: "function",
    signature: "createNoiseVolume(): INoiseVolume",
    summary:
      "The 64³ RGBA cloud noise volume as generated Rain source: `{ data: Uint8Array, texture: Data3DTexture }`. Its authored seed, octave weights and source-exact generator define the storm's cloud shapes.",
    situations: [
      "generate a 3D noise volume instead of shipping one as an asset",
      "rebuild the storm's clouds procedurally at startup",
      "tileable 3D noise that does not crease at the edges",
      "four octave scales packed into one texture",
    ],
    example:
      "src/render/noise-volume.ts — edit the seed, the lattices or the channel weights there",
    constraints: [
      "Seed 13291 uses the source's mulberry32 sequence. The generated volume matches all 1,048,576 reference bytes; changing the authored seed or generator changes its appearance.",
      "Two distinct failure channels, not one: `TN_NOISE_CHANNEL` is a channel value that does not fit a byte, `TN_NOISE_LENGTH` is a byte count that does not fill the volume. Both throw rather than uploading a volume the shader would read wrong.",
      "64³ of RGBA is 1 MiB, and `NOISE_SIZE` is what the loops and the byte count are written against; changing the size changes the memory cost with it.",
      "Indices wrap at every face, which is what makes the volume tile, and the fractional part is smoothed by `f²(3 − 2f)` so lattice edges do not show as creases in the cloud.",
      "This entry describes the Rain starter scaffold's own generated `src/render/noise-volume.ts`, not a `@threenative/` or three export — there is no installed package to import it from.",
    ],
  }),
  stage({
    symbol: "createStormAudio",
    importPath: "src/audio/storm.ts",
    packageName: "template:rain",
    kind: "function",
    signature: "createStormAudio(ctx: ICtx<GameState>): IStormAudio",
    summary:
      "The storm's sound as generated source, mixed through the engine's own `AudioBus`: a rain hiss, a wind bed, and thunder queued strike by strike and delayed and filtered by how far away it was struck.",
    situations: [
      "rain hiss, wind bed, thunder, a storm you can hear",
      "delay thunder by the distance it was struck",
      "sound that follows pause, mute and tab visibility",
      "audio that queues strikes instead of cutting each other off",
    ],
    example:
      "src/audio/storm.ts — register the returned helper, call update(state) after advancing the simulation, and dispose it with the owning scene",
    constraints: [
      "`queueStrike({ at, metres })` queues: a second strike does not overwrite one still crossing the air, and `at` is absolute simulation time, which is what lets a strike survive a freeze.",
      "Two holds, kept apart so neither latches the other: `setSilenced` is the game's own pause intent, `setHidden` is the UI realm or engine lifecycle visibility. The bus is released only when both are clear.",
      "`update(state)` is the frame's truth and is called once per frame after the simulation advances; `debug()` is what a playtest reads back.",
      "The caller owns entity registration, updates and disposal; creating the helper does not register it.",
      "Audio begins only after a user gesture — the bus's unlock error is surfaced rather than swallowed.",
      "The three clips are baked by `tools/make-storm-audio.mjs` from the study's own maths; this file plays them, it does not synthesise them live.",
      "The helper requests the source's compressor settings ahead of master gain: threshold -15 dB, knee 30 dB, ratio 5, attack 0.003 s and release 0.25 s.",
      "Each thunder voice is a labelled `thunder` cue, so a playtest's `audio` assertion reads it from the runtime ledger; the rain kit's `playtests/lightning.playtest.json` proves one cue after a strike, sounded only once the strike's `distance / 343` delay had passed.",
      "This entry describes the Rain starter scaffold's own generated `src/audio/storm.ts`, not a `@threenative/` or three export — there is no installed package to import it from.",
    ],
  }),
  stage({
    symbol: "createStormLightning",
    importPath: "src/render/lightning.ts",
    packageName: "template:rain",
    kind: "function",
    signature: "createStormLightning(scene: Scene, camera: PerspectiveCamera): IStormLightning",
    summary:
      "A branching lightning bolt as generated Rain source: `makeBolt(end, random)` walks a 30-segment channel down from the cloud deck with side branches, and one additive camera-facing ribbon draw (gaussian core inside a wide halo) shows it while the caller's flash envelope is above zero. `strike(position, random)` returns where the bolt entered the sky.",
    situations: [
      "generate branching lightning ribbon geometry",
      "a lightning strike that lights the scene and the clouds",
      "a camera-facing ribbon or beam that stays the same pixel width at any distance",
      "a flash envelope that stutters rather than fades once",
    ],
    example:
      "src/render/lightning.ts — the bolt; src/state.ts `flashAt` for the envelope; src/scenes/Boot.ts strike() for the thunder delay",
    constraints: [
      "Pass the game's seeded random so a strike is reproducible; a non-finite position or random value throws rather than drawing NaN geometry.",
      "The buffers hold the worst case (30 channel segments plus 24 branches of 9) and are allocated once; a strike rewrites them and opens the draw range, never reallocating.",
      "`update(flash)` takes an envelope already gated on photosensitivity mode by the caller; below 0.003 the mesh is hidden. Register it with `alwaysRender`: its quads are projected by its own vertex stage, so its bounds say nothing about where it lands.",
      "It depth-tests against the coast's written depth, so a bolt behind the headland is hidden by it.",
      "This entry describes the Rain starter scaffold's own generated `src/render/lightning.ts`, not a `@threenative/` or three export — there is no installed package to import it from.",
    ],
  }),
  stage({
    symbol: "createStormRain",
    importPath: "src/render/rain.ts",
    packageName: "template:rain",
    kind: "function",
    signature: "createStormRain(scene: Scene, camera: PerspectiveCamera): IStormRain",
    summary:
      "Camera-anchored falling rain as generated Rain source: one instanced draw whose vertex stage hashes each drop from its index, wraps it in a 66 × 30 × 66 m cell that follows the camera in 12 m steps, and projects a quad stretched along its own fall — no particle simulation, no texture.",
    situations: [
      "rain streaks around the camera",
      "thousands of falling drops in one draw",
      "rain that leans with the wind and lights up in a lightning flash",
    ],
    example:
      "src/render/rain.ts — the drop maths; `STUDY_TIERS` in src/render/quality.ts for the per-tier budget",
    constraints: [
      "The drawn count is `round(rainBudget × weather.rain)` for the tier, read back from `geometry.instanceCount` (`instanceCount`), not from the budget.",
      "Stateless by design: a drop's position is a function of its index and the clock, so pausing the clock freezes the rain and nothing accumulates. `GPUParticles3D` is the engine's emitter with lifetimes; reach for it when drops must spawn, live and die.",
      "Register it with `alwaysRender`: the vertex stage places every drop, so the geometry's own bounds do not.",
      "This entry describes the Rain starter scaffold's own generated `src/render/rain.ts`, not a `@threenative/` or three export — there is no installed package to import it from.",
    ],
  }),
  // Not a render stage: the engine's scene-draw optimizer, which a game can decline, and whose
  // per-frame material proof a game can bound or unbind. It lives here because it is framework
  // render-path behaviour with no package export for an agent to search — the same reason the
  // stages above are hand-entered. A game that measured the projection as a loss (paid reconcile
  // without a frame-time win) opts out with `false`.
  {
    symbol: "renderer.projection",
    package: "@threenative/core",
    importPath: "src/game.ts",
    kind: "function",
    signature: "renderer.projection?: boolean | { materialChecks?: 'spread' | 'everyFrame' }",
    summary:
      "The engine's scene-render projection — an internal mirror that collapses repeated draws, including animated skinned rigs that share a geometry and material into one palette draw per pass — on by default. Set `renderer.projection: false` to decline it, or `projection: { materialChecks: 'everyFrame' }` to keep it and pay for a per-material check on every frame.",
    situations: [
      "a crowd of animated characters draws slowly",
      "many SkinnedMesh copies of one rig, each its own draw call",
      "the game got slower after the projection engaged",
      "turn off the render projection, batching, or the instanced mirror",
      "draw count fell but frame time did not",
      "a multi-second freeze when the mirror first engages",
      "opt out of an engine render optimizer",
      "thousands of props each with their own material, one colour apart",
      "a material edit takes a few frames to show up",
      "check every batched material every frame anyway",
    ],
    example: "renderer: { projection: false } // in threenative.config.ts",
    constraints: [
      "Unset is the shipping behaviour: the projection runs. Only an explicit `false` declines it.",
      "An opted-out game builds no mirror and runs no eligibility scan; the authored scene is what renders, so declining costs nothing rather than being re-judged each frame.",
      "TN_RENDER_PROJECTION still reports the verdict, with reasonCode `disabled` rather than one of the measured declines.",
      "`materialChecks: 'spread'` is the default: a bounded slice of the batched materials is proved per frame instead of all of them, so a frame of 4,096 colour-only materials costs 512 checks rather than 4,096. A base-colour edit is never delayed — that write is O(1) per member.",
      "The price of `spread` is staleness on every other material edit: a material that gains a roughness, a map or a define still leaves its group and is drawn exactly, up to `materialCheckStaleFrames` frames later. TN_RENDER_PROJECTION reports that bound; `materialChecks: 'everyFrame'` sets it to 0 and restores the per-member, per-frame check.",
      "Any other `materialChecks` value throws at startup rather than falling back to a default.",
    ],
    overrides: [
      "renderer.projection: false declines the whole mirror and costs nothing to decline",
      "renderer: { projection: { materialChecks: 'everyFrame' } } proves every batched material every frame instead of the default bounded slice",
    ],
    supersedes: [],
    aliases: [],
  },
  // Also not a render stage: the projected-size cull, which is engine render-path behaviour with no
  // package export of its own. It lives here for the same reason the projection above does — an
  // agent searching "my frame is slow with many distant objects" has nowhere else to find it.
  {
    symbol: "renderer.minimumProjectedPixels",
    package: "@threenative/core",
    importPath: "src/game.ts",
    kind: "function",
    signature: "renderer.minimumProjectedPixels?: number | false",
    summary:
      "Do not submit what the render camera cannot resolve. On by default at a conservative 0.5 projected pixel; an object below it is skipped per render camera. Raise the number to cull more, set `false` to leave every object drawn — the count of what was skipped still reports in `TN_PROJECTION`.",
    situations: [
      "my frame is slow with many distant objects",
      "draw count is high but the screen is mostly empty",
      "far away models, aircraft, boats or props cost draw calls but are specks",
      "a large roster or fleet drops the frame rate while barely visible",
      "stop submitting objects smaller than a pixel to the camera",
      "cull by how big something looks to the camera rather than how far it is from the player",
      "tune how aggressively distant objects are skipped",
      "a small object I need disappeared at range",
    ],
    example: "renderer: { minimumProjectedPixels: 2 } // in threenative.config.ts",
    constraints: [
      "Unset is the shipping behaviour: the gate runs at 0.5 px. A game that wants the cut a shipped title tuned names 2; `false` leaves every object drawn.",
      "The decision reads the render camera's projection and viewport, not the player's distance — a camera far from the player still culls its own specks.",
      "It writes only `object.visible`, which the projection's batch key ignores; `castShadow`, `layers` and `frustumCulled` are never flipped, because that churns batch grouping.",
      "Shadow casters and objects attached to the render camera are never dropped on the main view alone. Exempt any other object with `alwaysRender`.",
      "Turning the gate off with `false` does not turn its measurement off: `TN_PROJECTION` still reports considered and skipped counts as `cull`.",
    ],
    overrides: [
      "alwaysRender(object) keeps one object drawn whatever the render camera resolves",
      "renderer.minimumProjectedPixels: false leaves the scene drawn and keeps the measurement on",
    ],
    supersedes: [],
  },
  // Also not a render stage: the per-frame world-matrix walk, which the engine owns by default and
  // a game can restore to three's every-node form. It lives here for the same reason the projection
  // above does — an agent whose profile is hot in `updateMatrixWorld` has nowhere else to find it.
  {
    symbol: "renderer.matrixWorld",
    package: "@threenative/core",
    importPath: "src/game.ts",
    kind: "function",
    signature: 'renderer.matrixWorld?: "visible" | "all"',
    summary:
      'The per-frame world-matrix walk, on by default as `"visible"`: a hidden subtree — a full-detail body behind a merged stand-in, a hidden LOD level, a parked or hangared model — is not recursed into, so nothing that cannot draw pays a world-matrix multiply. Every visible node is composed exactly as three does, a class that overrides `updateMatrixWorld` (`SkinnedMesh`, `Camera`) runs its own, and a hidden node that holds bones is still walked. `"all"` restores three\'s every-node walk.',
    situations: [
      "updateMatrixWorld and multiplyMatrices are hot in a profile",
      "the per-frame matrix walk is slow with many hidden LOD bodies or paired full/hull models",
      "stop paying for matrices of models nothing can draw",
      "a skinned mesh or camera goes stale because its world matrix was not refreshed",
      "restore three's own full updateMatrixWorld walk",
      "compare how many scene nodes the engine walks per frame",
    ],
    example:
      'renderer: { matrixWorld: "all" } // in threenative.config.ts; omit for the visible-only default',
    constraints: [
      'Unset is the shipping behaviour: `"visible"`, which does not recurse into a hidden subtree. `"all"` visits every node exactly as three\'s own `updateMatrixWorld` does.',
      "A game that reads a hidden object's `matrixWorld` directly must not rely on the walk reaching it: use `getWorldPosition`/`getWorldQuaternion`/`getWorldScale` or call `object.updateWorldMatrix(true, false)` first.",
      "The walk is the engine's either way, so three's renderer never walks the scene a second time; the count of nodes visited is reported as `matrixWorld` in every `TN_PROJECTION` window.",
      "Bones are never skipped: a hidden node that holds a `Bone` is walked, because a visible `SkinnedMesh` draws with its skeleton's matrices wherever the armature sits.",
    ],
    overrides: [
      'renderer.matrixWorld: "all" restores three\'s every-node walk; the visited count still reports',
    ],
    supersedes: [],
  },
];
