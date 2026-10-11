import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

it.runIf(process.platform === "linux")(
  "Perry defaults to the compiled CSS-only backend and honors an explicit renderer",
  () => {
    const source = readFileSync(
      new URL("../src/engine/abi/perry_player.cpp", import.meta.url),
      "utf8",
    );
    const selection = source.match(
      /const char\* renderer = std::getenv\("TN_UI_RENDERER"\);[\s\S]*?(?=#if defined\(__linux__\))/u,
    )?.[0];
    expect(selection).toBeDefined();
    const dir = makeTempDirSync("tn-perry-ui-backend-");
    const file = join(dir, "selection.cpp");
    const binary = join(dir, "selection");
    writeFileSync(
      file,
      `#include <cstdlib>\n#include <string>\n#include <iostream>\nint main() { ${selection} std::cout << cssUi; }\n`,
    );
    for (const [css, web, expected] of [
      [1, 0, "1"],
      [1, 1, "0"],
      [0, 1, "0"],
    ] as const) {
      const compile = spawnSync(
        "c++",
        [file, "-o", binary, `-DTN_ENABLE_CSS_UI=${css}`, `-DTN_ENABLE_UI_OVERLAY=${web}`],
        { encoding: "utf8" },
      );
      expect(compile.status, compile.stderr).toBe(0);
      for (const [renderer, answer] of [
        [undefined, expected],
        ["native-css", "1"],
        ["web", "0"],
      ]) {
        const env = { ...process.env, TN_UI_RENDERER: renderer };
        const run = spawnSync(binary, [], { env, encoding: "utf8" });
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout).toBe(answer);
      }
    }
  },
);
