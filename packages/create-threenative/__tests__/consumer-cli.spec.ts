import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, test } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { build, buildHelp, parseBuildArgs } from "../src/build.js";

const originalEnv = { ...process.env };
const envKeys = ["THREENATIVE_RUNTIME_BINARY", "THREENATIVE_RUNTIME_SOURCE"];

afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = originalEnv[key];
  }
});

async function desktopCallerFixture(): Promise<{ root: string; log: string }> {
  for (const key of envKeys) Reflect.deleteProperty(process.env, key);
  const root = await makeTempDir("threenative-consumer-cli-");
  const runtime = path.join(root, "node_modules/@threenative/runtime-native");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(runtime, "scripts"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"consumer-test","type":"module"}');
  await writeFile(
    path.join(root, "threenative.config.ts"),
    'export default { engine: "legacy", ui: { renderer: "native" } };\n',
  );
  await writeFile(path.join(root, "src/game.ts"), "export default {};\n");
  await writeFile(path.join(runtime, "package.json"), '{"name":"@threenative/runtime-native"}');
  await writeFile(
    path.join(runtime, "scripts/bundle.mjs"),
    `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    const output = process.argv[process.argv.indexOf('--output') + 1];
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, 'export default {};');
  `,
  );
  const log = path.join(root, "packager-args.json");
  await writeFile(
    path.join(runtime, "scripts/package-desktop.mjs"),
    `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    import { pathToFileURL } from 'node:url';
    export async function resolveDesktopRuntime(explicit) { return explicit ?? import.meta.filename; }
    if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const output = process.argv[process.argv.indexOf('--output') + 1];
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, 'packaged');
    writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
    }
  `,
  );
  return { root, log };
}

test("desktop caller does not reinterpret a source checkout as an explicit runtime", async () => {
  const { root, log } = await desktopCallerFixture();
  process.env.THREENATIVE_RUNTIME_SOURCE = path.join(root, "checkout");
  await build({ cwd: root, target: "desktop" });
  const args: string[] = JSON.parse(await readFile(log, "utf8"));
  assert.equal(
    args[args.indexOf("--runtime") + 1],
    path.join(root, "node_modules/@threenative/runtime-native/scripts/package-desktop.mjs"),
  );
});

test("explicit desktop binary still wins when a source override is also set", async () => {
  const { root, log } = await desktopCallerFixture();
  process.env.THREENATIVE_RUNTIME_BINARY = path.join(root, "custom runtime");
  process.env.THREENATIVE_RUNTIME_SOURCE = path.join(root, "checkout");
  await build({ cwd: root, target: "desktop" });
  const args: string[] = JSON.parse(await readFile(log, "utf8"));
  assert.equal(args[args.indexOf("--runtime") + 1], process.env.THREENATIVE_RUNTIME_BINARY);
});

test("Android source-build opt-in does not swallow unrelated native flags", async () => {
  const options = parseBuildArgs([
    "build",
    "--target",
    "android",
    "--allow-source-build",
    "--unexpected",
  ]);
  await assert.rejects(build({ ...options, cwd: "/unused" }), /does not accept --unexpected/u);
});

test("build help names the explicit Android source-build opt-in", () => {
  assert.match(buildHelp(), /--allow-source-build.*[Aa]ndroid/u);
});
