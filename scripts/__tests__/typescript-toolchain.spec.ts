import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { checkVersionPins } from "../check-version-pins.js";

const root = path.resolve(".");
const native = path.join(root, "node_modules/@typescript/native/bin/tsc");

describe("native compiler and compatibility API", () => {
  it("keeps the shipped template compiler pins coherent", async () => {
    expect(await checkVersionPins(root)).toEqual([]);
  });
  it("runs TypeScript 7 while retaining the documented compiler API", () => {
    const result = spawnSync(process.execPath, [native, "--version"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("Version 7.0.2");
    const require = createRequire(path.join(root, "package.json"));
    expect(require("typescript/package.json").name).toBe("@typescript/typescript6");
    expect(require("typescript/package.json").version).toBe("6.0.2");
    const source = ts.createSourceFile(
      "fixture.ts",
      "export const value = 1;",
      ts.ScriptTarget.ES2022,
    );
    expect(source.statements).toHaveLength(1);
    const tsupRequire = createRequire(
      require.resolve("tsup", { paths: [path.join(root, "packages/core")] }),
    );
    expect(tsupRequire.resolve("typescript")).toBe(require.resolve("typescript"));
  });

  it("keeps scaffold compiler identity separate from rain's shader API dependency", () => {
    const templates = path.join(root, "packages/create-threenative/templates");
    const rain = JSON.parse(readFileSync(path.join(templates, "rain/package.json"), "utf8"));
    const starter = JSON.parse(readFileSync(path.join(templates, "starter/package.json"), "utf8"));
    expect(starter.devDependencies.typescript).toBe("7.0.2");
    expect(rain.devDependencies.typescript).toBe("7.0.2");
    expect(rain.devDependencies["@typescript/typescript6"]).toBe("6.0.2");
    const rainRequire = createRequire(path.join(templates, "rain/package.json"));
    const rootRequire = createRequire(path.join(root, "package.json"));
    expect(rainRequire.resolve("@typescript/typescript6")).toBe(rootRequire.resolve("typescript"));
  });
});

describe("TypeScript 6 declaration worker compatibility", () => {
  it("emits declarations without injecting baseUrl and preserves explicit options", async () => {
    const cwd = await makeTempDir("threenative-tsup-compat-");
    writeFileSync(
      path.join(cwd, "index.ts"),
      "export interface IFixture { readonly value: number; }\n",
    );
    writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(path.join(cwd, "node_modules"));
    symlinkSync(
      path.join(root, "node_modules/typescript"),
      path.join(cwd, "node_modules/typescript"),
    );
    const config = path.join(cwd, "tsconfig.json");
    const require = createRequire(path.join(root, "packages/core/package.json"));
    const cli = path.join(
      path.dirname(require.resolve("tsup/package.json")),
      "dist/cli-default.js",
    );
    const run = () =>
      spawnSync(
        process.execPath,
        [cli, "index.ts", "--dts-only", "--format", "esm", "--tsconfig", config],
        { cwd, encoding: "utf8", timeout: 30_000 },
      );
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler" },
      }),
    );
    const valid = run();
    expect(valid.status, valid.stdout + valid.stderr).toBe(0);
    expect(readFileSync(path.join(cwd, "dist/index.d.ts"), "utf8")).toContain(
      "readonly value: number",
    );
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          baseUrl: ".",
        },
      }),
    );
    const deprecated = run();
    expect(deprecated.status).not.toBe(0);
    expect(deprecated.stdout + deprecated.stderr).toContain("Option 'baseUrl' is deprecated");
  }, 60_000);
});
