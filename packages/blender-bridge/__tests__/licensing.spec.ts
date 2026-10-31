import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Blender is GPLv2-or-later, and Python that runs inside it against `bpy` is treated here as
 * GPL-covered. The Node server stays MIT; every `.py` under `gpl/` carries a GPL-2.0-or-later
 * header beside a `LICENSE.GPL`. A script that lands without one silently relicenses itself, and
 * nothing else in this repository would notice.
 */

// From this file, not the working directory: `pnpm test` runs the spec from the package directory.
const packageRoot = path.resolve(import.meta.dirname, "..");
const gplRoot = path.join(packageRoot, "gpl");

function pythonFiles(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return pythonFiles(full);
    return entry.isFile() && entry.name.endsWith(".py") ? [full] : [];
  });
}

describe("blender-bridge GPL boundary", () => {
  it("should ship a GPL licence beside the scripts that run inside Blender", () => {
    const licence = path.join(gplRoot, "LICENSE.GPL");
    expect(existsSync(licence), licence).toBe(true);
    expect(readFileSync(licence, "utf8")).toContain("GNU GENERAL PUBLIC LICENSE");
  });

  it("should carry a GPL header on every gpl/*.py", () => {
    for (const file of pythonFiles(gplRoot)) {
      const head = readFileSync(file, "utf8").slice(0, 800);
      expect(head, file).toContain("SPDX-License-Identifier: GPL-2.0-or-later");
    }
  });

  it("should keep every Python file this package ships under gpl/", () => {
    const stray = pythonFiles(path.join(packageRoot, "src"));
    expect(stray).toEqual([]);
  });

  it("should keep the package manifest MIT and ship the gpl directory", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as { files?: string[]; license?: string };
    expect(manifest.license).toBe("MIT");
    expect(manifest.files).toContain("gpl");
  });
});
