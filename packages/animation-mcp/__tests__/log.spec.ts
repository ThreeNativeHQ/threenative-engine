import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  type AnimationLog,
  appendOp,
  logPathFor,
  readLog,
  replayOps,
  upgradeLog,
  writeLog,
} from "../src/ops/log.js";

const RECIPE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "enemy-ak47.pose.json",
);

async function recipe(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(RECIPE, "utf8")) as Record<string, unknown>;
}

describe("animation op log", () => {
  it("loads the recovered version 3 recipe as the ops a caller would have written", async () => {
    const log = upgradeLog(await recipe());

    expect(log.version).toBe(4);
    expect(log.host).toBe("public/assets/enemy-terrorist.glb");
    expect(log.ops[0]).toEqual({
      anchor: {
        id: "right-hand",
        label: "Right hand",
        node: "mixamorigRightHand_035",
        source: "detected",
      },
      attached: "public/assets/weapon-ak47.glb",
      op: "attach",
    });
    const clips = new Set(log.ops.flatMap((op) => (op.op === "key" ? [op.clip] : [])));
    expect([...clips].sort()).toEqual([
      "DeathBack",
      "DeathFront",
      "DeathHeadshot",
      "FiringRifle",
      "HitReaction",
      "RifleCrouchWalk",
      "RifleCrouchWalkToIdle",
      "RifleIdle",
      "RifleWalk",
    ]);
  });

  it("replays a version 3 recipe into exactly its own tracks", async () => {
    const source = await recipe();
    const log = upgradeLog(source);
    const poses = replayOps(log).poses;

    const animations = source.animations as Record<
      string,
      { attachment: string; keyframes: { time: number; transform: unknown }[] }
    >;
    expect(Object.keys(poses).sort()).toEqual(Object.keys(animations).sort());
    for (const [clip, pose] of Object.entries(animations)) {
      expect(poses[clip]?.attachment).toBe(pose.attachment);
      expect(poses[clip]?.keyframes).toHaveLength(pose.keyframes.length);
      expect(poses[clip]?.keyframes[0]?.transform).toEqual(pose.keyframes[0]?.transform);
    }
  });

  it("round-trips a version 4 log through disk unchanged", async () => {
    const log = upgradeLog(await recipe());
    const directory = await makeTempDir("animation-log-");
    const file = path.join(directory, "host.anim.json");

    await writeLog(file, log);
    const reloaded = await readLog(file);

    expect(reloaded).toEqual(log);
    expect(replayOps(reloaded)).toEqual(replayOps(log));
  });

  it("keeps a later key over an earlier one at the same time, and appends in order", async () => {
    const log = upgradeLog({
      animations: {
        Idle: {
          attachment: "attached",
          keyframes: [
            {
              time: 0,
              transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            },
          ],
        },
      },
      anchor: { id: "right-hand", label: "Right hand", node: "RightHand", source: "detected" },
      attached: "prop.glb",
      host: "host.glb",
      version: 3,
    });
    const moved: AnimationLog = appendOp(log, {
      clip: "Idle",
      op: "key",
      time: 1,
      transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });

    expect(moved.ops).toHaveLength(3);
    expect(replayOps(moved).poses.Idle?.keyframes).toHaveLength(2);
    expect(replayOps(moved).poses.Idle?.keyframes[1]?.transform.position).toEqual([1, 2, 3]);
  });

  it("names the op log beside the source it edits", () => {
    expect(logPathFor("/games/hero/public/hero.glb")).toBe("/games/hero/public/hero.anim.json");
  });

  it("refuses a log it cannot replay, rather than rewriting it", () => {
    expect(() => upgradeLog({ host: "host.glb", version: 9 })).toThrow(/Unsupported.*version/u);
    expect(() => upgradeLog({ version: 4 })).toThrow(/host GLB/u);
    expect(() => upgradeLog({ host: "host.glb", ops: [], version: 4 })).toThrow(/at least one op/u);
    expect(() =>
      upgradeLog({
        host: "host.glb",
        ops: [
          {
            anchor: { id: "right-hand", label: "Right hand", node: "h", source: "detected" },
            attached: "p.glb",
            op: "teleport",
          },
        ],
        version: 4,
      }),
    ).toThrow(/Unknown animation op/u);
    expect(() =>
      replayOps({
        host: "host.glb",
        ops: [
          {
            clip: "Idle",
            op: "key",
            time: 0,
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
        ],
        version: 4,
      }),
    ).toThrow(/attach op/u);
    expect(() =>
      upgradeLog({
        host: "host.glb",
        ops: [
          {
            clip: "Idle",
            op: "key",
            time: 0,
            transform: { position: [0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
        ],
        version: 4,
      }),
    ).toThrow(/transform.position/u);
  });
});
