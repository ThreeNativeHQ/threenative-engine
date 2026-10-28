import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { mirroredBone } from "../src/ops/clip-edit.js";
import type { AnimationLog } from "../src/ops/log.js";
import { renderLog } from "../src/ops/render.js";
import { verifyClip } from "../src/ops/verify.js";
import { writeFilmstrip } from "../src/report/filmstrip.js";
import { type IPoseFixture, writePoseFixture } from "./rig-fixture.js";

const JOINTS: IPoseFixture["joints"] = [
  { name: "mixamorigHips", translation: [0, 0.9, 0] },
  { name: "mixamorigLeftUpLeg", parent: "mixamorigHips", translation: [-0.2, -0.05, 0] },
  { name: "mixamorigLeftFoot", parent: "mixamorigLeftUpLeg", translation: [0, -0.81, 0] },
  { name: "mixamorigRightUpLeg", parent: "mixamorigHips", translation: [0.2, -0.05, 0] },
  { name: "mixamorigRightFoot", parent: "mixamorigRightUpLeg", translation: [0, -0.81, 0] },
];

/** A walk whose right foot slides 12 cm while planted: the seeded skate AC-5 repairs. */
async function slidingWalk(directory: string): Promise<string> {
  return writePoseFixture(directory, {
    channels: [
      {
        node: "mixamorigRightFoot",
        path: "translation",
        times: [0, 1],
        values: [
          [0, -0.81, 0],
          [0.12, -0.81, 0],
        ],
      },
    ],
    clip: "RifleWalk",
    joints: JOINTS,
  });
}

const log = (host: string, ops: AnimationLog["ops"]): AnimationLog => ({ host, ops, version: 4 });

describe("animation_modify", () => {
  it("names the bone on the other side", () => {
    expect(mirroredBone("mixamorigLeftHand")).toBe("mixamorigRightHand");
    expect(mirroredBone("Bip01 L Thigh")).toBe("Bip01 R Thigh");
    expect(mirroredBone("mixamorigHips")).toBeUndefined();
  });

  it("renders the same bytes twice from one log, so the log is the change", async () => {
    const directory = await makeTempDir("animation-modify-replay-");
    const host = await slidingWalk(directory);
    const edits = log(host, [
      { clip: "RifleWalk", edit: { kind: "retime", speed: 2 }, op: "modify" },
      { clip: "RifleWalk", edit: { kind: "resample", fps: 24 }, op: "modify" },
    ]);

    const first = path.join(directory, "a.glb");
    const second = path.join(directory, "b.glb");
    const a = await renderLog(edits, first);
    const b = await renderLog(edits, second);

    expect(a.modified).toEqual(["RifleWalk"]);
    expect(a.edits).toBe(2);
    expect((await readFile(first)).equals(await readFile(second))).toBe(true);
    expect(b.file).toBe(second);
  });

  it("repairs the skate it measured: verify passes after a foot lock", async () => {
    const directory = await makeTempDir("animation-modify-lock-");
    const host = await slidingWalk(directory);
    const before = await verifyClip(host, "RifleWalk");
    expect(before.defects.some((defect) => defect.kind === "foot-skate")).toBe(true);

    const repaired = path.join(directory, "repaired.glb");
    await renderLog(
      log(host, [
        {
          clip: "RifleWalk",
          edit: { contact: 0.03, feet: ["mixamorigRightFoot"], kind: "foot-lock" },
          op: "modify",
        },
      ]),
      repaired,
    );

    const after = await verifyClip(repaired, "RifleWalk");
    expect(after.defects.filter((defect) => defect.kind === "foot-skate")).toEqual([]);
  });

  it("closes a loop at the point it is asked to", async () => {
    const directory = await makeTempDir("animation-modify-loop-");
    const host = await writePoseFixture(directory, {
      channels: [
        {
          node: "mixamorigHips",
          path: "rotation",
          times: [0, 1],
          values: [
            [0, 0, 0, 1],
            [0, 0.2588, 0, 0.9659],
          ],
        },
      ],
      clip: "RifleIdle",
      joints: JOINTS,
    });

    const repaired = path.join(directory, "loop.glb");
    await renderLog(
      log(host, [{ clip: "RifleIdle", edit: { kind: "loop-point", time: 1 }, op: "modify" }]),
      repaired,
    );

    const after = await verifyClip(repaired, "RifleIdle");
    expect(after.defects.filter((defect) => defect.kind === "loop-seam")).toEqual([]);
  });

  it("trims a clip to its window and fails closed on an empty one", async () => {
    const directory = await makeTempDir("animation-modify-trim-");
    const host = await slidingWalk(directory);
    const trimmed = path.join(directory, "trimmed.glb");

    await renderLog(
      log(host, [{ clip: "RifleWalk", edit: { end: 0.5, kind: "trim", start: 0 }, op: "modify" }]),
      trimmed,
    );

    expect((await verifyClip(trimmed, "RifleWalk")).duration).toBeCloseTo(0.5, 3);
    await expect(
      renderLog(
        log(host, [
          { clip: "RifleWalk", edit: { end: 99, kind: "trim", start: 42 }, op: "modify" },
        ]),
        path.join(directory, "empty.glb"),
      ),
    ).rejects.toThrow(/is 1s long/u);
  });

  it("resamples onto a uniform grid", async () => {
    const directory = await makeTempDir("animation-modify-resample-");
    const host = await slidingWalk(directory);
    const output = path.join(directory, "resampled.glb");

    const result = await renderLog(
      log(host, [{ clip: "RifleWalk", edit: { fps: 12, kind: "resample" }, op: "modify" }]),
      output,
    );

    expect(result.edits).toBe(1);
    const after = await verifyClip(output, "RifleWalk", { fps: 12 });
    expect(after.frames).toBe(13);
  });
});

describe("filmstrip", () => {
  it("writes a non-blank PNG of the motion", async () => {
    const directory = await makeTempDir("animation-filmstrip-");
    const host = await slidingWalk(directory);
    const output = path.join(directory, "strip.png");

    const result = await writeFilmstrip({ clip: "RifleWalk", columns: 6, file: host, output });

    expect(result.frames).toBe(31);
    expect(result.columns).toBe(6);
    expect((await stat(output)).size).toBeGreaterThan(1_000);
    const png = await readFile(output);
    // PNG magic, and more than one distinct colour inside the file: a blank sheet compresses to
    // almost nothing and this one carries a skeleton.
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(new Set([...png]).size).toBeGreaterThan(16);
  });
});
