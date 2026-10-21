import { describe, expect, it } from "vitest";
import { referencePoses } from "../unreal-look/capture-threenative.js";

describe("the reference page starts at a capture pose, not inside the floor plane", () => {
  it("lists the calibration poses and each GI scene's poses by its ?model= folder", () => {
    const poses = referencePoses();
    expect(poses[""]?.length).toBeGreaterThan(0);
    expect(poses["sunlit-room"]?.[0]).toMatchObject({
      name: "sun60-window",
      position: [0, 1.5, -5.5],
      hfovDeg: 90,
    });
    expect(poses.cornell?.length).toBeGreaterThan(0);
    // A template-lit shadow scene opens through ?model=shadow/<name> (PRD-649).
    expect(poses["shadow/foliage"]?.[0]).toMatchObject({ name: "sun60-canopy" });
    for (const list of Object.values(poses))
      for (const pose of list) expect(pose.position[1]).not.toBe(0);
  });
});
