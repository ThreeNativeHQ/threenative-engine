import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import { assertPackedImportClosure, assertUnpinnedEngine } from "../verify-one-template-desktop.js";

function fixture(): string {
  const root = makeTempDirSync("tn-packed-closure-");
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "src"));
  return root;
}

describe("packed default-engine consumer", () => {
  it("rejects missing entrypoints and transitive imports, including dynamic imports and reexports", () => {
    const root = fixture();
    expect(() => assertPackedImportClosure(root, ["scripts/bundle.mjs"])).toThrow(
      "TN_PACKED_SCRIPT_MISSING",
    );
    writeFileSync(path.join(root, "scripts/bundle.mjs"), 'export * from "../src/player.mjs";');
    writeFileSync(path.join(root, "src/player.mjs"), 'const sibling = import("./missing.mjs");');
    expect(() => assertPackedImportClosure(root, ["scripts/bundle.mjs"])).toThrow(
      "src/player.mjs -> ./missing.mjs",
    );
    writeFileSync(path.join(root, "src/missing.mjs"), 'import fs from "node:fs";');
    expect(() => assertPackedImportClosure(root, ["scripts/bundle.mjs"])).not.toThrow();
  });
  it("rejects a threejs or threenative engine pin while ignoring comments", () => {
    for (const engine of ["threejs", "threenative"])
      expect(() => assertUnpinnedEngine(`export default { engine: "${engine}" };`)).toThrow(
        "TN_PACKED_ENGINE_PINNED",
      );
    expect(() =>
      assertUnpinnedEngine('// engine: "threejs"\nexport default { app: {} };'),
    ).not.toThrow();
  });
});
