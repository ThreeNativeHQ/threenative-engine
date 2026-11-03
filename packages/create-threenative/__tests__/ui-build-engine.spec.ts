import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { buildUi } from "../src/build.js";

const roots: string[] = [];
const require = createRequire(path.resolve("packages/create-threenative/package.json"));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The installed directory of a workspace package, for a fixture that links it as the game does. */
async function packageDir(name: string): Promise<string> {
  let directory: string;
  try {
    directory = path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    // `three` publishes no `./package.json` subpath; its entry's directory chain names the root.
    directory = path.dirname(require.resolve(name));
    while (!(await readdir(directory)).includes("package.json"))
      directory = path.dirname(directory);
  }
  return directory;
}

/**
 * A game whose UI reaches a value in `@threenative/core`.
 *
 * `src/ui/main.tsx` importing anything but types from the barrel is what the built page cannot
 * carry: the project's own `createWebBrandPlugin` routes that barrel to the threaded Wasm engine,
 * and the engine module refuses to load on a page that is not cross-origin isolated
 * (`TN_WEB_THREADS_OFF`) — which a native web view never is. The page then throws on its first
 * module line: no HUD, `uiReady` never true, every scripted tap falls through to the game.
 */
async function fixture(): Promise<string> {
  const root = await makeTempDir("threenative-ui-engine-");
  roots.push(root);
  await mkdir(path.join(root, "src/ui"), { recursive: true });
  await mkdir(path.join(root, "node_modules/@threenative"), { recursive: true });
  for (const name of ["vite", "three"])
    await symlink(await packageDir(name), path.join(root, "node_modules", name), "dir");
  await symlink(
    path.resolve("packages/create-threenative"),
    path.join(root, "node_modules", "create-threenative"),
    "dir",
  );
  await symlink(
    path.resolve("packages/core"),
    path.join(root, "node_modules/@threenative/core"),
    "dir",
  );
  // The engine plugin refuses to build a browser page without this package; a UI page must never
  // ask it for the Wasm engine in the first place, which is what this fixture proves.
  const runtime = path.join(root, "node_modules/@threenative/runtime-native");
  await mkdir(path.join(runtime, "build/web"), { recursive: true });
  await writeFile(
    path.join(runtime, "package.json"),
    JSON.stringify({ name: "@threenative/runtime-native", version: "0.0.0" }),
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "ui-engine", type: "module" }),
  );
  await writeFile(
    path.join(root, "threenative.config.ts"),
    'export default { engine: "threenative", app: { name: "UI Engine" } };\n',
  );
  await writeFile(
    path.join(root, "src/ui/main.tsx"),
    'import { version } from "@threenative/core";\nconsole.log(version);\n',
  );
  await writeFile(
    path.join(root, "vite.config.js"),
    [
      'import { createWebBrandPlugin } from "create-threenative";',
      "export default { plugins: [createWebBrandPlugin()] };",
    ].join("\n"),
  );
  return root;
}

async function jsFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await jsFiles(file)));
    else if (entry.name.endsWith(".js")) files.push(file);
  }
  return files.sort();
}

describe("the native UI page", () => {
  it("carries no browser engine, so a UI that reads a core value still boots in a web view", async () => {
    const root = await fixture();
    const output = await buildUi(root, {
      ui: { renderer: "web" },
    } as Parameters<typeof buildUi>[1]);
    const bundle = (
      await Promise.all((await jsFiles(output)).map((file) => readFile(file, "utf8")))
    ).join("\n");
    // The refusal itself, and the threaded Wasm entry that raises it: neither belongs on a page
    // whose host brings its own engine.
    expect(bundle).not.toContain("TN_WEB_THREADS_OFF");
    expect(bundle).not.toContain("tn-native-engine-web-threads");
    // The page still reads the value it imported.
    const version = /^export const version = "([^"]+)";$/mu.exec(
      await readFile("packages/core/src/index.ts", "utf8"),
    );
    expect(bundle).toContain(version?.[1]);
  }, 120_000);
});
