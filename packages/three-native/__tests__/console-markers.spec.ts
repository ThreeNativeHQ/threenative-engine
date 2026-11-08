// The console markers are a contract between whoever prints a `TN_*` line (C++ hosts, core, the
// facade) and whoever parses it (`threenative-playtest perf`, the evaluators). A rename in one
// language that misses the other compiles and then reads an empty log. These checks pin the copies
// generated from the manifest and fail when a producer or parser types a marker by hand again.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const MANIFEST = path.join(ROOT, "packages/three-native/api/console-markers.json");
const HEADER = path.join(ROOT, "packages/runtime-native/include/mystral/console_markers.h");
const TS_COPIES = ["playtest", "core", "three-native"].map((name) =>
  path.join(ROOT, "packages", name, "src/generated/console-markers.ts"),
);

interface IMarker {
  readonly marker: string;
  readonly name: string;
}

function manifest(): readonly IMarker[] {
  return (JSON.parse(readFileSync(MANIFEST, "utf8")) as { markers: readonly IMarker[] }).markers;
}

function sources(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && extensions.includes(path.extname(entry.name)))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !file.includes(`${path.sep}generated${path.sep}`))
    .filter((file) => !file.endsWith("console_markers.h"));
}

describe("the console marker table", () => {
  it("should generate every TypeScript copy from the manifest", () => {
    for (const copy of TS_COPIES) {
      const rows = [
        ...readFileSync(copy, "utf8").matchAll(/^ {2}(\w+): "(TN_[A-Z0-9_]+)",$/gmu),
      ].map(([, name, marker]) => ({ marker, name }));
      expect(rows, path.relative(ROOT, copy)).toEqual(manifest());
    }
  });

  it("should generate the C++ macros from the manifest", () => {
    const rows = [
      ...readFileSync(HEADER, "utf8").matchAll(
        /^#define TN_MARKER_([A-Z0-9_]+) "(TN_[A-Z0-9_]+)"$/gmu,
      ),
    ].map(([, name, marker]) => [name, marker] as const);
    expect(rows).toEqual(
      manifest().map(
        (entry) =>
          [entry.name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase(), entry.marker] as const,
      ),
    );
  });

  it("should keep every printer and parser off a hand-typed marker", () => {
    const typed = manifest()
      .map((entry) => entry.marker)
      .join("|");
    const parsers = new RegExp(`"(?:${typed}):?"`, "u");
    const printers = new RegExp(`"(?:${typed}):`, "u");
    const search = (directory: string, extensions: string[], pattern: RegExp): string[] =>
      sources(path.join(ROOT, directory), extensions)
        .filter((file) => pattern.test(readFileSync(file, "utf8")))
        .map((file) => path.relative(ROOT, file));
    const hits = [
      ...["playtest", "core", "three-native"].flatMap((name) =>
        search(`packages/${name}/src`, [".ts", ".tsx"], parsers),
      ),
      ...search("packages/runtime-native/src", [".cpp", ".h"], printers),
      ...search("packages/runtime-native/include", [".h"], printers),
    ];
    expect(
      hits,
      "import CONSOLE_MARKER (TS) or TN_MARKER_* (C++) instead of typing the text",
    ).toEqual([]);
  });
});
