import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";
// @ts-expect-error -- plain ESM with no type declarations.
import {
  assertOutsideGameAndRepo,
  bindHostGlobals,
  bindImportMeta,
  classifyPerryOutput,
  compareRuns,
  convertCheckScript,
} from "../compile-game.mjs";

const REPO = path.join(import.meta.dirname, "..", "..", "..");

describe("classifyPerryOutput", () => {
  const output = [
    "Found 30 module(s): 30 native, 0 JavaScript",
    "  Warning: Could not resolve import '@threenative/core' from game.ts",
    "  Warning: Could not resolve import '@threenative/core' from Play.ts",
    "  Warning: Could not resolve import 'three/tsl' from fog.ts",
    "  Warning: unknown identifier 'document' in src/main.ts — assuming global",
    "/usr/bin/ld: perry_module:(.text+0x1): undefined reference to `defineGame'",
    "/usr/bin/ld: perry_module:(.text+0x2): undefined reference to `__perry_wrap_perry_fn_node_modules_three_three_ts__MathUtils'",
    "Error: Linking failed",
  ].join("\n");

  it("separates missing engine API from Perry's own errors", () => {
    expect(classifyPerryOutput(output)).toEqual({
      modules: { total: 30, native: 30, javascript: 0 },
      unresolvedImports: ["@threenative/core", "three/tsl"],
      undefinedSymbols: ["defineGame"],
      missingFacadeMembers: ["MathUtils"],
      unknownGlobals: ["document"],
      perryErrors: [],
      linkFailed: true,
    });
  });

  it("reports a Perry error that is not the link failure", () => {
    const parsed = classifyPerryOutput("Error: Failed to parse a.ts: Parse error\n");
    expect(parsed.perryErrors).toEqual(["Error: Failed to parse a.ts: Parse error"]);
    expect(parsed.linkFailed).toBe(false);
  });
});

describe("convertCheckScript", () => {
  it("turns a bundle() helper into static namespace imports", () => {
    const source = [
      'import assert from "node:assert/strict";',
      'import { build } from "esbuild";',
      "async function bundle(entry) {",
      "  const { outputFiles } = await build({ entryPoints: [entry], bundle: true });",
      "  return import(`data:text/javascript;base64,${outputFiles[0].text}`);",
      "}",
      'const sub = await bundle("src/sim/submarine.ts");',
      "assert.ok(sub.ok);",
    ].join("\n");
    const { driver, bundles } = convertCheckScript(source, "check-sub");
    expect(bundles).toEqual([]);
    expect(driver).toContain('import * as sub from "./src/sim/submarine.js";');
    expect(driver).not.toMatch(/esbuild|bundle\(|data:text/u);
    expect(driver).toContain("assert.ok(sub.ok);");
  });

  it("turns an inline build() of entryPoints into a named import", () => {
    const source = [
      'import { build } from "esbuild";',
      "const { outputFiles } = await build({",
      '  entryPoints: ["src/sim/damage.ts"], bundle: true, write: false,',
      "});",
      "const { applyDamage } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);",
      "console.log(applyDamage);",
    ].join("\n");
    const { driver } = convertCheckScript(source, "check-damage");
    expect(driver).toContain('import { applyDamage } from "./src/sim/damage.js";');
    expect(driver).toContain("console.log(applyDamage);");
  });

  it("writes stdin contents as a module of its own, with the escapes decoded", () => {
    const source = [
      'import { build } from "esbuild";',
      "const built = await build({",
      '  stdin: { contents: \'export * from "./src/sim/a.ts";\\nexport { b } from "./src/sim/b.ts";\', resolveDir: process.cwd() },',
      "  bundle: true, write: false,",
      "});",
      "const ops = await import(`data:text/javascript,${encodeURIComponent(built.outputFiles[0].text)}`);",
      "console.log(ops.b);",
    ].join("\n");
    const { driver, bundles } = convertCheckScript(source, "check-ops");
    expect(driver).toContain('import * as ops from "./__bundle_check-ops_1.js";');
    expect(bundles).toEqual([
      {
        file: "__bundle_check-ops_1.ts",
        text: 'export * from "./src/sim/a.js";\nexport { b } from "./src/sim/b.js";\n',
      },
    ]);
  });

  it("refuses a script it cannot convert instead of guessing", () => {
    const source = 'import { build } from "esbuild";\nconst x = await build({ bundle: true });\n';
    expect(() => convertCheckScript(source, "check-odd")).toThrow(/^TN_COMPILE_GAME_UNCONVERTED/u);
    expect(() => convertCheckScript("console.log(import.meta.url);\n", "check-meta")).toThrow(
      /import\.meta/u,
    );
  });

  it("produces a driver that runs under tsx with the game's own modules", () => {
    const dir = makeTempDirSync("tn-compile-game-");
    fs.mkdirSync(path.join(dir, "src", "sim"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "src", "sim", "math.ts"),
      "export const add = (a: number, b: number): number => a + b;\n",
    );
    const script = [
      'import assert from "node:assert/strict";',
      'import { build } from "esbuild";',
      "async function bundle(entry) {",
      "  const { outputFiles } = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });",
      "  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);",
      "}",
      'const m = await bundle("src/sim/math.ts");',
      "assert.equal(m.add(2, 3), 5);",
      'console.log("check-add ok");',
    ].join("\n");
    fs.writeFileSync(
      path.join(dir, "check-add.ts"),
      convertCheckScript(script, "check-add").driver,
    );
    const run = spawnSync(path.join(REPO, "node_modules", ".bin", "tsx"), ["check-add.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(run.stdout.trim()).toBe("check-add ok");
    expect(run.status).toBe(0);
  });
});

describe("compareRuns", () => {
  it("accepts the same exit and stdout, ignoring trailing whitespace", () => {
    expect(compareRuns({ status: 0, stdout: "ok\n" }, { status: 0, stdout: "ok" })).toBe("same");
  });
  it("calls a different output different", () => {
    expect(compareRuns({ status: 0, stdout: "a" }, { status: 0, stdout: "b" })).toBe("different");
    expect(compareRuns({ status: 0, stdout: "a" }, { status: 1, stdout: "a" })).toBe("different");
  });
  it("proves nothing when the reference itself failed, even if the native run failed alike", () => {
    expect(compareRuns({ status: 1, stdout: "" }, { status: 1, stdout: "" })).toBe(
      "invalid-reference",
    );
  });
});

describe("assertOutsideGameAndRepo", () => {
  it("refuses to stage inside the game or this checkout", () => {
    expect(() => assertOutsideGameAndRepo("/games/midway/out", "/games/midway", "/repo")).toThrow(
      /TN_COMPILE_GAME_OUT_INSIDE.*the game/u,
    );
    expect(() => assertOutsideGameAndRepo("/repo/tmp/out", "/games/midway", "/repo")).toThrow(
      /this checkout/u,
    );
    expect(() => assertOutsideGameAndRepo("/tmp/out", "/games/midway", "/repo")).not.toThrow();
  });
});

describe("bindImportMeta", () => {
  it("inlines import.meta.env the way a production Vite build does and drops import.meta.hot", () => {
    const source = [
      'const on = import.meta.env.VITE_FPS === "1";',
      "const mode = import.meta.env.MODE;",
      "import.meta.hot?.accept();",
      "const here = import.meta.url;",
    ].join("\n");
    expect(bindImportMeta(source, "a.ts", { VITE_FPS: "1", HOME: "/root" })).toBe(
      [
        'const on = ({"BASE_URL":"/","DEV":false,"MODE":"production","PROD":true,"SSR":false,"VITE_FPS":"1"}).VITE_FPS === "1";',
        'const mode = ({"BASE_URL":"/","DEV":false,"MODE":"production","PROD":true,"SSR":false,"VITE_FPS":"1"}).MODE;',
        "undefined?.accept();",
        "const here = import.meta.url;",
      ].join("\n"),
    );
  });

  it("returns a file without import.meta untouched", () => {
    expect(bindImportMeta("const a = 1;", "a.ts", {})).toBe("const a = 1;");
  });
});

describe("bindHostGlobals", () => {
  it("routes free host globals through globalThis, where Perry honours the host's override", () => {
    const source = [
      "const context = new AudioContext();",
      "const legacy = new webkitAudioContext();",
      "const t0 = performance.now();",
      "const id: ReturnType<typeof setTimeout> = setTimeout(() => clearTimeout(id), 1);",
      "const r = await fetch(url);",
      "const b = await createImageBitmap(await r.blob());",
      "const o = { fetch, x: window.setTimeout, setInterval: 1 };",
      "class C { fetch() {} }",
    ].join("\n");
    expect(bindHostGlobals(source, "a.ts")).toBe(
      [
        "const context = new globalThis.AudioContext();",
        "const legacy = new globalThis.webkitAudioContext();",
        "const t0 = globalThis.performance.now();",
        "const id: ReturnType<typeof globalThis.setTimeout> = globalThis.setTimeout(() => globalThis.clearTimeout(id), 1);",
        "const r = await globalThis.fetch(url);",
        "const b = await globalThis.createImageBitmap(await r.blob());",
        "const o = { fetch: globalThis.fetch, x: window.setTimeout, setInterval: 1 };",
        "class C { fetch() {} }",
      ].join("\n"),
    );
  });

  it("leaves a name the file binds itself", () => {
    const source = "const fetch = (o: object) => o;\nfetch(this);\nsetTimeout(f);";
    expect(bindHostGlobals(source, "b.ts")).toBe(
      "const fetch = (o: object) => o;\nfetch(this);\nglobalThis.setTimeout(f);",
    );
  });
});
