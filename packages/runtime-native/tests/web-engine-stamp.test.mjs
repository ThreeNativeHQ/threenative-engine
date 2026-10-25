import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import {
  assertEngineStampCurrent,
  engineSourceHash,
  writeEngineStamp,
} from "../scripts/web-engine-stamp.mjs";

function tree() {
  const root = makeTempDirSync("tn-web-engine-stamp-");
  for (const directory of ["src/engine/renderer", "src/engine/player", "include/threenative", "build/web"])
    mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "src/engine/renderer/plan.h"), "int decide();\n");
  writeFileSync(join(root, "src/engine/player/run.cpp"), "int main() {}\n");
  writeFileSync(join(root, "include/threenative/abi.h"), "#pragma once\n");
  writeFileSync(join(root, "build/web/tn-native-engine-web.wasm"), "\0asm");
  return root;
}

describe("web engine stamp", () => {
  it("passes a module built from the sources in the tree", () => {
    const root = tree();
    writeEngineStamp(root);
    expect(() => assertEngineStampCurrent(root)).not.toThrow();
  });

  it("refuses a module built before an engine source changed", () => {
    const root = tree();
    writeEngineStamp(root);
    writeFileSync(join(root, "src/engine/renderer/plan.h"), "int decide(int contentClass);\n");
    expect(() => assertEngineStampCurrent(root)).toThrow("TN_PACK_WEB_ENGINE_STALE");
  });

  it("refuses a module that names no sources", () => {
    expect(() => assertEngineStampCurrent(tree())).toThrow("TN_PACK_WEB_ENGINE_UNSTAMPED");
  });

  it("leaves a tree with no module built to the engine-missing checks", () => {
    const root = tree();
    rmSync(join(root, "build/web/tn-native-engine-web.wasm"));
    expect(() => assertEngineStampCurrent(root)).not.toThrow();
  });

  it("ignores the V8 player, which the web module does not compile", () => {
    const root = tree();
    const before = engineSourceHash(root);
    writeFileSync(join(root, "src/engine/player/run.cpp"), "int main() { return 1; }\n");
    expect(engineSourceHash(root)).toBe(before);
    writeFileSync(join(root, "include/threenative/abi.h"), "#pragma once\nint x;\n");
    expect(engineSourceHash(root)).not.toBe(before);
  });
});
