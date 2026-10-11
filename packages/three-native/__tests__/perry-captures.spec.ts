import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

// Native compilation is opt-in, as it is for the native corpus.
it.runIf(process.env.TN_NATIVE_TS_CACHE)(
  "keeps the fixed-member converter in Perry's nested getter closure",
  () => {
    const compiler = spawnSync(
      process.execPath,
      ["tools/native-typescript/provision.mjs", "--check"],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(compiler.status, compiler.stderr).toBe(0);
    const dir = makeTempDirSync("tn-perry-capture-");
    const source = readFileSync(new URL("../src/browser-backend.ts", import.meta.url), "utf8");
    const getter = source.slice(
      source.indexOf("  const fastGetter ="),
      source.indexOf("  // A kept member of an object"),
    );
    const converter = source.match(
      /(?:const fromEngine = \(value: EngineValue\): unknown =>|function fromEngine\(value: EngineValue\): unknown) \{[\s\S]*?\n {2}\};?/u,
    )?.[0];
    expect(converter).toBeDefined();
    writeFileSync(
      path.join(dir, "main.ts"),
      `function factory() {
  const runtime = { get: (owner: object, name: string) => 42 };
  const within = new WeakMap<object, [object, string]>();
  const kept = new WeakMap<object, Map<string, unknown>>();
  const refOf = (owner: object) => owner;
  const addressOf = (owner: object, whole: boolean) => 0;
  const isRef = (value: unknown) => false;
  const wrap = (value: unknown) => value;
  const allNumbers = (value: unknown[]) => true;
${getter}
  const deferred = (owner: object, property: string, prototype: object) => ({});
${converter}
  return fastGetter({ getters: [], setters: [], fixedMembers: ["position"] }, "position");
}
const getter = factory();
const owner = {};
console.log("TN_PERRY_CAPTURE:" + getter.call(owner) + ":" + getter.call(owner));
`,
    );
    const binary = path.join(dir, "probe");
    const built = spawnSync(
      compiler.stdout.trim(),
      [
        "compile",
        path.join(dir, "main.ts"),
        "-o",
        binary,
        "--strict-eval",
        "--strict-dynamic-import",
        "--strict-unimplemented",
        "--no-auto-optimize",
      ],
      { cwd: dir, encoding: "utf8", timeout: 30_000 },
    );
    expect(built.status, built.stderr).toBe(0);
    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim()).toBe("TN_PERRY_CAPTURE:42:42");
  },
  45_000,
);
