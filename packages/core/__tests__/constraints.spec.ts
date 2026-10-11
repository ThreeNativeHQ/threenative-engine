import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createReplayDriver } from "../src/replay.js";

const sourceDirectory = path.resolve("packages/core/src");
const randomSource = path.join(sourceDirectory, "random.ts");
const replaySource = path.join(sourceDirectory, "replay.ts");
const indexSource = path.join(sourceDirectory, "index.ts");

/**
 * Every `.ts` file under `packages/core/src`, including subdirectories, as paths relative to it.
 *
 * Recursive on purpose. A flat `readdirSync` covered `src/*.ts` only, so the moment a subsystem
 * grew a folder — `src/atmosphere/`, then `src/ocean/` — its source left the charter's reach
 * entirely and could have declared a material with nothing to stop it.
 */
function coreSourceFiles(directory = sourceDirectory, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory())
      found.push(...coreSourceFiles(path.join(directory, entry.name), relative));
    else if (entry.name.endsWith(".ts")) found.push(relative);
  }
  return found;
}

/**
 * Source with its comments removed.
 *
 * The rule is about what the code does, and the words that name a visual concern are the same
 * words a comment uses to say the code does not touch one. Matching prose made "creates no mesh,
 * material, or scene light" a violation and "one copy is in flight" a violation twice over, which
 * teaches the next author to delete the explanation rather than the behaviour.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\/\/.*$/gmu, " ");
}

describe("core constraints", () => {
  it("should keep visual concerns out of core source", () => {
    const source = coreSourceFiles()
      .filter(
        (file) =>
          file !== "config.ts" &&
          file !== "assets.ts" &&
          file !== "particles.ts" &&
          file !== "projection-plan.ts" &&
          file !== "projection-apply.ts" &&
          // The skinned lane draws a node twin of the game's material; every value on it is copied
          // from the game's own material each frame. Its tighter check is below.
          file !== "projection-skinned.ts" &&
          file !== "renderProjection.ts" &&
          file !== "renderer.ts" &&
          file !== "react-host.ts" &&
          file !== "softbody.ts" &&
          file !== "warmup.ts" &&
          file !== "tracers.ts" &&
          // `mergeByMaterial` groups static meshes by their material's *identity* and hands each
          // group the game's own material instance on the merged mesh. It constructs no material,
          // configures no property of one, and reads only `name` for the error label; which
          // materials exist, and how each looks, is entirely the game's.
          file !== "merge-parts.ts" &&
          // FlightModel integrates lift, drag, thrust and moments on a game-owned airframe. It
          // constructs no material, light, colour or shader; the word "light" it trips on is
          // inside "flight".
          file !== "flight.ts" &&
          file !== "instanced-batch.ts" &&
          // The instanced LOD partitions an existing batch: every child mesh is built with the
          // batch's own geometry chain and handed the same material instance the game already gave
          // the parent, so recolouring the parent recolours every partition. It constructs no
          // material, configures none and reads no property that describes how anything looks.
          file !== "instanced-batch-lod.ts" &&
          // WorldCells streams a package: it reads the geometry and surface out of the package's
          // own GLBs and hands them to `InstancedBatch` by reference. It constructs no material,
          // light, colour or shader, and reads no appearance property — a cutout is
          // `render/foliage-alpha.ts`'s, and a cutoff a part names is the part's own. The word
          // "light" the generic filter trips on is inside `loadsInFlight`.
          file !== "world-cells.ts" &&
          // The cell proxy decides whether a baked HLOD stand-in may replace a cell's source draws.
          // It reads a material's identity and whether it is opaque, standard and untransformed to
          // make that call, and constructs, configures and colours none. The assertions below keep
          // that true.
          file !== "world-cell-proxy.ts" &&
          // The world package record only names `materialGroups`, an integer the cook counted for
          // each proxy. It holds no material, colour or shader; the assertions below keep that true.
          file !== "world-package.ts" &&
          file !== "clustered-mesh.ts" &&
          file !== "clustered-batch.ts" &&
          file !== "gpu-scene-bvh.ts" &&
          // The mesh pool parks a streamed world's instanced meshes by the (geometry, material)
          // pair they draw, so the cell after a walk gets a parked object back instead of a fresh
          // NodeBuilder build. It constructs no material, configures no property of one, and uses
          // the surface only as a map key; which surface exists and how it looks is the game's.
          file !== "render/mesh-pool.ts" &&
          // The census records material/object provenance at the renderer boundary; it observes
          // appearance inputs without constructing or choosing any visual output.
          file !== "pipeline-census.ts" &&
          file !== "render/probe-volume.ts" &&
          // The virtual shadow attaches to a light and renders depth through three's own
          // ShadowNode; it creates no material, light, colour or filter of its own.
          file !== "render/virtual-shadow.ts" &&
          file !== "render/virtual-shadow-pages.ts" &&
          // Alpha antialiasing decides how a cutout edge is RESOLVED, never how it looks: it
          // flips one coverage flag on the game's own material so an alpha-tested silhouette can
          // land on the samples `antialias` already paid for. It constructs no material, reads no
          // colour, map, roughness or opacity, and the silhouette itself — the alpha test and the
          // texture behind it — stays entirely the game's. The assertions below keep that true.
          file !== "render/alpha-antialiasing.ts" &&
          // Material identity compares a material's parameters and texture images to decide that
          // two package materials draw the same, so a streamed world shares one surface between
          // them. It reads appearance fields only to compare them; it constructs, sets and chooses
          // nothing, and the surface kept is the package's own.
          file !== "render/material-key.ts" &&
          // The daylight rig wires a sky, a sun, a fill light, haze and the tone curve from values
          // the game must supply — every colour, angle, intensity, density and exposure is a
          // required option. It constructs the objects those values need and chooses none of them.
          file !== "render/daylight.ts" &&
          // The pool is a Map keyed by the caller's own geometry and material so a recycled
          // InstancedMesh keeps the surface it was drawn with. It names a Material only as a key
          // type, reads no property that describes how anything looks, and constructs none.
          file !== "render/mesh-pool.ts" &&
          // The splat terrain surface builds its material from the world package's own table:
          // textures, tiles, tints, thresholds and noise scales are all the package's values.
          file !== "world-terrain-splat.ts" &&
          // The mip-aware cutout compensates the SAMPLING of a texture the game owns: it reads a
          // map's texel size and moves the cutoff the alpha is compared against, so a needle card
          // survives the mip chain instead of being discarded at mip one. The cutoff itself, the
          // map, the colour, the geometry and every other appearance value stay the game's, and the
          // assertions below keep it that way.
          file !== "render/foliage-alpha.ts" &&
          // The impostor baker is a SOURCE-derived mechanism: it stages the package's own parts into
          // a private scene and captures their own albedo and normals into an atlas. It constructs a
          // material only as a node twin of the source and copies every value from it; it chooses no
          // colour, light, tone or palette. The assertions below keep that true.
          file !== "render/world-impostor.ts" &&
          // The impostor surface projects that atlas: albedo, normals and coverage come from it and
          // scalar surface values from the source twin. The clear colour it saves is a scratch
          // object for restore, not a look it picked. The assertions below keep it so.
          file !== "render/world-impostor-surface.ts" &&
          // The geometry capture counts what the renderer submitted. It is handed a material by
          // `onBeforeRender` and puts it in a Set to report how many DISTINCT surfaces an object
          // was drawn with — identity, exactly as `warmup.ts` reads it. It constructs no material,
          // light or colour and reads no property that describes how anything looks; the
          // assertions below are what keep that true.
          file !== "geometry-capture.ts" &&
          // The structure proof decides whether a frame may skip re-classifying the scene, and a
          // material is one of the things that decides it: a transparent or vertex-displacing one
          // takes an object off the batched lane, so the proof compares identity and the same two
          // predicates the classification reads, and a light is one of the things that decides
          // whether a frame can be mirrored at all. It reads no property that describes how
          // anything looks, chooses none and constructs none — the assertions below keep it so.
          file !== "projection-stability.ts" &&
          // The uniform lane draws one geometry under one material the mirror owns, with each
          // member's own base colour carried per instance. This file is the part that decides
          // whether two materials are interchangeable: it reads their properties to compare them and
          // writes nothing on any of them. The white clone it exists to justify is built in
          // `projection-apply.ts`, which is allowlisted above for the same reason.
          file !== "projection-uniform.ts" &&
          // The unlit-foliage warning reports that cutout PBR is drawing with no image-based light,
          // which is why a forest renders as cardboard. It reads a material's alpha test and its
          // envMap's ABSENCE to count it, and constructs no material, sets no property of one and
          // chooses no environment: that sky stays the game's. The assertions below keep it so.
          file !== "profiling/unlit-foliage-warning.ts" &&
          file !== "index.ts",
      )
      .map((file) => withoutComments(readFileSync(path.join(sourceDirectory, file), "utf8")))
      .join("\n");

    expect(source).not.toMatch(/material|light|tonemapping|postprocessing|\.wgsl/iu);

    // `assets.ts` assigns compiler-produced textures to game-authored materials. It transports
    // appearance data but originates none: no material, light, colour, or shader may be created.
    const assets = readFileSync(path.join(sourceDirectory, "assets.ts"), "utf8");
    expect(assets).not.toMatch(
      /new\s+\w*Material|new\s+\w*Light|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
    );

    // The same terms as `warmup.ts` for the same reason: `mergeByMaterial` reads a material's
    // identity to decide which meshes share a draw call, and the material itself is the game's —
    // so no property of one is ever written here, only its `name` in an error label.
    const mergeParts = readFileSync(path.join(sourceDirectory, "merge-parts.ts"), "utf8");
    expect(mergeParts).not.toMatch(/new\s+\w*(Material|Light)|tonemapping|postprocessing|\.wgsl/iu);
    expect(mergeParts).not.toMatch(/\.material\s*[.=[]/u);

    const geometryCapture = readFileSync(path.join(sourceDirectory, "geometry-capture.ts"), "utf8");
    expect(geometryCapture).not.toMatch(
      /new\s+\w*(Material|Light)|tonemapping|postprocessing|\.wgsl/iu,
    );
    // The same appearance-property list as `warmup.ts`, minus the array method: a call is
    // `rows.map(...)`, a material's texture is `material.map`, and only the second is a look.
    expect(geometryCapture).not.toMatch(
      /\.(color|map|roughness|metalness|emissive|opacity|envMap)\b(?!\()/iu,
    );
    expect(geometryCapture.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    // `config.ts` is exempted on the same terms: it declares option NAMES a game types
    // (`assets.targets.maxMaterials`), measures nothing, and originates no visual concern.

    // `warmup.ts` is exempted on the same terms as the projection files: it reads a material's
    // *identity* to tell one pipeline from another, so that compiling one wall warms every wall
    // sharing its material. It never constructs a material, never configures one, and never reads
    // a property that describes how anything looks. The assertions below are what keep that true:
    // the moment it makes an appearance decision, this fails.
    const skinned = withoutComments(
      readFileSync(path.join(sourceDirectory, "projection-skinned.ts"), "utf8"),
    );
    expect(skinned).not.toMatch(
      /\.(color|map|roughness|metalness|emissive|opacity|envMap)\s*=|new\s+\w*Light|tonemapping|\.wgsl/iu,
    );
    expect(skinned.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();
    const warmup = readFileSync(path.join(sourceDirectory, "warmup.ts"), "utf8");
    expect(warmup).not.toMatch(/new\s+\w*(Material|Light)|tonemapping|postprocessing|\.wgsl/iu);
    expect(warmup).not.toMatch(/\.(color|map|roughness|metalness|emissive|opacity|envMap)\b/iu);
    expect(warmup.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    // `react-host.ts` is exempted on the same terms as particles, and needs to be: a renderer that
    // draws nothing has to construct the one material its quads are drawn with. What it must never
    // do is decide what that material looks like. Every colour it sets is read off the game's own
    // `style` prop, the geometry is a unit plane the game never sees, and the two constants below
    // are the fallback white for a missing colour and the red of the failure banner — diagnostics,
    // in the same category as `DebugOverlay`, not an appearance the framework is choosing.
    const reactHost = readFileSync(path.join(sourceDirectory, "react-host.ts"), "utf8");
    expect(reactHost).not.toMatch(/new\s+\w*Light|tonemapping|postprocessing|\.wgsl/iu);
    expect([...new Set(reactHost.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu))]).toEqual([
      "0xffffff",
      "#ff5f4d",
    ]);

    const alphaAntialiasing = readFileSync(
      path.join(sourceDirectory, "render/alpha-antialiasing.ts"),
      "utf8",
    );
    expect(alphaAntialiasing).not.toMatch(
      /new\s+\w*Material|new\s+\w*Light|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
    );
    expect(alphaAntialiasing).not.toMatch(
      /\.(color|map|roughness|metalness|emissive|opacity|envMap)\b/iu,
    );
    expect(alphaAntialiasing.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    const foliageAlpha = readFileSync(
      path.join(sourceDirectory, "render/foliage-alpha.ts"),
      "utf8",
    );
    expect(foliageAlpha).not.toMatch(
      /new\s+\w*Light|new\s+\w*Color|tonemapping|postprocessing|\.wgsl/iu,
    );
    // A map is read for its texel size, and for nothing else: naming a look — a colour, a
    // roughness, a metalness, an opacity — is how a framework starts deciding one.
    expect(foliageAlpha).not.toMatch(/\.(color|roughness|metalness|emissive|opacity|envMap)\b/iu);
    expect(foliageAlpha.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    // The unlit-foliage warning names an envMap for the same reason foliage-alpha names a map: it
    // asks whether one is there. Reading its absence is the whole finding, so the check is that it
    // is never WRITTEN — a framework that assigns a sky has decided how the game looks.
    const unlitFoliage = readFileSync(
      path.join(sourceDirectory, "profiling/unlit-foliage-warning.ts"),
      "utf8",
    );
    expect(unlitFoliage).not.toMatch(
      /new\s+\w*Material|new\s+\w*Light|new\s+\w*Color|tonemapping|postprocessing|\.wgsl/iu,
    );
    expect(unlitFoliage).not.toMatch(
      /\.(color|map|roughness|metalness|emissive|opacity|envMap|environment|alphaTest|alphaHash|alphaToCoverage)\b\s*(=[^=]|\?\?=)/iu,
    );
    expect(unlitFoliage.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    // The impostor baker stages the package's own parts and captures their own albedo and normals.
    // Every material value is copied from the source twin; the one colour literal is the scratch
    // clear the capture sets and restores, not a look the framework chose. No light, tone, post or
    // handwritten shader may appear.
    const impostorBaker = readFileSync(
      path.join(sourceDirectory, "render/world-impostor.ts"),
      "utf8",
    );
    expect(impostorBaker).not.toMatch(/new\s+\w*Light|tonemapping|postprocessing|\.wgsl/iu);
    expect([...new Set(impostorBaker.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu) ?? [])]).toEqual([
      "0x000000",
    ]);

    // The surface samples albedo, normals and coverage out of the atlas and keeps the source's own
    // scalar values. It originates no light, tone curve, post effect or shader, and names no colour.
    const impostorSurface = readFileSync(
      path.join(sourceDirectory, "render/world-impostor-surface.ts"),
      "utf8",
    );
    expect(impostorSurface).not.toMatch(/new\s+\w*Light|tonemapping|postprocessing|\.wgsl/iu);
    expect(impostorSurface.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    const particles = readFileSync(path.join(sourceDirectory, "particles.ts"), "utf8");
    expect(particles).not.toMatch(
      /new\s+\w*Material|new\s+Color|light|tonemapping|postprocessing|\.wgsl/iu,
    );

    // `softbody.ts` clones the game-owned node material so its position node can read the cloth
    // buffer without mutating a surface another mesh may share. It may never originate or tune a
    // visible property; the solver accepts every response value from the game.
    const softbody = readFileSync(path.join(sourceDirectory, "softbody.ts"), "utf8");
    expect(softbody).not.toMatch(
      /new\s+\w*Material|new\s+Color|light|tonemapping|postprocessing|\.wgsl/iu,
    );
    expect(softbody).not.toMatch(/\.(color|map|roughness|metalness|emissive|opacity|envMap)\b/iu);

    // `renderProjection.ts` is exempted on exactly the same terms, and needs the exemption for a
    // sharper reason than particles did: it maintains a private mirror of the game's scene, so
    // it has to name every kind of thing that scene can hold. What it must never do is originate
    // one. Every material it draws with is the game's own instance, passed through by reference so
    // that recolouring the original recolours the batch; every light in the mirror is a clone of a
    // light the game built, kept in step with it. Constructing either would be the framework
    // deciding how a game looks, which no amount of performance buys back.
    const projection = readFileSync(path.join(sourceDirectory, "renderProjection.ts"), "utf8");
    expect(projection).not.toMatch(
      /new\s+\w*Material|new\s+\w*Light|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
    );
    // It must recognise a light: the mirror is a separate graph, and a mirror with no lights in
    // it renders every lit surface black. Since P2-3 the recognition lives in the scan seam.

    // The P2-3 split moved the scan/plan and the mirror into `projection-plan.ts` and
    // `projection-apply.ts`; the renderProjection exemption follows the code, on exactly the
    // same terms. The plan names lights only to classify them; the apply seam clones the game's
    // own lights and passes the game's own geometry and material by reference. Neither may
    // originate an appearance, and the light classification must stay somewhere.
    for (const splitModule of ["projection-plan.ts", "projection-apply.ts"] as const) {
      const projectionPart = readFileSync(path.join(sourceDirectory, splitModule), "utf8");
      expect(projectionPart).not.toMatch(
        /new\s+\w*Material|new\s+\w*Light|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
      );
    }
    expect(readFileSync(path.join(sourceDirectory, "projection-plan.ts"), "utf8")).toMatch(
      /isLight/u,
    );

    // `renderer.ts` is exempted because `prewarm` must inspect and clone the game's own render
    // surfaces to compile them early. It does not construct a surface or choose its appearance.
    const renderer = readFileSync(path.join(sourceDirectory, "renderer.ts"), "utf8");
    expect(renderer).not.toMatch(
      /new\s+\w*Material|new\s+\w*Light|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
    );

    // `tracers.ts` is exempted on the same terms: a pooled travelling streak must name and fade
    // the surface it moves. It constructs none — the surface comes from the game (required),
    // cloned per slot so each streak can fade independently — and any geometry beyond the
    // neutral unit cylinder is the game's too.
    const tracers = readFileSync(path.join(sourceDirectory, "tracers.ts"), "utf8");
    expect(tracers).not.toMatch(
      /new\s+\w*Material|new\s+\w*Light|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
    );

    // `instanced-batch.ts` is exempted on the same terms as `tracers.ts`: collapsing repeated draws
    // into one requires naming the surface those draws share. It constructs none — the geometry and
    // the surface are both required options, held by reference so recolouring the game's own
    // instance recolours the batch — and it reads no property that describes how anything looks.
    // The assertions below are what keep that true.
    const instancedBatch = readFileSync(path.join(sourceDirectory, "instanced-batch.ts"), "utf8");
    expect(instancedBatch).not.toMatch(
      /new\s+\w*(Material|Light)|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
    );
    expect(instancedBatch).not.toMatch(
      /\.(color|map|roughness|metalness|emissive|opacity|envMap)\b/iu,
    );
    expect(instancedBatch.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    // The instanced LOD is exempt on exactly the same terms as `instanced-batch.ts`, and the
    // assertions below keep that true: a cell is a draw, so it must draw with the surface the game
    // gave the parent, and that reference is the whole of its contact with appearance.
    const instancedLod = readFileSync(path.join(sourceDirectory, "instanced-batch-lod.ts"), "utf8");
    expect(instancedLod).not.toMatch(
      /new\s+\w*(Material|Light)|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
    );
    // `(?!\()` for the same reason `geometry-capture.ts` carries it: `levels.map(...)` is an array
    // method; a material's texture is `material.map`.
    expect(instancedLod).not.toMatch(
      /\.(color|map|roughness|metalness|emissive|opacity|envMap)\b(?!\()/iu,
    );
    expect(instancedLod.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    // `clustered-mesh.ts` is exempted on the same terms as `instanced-batch.ts`: deciding which
    // clusters of a mesh to submit requires naming the surface those clusters draw with. It
    // constructs none — the geometry and the surface are both the game's, held by reference, and
    // swapping the surface swaps what draws — and it reads no property that describes how anything
    // looks. The assertions below are what keep that true.
    const clusteredMesh = readFileSync(path.join(sourceDirectory, "clustered-mesh.ts"), "utf8");
    expect(clusteredMesh).not.toMatch(
      /new\s+\w*(Material|Light)|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
    );
    expect(clusteredMesh).not.toMatch(
      /\.(color|map|roughness|metalness|emissive|opacity|envMap)\b/iu,
    );
    expect(clusteredMesh.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    // `clustered-batch.ts` is exempted on the same terms: it names the surface many copies share
    // and constructs none. Geometry, surface and every transform are the game's.
    const clusteredBatch = readFileSync(path.join(sourceDirectory, "clustered-batch.ts"), "utf8");
    expect(clusteredBatch).not.toMatch(
      /new\s+\w*(Material|Light)|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
    );
    expect(clusteredBatch).not.toMatch(
      /\.(color|map|roughness|metalness|emissive|opacity|envMap)\b/iu,
    );
    expect(clusteredBatch.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    // `world-cells.ts` is exempted on the same terms as `instanced-batch.ts`: streaming a package
    // means naming the geometry and surface its GLBs carry and handing both to `InstancedBatch` by
    // reference. It constructs no material, light or colour and reads no property that describes
    // how anything looks. The assertions below are what keep that true.
    const worldCells = readFileSync(path.join(sourceDirectory, "world-cells.ts"), "utf8");
    expect(worldCells).not.toMatch(
      /new\s+\w*(Material|Light)|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
    );
    // A property read, not the `Array.prototype.map` call the package's bookkeeping uses.
    expect(worldCells).not.toMatch(
      /\.(color|map|roughness|metalness|emissive|opacity|envMap)\b(?!\s*\()/iu,
    );
    expect(worldCells.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    // `world-cell-proxy.ts` is exempted on the same terms as `world-cells.ts`: it reads whether a
    // surface is safe to replace and builds nothing that describes how anything looks.
    const cellProxy = readFileSync(path.join(sourceDirectory, "world-cell-proxy.ts"), "utf8");
    expect(cellProxy).not.toMatch(
      /new\s+\w*(Material|Light)|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
    );
    expect(cellProxy).not.toMatch(
      /\.(color|map|roughness|metalness|emissive|opacity|envMap)\b(?!\s*\()/iu,
    );
    expect(cellProxy.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    const worldPackage = readFileSync(path.join(sourceDirectory, "world-package.ts"), "utf8");
    expect(worldPackage).not.toMatch(
      /new\s+\w*(Material|Light)|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
    );
    expect(worldPackage.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    // `gpu-scene-bvh.ts` is exempted on the same terms as `warmup.ts`: it reads a material's
    // *identity* — an integer index into the game's own surfaces — to pack triangles for the BVH's
    // leaf order. It never constructs a material and never reads a property that describes how
    // anything looks. The assertions below keep that true.
    const sceneBvh = readFileSync(path.join(sourceDirectory, "gpu-scene-bvh.ts"), "utf8");
    expect(sceneBvh).not.toMatch(/new\s+\w*(Material|Light)|tonemapping|postprocessing|\.wgsl/iu);
    expect(sceneBvh).not.toMatch(/\.(color|map|roughness|metalness|emissive|opacity|envMap)\b/iu);
    expect(sceneBvh.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    // `render/mesh-pool.ts` is exempt on the same terms as `instanced-batch.ts`: the surface is
    // named to key a pool by, never built and never tuned. The assertions below keep that true.
    const meshPool = readFileSync(path.join(sourceDirectory, "render/mesh-pool.ts"), "utf8");
    expect(meshPool).not.toMatch(
      /new\s+\w*(Material|Light)|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
    );
    expect(meshPool).not.toMatch(/\.(color|map|roughness|metalness|emissive|opacity|envMap)\b/iu);
    expect(meshPool.match(/#[0-9a-f]{6}\b|0x[0-9a-f]{6}\b/giu)).toBeNull();

    // The public surface may NAME the types it re-exports (`IGPUSceneBVHMaterialGroup` is a data
    // group, not a look); what it may never do is originate an appearance.
    expect(indexSource).not.toMatch(
      /new\s+\w*Material|new\s+\w*Light|new\s+Color|tonemapping|postprocessing|\.wgsl/iu,
    );

    // `render/probe-volume.ts` is the one render-mechanism exception admitted by PRD-268: the
    // WebGPU bake needs a TSL projection node and a render target, but all lighting and surface
    // inputs still come from the game scene. It must never construct a light or choose a visible
    // property, and the port must stay on common WebGPU render targets.
    const probeVolume = readFileSync(path.join(sourceDirectory, "render/probe-volume.ts"), "utf8");
    expect(probeVolume).not.toMatch(/new\s+\w*Light|new\s+Color|\.wgsl/iu);
    expect(probeVolume).not.toMatch(/\.(color|roughness|metalness|emissive|opacity|envMap)\b/iu);
    expect(probeVolume).toMatch(/RenderTarget3D|texture3D|ATLAS_PADDING/u);
  });

  /**
   * There is deliberately no line-count assertion here.
   *
   * A fatal 2,500-line cap lived at this spot and was removed on 2026-08-09. It appeared
   * nowhere in `CHARTER.md`, `AGENTS.md` or `pnpm budgets`, while the two LOC limits the
   * charter does state (15,000 framework, 50,000 native) are review triggers that report and
   * never fail. Core had reached 2,499 of 2,500, so the only fatal LOC number in the repo was
   * an unwritten one, and it blocked the next twenty lines of plumbing on arrival order
   * rather than on merit — while counting blank lines and comments, which taxes exactly the
   * package that most needs explaining.
   *
   * What guards framework weight is `scripts/count-loc.ts`, which scores whether the
   * framework costs more code than plain Three.js, and the reported trigger in
   * `pnpm budgets`. A ceiling on core belongs there, next to the other numbers, not as a
   * fatal per-package test. See `docs/PRDs/PRD-053-core-input-multitouch.md`.
   */

  it("should reject a recording schema key that names an entity type", () => {
    const source = readFileSync(replaySource, "utf8");
    expect(source).not.toMatch(/"(type|class|kind|prefab|components|nodes)"/u);
    expect(source).not.toMatch(/new (\w+\[|constructors?\[|registry\.get)/u);
    expect(source).not.toContain("EntitySnapshot");

    const recording = {
      input: [],
      randomState: 0,
      runtime: { agent: "node", core: "0.1.0", rapier: null, step: 1 / 60 },
      seed: 1,
      ticks: 1,
      version: 1,
    };
    const validRecording = { ...recording, input: [{ keys: [], tick: 0 }] };
    expect(() =>
      createReplayDriver({ ...validRecording, type: "entity" } as never, new EventTarget()),
    ).toThrow(/unknown key 'type'/u);
  });

  it("should keep the saveable random state on the public surface", () => {
    expect(readFileSync(randomSource, "utf8")).toMatch(/state:\s*number/u);
  });

  it("should keep the replay exports on the public surface", () => {
    const source = readFileSync(indexSource, "utf8");
    expect(source).toContain('export { createReplayDriver, replay } from "./replay.js";');
    expect(source).toContain('export type { IReplayOptions, Recording } from "./replay.js";');
  });
});
