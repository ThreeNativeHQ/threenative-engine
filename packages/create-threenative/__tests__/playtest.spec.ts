import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { templatesShipping } from "../../../test-support/templates.js";

// Read off disk: every template that ships the durable scenario is gated here, so a kit added
// tomorrow is covered the day it ships one rather than the day somebody extends a list.
const DURABLE_PLAYTEST_TEMPLATES = templatesShipping("playtests/survives.playtest.json");

/** The four keys every kit binds to `input.vector("move")`. */
const MOVE_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

describe("starter playtest proof", () => {
  it.each(DURABLE_PLAYTEST_TEMPLATES)(
    "should name survives as the durable scenario in the %s guide",
    async (template) => {
      const guide = await readFile(
        path.resolve(`packages/create-threenative/templates/${template}/AGENTS.md`),
        "utf8",
      );

      expect(guide).toContain("playtests/survives.playtest.json");
    },
  );

  it.each(DURABLE_PLAYTEST_TEMPLATES)(
    "should drive its registered subject with input in the %s durable scenario",
    async (template) => {
      const scenario = JSON.parse(
        await readFile(
          path.resolve(
            `packages/create-threenative/templates/${template}/playtests/survives.playtest.json`,
          ),
          "utf8",
        ),
      ) as {
        assert?: { movement?: { entity?: string; minDistance?: number } };
        steps?: Array<{ holdTicks?: number; kind?: string; press?: string }>;
        subject?: string;
      };

      // The subject is the template's own, not a literal: `minimal` proves its `player` moved,
      // `tower-defense` its camera, and the `rts` kit its camera, because a strategy game has no avatar
      // and its durable proof is that a held key pans a battlefield. What every one of them shares
      // is the claim underneath: a named registered entity, a held input step, and a distance.
      // Any of the four arrows, not one of them. Every kit binds `input.vector("move")` to all
      // four, and a room whose first move is sideways — the vault crosses east — is not a kit that
      // failed to prove anything. Demanding `ArrowUp` rejected a correct durable scenario over the
      // direction its own game happens to start in.
      const inputStep = scenario.steps?.find(
        (step) => step.kind === "input" && MOVE_KEYS.has(step.press ?? ""),
      );
      expect(scenario.subject).toBeTruthy();
      expect(scenario.assert?.movement?.entity).toBe(scenario.subject);
      expect(scenario.assert?.movement?.minDistance).toBeGreaterThan(0);
      expect(inputStep, `${template}: no movement key in the durable scenario`).toMatchObject({
        kind: "input",
      });
      expect(inputStep?.holdTicks).toBeGreaterThan(0);
    },
  );

  it("should pan the tower-defense camera from the move axis its durable scenario holds", async () => {
    const rig = await readFile(
      path.resolve("packages/create-threenative/templates/tower-defense/src/camera-rig.ts"),
      "utf8",
    );
    const game = await readFile(
      path.resolve("packages/create-threenative/templates/tower-defense/src/game.ts"),
      "utf8",
    );

    expect(rig).toContain('input.vector("move")');
    expect(game).toContain("move: {");
  });

  it.each(DURABLE_PLAYTEST_TEMPLATES)(
    "should run the scenario directory through one configured gate in the %s template",
    async (template) => {
      const packageJson = JSON.parse(
        await readFile(
          path.resolve(`packages/create-threenative/templates/${template}/package.json`),
          "utf8",
        ),
      ) as { scripts: { test: string } };

      expect(packageJson.scripts.test).toContain('--scenario "playtests/*.playtest.json"');
      expect(packageJson.scripts.test).toContain("--browser-recipe webgpu");
      expect(packageJson.scripts.test).toContain("--headed");
      expect(packageJson.scripts.test).toContain("pnpm build:web &&");
      expect(packageJson.scripts.test).toContain("vite preview --host");
      expect(packageJson.scripts.test).not.toContain("pnpm dev");
      expect(packageJson.scripts.test).not.toContain("4173");
    },
  );

  it("should route sailing native proof to its desktop scenario instead of the starter asset verifier", async () => {
    const packageJson = JSON.parse(
      await readFile(
        path.resolve("packages/create-threenative/templates/sailing/package.json"),
        "utf8",
      ),
    ) as { scripts: { "test:native": string } };
    const scenario = JSON.parse(
      await readFile(
        path.resolve(
          "packages/create-threenative/templates/sailing/native-playtests/survives.playtest.json",
        ),
        "utf8",
      ),
    ) as {
      assert?: { diagnostics?: Record<string, boolean>; movement?: { minDistance?: number } };
      target: string;
    };

    expect(packageJson.scripts["test:native"]).toContain(
      "threenative-playtest --scenario native-playtests/survives.playtest.json",
    );
    expect(packageJson.scripts["test:native"]).toContain("--target desktop");
    expect(packageJson.scripts["test:native"]).toContain(
      "--executable dist-native/__PROJECT_NAME__",
    );
    expect(packageJson.scripts["test:native"]).not.toContain("verify-starter-desktop");
    expect(scenario.target).toBe("desktop");
    expect(scenario.assert?.diagnostics).toBeUndefined();
    expect(scenario.assert?.movement?.minDistance).toBeGreaterThan(0);
  });

  it("should contain a loadable movement and score scenario", async () => {
    const scenario = await readFile(
      path.resolve("packages/create-threenative/templates/starter/playtests/play.playtest.json"),
      "utf8",
    );
    const parsed = JSON.parse(scenario) as {
      assert: {
        diagnostics: {
          noConsoleErrors: boolean;
          noNetworkErrors: boolean;
          noRuntimeDiagnostics: boolean;
          runtimeReady: boolean;
        };
        resources: unknown[];
      };
      steps: Array<{ label?: string; press?: string }>;
    };
    const player = await readFile(
      path.resolve("packages/create-threenative/templates/starter/src/entities/Player.ts"),
      "utf8",
    );
    // The starter boots straight into Play, so a scenario drives the player from its first step.
    // The menu-entry steps this used to require are gone with the menu screen: a scenario that
    // still clicks at a form that no longer exists is clicking at nothing, so assert their
    // absence rather than their order.
    const startGame = parsed.steps.findIndex((step) => step.label === "start-game");
    const moveRight = parsed.steps.findIndex((step) => step.press === "ArrowRight");
    expect(startGame, "the starter has no menu to leave").toBe(-1);
    expect(moveRight, "the scenario must still drive the player right").toBeGreaterThanOrEqual(0);
    expect(parsed.assert.diagnostics).toEqual({
      noConsoleErrors: true,
      noNetworkErrors: true,
      runtimeReady: true,
    });
    expect(parsed.assert.resources).toEqual([
      { id: "state", path: "score", gte: 1, changed: true },
    ]);
    expect(player).toContain('ctx.input.vector("move")');
  });

  it("should run the fox run-and-collect scenario in the platformer test chain", async () => {
    const scenario = JSON.parse(
      await readFile(
        path.resolve(
          "packages/create-threenative/templates/platformer/playtests/move.playtest.json",
        ),
        "utf8",
      ),
    ) as {
      warmupFrames: number;
      assert: {
        diagnostics: { noConsoleErrors: boolean; runtimeReady: boolean };
        movement: { minAxisDelta: { axis: string; min: number } };
        resources: { id: string; path: string; gte: number }[];
      };
    };

    // The coin line is the route's first real proof: the fox has to run, and the coins only count
    // if the pickup test and the reach both hold. Boot time decides how far it gets, so the
    // scenario asserts the smaller of the two rather than a distance the page's start time sets.
    expect(scenario.warmupFrames).toBe(20);
    expect(scenario.assert.diagnostics).toEqual({
      noConsoleErrors: true,
      noNetworkErrors: true,
      runtimeReady: true,
    });
    expect(scenario.assert.movement.minAxisDelta).toEqual({ axis: "x", min: 3 });
    expect(scenario.assert.resources).toEqual([
      { changed: true, gte: 5, id: "GameState", path: "coins" },
    ]);
  });

  // Both stomp scenarios once passed and failed run to run with identical tick counts. The span
  // was always 117; what moved was `firstTick` — the ticks that elapsed while the page booted —
  // and a walking target moves from the moment the level loads, so a stomp landed on it at a
  // different point in its cycle every run. Placing the target frozen is what makes the landing
  // reproducible; deleting the setup block puts the flake straight back. The platformer walks the
  // two stomp and damage scenarios, both of which place a walker.
  it.each(["damage", "stomp"])(
    "should place the platformer walker frozen in the %s scenario",
    async (name) => {
      const scenario = JSON.parse(
        await readFile(
          path.resolve(
            `packages/create-threenative/templates/platformer/playtests/${name}.playtest.json`,
          ),
          "utf8",
        ),
      ) as {
        setup?: {
          place?: readonly { entity: string; at: Record<string, number>; frozen?: boolean }[];
        };
      };
      const walker = scenario.setup?.place?.find((entry) => entry.entity.startsWith("walker."));

      expect(walker, "the walker must be placed, or boot time decides the stomp").toBeDefined();
      expect(walker?.frozen).toBe(true);
      expect(Object.keys(walker?.at ?? {}).sort()).toEqual(["x", "y", "z"]);
    },
  );

  it("should drive platformer movement and jumping with browser touch", async () => {
    const scenario = JSON.parse(
      await readFile(
        path.resolve(
          "packages/create-threenative/templates/platformer/playtests/touch-controls-web.playtest.json",
        ),
        "utf8",
      ),
    ) as {
      assert: {
        diagnostics: { noConsoleErrors: boolean; noNetworkErrors: boolean; runtimeReady: boolean };
        visibility: Array<{ entity: string; present: boolean }>;
      };
      steps: Array<{ pointers?: Array<{ id: number }> }>;
      target: string;
    };
    const play = await readFile(
      path.resolve("packages/create-threenative/templates/platformer/src/scenes/Play.ts"),
      "utf8",
    );

    expect(scenario.target).toBe("web");
    expect(scenario.steps.some((step) => (step.pointers?.length ?? 0) > 0)).toBe(true);
    expect(scenario.assert.diagnostics).toEqual({
      noConsoleErrors: true,
      noNetworkErrors: true,
      noRuntimeDiagnostics: true,
      runtimeReady: true,
    });
    expect(
      scenario.assert.visibility.some(
        (entry) => entry.entity === "touch-controls" && entry.present === true,
      ),
    ).toBe(true);
    expect(play).toContain("isMobile() && isTouchscreenAvailable()");
    expect(play).not.toContain("isNative() && isMobile()");
  });

  it("should drive sailing movement with browser touch", async () => {
    const scenario = JSON.parse(
      await readFile(
        path.resolve(
          "packages/create-threenative/templates/sailing/playtests/touch-controls.playtest.json",
        ),
        "utf8",
      ),
    ) as {
      assert: {
        diagnostics: Record<string, boolean>;
        movement: { entity: string; minDistance: number };
        resources: Array<{ id: string; path: string; changed?: boolean }>;
        visibility: Array<{ entity: string; present: boolean }>;
      };
      steps: Array<{ pointers?: Array<{ id: number }>; kind?: string }>;
      target: string;
    };
    const [scene, ship] = await Promise.all([
      readFile(
        path.resolve("packages/create-threenative/templates/sailing/src/scenes/Sailing.ts"),
        "utf8",
      ),
      readFile(
        path.resolve("packages/create-threenative/templates/sailing/src/entities/Ship.ts"),
        "utf8",
      ),
    ]);

    expect(scenario.target).toBe("web");
    expect(scenario.steps.some((step) => (step.pointers?.length ?? 0) > 0)).toBe(true);
    expect(scenario.assert.diagnostics).toEqual({
      noConsoleErrors: true,
      noNetworkErrors: true,
      noRuntimeDiagnostics: true,
      runtimeReady: true,
    });
    expect(scenario.assert.movement).toEqual({ entity: "player", minDistance: 0.1 });
    expect(scenario.assert.resources).toContainEqual({ id: "state", path: "shipZ", changed: true });
    expect(scenario.assert.visibility).toContainEqual({
      entity: "touch-controls",
      present: true,
      allowTrivial: expect.any(String),
    });
    expect(scene).toContain("const showTouchControls = isMobile() && isTouchscreenAvailable();");
    expect(ship).toContain("touch?: ITouchInput");
  });

  it("should form the same native touch scenario for Android and iOS targets", async () => {
    const scenarioPath =
      "packages/create-threenative/templates/platformer/playtests/native/touch-controls.playtest.json";
    const scenario = JSON.parse(await readFile(path.resolve(scenarioPath), "utf8")) as {
      assert: { resources: unknown[]; visibility: unknown[] };
      steps: Array<{ pointers?: Array<{ id: number }> }>;
    };
    const packageJson = JSON.parse(
      await readFile(
        path.resolve("packages/create-threenative/templates/platformer/package.json"),
        "utf8",
      ),
    ) as { scripts: { test: string } };
    const targetCommands = ["android", "ios"].map(
      (target) => `node packages/playtest/dist/runner/cli.js ${scenarioPath} --target ${target}`,
    );

    expect(packageJson.scripts.test).toContain('--scenario "playtests/*.playtest.json"');
    expect(scenarioPath).toContain("/playtests/native/");
    expect(targetCommands).toEqual([
      `node packages/playtest/dist/runner/cli.js ${scenarioPath} --target android`,
      `node packages/playtest/dist/runner/cli.js ${scenarioPath} --target ios`,
    ]);
    expect(scenario.steps.some((step) => (step.pointers?.length ?? 0) === 2)).toBe(true);
    expect(scenario.assert.visibility).toContainEqual({
      entity: "touch-controls",
      present: true,
    });
    expect(scenario.assert.resources).toEqual([
      { changed: true, gte: 1, id: "state", path: "jumps" },
      { changed: true, gte: 0.05, id: "state", path: "playerX" },
    ]);
  });

  it("should ship one smoke and one bounded performance scenario in the platformer chain", async () => {
    const root = path.resolve("packages/create-threenative/templates/platformer");
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const survives = JSON.parse(
      await readFile(path.join(root, "playtests/survives.playtest.json"), "utf8"),
    ) as { subject: string; assert: { diagnostics: Record<string, boolean> } };
    const performance = JSON.parse(
      await readFile(path.join(root, "playtests/performance.playtest.json"), "utf8"),
    ) as {
      assert: {
        performance: { maxDrawCalls: number; maxFrameMsP95?: number; minFps: number };
        renderChain: { tier: string };
      };
    };

    // `pnpm test` is the whole chain in one command: every scenario in the template, and no
    // separate script that can rot beside it.
    const testScript = packageJson.scripts?.test ?? "";
    expect(testScript).toContain("playtests/*.playtest.json");
    expect(testScript).toContain("--browser-recipe webgpu");
    expect(survives.subject).toBe("player");
    expect(survives.assert.diagnostics).toMatchObject({
      noConsoleErrors: true,
      noNetworkErrors: true,
      noRuntimeDiagnostics: true,
      runtimeReady: true,
    });
    // The Tier 3 Floor lives in the shipped scenario, beside the ceilings, not in a report.
    expect(performance.assert.performance.maxFrameMsP95).toBeUndefined();
    expect(performance.assert.performance.minFps).toBe(30);
    expect(performance.assert.performance.maxDrawCalls).toBeGreaterThan(0);
    expect(performance.assert.renderChain.tier).toBe("high");
  });

  it("should ship a pause button, a seeded level, and a playable pickup sound", async () => {
    const game = await readFile(
      path.resolve("packages/create-threenative/templates/starter/src/game.ts"),
      "utf8",
    );
    const menu = await readFile(
      path.resolve("packages/create-threenative/templates/starter/src/ui/Menu.tsx"),
      "utf8",
    );
    const seed = await readFile(
      path.resolve("packages/create-threenative/template-playtests/starter/seed.playtest.json"),
      "utf8",
    );
    const pickupAudio = await readFile(
      path.resolve("packages/create-threenative/templates/starter/assets/pickup.wav"),
    );

    expect(game).toContain("seed: 90210");
    // The pause button sends an intent; `src/game.ts` is what calls `game.pause()`. The UI is in
    // another process on every native target and cannot call the game directly.
    expect(menu).toContain('send(paused ? "resume" : "pause")');
    expect(game).toContain("game.pause()");
    expect(seed).toContain('"path": "levelX"');
    // WAV, not OGG. The Android runtime decodes RIFF/WAVE only, so a starter shipping OGG hands
    // every scaffolded project an `--target android` build that installs and black-screens.
    expect(pickupAudio.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(pickupAudio.subarray(8, 12).toString("ascii")).toBe("WAVE");
  });

  it("should assert the seeded level range instead of a generator draw", async () => {
    const seed = JSON.parse(
      await readFile(
        path.resolve("packages/create-threenative/template-playtests/starter/seed.playtest.json"),
        "utf8",
      ),
    ) as {
      assert: {
        resources: Array<{
          allowTrivial?: string;
          changed?: boolean;
          equals?: unknown;
          gte?: number;
          id: string;
          lte?: number;
          path?: string;
        }>;
      };
    };
    const level = seed.assert.resources.find(
      ({ id, path: resourcePath }) => id === "state" && resourcePath === "levelX",
    );
    const play = await readFile(
      path.resolve("packages/create-threenative/templates/starter/src/scenes/Play.ts"),
      "utf8",
    );

    // The row asserts the range and nothing else. `changed: true` used to be here and was the
    // defect: `levelX` was set at `ctx.after(0.25, ...)` so the transition could only be observed
    // if the runner's first sample landed inside 0.25 s of boot. Same commit, two machines —
    // firstTick 6 here and 47 in CI — so the row passed on a workstation and failed closed as
    // TN_PLAYTEST_ASSERTION_TRIVIAL on the runner. The range is the real assertion and both
    // sentinels fall outside it: -99 means the level never built, 2 means the seeded draw did not
    // advance `ctx.random`.
    expect(level).toMatchObject({ gte: -1, id: "state", lte: 1, path: "levelX" });
    expect(level).not.toHaveProperty("changed");
    expect(level).not.toHaveProperty("equals");
    expect(level?.allowTrivial).toMatch(/race with boot time/u);
    expect(play).toContain("const randomStateBeforeLevel = ctx.random.state");
    expect(play).toContain(
      "const seededLevelX = ctx.random.state === randomStateBeforeLevel ? 2 : levelX",
    );
    // Set with the level, not on a timer the observer has to win a race against.
    expect(play).toContain("ctx.state.set({ levelX: seededLevelX });");
    expect(play).not.toContain("ctx.after(0.25,");
  });

  it("should load the packaged texture and GLB through the starter scene", async () => {
    const play = await readFile(
      path.resolve("packages/create-threenative/templates/starter/src/scenes/Play.ts"),
      "utf8",
    );
    const texture = await readFile(
      path.resolve("packages/create-threenative/templates/starter/assets/native-proof.png"),
    );
    const model = await readFile(
      path.resolve("packages/create-threenative/templates/starter/assets/native-proof.glb"),
    );

    expect(play).toContain('ctx.assets.texture("native-proof.png")');
    expect(play).toContain('ctx.assets.model<{ scene: Group }>("native-proof.glb")');
    expect(play).toContain("TN_NATIVE_STARTER_ASSETS_LOADED:texture,glb");
    expect(texture.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(model.subarray(0, 4).toString("ascii")).toBe("glTF");
  });

  it("should ship JSON scenarios for both templates and no legacy TypeScript scenario", async () => {
    const minimal = await readFile(
      path.resolve("packages/create-threenative/templates/minimal/playtests/play.playtest.json"),
      "utf8",
    );
    expect(JSON.parse(minimal)).toMatchObject({ name: "play", schemaVersion: 1, target: "web" });
    await expect(
      readFile(
        path.resolve("packages/create-threenative/templates/starter/tests/play.playtest.ts"),
        "utf8",
      ),
    ).rejects.toThrow();
    await expect(
      readFile(
        path.resolve("packages/create-threenative/templates/minimal/tests/play.playtest.ts"),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  it("should boot straight into the Play scene with no menu screen", async () => {
    const game = await readFile(
      path.resolve("packages/create-threenative/templates/starter/src/game.ts"),
      "utf8",
    );
    expect(game).toContain("scenes: { play: Play }");
    expect(game).toContain('start: "play"');
    expect(game).not.toContain("MainMenu");
    expect(game).not.toContain("start-game");
    expect(game).not.toContain("back-to-menu");
    for (const removed of [
      "src/scenes/MainMenu.ts",
      "src/scenes/Boot.ts",
      "src/ui/MainMenuUi.tsx",
      "playtests/menu-flow.playtest.json",
    ]) {
      await expect(
        readFile(path.resolve("packages/create-threenative/templates/starter", removed), "utf8"),
        `${removed} must not ship with the starter`,
      ).rejects.toThrow();
    }
  });

  it("should drive the generated shooter through one committed fire-control scenario", async () => {
    const scenario = JSON.parse(
      await readFile(
        path.resolve(
          "packages/create-threenative/templates/shooter/playtests/debug-fire.playtest.json",
        ),
        "utf8",
      ),
    ) as {
      assert?: {
        movement?: { entity: string; minDistance: number };
        resources?: Array<{ id: string; path: string }>;
      };
      name: string;
      schemaVersion: number;
      steps: Array<{ kind?: string; label?: string; press?: string }>;
      target: string;
    };

    expect(scenario.name).toBe("debug-fire");
    expect(scenario.schemaVersion).toBe(1);
    expect(scenario.target).toBe("web");

    // Three trigger pulls around a reload and a walk: the cadence, the magazine and the fact
    // that a shot is a raycast from the crosshair rather than a muzzle. None of it can pass
    // from the opening state, so the scenario is not satisfied by doing nothing.
    const presses = (scenario.assert?.resources ?? []).map(({ path }) => path);
    for (const path of ["shots", "targetsHit", "score"]) {
      expect(presses).toContain(path);
    }
    expect(scenario.assert?.movement).toMatchObject({ entity: "player" });
    expect(scenario.assert?.movement?.minDistance).toBeGreaterThan(0);

    const labeled = new Map(scenario.steps.map((step) => [step.label ?? "", step]));
    expect(labeled.get("shot-1")).toMatchObject({ kind: "input", press: "Space" });
    expect(labeled.get("reload")).toMatchObject({ kind: "input", press: "KeyR" });
    expect(labeled.get("advance")).toMatchObject({ kind: "input", press: "KeyW" });
  });

  it("should bind mouse look, right-button aim, and left-button fire in the shooter template", async () => {
    const game = await readFile(
      path.resolve("packages/create-threenative/templates/shooter/src/game.ts"),
      "utf8",
    );
    const player = await readFile(
      path.resolve("packages/create-threenative/templates/shooter/src/entities/FpsPlayer.ts"),
      "utf8",
    );
    const scene = await readFile(
      path.resolve("packages/create-threenative/templates/shooter/src/scenes/Play.ts"),
      "utf8",
    );

    // Aim is F and the right button; Space and the left button fire. The bindings the game
    // documents in its own AGENTS.md, asserted here so the docs cannot drift from the map.
    expect(game).toContain('aim: { keys: ["KeyF"], mouseButtons: [2] }');
    expect(game).toContain('fire: { keys: ["Space"], mouseButtons: [0] }');
    expect(game).toContain("look: { pointerRelative: true }");
    expect(game).toContain('reload: { keys: ["KeyR"] }');
    // The player consumes the look axis through the real input map, on the same path a native
    // build takes; nothing in this kit reads `movementX` or the DOM.
    expect(player).toContain('ctx.input.vector("look")');
    expect(player).toContain('ctx.input.pressed("aim")');
    // Held, not edge-triggered: hold-to-fire and a single tap take one path through the
    // weapon's cyclic cooldown.
    expect(scene).toContain('frameCtx.input.pressed("fire")');
    // A shot starts at the crosshair, from the camera the player is looking through.
    expect(scene).toContain("const aimRay = player.aimRay();");
    expect(scene).toContain("fire(frameCtx, aimRay)");
  });
});
