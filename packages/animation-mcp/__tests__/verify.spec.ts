import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { verifyClip } from "../src/ops/verify.js";
import { type IPoseFixture, writePoseFixture } from "./rig-fixture.js";

/** A 1.7 m humanoid in metres: hips at 0.9, knees at 0.45, feet at 0.04. */
const JOINTS: IPoseFixture["joints"] = [
  { name: "mixamorigHips", translation: [0, 0.9, 0] },
  { name: "mixamorigLeftUpLeg", parent: "mixamorigHips", translation: [-0.2, -0.05, 0] },
  { name: "mixamorigLeftFoot", parent: "mixamorigLeftUpLeg", translation: [0, -0.81, 0] },
  { name: "mixamorigRightUpLeg", parent: "mixamorigHips", translation: [0.2, -0.05, 0] },
  { name: "mixamorigRightFoot", parent: "mixamorigRightUpLeg", translation: [0, -0.81, 0] },
];

const identity = [0, 0, 0, 1];

/** A clip where both feet stay put: nothing to report. */
const CLEAN: IPoseFixture = {
  channels: [
    {
      node: "mixamorigHips",
      path: "translation",
      times: [0, 0.5, 1],
      values: [
        [0, 0.9, 0],
        [0, 0.92, 0],
        [0, 0.9, 0],
      ],
    },
  ],
  clip: "RifleIdle",
  joints: JOINTS,
};

describe("animation_verify", () => {
  it("passes a clean clip and reports what it measured", async () => {
    const directory = await makeTempDir("animation-verify-clean-");
    const file = await writePoseFixture(directory, CLEAN);

    const report = await verifyClip(file, "RifleIdle");

    expect(report.defects).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.bones).toBe(5);
    expect(report.frames).toBe(31);
    expect(report.duration).toBe(1);
    expect(report.thresholds.skate).toBe(0.02);
  });

  it("names a planted foot that slides, with the bone and the frames it slid through", async () => {
    const directory = await makeTempDir("animation-verify-skate-");
    const file = await writePoseFixture(directory, {
      channels: [
        {
          node: "mixamorigRightFoot",
          path: "translation",
          times: [0, 1],
          values: [
            [0, -0.81, 0],
            [0.15, -0.81, 0],
          ],
        },
      ],
      clip: "RifleWalk",
      joints: JOINTS,
    });

    const report = await verifyClip(file, "RifleWalk");

    expect(report.passed).toBe(false);
    const skate = report.defects.filter((defect) => defect.kind === "foot-skate");
    expect(skate).toHaveLength(1);
    expect(skate[0]?.bone).toBe("mixamorigRightFoot");
    expect(skate[0]?.measured).toBeGreaterThan(0.02);
    expect(skate[0]?.fromFrame).toBe(0);
    expect(skate[0]?.toFrame).toBe(30);
  });

  it("names a foot under the floor, and only mentions the foot", async () => {
    const directory = await makeTempDir("animation-verify-floor-");
    const file = await writePoseFixture(directory, {
      channels: [
        {
          node: "mixamorigLeftFoot",
          path: "translation",
          times: [0, 1],
          values: [
            [0, -0.81, 0],
            [0, -0.9, 0],
          ],
        },
      ],
      clip: "RifleCrouchWalk",
      joints: JOINTS,
    });

    const report = await verifyClip(file, "RifleCrouchWalk");

    const penetration = report.defects.filter((defect) => defect.kind === "ground-penetration");
    expect(penetration.length).toBeGreaterThan(0);
    expect(penetration.every((defect) => defect.bone === "mixamorigLeftFoot")).toBe(true);
    expect(penetration[0]?.detail).toMatch(/below the floor/u);
  });

  it("names a loop that does not close, in degrees", async () => {
    const directory = await makeTempDir("animation-verify-seam-");
    const file = await writePoseFixture(directory, {
      channels: [
        {
          node: "mixamorigHips",
          path: "rotation",
          times: [0, 1],
          values: [identity, [0, 0.2588, 0, 0.9659]],
        },
      ],
      clip: "RifleIdle",
      joints: JOINTS,
    });

    const report = await verifyClip(file, "RifleIdle");

    const seam = report.defects.filter((defect) => defect.kind === "loop-seam");
    expect(seam).toHaveLength(1);
    expect(seam[0]?.bone).toBe("mixamorigHips");
    expect(seam[0]?.measured).toBeCloseTo(30, 0);
    expect(seam[0]?.detail).toMatch(/ends 30/u);
  });

  it("names a single-frame spike, not the whole clip", async () => {
    const directory = await makeTempDir("animation-verify-jitter-");
    const file = await writePoseFixture(directory, {
      channels: [
        {
          node: "mixamorigHips",
          path: "translation",
          times: [0, 0.4, 0.45, 0.5, 1],
          values: [
            [0, 0.9, 0],
            [0, 0.9, 0],
            [0.3, 0.9, 0],
            [0, 0.9, 0],
            [0, 0.9, 0],
          ],
        },
      ],
      clip: "HitReaction",
      joints: JOINTS,
    });

    const report = await verifyClip(file, "HitReaction");

    const spikes = report.defects.filter((defect) => defect.kind === "jitter");
    expect(spikes.length).toBeGreaterThan(0);
    expect(spikes[0]?.bone).toBe("mixamorigHips");
    // One keyframe of damage must not be reported as the whole clip.
    expect((spikes[0]?.toFrame ?? 0) - (spikes[0]?.fromFrame ?? 0)).toBeLessThanOrEqual(4);
  });

  it("names a skeleton whose bones change length", async () => {
    const directory = await makeTempDir("animation-verify-stretch-");
    const file = await writePoseFixture(directory, {
      channels: [
        {
          node: "mixamorigLeftFoot",
          path: "translation",
          times: [0, 1],
          values: [
            [0, -0.81, 0],
            [0, -0.4, 0],
          ],
        },
      ],
      clip: "DeathFront",
      joints: JOINTS,
    });

    const report = await verifyClip(file, "DeathFront");

    const stretch = report.defects.filter((defect) => defect.kind === "bone-stretch");
    expect(stretch.length).toBeGreaterThan(0);
    expect(stretch.some((defect) => defect.detail.includes("mixamorigLeftFoot"))).toBe(true);
  });

  it("reads centimetres as metres when the model says so", async () => {
    const directory = await makeTempDir("animation-verify-scale-");
    // One model unit of slide: 1 m when the model is in metres, 1 cm once it says centimetres,
    // which is the difference between over and under AC-5's 2 cm.
    const file = await writePoseFixture(directory, {
      channels: [
        {
          node: "mixamorigRightFoot",
          path: "translation",
          times: [0, 1],
          values: [
            [0, -81, 0],
            [1, -81, 0],
          ],
        },
      ],
      clip: "RifleWalk",
      joints: JOINTS.map((joint) => ({
        ...joint,
        translation: [
          joint.translation[0] * 100,
          joint.translation[1] * 100,
          joint.translation[2] * 100,
        ] as [number, number, number],
      })),
    });

    const metres = await verifyClip(file, "RifleWalk");
    const centimetres = await verifyClip(file, "RifleWalk", { scale: 0.01 });

    expect(metres.defects.some((defect) => defect.kind === "foot-skate")).toBe(true);
    expect(centimetres.defects.some((defect) => defect.kind === "foot-skate")).toBe(false);
  });

  it("fails closed on a clip the file does not carry", async () => {
    const directory = await makeTempDir("animation-verify-missing-");
    const file = await writePoseFixture(directory, CLEAN);

    await expect(verifyClip(file, "NoSuchClip")).rejects.toThrow(
      /no clip 'NoSuchClip'.*RifleIdle/u,
    );
  });
});
