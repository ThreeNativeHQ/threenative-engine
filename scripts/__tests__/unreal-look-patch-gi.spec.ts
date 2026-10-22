import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { calibrationScenes, patchGi } from "../unreal-look/capture-gi-threenative.js";

/** A scaffold with only the anchors patchGi edits: the template's game.ts and config. */
function scaffold(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "tn-patch-gi-"));
  mkdirSync(path.join(root, "src/scenes"), { recursive: true });
  writeFileSync(
    path.join(root, "threenative.config.ts"),
    'export default {\n  nativeEntry: "src/game.ts",\n};\n',
  );
  writeFileSync(
    path.join(root, "src/game.ts"),
    [
      'import { Reference } from "./scenes/Reference.js";',
      "scenes: { play: Play, reference: Reference },",
      'start: "reference",',
      "",
    ].join("\n"),
  );
  return root;
}

const dataOf = (target: string) =>
  calibrationScenes(readFileSync(path.join(target, "src/scenes/calibrationData.ts"), "utf8"));

describe("a calibration scaffold keeps every scene it was patched with (owner preview)", () => {
  it("adds a scene on a second patch instead of replacing the first", async () => {
    const target = scaffold();
    await patchGi(target, ["cornell"]);
    await patchGi(target, ["sunlit-room"]);
    expect(Object.keys(dataOf(target)).sort()).toEqual(["cornell", "sunlit-room"]);
  });

  it("refreshes a scene it already holds", async () => {
    const target = scaffold();
    await patchGi(target, ["cornell"]);
    const file = path.join(target, "src/scenes/calibrationData.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace('"scene":"cornell"', '"scene":"stale"'));
    expect((dataOf(target).cornell as { scene: string }).scene).toBe("stale");
    await patchGi(target, ["cornell"]);
    expect((dataOf(target).cornell as { scene: string }).scene).toBe("cornell");
  });

  it("fails closed on a data file it did not write", async () => {
    const target = scaffold();
    writeFileSync(path.join(target, "src/scenes/calibrationData.ts"), "export const SCENES = 1;\n");
    await expect(patchGi(target, ["cornell"])).rejects.toThrow(/TN_UNREAL_LOOK_PATCH/);
  });
});
