import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { bakeAttachment, eulerToQuaternion } from "../src/ops/attach.js";
import { upgradeLog } from "../src/ops/log.js";
import { writeRigFixture } from "./rig-fixture.js";

const RECIPE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "enemy-ak47.pose.json",
);
const reader = () => new NodeIO().registerExtensions(ALL_EXTENSIONS);

interface Recipe {
  readonly animations: Record<
    string,
    {
      attachment: string;
      keyframes: {
        time: number;
        transform: { position: number[]; rotation: number[]; scale: number[] };
      }[];
    }
  >;
  readonly anchor: { id: string; label: string; node: string; source: string };
  readonly attached: string;
  readonly host: string;
  readonly version: number;
}

async function recipe(): Promise<Recipe> {
  return JSON.parse(await readFile(RECIPE, "utf8")) as Recipe;
}

describe("animation_attach bake", () => {
  it("converts the view's Euler degrees to the quaternion glTF stores", () => {
    for (const angles of [
      [0, 0, 0],
      [-112.708, -30.378, -45.826],
      [12.5, -170, 89.999],
    ] as [number, number, number][]) {
      const expected = new Quaternion().setFromEuler(
        new Euler(
          (angles[0] * Math.PI) / 180,
          (angles[1] * Math.PI) / 180,
          (angles[2] * Math.PI) / 180,
          "XYZ",
        ),
      );
      const [x, y, z, w] = eulerToQuaternion(angles);
      expect(x).toBeCloseTo(expected.x, 10);
      expect(y).toBeCloseTo(expected.y, 10);
      expect(z).toBeCloseTo(expected.z, 10);
      expect(w).toBeCloseTo(expected.w, 10);
    }
  });

  it("bakes enemy-ak47.pose.json into a GLB where the rifle rides the right hand", async () => {
    const source = await recipe();
    const directory = await makeTempDir("animation-attach-");
    // The recipe names the paths it was calibrated against; the fixture stands in for both file
    // bodies while keeping the bone and clip names the calibration was measured on.
    const { host, prop } = await writeRigFixture(directory, Object.keys(source.animations));
    const log = upgradeLog({ ...source, attached: prop, host });
    const output = path.join(directory, "enemy.anim.glb");

    const baked = await bakeAttachment(log, output);

    expect(baked.anchor).toBe("mixamorigRightHand_035");
    expect(baked.node).toBe("attach-weapon");
    expect([...baked.clips].sort()).toEqual([
      "FiringRifle",
      "HitReaction",
      "RifleCrouchWalk",
      "RifleCrouchWalkToIdle",
      "RifleIdle",
      "RifleWalk",
    ]);
    // The three death clips release the rifle: the bake records the release in the op log, and the
    // game decides when the prop leaves the hand.
    expect([...baked.detached].sort()).toEqual(["DeathBack", "DeathFront", "DeathHeadshot"]);

    const document = await reader().read(output);
    const node = document
      .getRoot()
      .listNodes()
      .find((candidate) => candidate.getName() === "attach-weapon");
    if (node === undefined) throw new Error("The bake wrote no attach-weapon node.");
    const hand = node.getParentNode();
    expect(hand?.getName()).toBe("mixamorigRightHand_035");

    // The offsets live in the GLB: three channels per attached clip, none on a released clip.
    const channels = (name: string) =>
      document
        .getRoot()
        .listAnimations()
        .find((animation) => animation.getName() === name)
        ?.listChannels()
        .filter((channel) => channel.getTargetNode()?.getName() === "attach-weapon") ?? [];
    expect(
      channels("RifleIdle")
        .map((channel) => channel.getTargetPath())
        .sort(),
    ).toEqual(["rotation", "scale", "translation"]);
    expect(channels("DeathFront")).toEqual([]);

    // AC-3: posing the baked track puts the rifle where the recipe does, within 1 mm — measured in
    // world space, through a hand bone that is neither at the origin nor unrotated.
    const calibration = source.animations.RifleIdle?.keyframes[0]?.transform;
    if (calibration === undefined || hand === null)
      throw new Error("The recipe lost its RifleIdle calibration.");
    const sample = channels("RifleIdle")
      .find((channel) => channel.getTargetPath() === "translation")
      ?.getSampler()
      ?.getOutput()
      ?.getArray();
    if (sample === null || sample === undefined)
      throw new Error("The bake wrote no RifleIdle translation.");
    node.setTranslation([sample[0] ?? 0, sample[1] ?? 0, sample[2] ?? 0]);
    const expected = new Matrix4()
      .fromArray(hand.getWorldMatrix())
      .multiply(
        new Matrix4().makeTranslation(...(calibration.position as [number, number, number])),
      );
    const posed = new Vector3().setFromMatrixPosition(
      new Matrix4().fromArray(node.getWorldMatrix()),
    );
    expect(posed.distanceTo(new Vector3().setFromMatrixPosition(expected))).toBeLessThan(1e-3);
  });

  it("fails closed when the bone the log names is not in the host", async () => {
    const source = await recipe();
    const directory = await makeTempDir("animation-attach-missing-");
    const { host, prop } = await writeRigFixture(directory, Object.keys(source.animations));
    const log = upgradeLog({
      ...source,
      anchor: { id: "right-hand", label: "Right hand", node: "missing-bone", source: "detected" },
      attached: prop,
      host,
    });

    await expect(bakeAttachment(log, path.join(directory, "out.glb"))).rejects.toThrow(
      /missing-bone/u,
    );
  });
});
