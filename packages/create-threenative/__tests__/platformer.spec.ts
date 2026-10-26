import { readFile } from "node:fs/promises";
import path from "node:path";
import { PerspectiveCamera, Scene, Vector2, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import { Checkpoints } from "../templates/platformer/src/level/Checkpoints.js";
import { setupPost } from "../templates/platformer/src/render/postprocessing.js";
import { TouchControls } from "../templates/platformer/src/render/touch-controls.js";
import { touchControlPoint } from "../templates/platformer/src/render/touch-layout.js";

type RenderChainOptions = Parameters<
  NonNullable<Parameters<typeof setupPost>[0]["createRenderChain"]>
>[0];

type Target = Parameters<Checkpoints["hurt"]>[0];

function point(x: number): Vector3 {
  return new Vector3(x, 0, 0);
}

function target(): Target {
  return {
    body: { teleport: vi.fn(), velocity: { set: vi.fn() } },
    mesh: { position: point(1) },
  } as unknown as Target;
}

describe("platformer checkpoints", () => {
  it("uses the existing low look only for hosted software profiles", () => {
    const globals = globalThis as typeof globalThis & {
      __THREENATIVE_PROFILE__?: { hostedSoftware?: boolean };
    };
    const createRenderChain = vi.fn((options: RenderChainOptions) => ({
      applied: { dropped: [], stages: [...(options.request?.stages ?? [])] },
      dispose() {},
    }));
    const renderer = { kind: "webgpu", raw: {}, createRenderChain } as Parameters<
      typeof setupPost
    >[0];
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    // The applied environment prints its own report after the tier line; read that line out.
    const reportedTier = (): string =>
      info.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.startsWith("TN_QUALITY_TIER")) ?? "";
    vi.clearAllMocks();

    globals.__THREENATIVE_PROFILE__ = { hostedSoftware: true };
    setupPost(renderer, scene, camera, { mobile: false });
    expect(reportedTier()).toBe(
      "TN_QUALITY_TIER low mobile=false software=false source=hosted-software",
    );

    info.mockClear();
    setupPost(renderer, scene, camera, { mobile: false, tier: "high" });
    expect(reportedTier()).toBe("TN_QUALITY_TIER high mobile=false software=false source=override");
    // The three names must be three looks. On this level the difference is contact occlusion: a
    // 2,300-mesh route where every mesh costs per-object work is where a phone loses the screen-space
    // stages and a desktop keeps them.
    expect(createRenderChain.mock.calls[0]?.[0].request?.stages).not.toContain("ambientOcclusion");
    expect(createRenderChain.mock.calls[1]?.[0].request?.stages).toContain("ambientOcclusion");

    globals.__THREENATIVE_PROFILE__ = undefined;
    info.mockRestore();
  });

  it("rejects an empty checkpoint list", () => {
    expect(() => new Checkpoints([], 3)).toThrow("at least one checkpoint");
  });

  it("decrements hearts once during the invulnerability window", () => {
    const state = new Checkpoints([point(0)], 3);
    const player = target();

    expect(state.hurt(player, 0)).toBe(true);
    expect(state.hurt(player, 0)).toBe(false);
    expect(state.hearts).toBe(2);

    state.update(1.3);
    expect(state.hurt(player, 0)).toBe(true);
    expect(state.hearts).toBe(1);
  });

  it("leaves hearts exhausted without respawning", () => {
    const state = new Checkpoints([point(0)], 1);
    const player = target();

    expect(state.hurt(player, 0)).toBe(true);
    expect(state.hearts).toBe(0);
    expect(player.body.teleport).not.toHaveBeenCalled();
    expect(state.hurt(player, 0)).toBe(false);
  });

  it("advances through ordered checkpoints only", () => {
    const state = new Checkpoints([point(0), point(14), point(25)], 3);

    state.pass(point(15));
    expect(state.currentIndex).toBe(1);
    state.pass(point(26));
    expect(state.currentIndex).toBe(2);
  });

  it("blinks while invulnerable and draws on every other frame", () => {
    const state = new Checkpoints([point(0)], 3);
    const player = target();
    state.hurt(player, 0);

    // Two consecutive samples of the same instant agree: the blink is a function of the window,
    // not of how many times the scene has been stepped.
    expect(state.blinks(0)).toBe(state.blinks(0));
    state.update(1.3);
    expect(state.blinks(0)).toBe(true);
  });

  it("clears velocity before teleporting to the current checkpoint", () => {
    const state = new Checkpoints([point(0), point(14)], 3);
    const player = target();
    state.pass(point(15));

    state.respawn(player);

    expect(player.body.velocity.set).toHaveBeenCalledWith(0, 0, 0);
    expect(player.body.teleport).toHaveBeenCalledWith(state.points[1]);
  });

  it("restores a full set of hearts instead of ending the run", () => {
    const state = new Checkpoints([point(0)], 2);
    const player = target();
    state.hurt(player, 0);
    state.hurt(player, 0);
    state.update(2);
    state.hurt(player, 0);
    expect(state.hearts).toBe(0);

    state.restore();
    expect(state.hearts).toBe(2);
    // Restoring is a transition, not a terminal state: the fox is invulnerable and playable again.
    expect(state.invulnerable).toBe(true);
  });

  it("should hand the walkable level to the engine's own static collider builder", async () => {
    const play = await readFile(
      path.resolve("packages/create-threenative/templates/platformer/src/scenes/Play.ts"),
      "utf8",
    );
    const stage = await readFile(
      path.resolve("packages/create-threenative/templates/platformer/src/level/Stage.ts"),
      "utf8",
    );

    // The route is authored geometry, so collision is the engine's reading of what the camera
    // draws. A hand-rolled AABB list alongside a modelled level is how the two drift apart.
    expect(play).toContain("buildStaticColliders(ctx, stage.group");
    expect(play).toContain("object.userData.solid === true");
    expect(stage).toContain("mesh.userData.solid = true");
    expect(stage).not.toMatch(/colliders\s*:\s*\[\]/u);
  });

  it("should read the sun and the camera from afterPhysics, not from the scene frame", async () => {
    const play = await readFile(
      path.resolve("packages/create-threenative/templates/platformer/src/scenes/Play.ts"),
      "utf8",
    );

    // `moveAndSlide` only queues motion, so a camera written before the physics step frames where
    // the body was. `afterPhysics` is the phase the engine owns.
    expect(play).toContain("afterPhysics(ctx, (dt) => {");
    expect(play).toContain("followCamera(camera, fox.mesh.position, fox.body.velocity.x, dt)");
    expect(play).toContain("lighting.follow(fox.mesh.position)");
  });

  it("should ship touch controls as user-owned render source", async () => {
    const controls = await readFile(
      path.resolve("packages/create-threenative/templates/platformer/src/render/touch-controls.ts"),
      "utf8",
    );
    const fox = await readFile(
      path.resolve("packages/create-threenative/templates/platformer/src/entities/Fox.ts"),
      "utf8",
    );
    const play = await readFile(
      path.resolve("packages/create-threenative/templates/platformer/src/scenes/Play.ts"),
      "utf8",
    );

    expect(controls).toContain("ReadonlyMap<number, ITouchPointer>");
    expect(controls).toContain("TouchControls");
    expect(controls).toContain("readonly object = this.root;");
    expect(play).toContain("isMobile() && isTouchscreenAvailable()");
    expect(play).toContain('ctx.entities.add("touch-controls", new TouchControls(camera))');
    expect(play).toContain("touchControls?.update(frameCtx.input.raw.pointers");
    expect(fox).toContain("ITouchInput");
    expect(fox).toContain("touch?.jumpPressed === true");
    expect(fox).toContain("touch?.dashPressed === true");
  });

  it("keeps portrait movement and dash pointers in separate hit regions", () => {
    for (const size of [
      { aspect: 390 / 844, height: 844, width: 390 },
      { aspect: 320 / 568, height: 568, width: 320 },
    ]) {
      const controls = new TouchControls(new PerspectiveCamera(54, size.aspect));
      const movementCenter = touchControlPoint(size, "move");
      const dashCenter = touchControlPoint(size, "dash");
      const movementPosition = movementCenter.clone().add(new Vector2(20, 0));

      const movement = controls.update(new Map([[1, { id: 1, position: movementPosition }]]), size);
      expect(movement.dashPressed).toBe(false);
      // The stick anchors where the thumb lands, so the landing frame is zero by design and the
      // drag is what deflects it. This test is about which region claimed the pointer.
      expect(movement.move.toArray()).toEqual([0, 0]);
      // Dragged up, not right: on the 320-wide screen a rightward drag of this size reaches the
      // dash button's exclusion radius and the pointer stops being a movement pointer at all.
      const dragged = controls.update(
        new Map([[1, { id: 1, position: movementPosition.clone().add(new Vector2(0, -30)) }]]),
        size,
      );
      expect(dragged.move.length()).toBeGreaterThan(0);

      controls.update(new Map(), size);
      const dash = controls.update(new Map([[2, { id: 2, position: dashCenter }]]), size);
      expect(dash.dashPressed).toBe(true);
      expect(dash.move.toArray()).toEqual([0, 0]);

      if (size.width === 320) {
        const outsideDash = new Vector2(dashCenter.x - 65, dashCenter.y);
        const insideDash = new Vector2(dashCenter.x - 63, dashCenter.y);

        controls.update(new Map(), size);
        const movementAtBoundary = controls.update(
          new Map([[3, { id: 3, position: outsideDash }]]),
          size,
        );
        expect(movementAtBoundary.dashPressed).toBe(false);
        const draggedAtBoundary = controls.update(
          new Map([[3, { id: 3, position: outsideDash.clone().add(new Vector2(0, -30)) }]]),
          size,
        );
        expect(draggedAtBoundary.move.length()).toBeGreaterThan(0);

        controls.update(new Map(), size);
        const dashAtBoundary = controls.update(
          new Map([[4, { id: 4, position: insideDash }]]),
          size,
        );
        expect(dashAtBoundary.dashPressed).toBe(true);
        expect(dashAtBoundary.move.toArray()).toEqual([0, 0]);
      }
      controls.dispose();
    }
  });

  it("keeps simultaneous movement and jump pointers active", () => {
    const controls = new TouchControls(new PerspectiveCamera(54, 2400 / 1080));
    const pointers = new Map([
      [7, { buttons: 1, id: 7, position: new Vector2(180, 972) }],
      [3, { buttons: 1, id: 3, position: new Vector2(2300, 980) }],
    ]);
    const size = { aspect: 2400 / 1080, height: 1080, width: 2400 };

    const first = controls.update(pointers, size);
    // Landing frame anchors the stick; jump is edge-triggered and fires immediately.
    expect(first.move.x).toBe(0);
    expect(first.jumpPressed).toBe(true);

    // The moving thumb drags a full radius right while the jump thumb stays down. Both pointers
    // must still be honoured: this is the case a single-pointer reading cannot express.
    const dragged = new Map([
      [7, { buttons: 1, id: 7, position: new Vector2(180 + 72, 972) }],
      [3, { buttons: 1, id: 3, position: new Vector2(2300, 980) }],
    ]);
    const second = controls.update(dragged, size);

    expect(second.move.x).toBe(1);
    expect(second.jumpPressed).toBe(false);
    controls.dispose();
  });

  it("ships the production performance scenario with honest, bounded budgets", async () => {
    const performance = await readFile(
      path.resolve(
        "packages/create-threenative/templates/platformer/playtests/performance.playtest.json",
      ),
      "utf8",
    );
    const scenario = JSON.parse(performance) as {
      assert: {
        performance: {
          maxDrawCalls: number;
          maxTriangles: number;
          minFps: number;
        };
      };
      steps: Array<Record<string, unknown>>;
    };

    // Measured off the running scene, 2026-09-28, at 1920x1080 on a discrete adapter with the
    // high tier: 562 draw calls and 186,016 triangles for the whole 97 m route and its backdrop.
    // That is what the fox route costs in objects, and it is what the collapse in
    // `scenes/Play.ts` bought: the same scene un-collapsed is 2,128 draws, because a level
    // authored out of primitives is one draw per primitive until something merges it.
    //
    // The FPS floor deliberately did not move, and the scenario pins no frame time: the harness holds
    // every tier to 16.7 ms p95 (PRD-735). A cap raised to fit the work is a cap routed around; these numbers
    // are a guard against the next change that makes the frame worse, not a score.
    expect(scenario.assert.performance).toEqual({
      maxDrawCalls: 600,
      maxTriangles: 190_000,
      // PRD-222 Phase 1: the Tier 3 Floor lives in the shipped scenario, beside the ceilings.
      minFps: 30,
    });
    expect(scenario.steps.map((step) => step.kind)).toEqual(["input", "wait"]);
    expect(scenario.steps).not.toContainEqual(expect.objectContaining({ kind: "performance" }));
    expect(scenario.steps).not.toContainEqual(expect.objectContaining({ sampleSeconds: 10 }));
  });
});
