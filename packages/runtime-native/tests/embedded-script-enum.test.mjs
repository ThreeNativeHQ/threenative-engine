// Embedded runtime scripts are named by a generated enum (cmake/EmbedRuntimeScripts.cmake), so a
// misspelled name is a compile error and a script that lost its payload aborts boot naming itself.
// These checks hold the three places a script name lives to one list: the CMake list, the files on
// disk and the enumerators the C++ callers name.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const root = join(import.meta.dirname, "..");
const scriptsDirectory = join(root, "src", "runtime-scripts");
const embed = join(root, "cmake", "EmbedRuntimeScripts.cmake");

function listedScripts() {
  const cmake = readFileSync(join(root, "CMakeLists.txt"), "utf8");
  const block = /set\(TN_RUNTIME_SCRIPT_NAMES\n([\s\S]*?)\n\)/u.exec(cmake)?.[1];
  expect(block, "TN_RUNTIME_SCRIPT_NAMES block").toBeDefined();
  return block.split("\n").map((line) => line.trim()).filter(Boolean);
}

function cSources(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(cpp|h)$/u.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function generate(workdir, names) {
  const output = join(workdir, "runtime_scripts.h");
  const result = spawnSync(
    "cmake",
    [`-DOUTPUT=${output}`, `-DSOURCE_DIR=${scriptsDirectory}`, `-DSCRIPT_NAMES=${names.join(";")}`, "-DSCRIPT_ENUM=ON", "-P", embed],
    { encoding: "utf8" },
  );
  return { output, result };
}

describe("embedded runtime script names", () => {
  it("lists exactly the scripts on disk", () => {
    const onDisk = readdirSync(scriptsDirectory).filter((name) => name.endsWith(".js")).map((name) => name.slice(0, -3));
    expect([...listedScripts()].sort()).toEqual(onDisk.sort());
  });

  it("is named by enumerators that every caller spells from the list", () => {
    const enumerators = new Set(listedScripts().map((name) => name.replaceAll("-", "_")));
    const unknown = [];
    for (const file of cSources(join(root, "src"))) {
      for (const [, name] of readFileSync(file, "utf8").matchAll(/runtime_scripts::Script::(\w+)/gu)) {
        if (!enumerators.has(name)) unknown.push(`${file}: ${name}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("keeps string lookups out of every caller but the math script's", () => {
    const strings = cSources(join(root, "src")).filter((file) =>
      /runtime_scripts::find\(\s*"/u.test(readFileSync(file, "utf8")),
    );
    expect(strings.map((file) => file.slice(root.length + 1))).toEqual(["src/adapters/v8/math_bridge.cpp"]);
  });

  it("refuses to generate a header for a script with no file, naming it", () => {
    const workdir = makeTempDirSync("tn-embed-");
    try {
      const { result } = generate(workdir, ["storage-polyfill", "no-such-script"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("no-such-script");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("aborts boot, naming the script, when an enumerator has no payload", () => {
    const workdir = makeTempDirSync("tn-embed-");
    try {
      const { result } = generate(workdir, ["storage-polyfill", "frame-op-stream"]);
      expect(result.status).toBe(0);
      const program = join(workdir, "probe.cpp");
      writeFileSync(
        program,
        `#include "runtime_scripts.h"\nusing namespace mystral::runtime_scripts;\n` +
          `int main(int argc, char**) {\n  if (argc > 1) return static_cast<int>(require(static_cast<Script>(7)).size);\n` +
          `  return require(Script::frame_op_stream).size > 0 ? 0 : 2;\n}\n`,
      );
      const binary = join(workdir, "probe");
      const compile = spawnSync("c++", ["-std=c++17", `-I${workdir}`, program, "-o", binary], { encoding: "utf8" });
      expect(compile.stderr).toBe("");
      expect(spawnSync(binary, [], { encoding: "utf8" }).status).toBe(0);
      const missing = spawnSync(binary, ["missing"], { encoding: "utf8" });
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain("TN_EMBEDDED_SCRIPT_MISSING");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
