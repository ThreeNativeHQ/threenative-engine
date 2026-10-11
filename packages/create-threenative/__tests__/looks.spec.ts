import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { qualityPreset } from "../templates/starter/src/render/quality.js";

const starter = path.resolve("packages/create-threenative/templates/starter");
// PRD-449: engine-only guards, copied into the scaffold by `pnpm test:templates` rather than
// shipped inside it.
const templatePlaytests = path.resolve("packages/create-threenative/template-playtests/starter");
const minimal = path.resolve("packages/create-threenative/templates/minimal");
const platformer = path.resolve("packages/create-threenative/templates/platformer");
const templatesRoot = path.resolve("packages/create-threenative/templates");
const bootErrorSelector = '[data-threenative-canvas-error="true"]';
const requiredBootErrorDeclarations = [
  ["position", "fixed"],
  ["inset", "0"],
  ["z-index", "1000"],
  ["display", "grid"],
  ["place-items", "center"],
  ["overflow-wrap", "anywhere"],
] as const;
const bootErrorColour = /^(?:#[\da-f]{6}|var\(--[\w-]+\))$/iu;

describe("starter visual floor", () => {
  it("should provide readable dynamic-range defaults without framework imports", async () => {
    const files = await Promise.all(
      ["lighting.ts", "postprocessing.ts", "worldEnvironment.ts", "materials.ts"].map((file) =>
        readFile(path.join(starter, "src/render", file), "utf8"),
      ),
    );
    const source = files.join("\n");
    expect(source).toContain("shadow");
    expect(source).toContain("ACESFilmicToneMapping");
    expect(source).not.toContain("@threenative/");
  });

  it("should route setupPost through the framework output node", async () => {
    const [post, environment] = await Promise.all([
      readFile(path.join(starter, "src/render/postprocessing.ts"), "utf8"),
      readFile(path.join(starter, "src/render/worldEnvironment.ts"), "utf8"),
    ]);
    const play = await readFile(path.join(starter, "src/scenes/Play.ts"), "utf8");
    expect(`${post}\n${environment}`).toContain("createRenderChain");
    expect(`${post}\n${environment}`).toContain("bloom");
    expect(play).toContain("setupPost");
  });

  it("should keep the kit's look in its own render folder, never in the shared chain", async () => {
    // `worldEnvironment.ts` is the plumbing every kit copies verbatim, so this kit's aesthetic must
    // not be inside it — `shared-render-sources.spec.ts` fails when it is, and this says why in
    // one place. What replaced the authored paint stages is the grid: three materials, two greys
    // and one saturated colour, with world-metre UVs.
    const [environment, materials, arena] = await Promise.all([
      readFile(path.join(starter, "src/render/worldEnvironment.ts"), "utf8"),
      readFile(path.join(starter, "src/render/materials.ts"), "utf8"),
      readFile(path.join(starter, "src/render/arena.ts"), "utf8"),
    ]);
    expect(environment).toContain("createRenderChain");
    expect(environment).not.toMatch(/create(?:Outline|Kuwahara|Watercolor)Stage/u);
    expect(`${materials}\n${arena}`).toMatch(/gridTexture\(|worldGridUVs/u);
    // One grid tile is one metre on every face of every prop, whichever axis dominates.
    expect(materials).toContain("export function worldGridUVs");
  });

  it("should ship the deleted painterly stages as no fields at all", async () => {
    // The three authored paint stages and the rock ridge are gone from the generated source, not
    // left dormant behind a false switch. What is asserted now is the fact behind the deletion:
    // a photographed sky under one sun carries the shading, so the chain asks for occlusion,
    // bloom, vignette and the tone curve and nothing that smears the frame's contrast.
    const quality = await readFile(path.join(starter, "src/render/quality.ts"), "utf8");
    const post = await readFile(path.join(starter, "src/render/postprocessing.ts"), "utf8");
    for (const stage of ["outline", "kuwahara", "watercolor", "ridge", "scenery", "coast"]) {
      expect(`${quality}\n${post}`, `${stage} wiring`).not.toMatch(
        new RegExp(`${stage}[A-Za-z]*(?:Enabled|Stage|Stages)\\b`, "u"),
      );
    }
    expect(quality).toContain("gtaoEnabled: true");
    expect(quality).toContain("bloomEnabled: true");
    expect(quality).toContain("vignetteAmount:");
  });

  it("should keep the metre grid on the same byte layout minimal ships", async () => {
    // Two kits now build the same arena, and a generated project must not get two subtly different
    // grids. The three grid builders are compared function by function, so a change to one is a
    // change to both.
    const definitions = async (root: string): Promise<string[]> => {
      const source = await readFile(path.join(root, "src/render/materials.ts"), "utf8");
      return ["gridTexture", "grainNormalTexture", "worldGridUVs"].map((name) => {
        const start = source.indexOf(`function ${name}`);
        if (start < 0) throw new Error(`${root}/materials.ts has no ${name}.`);
        let depth = 0;
        for (let index = source.indexOf("{", start); index < source.length; index += 1) {
          if (source[index] === "{") depth += 1;
          else if (source[index] === "}") depth -= 1;
          if (depth === 0) return source.slice(start, index + 1);
        }
        throw new Error(`${root}/materials.ts has an unterminated ${name}.`);
      });
    };
    expect(await definitions(starter)).toEqual(await definitions(minimal));
  });

  it("should gather occlusion with fewer samples on medium than high", () => {
    const highPreset = qualityPreset("high");
    const mediumPreset = qualityPreset("medium");
    const highSamples = highPreset.gtaoSamples ?? 16;
    expect(highSamples).toBe(16);
    expect(mediumPreset.gtaoSamples).toBe(8);
    expect(mediumPreset.gtaoSamples).toBeLessThan(highSamples);
  });

  it("should ship no contrast-reducing stage at any tier", () => {
    // The shipped look is graded by bloom, vignette and the tone curve, and nothing smears the
    // image's contrast on the way there.
    for (const tier of ["high", "medium", "low"] as const) {
      const preset = qualityPreset(tier);
      expect(preset.ssrEnabled, tier).toBeFalsy();
      expect(preset.ssgiEnabled, tier).toBeFalsy();
      expect(preset.sharpenEnabled, tier).toBeFalsy();
    }
  });

  it("should remove debug materials and wire live shadows", async () => {
    const files = await Promise.all([
      readFile(path.join(starter, "src/entities/Player.ts"), "utf8"),
      readFile(path.join(starter, "src/entities/Crate.ts"), "utf8"),
      readFile(path.join(starter, "src/scenes/Play.ts"), "utf8"),
      readFile(path.join(minimal, "src/entities/Player.ts"), "utf8"),
      readFile(path.join(minimal, "src/scenes/Play.ts"), "utf8"),
    ]);
    expect(files.join("\n")).not.toContain("MeshNormalMaterial");
    // Light grid on the walking surface, dark grid on the sides, one saturated prop: three
    // materials, and the arena is the only thing that chooses between them.
    const materials = await readFile(path.join(starter, "src/render/materials.ts"), "utf8");
    expect(materials).toMatch(/floorMaterial[\s\S]*structureMaterial[\s\S]*propMaterial/u);
    expect(await readFile(path.join(starter, "src/render/lighting.ts"), "utf8")).toContain(
      "shadowMap.enabled = true",
    );
    expect(files.join("\n")).toContain("receiveShadow = true");
  });

  it("should keep generated render files readable and framework-free", async () => {
    // This used to cap every render file at 20 lines, which was CHARTER §11
    // rule 1 applied to the one folder rule 3 sends the look to. The result
    // was a 47-line visual floor: three materials and a three-light rig, no
    // rounded geometry, no rim light. Every scaffolded project then had to
    // rediscover the entire look, and agents — graded by typecheck, lint and
    // playtests, none of which can see a pixel — mostly did not.
    //
    // The rule that actually matters here is ownership, not length: these
    // files must stay plain Three.js the user can rewrite, never a framework
    // reaching back in. The cap is now a smell test for a hidden engine.
    const roots = [starter, minimal, platformer];
    const files = await Promise.all(
      roots.flatMap(async (root) => {
        const names = await renderFiles(path.join(root, "src/render"));
        return Promise.all(
          names.map(async (file) => [file, await readFile(file, "utf8")] as const),
        );
      }),
    );
    for (const entries of files) {
      for (const [name, source] of entries) {
        expect(source, name).not.toContain("@threenative/");
        // Loading is the one generated surface that carries real startup behavior: safe-area
        // layout, texture crops, truthful progress and disposal. Its source stays game-owned; the
        // old 200-line smell cap must not reject that behavior.
        // WorldEnvironment is the starter's complete, Godot-named visual recipe. It intentionally
        // carries the stage contracts and their reasons in one editable file; the ownership check
        // above still prevents it from becoming a hidden framework import.
        // AutoExposureNode sequences five GPU passes (meter, reduce, histogram tiles, histogram
        // bins, adapt) with their disposal. It stays plain Three.js the game can rewrite, so the
        // ownership check above is the rule that matters for it.
        if (
          !name.endsWith("loading.ts") &&
          !name.endsWith("worldEnvironment.ts") &&
          !name.endsWith("autoExposure.ts")
        )
          expect(source.trimEnd().split("\n").length, name).toBeLessThan(200);
      }
    }
  });

  it("should refuse godrays by name when the shadow map is not allocated yet", async () => {
    // `castShadow` is a request, not a result: three allocates the shadow map on the first render
    // that needs it, and GodraysNode reads `shadow.map.depthTexture` while the graph is built.
    // Reading it too early throws inside TSL, which fails the whole chain build — so SSGI, SSR,
    // bloom and the tonemap all vanish with it and the frame comes back ungraded. That reads as a
    // broken scene rather than a missing shadow map, and it cost a day of the cave scene.
    //
    // The stage list's contract is that an unavailable stage is refused **by name, with a
    // reason**, leaving the rest of the chain intact. Guarding the map is what keeps that promise.
    const templateRoot = path.join(starter, "..");
    const templates = (await readdir(templateRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      const source = await readFile(
        path.join(templateRoot, template, "src/render/worldEnvironment.ts"),
        "utf8",
      );
      const guard = source.slice(source.indexOf('name: "godRays"'));
      expect(guard.slice(0, guard.indexOf("build:")), template).toContain("shadow?.map == null");
    }
  });

  it("should ship a rounded-geometry floor rather than raw boxes", async () => {
    // A sharp BoxGeometry reads as Minecraft; the same box with a corner
    // radius reads as a toy. Shipping this is most of the difference between
    // a generated project that looks designed and one that looks like a test
    // scene, and it is far too long to expect an agent to rederive.
    const shapes = await readFile(path.join(starter, "src/render/shapes.ts"), "utf8");
    expect(shapes).toContain("export function roundedBox");
    expect(shapes).toContain("mergeVertices");
    expect(shapes).toContain("computeVertexNormals");
    expect(shapes).not.toContain("Math.random(");

    // Deterministic scatter: `Math.random` makes a screenshot diff meaningless, because you
    // cannot tell a bug from a reroll. This used to be asserted by requiring `shapes.ts` to
    // export its own `makeRandom` — a hand-rolled LCG that was a line-for-line copy of the
    // `createRandom` the framework already exports with a `@supersedes Math.random(` tag, which
    // taught every cold agent reading the starter to write the copy rather than the import.
    // The seeded source now comes from the framework and is threaded in from the scene, because
    // `src/render/` may not import a framework package. Assert the property, not the copy:
    // the level is seeded, and nothing in the chain reaches for `Math.random`.
    const play = await readFile(path.join(starter, "src/scenes/Play.ts"), "utf8");
    const arena = await readFile(path.join(starter, "src/render/arena.ts"), "utf8");
    expect(play).toContain("createRandom");
    expect(play).toContain("ctx.random.range");
    expect(play).not.toContain("Math.random(");
    expect(arena).not.toContain("Math.random(");
  });

  it("should keep the look scenario on the frame the arena now draws", async () => {
    const scenario = JSON.parse(
      await readFile(path.join(templatePlaytests, "look.playtest.json"), "utf8"),
    ) as {
      assert?: {
        camera?: { entity?: string; follows?: string; within?: number };
        movement?: { entity?: string; minDistance?: number };
        renderChain?: {
          contributions?: Record<string, string[]>;
          stages?: { includes?: string[] };
        };
        resources?: Array<{
          atSteps?: Array<{ label: string; textIncludes?: string }>;
          id?: string;
          path?: string;
        }>;
        visual?: Array<{ region?: { maxDarkPixelRatio?: number; minNonblankPixelRatio?: number } }>;
      };
      steps: Array<{ holdTicks?: number; kind?: string; label?: string; press?: string }>;
      warmupFrames?: number;
    };
    // The arena is built in the first frame, so there is no preview wait to prove any more: the
    // scenario is move, settle, and read the frame the camera is actually pointing at.
    expect(scenario.steps.map(({ label }) => label)).toEqual([
      "scene-ready",
      "move-across-the-platform",
      "frame-settles",
    ]);
    expect(scenario.warmupFrames).toBe(1);
    expect(scenario.steps[1]).toMatchObject({
      holdTicks: 140,
      kind: "input",
      press: "ArrowRight",
    });
    expect(scenario.assert?.camera).toMatchObject({ entity: "camera.main", follows: "player" });
    expect(scenario.assert?.movement).toMatchObject({ entity: "player", minDistance: 4 });
    // AO, bloom and vignette are the chain this kit ships, `grade` and `grain` are the two stages
    // its own `src/render/grade.ts` adds, and each one is proved to have changed the graph output
    // rather than being reported as applied.
    expect(scenario.assert?.renderChain?.stages?.includes).toEqual([
      "ambientOcclusion",
      "bloom",
      "vignette",
      "grade",
      "grain",
    ]);
    expect(Object.keys(scenario.assert?.renderChain?.contributions ?? {})).toEqual([
      "graphOutputChanged",
    ]);
    expect(scenario.assert?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          atSteps: [{ label: "move-across-the-platform", textIncludes: "." }],
          id: "state",
          path: "odometer",
        }),
      ]),
    );
    // The frame is graded, not black. `maxLuminance` is the guard that matters: a black or
    // unlit capture still counts as "non-blank", so the dark-pixel ceiling is a design bound —
    // this is a dark-grid arena, and its walls, pillar and platform flanks are a quarter of the
    // frame by design. The floor is the other half of that: a frame that lost its dark structure
    // is as wrong as one that drowned in it.
    const regions = (scenario.assert?.visual ?? [])
      .flatMap((entry) => (entry.region === undefined ? [] : [entry.region]))
      .filter((region): region is NonNullable<typeof region> => region !== undefined);
    expect(regions).toHaveLength(3);
    const [whole, sky, middle] = regions as [
      {
        maxDarkPixelRatio?: number;
        maxLuminance?: number;
        minDarkPixelRatio?: number;
        minNonblankPixelRatio?: number;
      },
      { maxDarkPixelRatio?: number; maxLuminance?: number; minNonblankPixelRatio?: number },
      { minNonblankPixelRatio?: number },
    ];
    expect(whole?.minNonblankPixelRatio).toBeGreaterThan(0.9);
    expect(whole?.maxLuminance).toBeLessThan(0.3);
    expect(whole?.minDarkPixelRatio).toBeGreaterThan(0);
    expect(whole?.maxDarkPixelRatio).toBeGreaterThan(0.3);
    expect(sky?.minNonblankPixelRatio).toBeGreaterThan(0.9);
    expect(sky?.maxLuminance).toBeLessThan(0.3);
    expect(sky?.maxDarkPixelRatio).toBeGreaterThan(0.2);
    expect(middle?.minNonblankPixelRatio).toBeGreaterThan(0.5);
  });

  it("should tell the generated project what the arena is and what replaced the coast", async () => {
    const [arena, play, instructions, mirror] = await Promise.all([
      readFile(path.join(starter, "src/render/arena.ts"), "utf8"),
      readFile(path.join(starter, "src/scenes/Play.ts"), "utf8"),
      readFile(path.join(starter, "AGENTS.md"), "utf8"),
      readFile(path.join(starter, "CLAUDE.md"), "utf8"),
    ]);
    // The generated instructions are the product: an agent editing this game has to be told the
    // scene is a test arena and where its parts live, or it will go looking for the coast.
    for (const text of [instructions, mirror]) {
      expect(text).toContain("arena.ts");
      expect(text).toContain("test arena");
      expect(text).toContain("grid");
    }
    // Two solids per platform and one fixed body each: the collider is the triangles on screen.
    expect(arena).toContain("export function platform");
    expect(play).toContain("createArena()");
    for (const name of [
      "arena.solids",
      'CollisionShape3D.fromMesh(mesh, "trimesh")',
      'type: "fixed"',
    ]) {
      expect(play, name).toContain(name);
    }
  });

  it("should not ship an unused high-poly sculpture helper", async () => {
    const [shapes, play] = await Promise.all([
      readFile(path.join(starter, "src/render/shapes.ts"), "utf8"),
      readFile(path.join(starter, "src/scenes/Play.ts"), "utf8"),
    ]);
    expect(shapes).not.toContain("TorusKnotGeometry");
    expect(shapes).not.toContain("export function sculpture");
    expect(play).not.toContain("sculpture");
  });

  it("should light silhouettes with a rim, not just a key", async () => {
    for (const root of [starter, minimal, platformer]) {
      const lighting = await readFile(path.join(root, "src/render/lighting.ts"), "utf8");
      const sky = await readFile(path.join(root, "src/render/sky.ts"), "utf8");
      // An image-based environment puts the sky's own highlight on every silhouette, which is the
      // job the rim light was doing; `minimal` lights with its sky photograph instead of a rim.
      if (/scene\.environment\s*=/u.test(sky)) expect(sky).toContain("environmentIntensity");
      else expect(lighting).toContain("const rim = new DirectionalLight");
      expect(lighting).toContain("PCFSoftShadowMap");
      expect(lighting).toContain("normalBias");
    }
  });

  it("should tell the user's agent to budget effort for the look", async () => {
    // The only thing in this project that can judge the look is a person
    // reading a screenshot. Every automated gate passes on grey boxes, so if
    // the generated instructions do not say "go look at it", the agent
    // optimises what it can measure and ships grey boxes. This assertion
    // exists because that instruction is load-bearing, not decorative.
    const visualSkill = await readFile(
      path.resolve(
        "packages/create-threenative/agent-files/.agents/skills/threenative-visuals/SKILL.md",
      ),
      "utf8",
    );
    expect(visualSkill).toContain("grey boxes and a black screen");
    expect(visualSkill).toContain("A black headless capture is a capture failure");
    expect(visualSkill).toMatch(/browser automation|browser tool/);
    for (const root of [starter, minimal, platformer]) {
      const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");
      expect(agents).toContain("Budget real time for the look");
      expect(agents).toContain(".agents/skills/threenative-visuals/SKILL.md");
      // AGENTS.md is the source; CLAUDE.md is generated from it by pnpm
      // sync:agents, so it has to carry the same instruction.
      const mirror = await readFile(path.join(root, "CLAUDE.md"), "utf8");
      expect(mirror).toContain("Budget real time for the look");
    }
  });

  it("should declare Tailwind sources so HUD classes cannot silently do nothing", async () => {
    // With no sources, Tailwind still builds — it emits the theme and zero
    // utilities, and every class in src/ui/ becomes an inert string.
    const css = await readFile(path.join(starter, "src/style.css"), "utf8");
    expect(css).toContain('@import "tailwindcss"');
    expect(css).toContain("@source");
    expect(css).toContain("@theme");
  });

  it("should keep concrete boot-error defaults in every generated template", async () => {
    const templates = (await readdir(templatesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(templates.length).toBeGreaterThan(0);

    for (const template of templates) {
      const style = await readFile(path.join(templatesRoot, template, "src/style.css"), "utf8");
      const rule = cssRule(style, bootErrorSelector);
      expect(rule, `${template} boot-error rule`).toBeDefined();
      for (const [property, value] of requiredBootErrorDeclarations) {
        expect(cssDeclaration(rule, property), `${template} boot-error ${property}`).toBe(value);
      }
      expect(cssDeclaration(rule, "background"), `${template} boot-error background`).toMatch(
        bootErrorColour,
      );
      expect(cssDeclaration(rule, "color"), `${template} boot-error color`).toMatch(
        bootErrorColour,
      );
    }
  });

  it("should host the canvas in a container rather than appending it to body", async () => {
    // An unpositioned canvas appended after a full-height wrapper renders
    // below the fold: a black page with nothing logged anywhere.
    const main = await readFile(path.join(minimal, "src/main.ts"), "utf8");
    expect(main).toContain("app.prepend(canvas)");
    const css = await readFile(path.join(minimal, "src/style.css"), "utf8");
    expect(css).toContain("#app canvas");
  });
});

async function renderFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await renderFiles(file)));
    else files.push(file);
  }
  return files;
}

function cssRule(source: string, selector: string): string | undefined {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escapedSelector}\\s*\\{([^{}]*)\\}`, "u").exec(source)?.[1];
}

function cssDeclaration(rule: string | undefined, property: string): string | undefined {
  if (rule === undefined) return undefined;
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|;)\\s*${escapedProperty}\\s*:\\s*([^;]+?)(?:\\s*;|\\s*$)`, "mu")
    .exec(rule)?.[1]
    ?.trim();
}
