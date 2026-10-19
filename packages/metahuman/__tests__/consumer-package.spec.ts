import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publicWorkspacePackages, workspacePackages } from "../../../scripts/workspace-packages.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";

const run = promisify(execFile);
const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGE_NAME = (
  JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    name: string;
  }
).name;

interface IPacked {
  /** Every path in the tarball, `package/`-prefixed exactly as `npm pack` writes it. */
  readonly entries: readonly string[];
  readonly root: string;
}

let packed: IPacked;
let sandbox: string;

/**
 * Pack the package the way a registry would and read the tarball, not the working tree.
 *
 * `files` is the whole installation mechanism, so every claim here has to be read off the
 * archive: a fixture or a C++ source that only lives in `dist/` of a sibling checkout proves
 * nothing about what an installed consumer receives.
 */
beforeAll(async () => {
  sandbox = await makeTempDir("threenative-metahuman-pack-");
  const archiveDirectory = path.join(sandbox, "archive");
  await mkdir(archiveDirectory, { recursive: true });
  await run("pnpm", ["pack", "--pack-destination", archiveDirectory], { cwd: PACKAGE_ROOT });
  const archive = (await readdir(archiveDirectory)).find((entry) => entry.endsWith(".tgz"));
  if (archive === undefined) throw new Error("metahuman pack produced no tarball");
  const listed = await run("tar", ["-tzf", path.join(archiveDirectory, archive)]);
  await run("tar", ["-xzf", path.join(archiveDirectory, archive), "-C", archiveDirectory]);
  // `three` is a peer dependency, so the packed tree has no node_modules of its own; the packed
  // index can only be imported once the workspace's copy is reachable from it.
  await symlink(
    path.join(PACKAGE_ROOT, "node_modules"),
    path.join(archiveDirectory, "package", "node_modules"),
    "dir",
  );
  packed = {
    entries: listed.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    // Node resolves import.meta URLs through a symlinked TMPDIR to physical paths.
    root: await realpath(path.join(archiveDirectory, "package")),
  };
  // Created in beforeAll, outside any test, so makeTempDir can only register process-exit cleanup,
  // which a vitest worker does not reliably reach: remove the one sandbox directory explicitly.
}, 120_000);

afterAll(async () => {
  if (sandbox !== undefined) await rm(sandbox, { force: true, recursive: true });
});

async function read(relative: string): Promise<string> {
  return await readFile(path.join(packed.root, relative), "utf8");
}

describe("packed @threenative/metahuman", () => {
  it("should ship the built runtime, its types and the checksum-manifested WASM", async () => {
    for (const target of [
      "package/dist/index.js",
      "package/dist/index.d.ts",
      "package/dist/native/index.js",
      "package/dist/native/index.d.ts",
      "package/wasm/riglogic.wasm",
      "package/wasm/riglogic.mjs",
      "package/wasm/checksums.json",
    ])
      expect(packed.entries, target).toContain(target);

    // The published binary is the one the loader verifies before it instantiates the module, so
    // the archive and the manifest have to agree without anyone re-hashing by hand at install.
    const manifest = JSON.parse(await read("wasm/checksums.json")) as {
      files?: Record<string, string>;
    };
    const wasm = await readFile(path.join(packed.root, "wasm/riglogic.wasm"));
    expect(createHash("sha256").update(wasm).digest("hex")).toBe(manifest.files?.["riglogic.wasm"]);
  }, 60_000);

  it("should keep the default entry bundleable by a native host that has WebAssembly", async () => {
    // A V8 desktop host bundles the default entry, and the native bundler refuses any runtime
    // import (`runtime-native/scripts/bundle.mjs`). So the entry names no Node builtin and has no
    // dynamic `import()`: the Emscripten glue is inlined, and the payload is fetched.
    const source = await read("package/dist/index.js".replace(/^package\//u, ""));
    expect(source).not.toMatch(/\bimport\s*\(/u);
    expect(source).not.toMatch(/["'](?:node:)?(?:fs|fs\/promises|url|module|path)["']/u);
  });

  it("should give the native export condition a target that cannot reach the WASM payload", async () => {
    const manifest = JSON.parse(await read("package.json")) as {
      exports?: Record<string, Record<string, string>>;
    };
    const nativeTarget = (
      manifest.exports?.["."]?.["threenative-native"] as string | undefined
    )?.replace(/^\.\//u, "");
    expect(nativeTarget, "exports['.'].['threenative-native']").toBeTypeOf("string");
    expect(packed.entries, nativeTarget).toContain(`package/${nativeTarget}`);

    // A native bundle that cannot carry a WASM binary must not so much as name one: the loader
    // URLs, the Emscripten glue and the module specifier all have to be absent from the file the
    // native condition resolves to. (The prose "the WASM module is not in this bundle" is a
    // comment, not a payload, so only file references are rejected.)
    const nativeSource = await read(nativeTarget as string);
    expect(nativeSource).not.toMatch(/riglogic\.(?:wasm|mjs)/iu);
    expect(nativeSource).not.toMatch(/["'][^"']*\.\.\/wasm\//u);
    const specifiers = [...nativeSource.matchAll(/(?:from|import)\s*["']([^"']+)["']/gu)].map(
      (match) => match[1] as string,
    );
    expect(specifiers.filter((specifier) => /wasm|riglogic/iu.test(specifier))).toEqual([]);

    // Staging those packaged assets offline at native build time is the host's job and is already
    // proven where it lives: `packages/runtime-native/tests/desktop-assets.test.mjs` (web-root
    // staging, reserved-path rejection) and `android-first-proof-gate.test.mjs` (an APK carrying
    // its assets with no network). Repeating it here would test the runtime-native bundler, not
    // this package's distribution contract.
  });

  it("should keep sources, build scripts, fixtures and specimen assets out of the archive", async () => {
    for (const entry of packed.entries) {
      expect(entry, entry).not.toMatch(/^package\/(?:cpp|fixtures|scripts|__tests__)\//u);
      expect(entry, entry).not.toMatch(/\.(?:dna|glb|gltf|png|jpeg|jpg|ktx2|hdr|exr)$/u);
    }
  });

  it("should declare no workspace protocol and no unpublished workspace dependency", async () => {
    const manifest = JSON.parse(await read("package.json")) as {
      [field: string]: unknown;
      name: string;
      peerDependencies?: Record<string, string>;
      version: string;
    };
    expect(manifest.name).toBe(PACKAGE_NAME);

    const unpublished = new Set(
      workspacePackages()
        .filter((item) => item.private)
        .map((item) => item.name),
    );
    expect(publicWorkspacePackages().some((item) => item.name === PACKAGE_NAME)).toBe(true);
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      const block = (manifest[field] ?? {}) as Record<string, string>;
      for (const [name, range] of Object.entries(block)) {
        expect(range, `${field}.${name}`).not.toMatch(/^(?:workspace|file|link):/u);
        // The registry cannot resolve an unpublished sibling, so naming one makes the whole
        // package uninstallable rather than merely version-skewed.
        expect(unpublished.has(name), `${field}.${name}`).toBe(false);
      }
    }
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });

  it("should declare no side-effectful module and fetch nothing until an evaluator is created", async () => {
    const manifest = JSON.parse(await read("package.json")) as { sideEffects?: unknown };
    // Whatever the declaration is, it must not claim the WASM payload is a side effect: an
    // unrelated app that never calls `RigEvaluator.create` must never pay for it. The
    // behavioural proof is the import below; this only rules the manifest out as the loophole.
    expect(JSON.stringify(manifest.sideEffects ?? false)).not.toMatch(/wasm|riglogic/iu);

    // A child process, not this one: the loader reaches `node:fs/promises` through a lazily
    // imported namespace a test runner may have snapshotted before any spy is installed, and Node's
    // own loader is the environment a consumer's bundler resolves against anyway. The load itself
    // is observed through the public `liveHandleCount`, which reads the ABI registry and therefore
    // only answers once the module is instantiated — no `fs` patching is needed to prove laziness.
    const probe = path.join(sandbox, "lazy-probe.mjs");
    await writeFile(
      probe,
      [
        'import { readFile, writeFile } from "node:fs/promises";',
        "const calls = [];",
        // Node's fetch refuses `file:`; a browser and the native host answer it. Anything else is
        // the network, which the package must never reach.
        "globalThis.fetch = async (url) => { calls.push(String(url)); if (!String(url).startsWith('file:')) throw new Error('the packed index reached the network'); return new Response(await readFile(new URL(url))); };",
        `const module = await import(${JSON.stringify(pathToFileURL(path.join(packed.root, "dist/index.js")).href)});`,
        "let liveBefore = '';",
        "try { liveBefore = String(module.RigEvaluator.liveHandleCount()); }",
        "catch (error) { liveBefore = error.code ?? error.message; }",
        "const callsAfterImport = [...calls];",
        'let rejection = "";',
        "try { await module.RigEvaluator.create(new Uint8Array([1, 2, 3])); }",
        "catch (error) { rejection = error.code ?? error.message; }",
        "await writeFile(process.env.TN_PROBE_OUT, JSON.stringify({ calls, callsAfterImport, liveAfter: module.RigEvaluator.liveHandleCount(), liveBefore, rejection }));",
      ].join("\n"),
    );
    const out = path.join(sandbox, "lazy-probe.json");
    await writeFile(out, "");
    await run("node", [probe], { cwd: sandbox, env: { ...process.env, TN_PROBE_OUT: out } });

    const observed = JSON.parse(await readFile(out, "utf8")) as {
      calls: string[];
      callsAfterImport: string[];
      liveAfter: number;
      liveBefore: string;
      rejection: string;
    };
    // `TN_MH_WASM_LOAD` is the module-not-loaded rejection: importing the entry must not have
    // instantiated the WASM build, and must not have reached for the network to do it.
    expect(observed.liveBefore).toBe("TN_MH_WASM_LOAD");
    expect(observed.callsAfterImport, "fetches on import").toEqual([]);

    // The boundary, not the absence: the payload loads on the first `create`, so a consumer that
    // uses only the asset contract never touches it. The bogus DNA still proves the load happened
    // — the ABI rejects the signature, which it can only do from inside the instantiated module.
    expect(observed.rejection).not.toBe("");
    expect(observed.liveAfter).toBe(0);
    // The payload comes from the package itself, beside the entry, by `fetch` alone: the same
    // path a browser and a native host take, and no CDN.
    expect(
      observed.calls.map((url) => path.relative(packed.root, new URL(url).pathname)).sort(),
    ).toEqual(["wasm/checksums.json", "wasm/riglogic.wasm"]);
  }, 60_000);

  it("should load nothing from the integration for an app that never asks for it", async () => {
    const consumer = path.join(sandbox, "consumer");
    await mkdir(path.join(consumer, "node_modules", "@threenative"), { recursive: true });
    await symlink(packed.root, path.join(consumer, "node_modules", PACKAGE_NAME), "dir");
    await writeFile(
      path.join(consumer, "package.json"),
      `${JSON.stringify({ name: "unrelated-app", private: true, type: "module" })}\n`,
    );
    await writeFile(
      path.join(consumer, "app.mjs"),
      ["export const frames = () => 2;", "console.log(frames());"].join("\n"),
    );
    await writeFile(
      path.join(consumer, "loader.mjs"),
      [
        'import { appendFileSync } from "node:fs";',
        "export function resolve(specifier, context, next) {",
        "  const resolved = next(specifier, context);",
        "  return Promise.resolve(resolved).then((value) => {",
        "    appendFileSync(process.env.TN_RESOLVE_LOG, `${value.url}\\n`);",
        "    return value;",
        "  });",
        "}",
      ].join("\n"),
    );
    await writeFile(
      path.join(consumer, "register.mjs"),
      [
        'import { register } from "node:module";',
        'register("./loader.mjs", import.meta.url);',
      ].join("\n"),
    );

    const loaded = async (entry: string, name: string): Promise<readonly string[]> => {
      const log = path.join(sandbox, `${name}.log`);
      await writeFile(log, "");
      await run("node", ["--import", "./register.mjs", entry], {
        cwd: consumer,
        env: { ...process.env, TN_RESOLVE_LOG: log },
      });
      return (await readFile(log, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    };

    await writeFile(
      path.join(consumer, "integration.mjs"),
      [`import { RigEvaluator } from "${PACKAGE_NAME}";`, "console.log(typeof RigEvaluator);"].join(
        "\n",
      ),
    );

    // The negative arm is only meaningful next to a positive one: the same tracer must see the
    // package when the app does import it, or the empty log would prove nothing. Matched on the
    // tarball's own directory rather than on "metahuman", which the temp prefix itself contains.
    const fromPackage = (urls: readonly string[]): readonly string[] =>
      urls.filter((url) => url.includes(packed.root));
    expect(fromPackage(await loaded("./app.mjs", "unrelated"))).toEqual([]);
    expect(fromPackage(await loaded("./integration.mjs", "integration")).length).toBeGreaterThan(0);
  }, 120_000);
});
