import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  PACKAGES,
  assertPackedManifestResolved,
  assertPackedTypesShipped,
  assertTemplateSourcesCovered,
  isArchived,
  makeSandbox,
  readManifest,
  resolveGenre,
  sandboxPackageDirectory,
  sandboxWorkspacePackages,
  sealedProofHash,
  stampTarball,
} from "../make-sandbox";
import { workspacePackageSourceFlag } from "../workspace-packages.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await makeTempDir(prefix);
  temporaryRoots.push(root);
  return root;
}

describe("genre sandbox", () => {
  it("fails closed when a packed manifest still contains catalog or workspace protocols", async () => {
    const root = await temporaryRoot("threenative-packed-manifest-");
    const packageRoot = path.join(root, "package");
    await mkdir(packageRoot, { recursive: true });
    const archive = path.join(root, "package.tgz");
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        dependencies: { three: "catalog:" },
        name: "fixture",
        version: "0.1.0",
      }),
    );
    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);

    expect(() => assertPackedManifestResolved(archive)).toThrow(/catalog:/u);
  });

  // `pnpm pack` copies whatever `dist` holds at the moment it runs. A tsup rebuild in another
  // lane clears that directory and writes the bundles ~11s before the declarations, so a pack
  // landing inside that window ships every `.js`, no `.d.ts`, and no error. The sandbox then
  // installs a package whose `types` entry resolves to nothing and every game importing it
  // typechecks as implicit `any`. @threenative/physics shipped exactly that tarball.
  async function packFixture(root: string, manifest: unknown, files: readonly string[]) {
    const packageRoot = path.join(root, "package");
    await mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify(manifest));
    for (const file of files) await writeFile(path.join(packageRoot, file), "");
    const archive = path.join(root, "package.tgz");
    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
    return archive;
  }

  const typedManifest = {
    exports: {
      ".": { import: "./dist/index.js", types: "./dist/index.d.ts" },
      "./navigation": {
        import: "./dist/navigation/index.js",
        types: "./dist/navigation/index.d.ts",
      },
    },
    files: ["dist"],
    name: "fixture",
    types: "./dist/index.d.ts",
    version: "0.1.0",
  };

  it("fails closed when a packed tarball omits the declarations its manifest promises", async () => {
    const root = await temporaryRoot("threenative-packed-types-");
    const archive = await packFixture(root, typedManifest, ["dist/index.js"]);

    expect(() => assertPackedTypesShipped(archive)).toThrow(/dist\/index\.d\.ts/u);
  });

  it("fails closed when only a subpath's declarations are missing", async () => {
    const root = await temporaryRoot("threenative-packed-subpath-types-");
    await mkdir(path.join(root, "package", "dist", "navigation"), { recursive: true });
    const archive = await packFixture(root, typedManifest, [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/navigation/index.js",
    ]);

    expect(() => assertPackedTypesShipped(archive)).toThrow(/dist\/navigation\/index\.d\.ts/u);
  });

  it("accepts a tarball that ships every declaration it declares, and one that declares none", async () => {
    const complete = await temporaryRoot("threenative-packed-complete-");
    await mkdir(path.join(complete, "package", "dist", "navigation"), { recursive: true });
    const shipped = await packFixture(complete, typedManifest, [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/navigation/index.js",
      "dist/navigation/index.d.ts",
    ]);
    expect(() => assertPackedTypesShipped(shipped)).not.toThrow();

    // The native runtime publishes scripts and Gradle sources and declares no types at all.
    const untyped = await temporaryRoot("threenative-packed-untyped-");
    const scripts = await packFixture(
      untyped,
      { files: ["scripts"], name: "fixture-native", version: "0.1.0" },
      ["dist/bundle.mjs"],
    );
    expect(() => assertPackedTypesShipped(scripts)).not.toThrow();
  });

  it("packs the native runtime and capability server with the user-facing packages", () => {
    expect(PACKAGES).toContain("runtime-native");
    expect(PACKAGES).toContain("engine-mcp");
    expect(PACKAGES).toContain("blender-bridge");
    expect(PACKAGES).toContain("raw-unreal");
    expect(sandboxWorkspacePackages()).toContain("@threenative/runtime-native");
  });

  it("resolves unscoped package names through their actual workspace directories", () => {
    expect(sandboxPackageDirectory("threenative-engine-mcp")).toBe("packages/engine-mcp");
    expect(sandboxPackageDirectory("@threenative/blender-bridge")).toBe("packages/blender-bridge");
  });

  it("defaults to the workspace sandbox and keeps package staging inside it", async () => {
    const workspace = await temporaryRoot("threenative-workspace-");
    const repo = path.join(workspace, "engine");
    const genre = path.join(repo, "docs", "benchmark", "genres", "platformer");
    await mkdir(path.join(genre, "proof"), { recursive: true });
    await writeFile(path.join(repo, "package.json"), JSON.stringify({ version: "0.1.0" }));
    await writeFile(path.join(genre, "brief.md"), "sealed brief\n");
    await writeFile(path.join(genre, "reference.png"), "reference");
    await writeFile(path.join(genre, "proof", "smoke.playtest.json"), "{}\n");

    const result = makeSandbox({
      arm: "vanilla",
      bare: true,
      genre: "platformer",
      install: false,
      prepare: false,
      repo,
    });

    expect(result.out).toBe(path.join(workspace, "sandbox"));
    // One game per folder: the sandbox root carries the sealed inputs, never the game itself.
    expect(result.project).toBe(path.join(workspace, "sandbox", "platformer-game"));
    expect(existsSync(path.join(result.out, "package.json"))).toBe(false);
    expect(existsSync(path.join(result.out, "src"))).toBe(false);
    expect(existsSync(path.join(result.out, ".packages"))).toBe(true);
    expect(existsSync(path.join(workspace, "sandbox-packages"))).toBe(false);
    await expect(readFile(path.join(result.project, "package.json"), "utf8")).resolves.toContain(
      path.join(result.out, ".packages", "playtest.tgz"),
    );
    // sweep:archive finds the game by a src/ beside a sweep.json, so the folder carries its own.
    await expect(readFile(path.join(result.project, "sweep.json"), "utf8")).resolves.toContain(
      "platformer",
    );
    await expect(readFile(path.join(result.project, "brief.md"), "utf8")).resolves.toBe(
      "sealed brief\n",
    );
  });

  it("names the game folder from --name", async () => {
    const root = await temporaryRoot("threenative-named-");
    const result = makeSandbox({
      arm: "vanilla",
      genre: "platformer",
      install: false,
      name: "fox-game",
      out: path.join(root, "sandbox"),
      prepare: false,
      repo: process.cwd(),
    });
    expect(result.project).toBe(path.join(root, "sandbox", "fox-game"));
    expect(existsSync(path.join(result.project, "src"))).toBe(true);
  });

  // pnpm pack names by version alone, so two sweeps produced the same path with different bytes
  // and a package manager could serve the copy it already had. A rebuilt engine must install.
  it("gives a repacked tarball a new path when its contents change", async () => {
    const root = await temporaryRoot("threenative-stamp-");
    const file = path.join(root, "threenative-core-0.1.0.tgz");
    await writeFile(file, "first build");
    const first = stampTarball(file);
    await writeFile(file, "second build");
    const second = stampTarball(file);
    expect(first).not.toBe(second);
    expect(path.basename(first)).toMatch(/^threenative-core-0\.1\.0-[0-9a-f]{12}\.tgz$/);
    await expect(readFile(second, "utf8")).resolves.toBe("second build");
  });

  it("refuses a project name that would escape its folder", async () => {
    const root = await temporaryRoot("threenative-bad-name-");
    for (const name of ["../escape", "Fox Game", ".packages"])
      expect(() =>
        makeSandbox({
          arm: "vanilla",
          genre: "platformer",
          install: false,
          name,
          out: path.join(root, "sandbox"),
          prepare: false,
          repo: process.cwd(),
        }),
      ).toThrow(/Invalid project name/);
  });

  it("writes a manifest with the genre and sealed brief hash", async () => {
    const root = await temporaryRoot("threenative-sandbox-");
    const result = makeSandbox({
      bare: true,
      genre: "platformer",
      out: path.join(root, "sandbox"),
      prepare: false,
      repo: process.cwd(),
      template: "platformer",
    });
    const manifest = readManifest(path.join(result.out, "sweep.json"));
    const brief = await readFile(path.join(result.out, "brief.md"));
    const scaffold = await readFile(path.join(result.out, "scaffold.sh"), "utf8");
    expect(manifest).toMatchObject({
      arm: "framework",
      genre: "platformer",
      proofHash: sealedProofHash(process.cwd(), "platformer"),
      template: "platformer",
    });
    expect(manifest.briefHash).toBe(createHash("sha256").update(brief).digest("hex"));
    expect(scaffold).toContain('cp sweep.json "${1:-platformer-game}"/sweep.json');
    expect(scaffold).toContain('"${1:-platformer-game}" --template platformer');
    await expect(readFile(path.join(result.out, "reference.png"))).resolves.toEqual(
      await readFile("docs/benchmark/genres/platformer/reference.png"),
    );
  }, 30_000);

  it("gives the scaffold a local source for every workspace package the template declares", async () => {
    const root = await temporaryRoot("threenative-sandbox-sources-");
    const result = makeSandbox({
      bare: true,
      genre: "endless-runner",
      out: path.join(root, "sandbox"),
      prepare: false,
      repo: process.cwd(),
      template: "starter",
    });
    const scaffold = await readFile(path.join(result.out, "scaffold.sh"), "utf8");
    const manifest = JSON.parse(
      await readFile(
        path.join(process.cwd(), "packages/create-threenative/templates/starter/package.json"),
        "utf8",
      ),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ].filter((name) => name === "create-threenative" || name.startsWith("@threenative/"));
    // Every one of these 404s on the registry today; an unpassed source is a dead scaffold.
    expect(declared).toContain("@threenative/playtest");
    expect(declared).toContain("create-threenative");
    expect(scaffold).toContain(workspacePackageSourceFlag("@threenative/runtime-native"));
    expect(scaffold).toContain(workspacePackageSourceFlag("threenative-engine-mcp"));
    for (const dependency of declared) {
      const flag =
        dependency === "create-threenative"
          ? "--cli-package"
          : workspacePackageSourceFlag(dependency);
      expect(scaffold, dependency).toContain(flag);
    }
    expect(scaffold).toContain(workspacePackageSourceFlag("@threenative/blender-bridge"));
    expect(scaffold).toContain(workspacePackageSourceFlag("@threenative/raw-unreal"));
  }, 30_000);

  it("refuses a sandbox whose template needs a package the sweep never packed", () => {
    expect(() =>
      assertTemplateSourcesCovered(process.cwd(), "starter", {
        core: "core.tgz",
        physics: "physics.tgz",
        ui: "ui.tgz",
        "create-threenative": "cli.tgz",
      }),
    ).toThrow(/@threenative\/playtest/);
  });

  it("throws before creating a sandbox when the genre brief is missing", async () => {
    const root = await temporaryRoot("threenative-genre-");
    const genre = path.join(root, "docs", "benchmark", "genres", "missing");
    await mkdir(genre, { recursive: true });
    await writeFile(path.join(genre, "reference.png"), "reference");
    expect(() => resolveGenre(root, "missing")).toThrow(/missing its required brief/);
    await expect(readFile(path.join(root, "sandbox", "sweep.json"))).rejects.toThrow();
  });

  it("throws when the genre reference image is missing", async () => {
    const root = await temporaryRoot("threenative-genre-");
    const genre = path.join(root, "docs", "benchmark", "genres", "missing");
    await mkdir(genre, { recursive: true });
    await writeFile(path.join(genre, "brief.md"), "sealed brief\n");
    expect(() => resolveGenre(root, "missing")).toThrow(/missing its required reference image/);
  });

  it("writes a vanilla project with only the plain Three.js bridge package", async () => {
    const root = await temporaryRoot("threenative-vanilla-");
    const result = makeSandbox({
      arm: "vanilla",
      genre: "platformer",
      install: false,
      out: path.join(root, "sandbox"),
      prepare: false,
      repo: process.cwd(),
    });
    const packageJson = JSON.parse(
      await readFile(path.join(result.project, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const packageText = JSON.stringify(packageJson);
    expect(packageText).toContain("@threenative/playtest");
    expect(packageText).not.toMatch(/@threenative\/(?:core|physics|ui)/);
    await expect(readFile(path.join(result.project, "index.html"), "utf8")).resolves.toContain(
      "/src/main.ts",
    );
    const agents = await readFile(path.join(result.project, "AGENTS.md"), "utf8");
    expect(agents).toContain(
      "You may install any npm package you choose, including a physics engine.",
    );
    expect(agents).toContain("fixedStep");
    // The snippet publishes a readout rather than an empty array, and the prose states the
    // contract. Round 9's vanilla arm followed the old wording — "`diagnostics` returns current
    // runtime diagnostics" — published its debug HUD, and lost both sealed scenarios because every
    // entry was counted as a runtime error.
    expect(agents).toContain('diagnostics: () => [{ label: "FPS", value: fps }]');
    expect(agents).toContain("is a readout and never fails a proof");
    // Installing fixedStep without its tick provider throws at module scope and takes the whole
    // entry file down; the snippet omitted it, and the vanilla builder lost its bootstrap to that.
    expect(agents).toContain("tick: () => frame");
    expect(agents).toContain("gameplay: () => ({");
    expect(agents).toContain('animation: { player: { clip: "idle", advancedFrames: 1 } }');
    expect(agents).toContain('states: { player: "idle", mission: "playing" }');
    expect(agents).toContain("resources: { read: () => ({ state: { ...state } }) }");
    expect(agents).toContain("all five provider hooks");
    expect(agents).toContain("generic resource id `state`");
    await expect(readFile(path.join(result.project, "src", "main.ts"))).rejects.toThrow();
    await expect(
      readFile(path.join(result.project, "node_modules", "@threenative", "core")),
    ).rejects.toThrow();
  });

  it("rejects a manifest that omits the arm", async () => {
    const root = await temporaryRoot("threenative-manifest-");
    const file = path.join(root, "sweep.json");
    await writeFile(
      file,
      JSON.stringify({
        genre: "platformer",
        briefHash: "a".repeat(64),
        proofHash: "b".repeat(64),
        template: "platformer",
        date: "2099-01-01T00:00:00.000Z",
        frameworkVersion: "0.1.0",
        sourceLines: 0,
      }),
    );
    expect(() => readManifest(file)).toThrow(/missing arm/);
  });

  it("rejects non-string identity fields and fractional source lines", async () => {
    const root = await temporaryRoot("threenative-manifest-types-");
    const file = path.join(root, "sweep.json");
    const valid = {
      arm: "framework",
      genre: "platformer",
      briefHash: "a".repeat(64),
      proofHash: "b".repeat(64),
      template: "platformer",
      date: "2099-01-01T00:00:00.000Z",
      frameworkVersion: "0.1.0",
      sourceLines: 0,
    };
    for (const field of ["briefHash", "proofHash", "template", "frameworkVersion"] as const) {
      await writeFile(file, JSON.stringify({ ...valid, [field]: 1 }));
      expect(() => readManifest(file)).toThrow(new RegExp(`${field} must be a non-empty string`));
    }
    await writeFile(file, JSON.stringify({ ...valid, sourceLines: 1.5 }));
    expect(() => readManifest(file)).toThrow(/sourceLines must be a non-negative integer/);
  });

  // The old layout put the game at the sandbox root, which leaves no folder to scope a wipe to.
  it("refuses a sandbox root that holds a game directly", async () => {
    const root = await temporaryRoot("threenative-guard-");
    const sandbox = path.join(root, "sandbox");
    await mkdir(path.join(sandbox, "src"), { recursive: true });
    await writeFile(path.join(sandbox, "sentinel.txt"), "keep me\n");
    expect(() =>
      makeSandbox({
        genre: "platformer",
        out: sandbox,
        repo: process.cwd(),
        template: "platformer",
      }),
    ).toThrow(/holds a game directly/);
    await expect(readFile(path.join(sandbox, "sentinel.txt"), "utf8")).resolves.toBe("keep me\n");
  });

  // A sandbox holds one game per folder, so the build is at <sandbox>/<game>/src. Reusing a name
  // whose build was never archived would wipe game data that no archive preserves.
  it("refuses to wipe an unarchived build in a game folder", async () => {
    const root = await temporaryRoot("threenative-nested-guard-");
    const sandbox = path.join(root, "sandbox");
    const brief = await readFile("docs/benchmark/genres/platformer/brief.md");
    await mkdir(path.join(sandbox, "my-game", "src"), { recursive: true });
    await writeFile(path.join(sandbox, "my-game", "src", "game.ts"), "export default {};\n");
    await writeFile(
      path.join(sandbox, "my-game", "sweep.json"),
      JSON.stringify({
        genre: "platformer",
        briefHash: createHash("sha256").update(brief).digest("hex"),
        proofHash: sealedProofHash(process.cwd(), "platformer"),
        arm: "framework",
        template: "platformer",
        date: "2099-01-01T00:00:00.000Z",
        frameworkVersion: "0.1.0",
        sourceLines: 0,
      }),
    );

    expect(() =>
      makeSandbox({
        genre: "platformer",
        name: "my-game",
        out: sandbox,
        repo: process.cwd(),
        template: "platformer",
      }),
    ).toThrow(/pnpm sweep:archive/);
    await expect(
      readFile(path.join(sandbox, "my-game", "src", "game.ts"), "utf8"),
    ).resolves.toContain("export default");
  });

  // The point of one game per folder: the next sweep is a new folder, not a wipe of the last one.
  it("leaves earlier game folders alone when the next sweep uses another name", async () => {
    const root = await temporaryRoot("threenative-sibling-");
    const sandbox = path.join(root, "sandbox");
    await mkdir(path.join(sandbox, "fox-game", "src"), { recursive: true });
    await writeFile(path.join(sandbox, "fox-game", "src", "game.ts"), "export default {};\n");

    const result = makeSandbox({
      arm: "vanilla",
      genre: "platformer",
      install: false,
      name: "fps-game",
      out: sandbox,
      prepare: false,
      repo: process.cwd(),
    });

    expect(result.project).toBe(path.join(sandbox, "fps-game"));
    await expect(
      readFile(path.join(sandbox, "fox-game", "src", "game.ts"), "utf8"),
    ).resolves.toContain("export default");
  });

  // A game folder created and never scaffolded used to strand the loop: this guard demanded an
  // archive, and archiveSandbox refused the same directory for having no src/. Neither command
  // could clear it, so no further sweep could start until someone deleted it by hand.
  it("wipes an unarchived game folder that was never scaffolded", async () => {
    const root = await temporaryRoot("threenative-unbuilt-");
    const sandbox = path.join(root, "sandbox");
    const brief = await readFile("docs/benchmark/genres/platformer/brief.md");
    await mkdir(path.join(sandbox, "platformer-game"), { recursive: true });
    await writeFile(path.join(sandbox, "platformer-game", "stale.txt"), "no build here\n");
    await writeFile(
      path.join(sandbox, "platformer-game", "sweep.json"),
      JSON.stringify({
        genre: "platformer",
        briefHash: createHash("sha256").update(brief).digest("hex"),
        proofHash: sealedProofHash(process.cwd(), "platformer"),
        arm: "framework",
        template: "platformer",
        date: "2099-01-01T00:00:00.000Z",
        frameworkVersion: "0.1.0",
        sourceLines: 0,
      }),
    );

    const result = makeSandbox({
      bare: true,
      genre: "platformer",
      out: sandbox,
      prepare: false,
      repo: process.cwd(),
      template: "platformer",
    });

    expect(readManifest(path.join(result.out, "sweep.json")).genre).toBe("platformer");
    await expect(
      readFile(path.join(sandbox, "platformer-game", "stale.txt"), "utf8"),
    ).rejects.toThrow();
  }, 30_000);

  it("does not treat another arm or proof as the archived run", async () => {
    const root = await temporaryRoot("threenative-archive-identity-");
    const manifest = {
      arm: "vanilla" as const,
      briefHash: "a".repeat(64),
      date: "2099-01-01T00:00:00.000Z",
      frameworkVersion: "0.1.0",
      genre: "platformer",
      proofHash: "b".repeat(64),
      sourceLines: 0,
      template: "platformer",
    };
    const archive = path.join(root, "docs", "benchmark", "sweeps", "platformer-2099-01-01");
    await mkdir(archive, { recursive: true });
    await writeFile(
      path.join(archive, "sweep.json"),
      JSON.stringify({ ...manifest, arm: "framework" }),
    );
    expect(isArchived(manifest, root)).toBe(false);
    await writeFile(
      path.join(archive, "sweep.json"),
      JSON.stringify({ ...manifest, proofHash: "c".repeat(64) }),
    );
    expect(isArchived(manifest, root)).toBe(false);
    await writeFile(path.join(archive, "sweep.json"), JSON.stringify(manifest));
    expect(isArchived(manifest, root)).toBe(true);
  });
});
