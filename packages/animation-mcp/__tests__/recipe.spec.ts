import { describe, expect, it } from "vitest";
import { migrateRecipe, poseAt, upsertKeyframe } from "../src/client/recipe.js";

const transform = (x: number) => ({
  position: [x, 0, 0] as [number, number, number],
  rotation: [0, x, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
});

describe("Pose Lab recipe timeline", () => {
  it("migrates legacy animation samples without changing their values", () => {
    const migrated = migrateRecipe({
      anchor: { id: "right-hand", label: "Right hand", node: "RightHand", source: "detected" },
      animations: { Death: { time: 0.7, transform: transform(12) } },
      attached: "rifle.glb",
      host: "host.glb",
      version: 2,
    });
    expect(migrated?.animations.Death).toEqual({
      attachment: "attached",
      keyframes: [{ time: 0.7, transform: transform(12) }],
    });
  });

  it("stores multiple frame poses and interpolates between them", () => {
    const first = upsertKeyframe(undefined, { time: 0, transform: transform(0) });
    const track = upsertKeyframe(first, { time: 1, transform: transform(10) });
    expect(track.keyframes).toHaveLength(2);
    expect(poseAt(track, 0.25)?.position[0]).toBe(2.5);
  });

  it("preserves detached animation behavior while updating a keyframe", () => {
    const track = upsertKeyframe(
      { attachment: "detached", keyframes: [{ time: 0, transform: transform(0) }] },
      { time: 0.5, transform: transform(5) },
    );
    expect(track.attachment).toBe("detached");
    expect(track.keyframes).toHaveLength(2);
  });
});
