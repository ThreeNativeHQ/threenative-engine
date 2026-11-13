import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const packageDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");

// An installed project holds only what npm publishes. A weak-model build looked for the tick units of
// `holdTicks` in node_modules/@threenative/playtest/docs, found no folder, and read the minified
// runner instead (wm-platformer-3, 2026-11-13).
test("the published package carries the reference and determinism docs", () => {
  const [pack] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: packageDirectory,
      encoding: "utf8",
    }),
  ) as [{ files: { path: string }[] }];
  const files = pack.files.map((file) => file.path);
  expect(files).toEqual(expect.arrayContaining(["docs/reference.md", "docs/determinism.md"]));
});
