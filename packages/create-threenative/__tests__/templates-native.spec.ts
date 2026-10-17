import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { assertNativeBundleCompatible, build } from "../src/build.js";

const run = promisify(execFile);
const roots: string[] = [];
const bundler = path.resolve("packages/runtime-native/scripts/bundle.mjs");
const viteInstall = path.resolve(import.meta.dirname, "../node_modules/vite");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function projectRoot(prefix: string): Promise<string> {
  const project = await makeTempDir(prefix);
  roots.push(project);
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "node_modules"), { recursive: true });
  await symlink(viteInstall, path.join(project, "node_modules/vite"));
  await writeFile(path.join(project, "package.json"), '{"name":"entry-proof","type":"module"}\n');
  return project;
}

async function bundle(
  project: string,
  target: "android" | "desktop" | "ios",
  entry = "src/game.ts",
  extraArgs: readonly string[] = [],
): Promise<string> {
  const output = path.join(project, `dist/${target}.js`);
  await run(
    process.execPath,
    [
      bundler,
      "--project",
      project,
      "--entry",
      entry,
      "--target",
      target,
      "--output",
      output,
      ...extraArgs,
    ],
    { cwd: project },
  );
  return output;
}

/** A project with a stub runtime-native whose desktop packager is `packager`. */
/** Package entry is both the selected-runtime resolver and a subprocess executable. */
async function writePackager(runtime: string, target: string, source: string): Promise<void> {
  await writeFile(path.join(runtime, `scripts/package-${target}-execute.mjs`), source);
  await writeFile(
    path.join(runtime, `scripts/package-${target}.mjs`),
    `
import { pathToFileURL } from "node:url";
export async function resolveDesktopRuntime() { return import.meta.filename; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import("./package-${target}-execute.mjs");
}
`,
  );
}

async function stubRuntime(
  project: string,
  packager: string,
  config = 'export default { engine: "legacy", ui: { renderer: "native" } };\n',
): Promise<void> {
  const runtime = path.join(project, "node_modules/@threenative/runtime-native");
  await mkdir(path.join(runtime, "scripts"), { recursive: true });
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({ name: "native-staging", type: "module" }),
  );
  await writeFile(path.join(project, "threenative.config.ts"), config);
  await writeFile(path.join(project, "src/game.ts"), "export default { start: async () => {} };\n");
  await writeFile(
    path.join(runtime, "package.json"),
    '{"name":"@threenative/runtime-native","type":"module"}\n',
  );
  await writeFile(
    path.join(runtime, "scripts/bundle.mjs"),
    `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, "globalThis.__nativeProof = true;\\n");
`,
  );
  await writePackager(runtime, "desktop", packager);
}

/** The packager the staged-publish tests share: a complete run that writes its output. */
const PACKAGES = `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, "a complete package");
`;

/** `PACKAGES` writes 18 bytes, so a 17-byte ceiling is one byte below what the build produces. */
function budgetedProject(severity: "error" | "warn", limit = 17): string {
  return [
    "export default {",
    '  engine: "legacy",',
    `  buildProfiles: { defaults: { desktop: "capped" }, profiles: { capped: { artifactBudget: { artifactBytes: { limit: ${limit}, severity: "${severity}" } } } } },`,
    '  ui: { renderer: "native" },',
    "};",
    "",
  ].join("\n");
}

describe("atomic publish and the project build lock", () => {
  it("leaves the previous artifact untouched when the packager fails, with no staging left", async () => {
    const project = await projectRoot("threenative-native-atomic-");
    await stubRuntime(
      project,
      `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, "half a package");
process.exit(1);
`,
    );
    const artifact = path.join(project, "dist-native", "native-staging");
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, "the previous package");

    await expect(build({ cwd: project, target: "desktop" })).rejects.toThrow(/exited with code 1/u);
    expect(await readFile(artifact, "utf8")).toBe("the previous package");
    expect(await readdir(path.dirname(artifact))).toEqual(["native-staging"]);
  });

  it("publishes a packager that writes only its container, never a bare <name>", async () => {
    // A desktop release writes `<name>.tar.gz` and a Windows build `<name>.exe`: no file carries
    // the requested name, and the publish, the budget and the report must all still find it.
    const project = await projectRoot("threenative-native-container-");
    await stubRuntime(
      project,
      `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
await mkdir(path.dirname(output), { recursive: true });
await writeFile(\`\${output}.tar.gz\`, "a release container");
`,
    );
    await writeFile(path.join(project, "threenative.config.ts"), budgetedProject("warn"));

    await expect(build({ cwd: project, target: "desktop" })).resolves.toBeUndefined();
    const dist = path.join(project, "dist-native");
    expect((await readdir(dist)).sort()).toEqual([
      "native-staging.tar.gz",
      "native-staging.tar.gz.build-report.json",
    ]);
    expect(await readFile(path.join(dist, "native-staging.tar.gz"), "utf8")).toBe(
      "a release container",
    );
  });

  // A Windows release writes two artifacts — the container and the installer that installs it —
  // and neither carries the requested name. Binding the budget and the report to whichever
  // sibling sorted first bound both to the installer, which is not what the player downloads.
  it("reports and budgets the container a Windows release shipped beside its installer", async () => {
    const windows = `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
await mkdir(path.dirname(output), { recursive: true });
await writeFile(\`\${output}.zip\`, "the zipped container");
await writeFile(\`\${output}-setup.exe\`, "installer");
`;
    const project = await projectRoot("threenative-native-windows-");
    await stubRuntime(project, windows);

    await expect(build({ cwd: project, target: "desktop" })).resolves.toBeUndefined();

    const dist = path.join(project, "dist-native");
    expect((await readdir(dist)).sort()).toEqual([
      "native-staging-setup.exe",
      "native-staging.zip",
      "native-staging.zip.build-report.json",
    ]);
    const report = JSON.parse(
      await readFile(path.join(dist, "native-staging.zip.build-report.json"), "utf8"),
    ) as { artifact: { kind: string; name: string; sha256: string } };
    expect(report.artifact).toEqual({
      kind: "file",
      name: "native-staging.zip",
      sha256: createHash("sha256").update("the zipped container").digest("hex"),
    });

    // The ceiling sits above the installer and below the container, so a build that measured the
    // installer would publish and one that measured the container refuses.
    const capped = await projectRoot("threenative-native-windows-budget-");
    await stubRuntime(capped, windows, budgetedProject("error", 15));

    await expect(build({ cwd: capped, target: "desktop" })).rejects.toThrow(
      /TN_BUILD_ARTIFACT_BUDGET_EXCEEDED.*artifactBytes measured 20 bytes over its 15-byte limit/u,
    );
    expect(await readdir(path.join(capped, "dist-native"))).toEqual([]);
  });

  it("refuses a second build while a live pid holds the lock, and reclaims a dead one", async () => {
    const project = await projectRoot("threenative-native-lock-");
    await stubRuntime(project, PACKAGES);
    const lock = path.join(project, ".threenative", "build.lock");
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, String(process.pid));

    await expect(build({ cwd: project, target: "desktop" })).rejects.toThrow(
      new RegExp(`TN_BUILD_BUSY.*pid ${process.pid}`, "u"),
    );

    // A build that died mid-packaging leaves its pid behind; that must not lock the project out.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    if (dead === undefined) throw new Error("no dead pid to reclaim with");
    await writeFile(lock, String(dead));

    await expect(build({ cwd: project, target: "desktop" })).resolves.toBeUndefined();
    expect(await readFile(path.join(project, "dist-native", "native-staging"), "utf8")).toBe(
      "a complete package",
    );
    await expect(readFile(lock, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("an artifact budget measured before publish", () => {
  it("refuses an over-limit artifact and leaves the previous one in place", async () => {
    const project = await projectRoot("threenative-native-budget-error-");
    await stubRuntime(project, PACKAGES, budgetedProject("error"));
    const artifact = path.join(project, "dist-native", "native-staging");
    await mkdir(path.dirname(artifact), { recursive: true });
    await writeFile(artifact, "the previous package");

    await expect(build({ cwd: project, target: "desktop" })).rejects.toThrow(
      /TN_BUILD_ARTIFACT_BUDGET_EXCEEDED.*artifactBytes measured 18 bytes over its 17-byte limit/u,
    );
    expect(await readFile(artifact, "utf8")).toBe("the previous package");
    expect(await readdir(path.dirname(artifact))).toEqual(["native-staging"]);
  });

  it("prints the same sentence and publishes when the ceiling only warns", async () => {
    const project = await projectRoot("threenative-native-budget-warn-");
    await stubRuntime(project, PACKAGES, budgetedProject("warn"));
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });

    await expect(build({ cwd: project, target: "desktop" })).resolves.toBeUndefined();
    expect(await readFile(path.join(project, "dist-native", "native-staging"), "utf8")).toBe(
      "a complete package",
    );
    expect(lines).toContain(
      "threenative build: artifactBytes measured 18 bytes over its 17-byte limit.\n",
    );
  });
});

describe("native template contract", () => {
  it("keeps the portable graph and generated start while excluding the web entry", async () => {
    const project = await projectRoot("threenative-native-entry-");
    await writeFile(
      path.join(project, "src/portable.ts"),
      'export const portableMarker = "TN_PORTABLE_MODULE_PRESENT";\n',
    );
    await writeFile(
      path.join(project, "src/ui.ts"),
      'export const uiMarker = "TN_WEB_UI_MODULE_PRESENT";\n',
    );
    await writeFile(
      path.join(project, "src/game.ts"),
      `import { portableMarker } from "./portable.js";
const arena = { start: async () => console.info(portableMarker) };
export default arena;
`,
    );
    await writeFile(
      path.join(project, "src/main.ts"),
      `import arena from "./game.js";
import { uiMarker } from "./ui.js";
console.info(arena, uiMarker);
`,
    );

    const output = await bundle(project, "desktop");
    const source = await readFile(output, "utf8");
    expect(source).toMatch(/\/\*! TN_NATIVE_BUNDLE_SCOPE \*\/\n\(\(\)=>\{/u);
    expect(source.trimEnd()).toMatch(/\}\)\(\);$/u);
    expect(source).toContain("TN_PORTABLE_MODULE_PRESENT");
    expect(source).toContain("TN_NATIVE_START_FAILED");
    expect(source).not.toContain("TN_WEB_UI_MODULE_PRESENT");
    for (const target of ["desktop", "android", "ios"] as const) {
      await expect(assertNativeBundleCompatible(output, target)).resolves.toBeUndefined();
    }
  });

  it("fails with TN_NATIVE_ENTRY_NO_DEFAULT when the portable entry has no default", async () => {
    const project = await projectRoot("threenative-native-default-");
    const output = path.join(project, "dist/desktop.js");
    await writeFile(path.join(project, "src/game.ts"), "export const game = { start() {} };\n");

    await expect(bundle(project, "desktop")).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "TN_NATIVE_ENTRY_NO_DEFAULT: src/game.ts must default-export the game.",
      ),
    });
    await expect(readFile(output, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects UI only when the portable entry imports it", async () => {
    const project = await projectRoot("threenative-native-ui-");
    await writeFile(
      path.join(project, "src/ui.ts"),
      `export const uiMarker = "TN_IMPORTED_UI_MODULE_PRESENT";
export function mount() { return document.getElementById("root"); }
`,
    );
    await writeFile(
      path.join(project, "src/game.ts"),
      `import { mount, uiMarker } from "./ui.js";
export default { start: async () => console.info(uiMarker, mount()) };
`,
    );

    const output = await bundle(project, "desktop");
    expect(await readFile(output, "utf8")).toContain("TN_IMPORTED_UI_MODULE_PRESENT");
    for (const target of ["desktop", "android", "ios"] as const) {
      await expect(assertNativeBundleCompatible(output, target)).rejects.toThrow(
        /TN_NATIVE_WEB_ONLY_UI/u,
      );
    }
  });

  it("uses normal package exports on desktop and native exports on mobile", async () => {
    const project = await projectRoot("threenative-native-conditions-");
    const dependency = path.join(project, "node_modules/condition-proof");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({
        exports: { ".": { "threenative-native": "./native.js", import: "./web.js" } },
        name: "condition-proof",
        type: "module",
      }),
    );
    await writeFile(path.join(dependency, "web.js"), 'export const marker = "WEB_BACKEND";\n');
    await writeFile(
      path.join(dependency, "native.js"),
      'export const marker = "NATIVE_BACKEND";\n',
    );
    await writeFile(
      path.join(project, "src/game.ts"),
      `import { marker } from "condition-proof";
export default { start: async () => console.info(marker) };
`,
    );

    const desktop = await readFile(await bundle(project, "desktop"), "utf8");
    const android = await readFile(await bundle(project, "android"), "utf8");
    expect(desktop).toContain("WEB_BACKEND");
    expect(desktop).not.toContain("NATIVE_BACKEND");
    expect(android).toContain("NATIVE_BACKEND");
    expect(android).not.toContain("WEB_BACKEND");

    // A desktop host whose runtime has no WebAssembly (the Linux arm64 lane's QuickJS) is told so
    // by `threenative build`; the same desktop target then takes the native exports too.
    const nativeDesktop = await readFile(
      await bundle(project, "desktop", "src/game.ts", ["--native-backend"]),
      "utf8",
    );
    expect(nativeDesktop).toContain("NATIVE_BACKEND");
    expect(nativeDesktop).not.toContain("WEB_BACKEND");
  }, 15_000);

  it("passes the configured asset root to every native packager", async () => {
    const project = await projectRoot("threenative-native-assets-");
    const runtime = path.join(project, "node_modules/@threenative/runtime-native");
    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify({
        name: "native-assets",
        type: "module",
      }),
    );
    await writeFile(
      path.join(project, "threenative.config.ts"),
      [
        "export default {",
        '  engine: "legacy",',
        '  assets: { output: "cooked" },',
        '  display: { orientation: "portrait" },',
        '  ui: { renderer: "native" },',
        "};",
        "",
      ].join("\n"),
    );
    await mkdir(path.join(project, "cooked"), { recursive: true });
    await mkdir(path.join(project, "assets"), { recursive: true });
    await mkdir(path.join(runtime, "scripts"), { recursive: true });
    await writeFile(
      path.join(project, "src/game.ts"),
      "export default { start: async () => {} };\n",
    );
    await writeFile(path.join(project, "cooked/texture.png"), "texture\n");
    await writeFile(
      path.join(runtime, "package.json"),
      '{"name":"@threenative/runtime-native","type":"module"}\n',
    );
    await writeFile(
      path.join(runtime, "scripts/bundle.mjs"),
      `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, "globalThis.__nativeProof = true;\\n");
`,
    );
    for (const target of ["desktop", "android", "ios"] as const) {
      await writePackager(
        runtime,
        target,
        `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, "packaged");
await writeFile(new URL("../${target}-args.json", import.meta.url), JSON.stringify(process.argv.slice(2)));
`,
      );
      await build({ cwd: project, target });
      const args = JSON.parse(
        await readFile(path.join(runtime, `${target}-args.json`), "utf8"),
      ) as string[];
      expect(args, `${target} must receive --assets`).toContain("--assets");
      expect(args[args.indexOf("--assets") + 1], `${target} asset root`).toBe(
        path.join(project, "cooked"),
      );
      if (target !== "desktop") {
        expect(args, `${target} must receive orientation`).toContain("--orientation");
        expect(args[args.indexOf("--orientation") + 1], `${target} orientation`).toBe("portrait");
      }
    }
  });

  it("builds a project with only the legacy engine named through all native targets using defaults", async () => {
    const project = await projectRoot("threenative-native-no-config-");
    await writeFile(
      path.join(project, "threenative.config.ts"),
      'export default { engine: "legacy" };\n',
    );
    await mkdir(path.join(project, "src/ui"), { recursive: true });
    await writeFile(
      path.join(project, "src/ui/main.tsx"),
      'import "./hud.css"; document.querySelector("#tn-ui").textContent = "Default HUD";\n',
    );
    await writeFile(path.join(project, "src/ui/hud.css"), "#tn-ui { color: white; }\n");
    await writeFile(
      path.join(project, "src/game.ts"),
      "export default { start: async () => {} };\n",
    );
    await mkdir(path.join(project, "assets"), { recursive: true });
    const runtime = path.join(project, "node_modules/@threenative/runtime-native");
    await mkdir(path.join(runtime, "scripts"), { recursive: true });
    await writeFile(
      path.join(runtime, "package.json"),
      '{"name":"@threenative/runtime-native","type":"module"}\n',
    );
    await writeFile(
      path.join(runtime, "scripts/bundle.mjs"),
      `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, "export default { start() {} };\\n");
`,
    );
    for (const target of ["desktop", "android", "ios"] as const) {
      await writePackager(
        runtime,
        target,
        `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--output") + 1];
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, "packaged");
await writeFile(new URL("../${target}-args.json", import.meta.url), JSON.stringify(process.argv.slice(2)));
`,
      );

      await expect(build({ cwd: project, target })).resolves.toBeUndefined();
      const args = JSON.parse(
        await readFile(path.join(runtime, `${target}-args.json`), "utf8"),
      ) as string[];
      expect(args, `${target} must receive the resolved config`).toContain("--config");
      expect(args, `${target} must receive the default asset root`).toContain("--assets");
      expect(args[args.indexOf("--assets") + 1], `${target} asset root`).toBe(
        path.join(project, "public"),
      );
      expect(args, `${target} must receive the default UI`).toContain("--ui");
      const ui = args[args.indexOf("--ui") + 1];
      if (ui === undefined) throw new Error(`${target} must name its UI output`);
      const page = await readFile(path.join(ui, "index.html"), "utf8");
      for (const extension of ["js", "css"]) {
        const asset = page.match(new RegExp(`(?:src|href)="\\./([^" ]+\\.${extension})"`, "u"));
        if (asset?.[1] === undefined) throw new Error(`${target} UI must load ${extension}`);
        await expect(readFile(path.join(ui, asset[1]), "utf8")).resolves.not.toBe("");
      }
      if (target !== "desktop") {
        expect(args, `${target} must receive the default orientation`).toContain("--orientation");
        expect(args[args.indexOf("--orientation") + 1]).toBe("landscape");
      }
    }
    const resolved = JSON.parse(
      await readFile(path.join(project, ".threenative/build/config.json"), "utf8"),
    );
    expect(resolved).toMatchObject({
      app: { id: "com.threenative.entryproof", name: "entry-proof" },
      display: { orientation: "landscape", fullscreen: true, keepScreenOn: false },
      window: { title: "entry-proof", width: 1280, height: 720, maximized: false, resizable: true },
      renderer: { preferWebGPU: true },
      ui: { renderer: "web" },
    });
  });
});
