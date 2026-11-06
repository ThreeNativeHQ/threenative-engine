import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { rgbaPng } from "../../../test-support/png.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { basisTranscoderPaths } from "../../../test-support/three-basis.js";
import { type IAssetSourceConfig, compileAssets, resolveBasisTranscoder } from "../src/index.js";

const THREE_INSTALL = path.resolve(import.meta.dirname, "../node_modules/three");
const TRANSCODER_MODULE = "three/examples/jsm/libs/basis/basis_transcoder.js";

/**
 * Whether three's transcoder resolves. Vitest answers `createRequire(...).resolve` through its own
 * resolver, from this file's install, so a temp project that never installed `three` still
 * resolves; the flag makes it fail the way Node does in a real project without it.
 */
const resolution = { failing: false };

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: (filename: string | URL) => {
      const require = actual.createRequire(filename);
      if (!resolution.failing) return require;
      const fail = (): never => {
        throw new Error(`Cannot find module '${TRANSCODER_MODULE}'`);
      };
      return Object.assign(fail, { resolve: fail }) as unknown as typeof require;
    },
  };
});

/** Gives a temp project the `three` install the transcoder is resolved from. */
async function installThree(root: string): Promise<void> {
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await symlink(THREE_INSTALL, path.join(root, "node_modules", "three"));
}

/**
 * One 64x64 gradient texture, with an explicit `etc1s` codec so the compile ships a Basis output
 * whatever the encoder's size heuristic would have decided for this source.
 */
async function projectWithBasisTexture(prefix: string): Promise<string> {
  const root = await makeTempDir(prefix);
  await mkdir(path.join(root, "assets"));
  await writeFile(
    path.join(root, "assets", "ground.png"),
    rgbaPng({
      blue: (x, y) => 100 + ((x * 21 + y * 21) % 8),
      green: (x, y) => 100 + ((x * 29 + y * 31) % 8),
      height: 64,
      red: (x, y) => 100 + ((x * 37 + y * 41) % 8),
      width: 64,
    }),
  );
  return root;
}

const BASIS_TEXTURE_CONFIG = {
  textures: { overrides: [{ codec: "etc1s", glob: "*.png" }] },
} as IAssetSourceConfig;

/** Runs `run` with three's transcoder made unresolvable, restoring the resolver afterwards. */
async function withoutThree<T>(run: () => Promise<T> | T): Promise<T> {
  resolution.failing = true;
  try {
    return await run();
  } finally {
    resolution.failing = false;
  }
}

/**
 * The runtime KTX2 loader cannot decode a Basis texture without three's transcoder, so a compile
 * that shipped one without it produced a build that 404s in a browser instead of failing here.
 * These pin the three outcomes: resolved from the project's own install, a named failure when it
 * is not there, and the injected override that skips resolution entirely.
 */
describe("resolveBasisTranscoder", () => {
  it("should resolve three's transcoder through the project's own install", async () => {
    const root = await makeTempDir("threenative-transcoder-found-");
    await installThree(root);

    const transcoder = resolveBasisTranscoder(root);

    expect(
      transcoder.javascriptPath.endsWith(
        path.join("three", "examples", "jsm", "libs", "basis", "basis_transcoder.js"),
      ),
    ).toBe(true);
    expect(transcoder.wasmPath).toBe(transcoder.javascriptPath.replace(/\.js$/u, ".wasm"));
    expect((await stat(transcoder.javascriptPath)).isFile()).toBe(true);
    expect((await stat(transcoder.wasmPath)).isFile()).toBe(true);
  });

  it("should name the cwd it could not resolve three from", async () => {
    const root = await makeTempDir("threenative-transcoder-missing-");

    const error = await withoutThree(() => {
      try {
        return resolveBasisTranscoder(root);
      } catch (thrown) {
        return thrown as Error;
      }
    });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `TN_ASSETS_TRANSCODER_MISSING: could not resolve three's Basis transcoder from '${root}': Cannot find module '${TRANSCODER_MODULE}'. The runtime KTX2 loader needs it copied next to the compiled assets.`,
    );
  });

  it("should fail a compile that ships Basis output rather than ship it undecodable", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const root = await projectWithBasisTexture("threenative-transcoder-compile-missing-");

      await expect(
        withoutThree(() => compileAssets({ config: BASIS_TEXTURE_CONFIG, cwd: root })),
      ).rejects.toThrow(
        /TN_ASSETS_TRANSCODER_MISSING: could not resolve three's Basis transcoder/u,
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("should copy the injected transcoder instead of resolving one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const root = await projectWithBasisTexture("threenative-transcoder-override-");
      const transcoder = basisTranscoderPaths();

      // No `three` install in this project at all: the injection is the only source.
      await withoutThree(() =>
        compileAssets({ config: BASIS_TEXTURE_CONFIG, cwd: root, transcoder }),
      );

      const copied = {
        javascriptPath: path.join(root, "public", "basis", "basis_transcoder.js"),
        wasmPath: path.join(root, "public", "basis", "basis_transcoder.wasm"),
      };
      expect(
        (await readFile(copied.javascriptPath)).equals(await readFile(transcoder.javascriptPath)),
      ).toBe(true);
      expect((await readFile(copied.wasmPath)).equals(await readFile(transcoder.wasmPath))).toBe(
        true,
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
