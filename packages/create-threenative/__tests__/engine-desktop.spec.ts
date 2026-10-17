import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { copyFile, cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { bundleNativeEngine } from "../../runtime-native/scripts/bundle-native-engine.mjs";
import {
  launcher,
  packageEngineDesktop,
  // @ts-expect-error The packager is a plain .mjs script with no declaration file.
} from "../../runtime-native/scripts/package-engine-desktop.mjs";
import { build, engineDesktopPlayer } from "../src/build.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function temp(prefix: string): Promise<string> {
  const root = await makeTempDir(prefix);
  roots.push(root);
  return root;
}

describe("engine: native on desktop", () => {
  it.each(["no-git", "no-repo", "consumer-git", "dirty-engine"])(
    "bundles outside the engine checkout (%s)",
    async (state) => {
      const root = await temp("threenative-installed-bundler-");
      const native = path.join(root, "packages/runtime-native");
      await mkdir(path.join(native, "scripts"), { recursive: true });
      for (const name of ["bundle-native-engine.mjs", "package-engine-desktop.mjs"])
        await copyFile(
          path.resolve("packages/runtime-native/scripts", name),
          path.join(native, "scripts", name),
        );
      for (const name of ["src", "node_modules", "package.json"])
        await symlink(path.resolve("packages/runtime-native", name), path.join(native, name));
      for (const name of ["core", "create-threenative", "three-native"])
        await symlink(path.resolve("packages", name), path.join(root, "packages", name));
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: state === "dirty-engine" ? "threenative" : "unrelated-consumer",
          type: "module",
        }),
      );
      if (state === "consumer-git" || state === "dirty-engine") {
        execFileSync("git", ["init", "--quiet", root]);
        execFileSync("git", ["add", "."], { cwd: root });
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "consumer",
          ],
          { cwd: root },
        );
      }
      if (state === "dirty-engine") {
        const script = path.join(native, "scripts/bundle-native-engine.mjs");
        await writeFile(script, `${readFileSync(script, "utf8")}\n// dirty source fixture\n`);
      }
      await writeFile(path.join(root, "game.ts"), "export default {};\n");
      await writeFile(path.join(root, "player"), "player");
      const result = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { bundleNativeEngine } from ${JSON.stringify(path.join(native, "scripts/bundle-native-engine.mjs"))};
      import { packageEngineDesktop } from ${JSON.stringify(path.join(native, "scripts/package-engine-desktop.mjs"))};
      const result = await bundleNativeEngine({ entry: 'game.ts', outfile: 'game.js', boot: false });
      if (result.engineCommit !== undefined) throw new Error('consumer HEAD stamped as engine');
      await packageEngineDesktop({ project: '.', entry: 'game.ts', player: 'player', output: 'out' }, {
        bundle: (options) => bundleNativeEngine({ ...options, boot: false }), cook: async () => {},
      });
    `,
        ],
        {
          cwd: root,
          env: { ...process.env, ...(state === "no-git" ? { PATH: root } : {}) },
          encoding: "utf8",
        },
      );
      expect(result).toContain("ThreeNative desktop artifact");
      expect(existsSync(path.join(root, "out/game.js"))).toBe(true);
      expect(existsSync(path.join(root, "out/midway-provenance.json"))).toBe(false);
    },
  );

  it("accepts installed playtest's three directory but refuses the actual upstream package", async () => {
    const root = await temp("threenative-installed-playtest-");
    const playtest = path.join(
      root,
      "node_modules/.pnpm/@threenative+playtest@1/node_modules/@threenative/playtest",
    );
    await mkdir(path.join(playtest, "dist/three"), { recursive: true });
    await writeFile(
      path.join(playtest, "package.json"),
      JSON.stringify({
        name: "@threenative/playtest",
        type: "module",
        exports: "./dist/three/index.js",
      }),
    );
    await writeFile(path.join(playtest, "dist/three/index.js"), "export const marker = 42;");
    await mkdir(path.join(root, "node_modules/@threenative"), { recursive: true });
    await symlink(playtest, path.join(root, "node_modules/@threenative/playtest"));
    const entry = path.join(root, "game.ts");
    const outfile = path.join(root, "game.js");
    await writeFile(
      entry,
      'import { marker } from "@threenative/playtest"; globalThis.installedMarker = marker; export default { marker };',
    );
    await bundleNativeEngine({ entry, outfile, boot: false });
    expect(readFileSync(outfile, "utf8")).toContain("42");
    const upstream = path.join(root, "node_modules/.pnpm/three@1/node_modules/three");
    await mkdir(upstream, { recursive: true });
    await writeFile(path.join(upstream, "index.js"), "export const marker = 43;");
    await writeFile(
      entry,
      'import { marker } from "./node_modules/.pnpm/three@1/node_modules/three/index.js"; globalThis.installedMarker = marker; export default { marker };',
    );
    await expect(bundleNativeEngine({ entry, outfile, boot: false })).rejects.toThrow(
      /TN_NATIVE_ENGINE_UPSTREAM/u,
    );
  });

  it("resolves player facade siblings from installed dependencies", async () => {
    const root = await temp("threenative-installed-facades-");
    const native = path.join(root, "node_modules/@threenative/runtime-native");
    await mkdir(path.join(native, "scripts"), { recursive: true });
    await copyFile(
      path.resolve("packages/runtime-native/scripts/bundle-native-engine.mjs"),
      path.join(native, "scripts/bundle-native-engine.mjs"),
    );
    await cp(
      path.resolve("packages/runtime-native/src/engine/player"),
      path.join(native, "src/engine/player"),
      { recursive: true },
    );
    for (const name of ["node_modules", "package.json"])
      await symlink(path.resolve("packages/runtime-native", name), path.join(native, name));
    const { bundleNativeEngine: installedBundle } = await import(
      path.join(native, "scripts/bundle-native-engine.mjs")
    );
    const entry = path.join(root, "game.ts");
    const outfile = path.join(root, "game.js");
    await writeFile(
      entry,
      'import { Vector3 } from "three"; globalThis.installedVector = new Vector3(1, 2, 3); export default {};',
    );
    await installedBundle({ entry, outfile, boot: false });
    expect(readFileSync(outfile, "utf8")).toContain("installedVector");
  });

  it("routes the build to the engine player, never to the legacy host's prebuilt", async () => {
    const root = await temp("threenative-engine-desktop-");
    // An installed runtime-native with no engine bundler: the build must name that, not install a prebuilt.
    await mkdir(path.join(root, "node_modules/@threenative/runtime-native"), { recursive: true });
    await writeFile(
      path.join(root, "node_modules/@threenative/runtime-native/package.json"),
      JSON.stringify({ name: "@threenative/runtime-native", version: "0.0.0" }),
    );
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/game.ts"), "export default {};\n");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "engine-game" }));
    await writeFile(
      path.join(root, "threenative.config.ts"),
      'export default { engine: "native" };\n',
    );
    await expect(build({ cwd: root, target: "desktop" })).rejects.toThrow(
      /TN_ENGINE_BUNDLER_MISSING/u,
    );
  });

  it("finds the player through THREENATIVE_ENGINE_PLAYER, checkout, then installed prebuilt", async () => {
    expect(engineDesktopPlayer("/rt", { THREENATIVE_ENGINE_PLAYER: "bin/player" }, "/game")).toBe(
      "/game/bin/player",
    );
    const root = await temp("threenative-player-resolution-");
    const filename = `tn-native-engine-player-v8${process.platform === "win32" ? ".exe" : ""}`;
    const checkout = path.join(root, "build/tn-engine-ui", filename);
    const installed = path.join(root, `prebuilt/${process.platform}-${process.arch}/${filename}`);
    await mkdir(path.dirname(installed), { recursive: true });
    await writeFile(installed, "installed");
    expect(engineDesktopPlayer(root, {}, "/game")).toBe(installed);
    await mkdir(path.dirname(checkout), { recursive: true });
    await writeFile(checkout, "checkout");
    expect(engineDesktopPlayer(root, {}, "/game")).toBe(checkout);
    expect(engineDesktopPlayer(root, { THREENATIVE_ENGINE_PLAYER: "bin/player" }, "/game")).toBe(
      "/game/bin/player",
    );
  });
});

describe("packageEngineDesktop", () => {
  const stubs = {
    bundle: async ({ outfile }: { outfile: string }) => writeFile(outfile, "// game\n"),
    cook: async ({ outfile }: { outfile: string }) => {
      const target = path.join(path.dirname(outfile), "native/assets.tnpk");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "pkg");
    },
  };

  it("lays the player, bundle, cooked assets, UI and launcher out where the player reads them", async () => {
    const root = await temp("threenative-engine-package-");
    const player = path.join(root, "player");
    await writeFile(player, "#!/bin/sh\n");
    const ui = path.join(root, "ui-built");
    await mkdir(ui, { recursive: true });
    await writeFile(path.join(ui, "index.html"), "<html></html>");
    const output = path.join(root, "dist-native", "midway");
    await packageEngineDesktop(
      { project: root, entry: "src/game.ts", player, ui, output, width: 1920, height: 1080 },
      stubs,
    );
    for (const file of [
      "game.js",
      "native/assets.tnpk",
      "ui/index.html",
      "tn-native-engine-player-v8",
      "midway",
    ])
      expect(existsSync(path.join(output, file)), file).toBe(true);
    expect(statSync(path.join(output, "midway")).mode & 0o111).not.toBe(0);
    const start = readFileSync(path.join(output, "midway"), "utf8");
    expect(start).toBe(launcher(1920, 1080));
    expect(start).toContain(':"${TN_PLAYER_WIDTH:=1920}"'.slice(1));
    expect(start).toContain('exec "$DIR/tn-native-engine-player-v8" "$DIR/game.js" "$@"');
  });

  it("opens the window with the game's title and size, a quote in the title included", async () => {
    const root = await temp("threenative-engine-package-title-");
    const player = path.join(root, "player");
    // A stand-in player that reports what the launcher gave it.
    await writeFile(
      player,
      '#!/bin/sh\necho "$TN_PLAYER_TITLE|$TN_PLAYER_WIDTH|$TN_PLAYER_HEIGHT"\n',
    );
    const output = path.join(root, "dist-native", "midway");
    await packageEngineDesktop(
      {
        project: root,
        entry: "e",
        player,
        output,
        width: 1280,
        height: 720,
        title: "MIDWAY — Pilot's Open Pacific",
      },
      stubs,
    );
    const env = { ...process.env, TN_PLAYER_TITLE: "", TN_PLAYER_WIDTH: "", TN_PLAYER_HEIGHT: "" };
    for (const key of ["TN_PLAYER_TITLE", "TN_PLAYER_WIDTH", "TN_PLAYER_HEIGHT"])
      delete (env as Record<string, unknown>)[key];
    expect(execFileSync(path.join(output, "midway"), { env, encoding: "utf8" }).trim()).toBe(
      "MIDWAY — Pilot's Open Pacific|1280|720",
    );
  });

  it("fails closed without a player, and without a UI page when one was asked for", async () => {
    const root = await temp("threenative-engine-package-fail-");
    const output = path.join(root, "out");
    await expect(
      packageEngineDesktop(
        { project: root, entry: "e", player: path.join(root, "absent"), output },
        stubs,
      ),
    ).rejects.toThrow(/TN_ENGINE_PLAYER_MISSING/u);
    const player = path.join(root, "player");
    await writeFile(player, "x");
    await mkdir(path.join(root, "ui-empty"), { recursive: true });
    await expect(
      packageEngineDesktop(
        { project: root, entry: "e", player, ui: path.join(root, "ui-empty"), output },
        stubs,
      ),
    ).rejects.toThrow(/TN_UI_BUNDLE_MISSING/u);
  });
});
