import { type IPlaytestBridgeV1, PLAYTEST_BRIDGE_GLOBAL } from "@threenative/playtest";
import {
  AnimationClip,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Vector2,
  VectorKeyframeTrack,
} from "three";
import { describe, expect, it } from "vitest";
import { AnimationPlayer } from "../src/animation.js";
import { defineGame } from "../src/game.js";
import { playtest } from "../src/playtest.js";
import { type ICtx, Scene } from "../src/scene.js";

/**
 * "Feet meet the floor" is a convention this framework ships on by default, with a named override
 * and a live measurement — `AnimationPlayer.stride`. Nothing could read that measurement from
 * outside the game: it never crossed the playtest bridge, so a character skating across the floor
 * was invisible to every instrument, and a game that set `strideSync: false` had turned the
 * measurement off as far as any proof was concerned. Turning a convention off must not turn its
 * measurement off.
 */

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 180 },
    clientWidth: { configurable: true, value: 320 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

function bridge(): IPlaytestBridgeV1 {
  const value = (globalThis as Record<string, unknown>)[PLAYTEST_BRIDGE_GLOBAL];
  if (typeof value !== "object" || value === null)
    throw new Error("Playtest bridge was not installed.");
  return value as IPlaytestBridgeV1;
}

/** A one-second walk cycle whose root travels two metres along +x: 2 m/s of ground at rate 1. */
function walkClip(): AnimationClip {
  return new AnimationClip("walk", 1, [
    new VectorKeyframeTrack(".position", [0, 1], [0, 0, 0, 2, 0, 0]),
  ]);
}

async function runGame(build: (ctx: ICtx<Record<string, never>>) => void) {
  const canvas = testCanvas();
  class TestScene extends Scene<Record<string, never>> {
    override enter(ctx: ICtx<Record<string, never>>): void {
      build(ctx);
    }
  }
  const game = defineGame<Record<string, never>>({
    initialState: {},
    plugins: [playtest()],
    renderer: {
      canvas,
      preferWebGPU: false,
      webgl2Factory: () => ({
        dispose: () => undefined,
        domElement: canvas,
        getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
        render: () => undefined,
        setSize: () => undefined,
      }),
    },
    scenes: { test: TestScene },
    start: "test",
  });
  await game.start();
  return game;
}

/** The rig hangs off a body the game moves, which is the shape the convention is written for. */
function walkingCharacter(travelPerSecond: number, options: { strideSync?: boolean } = {}) {
  const body = new Group();
  const rig = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  body.add(rig);
  const animation = new AnimationPlayer({
    clips: [walkClip()],
    root: rig,
    strideRoot: body,
    ...(options.strideSync === undefined ? {} : { strideSync: options.strideSync }),
  });
  animation.play("walk");
  // One second of travel, sampled as one update, so the measured ground speed is the argument.
  animation.update(1);
  body.position.x += travelPerSecond;
  body.updateMatrixWorld(true);
  animation.update(1);
  return { animation, body };
}

describe("the stride convention reports itself across the playtest bridge", () => {
  it("publishes what the feet carry against what the body covered", async () => {
    let game: Awaited<ReturnType<typeof runGame>> | undefined;
    try {
      game = await runGame((ctx) => {
        const { animation, body } = walkingCharacter(2);
        ctx.add(body);
        ctx.entities.add("player", { animation, mesh: body });
      });
      const snapshot = await bridge().sample({});
      const stride = snapshot.gameplay?.animation.player?.stride;
      expect(stride).toBeDefined();
      // The clip carries 2 m/s and the body covered 2 m/s, so the convention leaves the rate at 1.
      expect(stride?.clipGroundSpeed).toBeCloseTo(2, 5);
      expect(stride?.groundSpeed).toBeCloseTo(2, 5);
      expect(stride?.rate).toBeCloseTo(1, 5);
      expect(stride).toMatchObject({ inPlace: false, overridden: false, synced: true });
    } finally {
      await game?.stop?.();
    }
  });

  it("reports the rate it declined when the game overrides the convention", async () => {
    let game: Awaited<ReturnType<typeof runGame>> | undefined;
    try {
      game = await runGame((ctx) => {
        const { animation, body } = walkingCharacter(4, { strideSync: false });
        ctx.add(body);
        ctx.entities.add("player", { animation, mesh: body });
      });
      const stride = (await bridge().sample({})).gameplay?.animation.player?.stride;
      // Body at 4 m/s against a 2 m/s clip: the measurement stands, the application does not.
      expect(stride?.rate).toBeCloseTo(2, 5);
      expect(stride).toMatchObject({ overridden: true, synced: false });
    } finally {
      await game?.stop?.();
    }
  });

  it("drops a stride report it cannot trust rather than filling the missing half in", async () => {
    let game: Awaited<ReturnType<typeof runGame>> | undefined;
    try {
      game = await runGame((ctx) => {
        const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        ctx.add(mesh);
        ctx.entities.add("player", {
          // A hand-rolled animation object shaped like the real one but missing `synced`.
          animation: {
            advancedFrames: 3,
            current: "walk",
            stride: { clipGroundSpeed: 2, groundSpeed: 2, overridden: false, rate: 1 },
          },
          mesh,
        });
      });
      const observed = (await bridge().sample({})).gameplay?.animation.player;
      expect(observed).toMatchObject({ advancedFrames: 3, clip: "walk" });
      expect(observed?.stride).toBeUndefined();
    } finally {
      await game?.stop?.();
    }
  });
});
