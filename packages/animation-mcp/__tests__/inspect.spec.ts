import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { inspectModel } from "../src/ops/inspect.js";
import { writeRigFixture } from "./rig-fixture.js";

describe("animation_inspect", () => {
  it("reads a rig's bones, landmarks and clips, and finds the clip in place", async () => {
    const directory = await makeTempDir("animation-inspect-");
    const { host } = await writeRigFixture(directory, [
      "RifleIdle",
      "RifleWalk",
      "CrouchWalkToIdle",
    ]);

    const report = await inspectModel(host);

    expect(report.bones).toEqual(["mixamorigHips", "mixamorigRightHand_035"]);
    expect(report.skins).toBe(1);
    expect(report.meshes).toBe(1);
    expect(report.rootBone).toBe("mixamorigHips");
    expect(report.landmarks).toEqual([
      { id: "right-hand", label: "Right hand", node: "mixamorigRightHand_035", source: "detected" },
      { id: "hips", label: "Hips / root", node: "mixamorigHips", source: "detected" },
    ]);
    expect(report.clips.map((clip) => clip.name)).toEqual([
      "CrouchWalkToIdle",
      "RifleIdle",
      "RifleWalk",
    ]);
    expect(report.clips.every((clip) => clip.channels === 1)).toBe(true);
    expect(report.inPlace).toBe(true);
    expect(report.warnings).toEqual([]);
    expect(report.bytes).toBeGreaterThan(0);
  });

  it("names a clip that carries the character as root motion, not in place", async () => {
    const directory = await makeTempDir("animation-inspect-walk-");
    const { walk } = await writeRigFixture(directory, ["RifleIdle"]);

    const report = await inspectModel(walk);

    const rootWalk = report.clips.find((clip) => clip.name === "RootWalk");
    expect(rootWalk?.inPlace).toBe(false);
    expect(rootWalk?.horizontalTravel).toBeCloseTo(2, 4);
    expect(report.inPlace).toBe(false);
  });

  it("reports a model with no rig or clip instead of inventing one", async () => {
    const directory = await makeTempDir("animation-inspect-bare-");
    const { prop } = await writeRigFixture(directory, []);

    const report = await inspectModel(prop);

    expect(report.skins).toBe(0);
    expect(report.landmarks).toEqual([]);
    expect(report.rootBone).toBeNull();
    expect(report.warnings).toContain("No skin: the model is not rigged.");
    expect(report.warnings).toContain("No animation clip: nothing to verify.");
  });

  it("fails closed on a file that is not a GLB", async () => {
    const directory = await makeTempDir("animation-inspect-bad-");
    const file = path.join(directory, "not-a-model.glb");
    await writeFile(file, "not a model");

    await expect(inspectModel(file)).rejects.toThrow();
  });
});
