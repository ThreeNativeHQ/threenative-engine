/**
 * PRD-830: a `three` export the Wasm engine refuses fails at the import line, in `pnpm dev` and in
 * `threenative build`, not at the first frame. The refusals here come from the runtime's own
 * binding (`bindUpstreamExports`, the catalog and the registry classes); only the Wasm boot is
 * replaced, because the unit lane has no built engine. Every kit build runs the real boot (AC-3).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { bindUpstreamExports } from "../../three-native/src/browser-entry.js";
import { type ICatalog, loadCatalog } from "../../three-native/src/catalog.js";
import { refusalsOf } from "../src/web-engine.js";

const REPO = process.cwd();
const catalog: ICatalog = loadCatalog(REPO);
const registry = JSON.parse(
  await readFile(path.join(REPO, "packages/three-native/api/native-registry.json"), "utf8"),
) as { classes: Record<string, unknown> };
const classes = Object.fromEntries(
  Object.keys(registry.classes).map((name) => [name, class {}] as const),
);
const fromCore = createRequire(path.join(REPO, "packages/core/package.json"));
const names = [
  ...new Set(
    (
      await Promise.all(
        ["three", "three/webgpu", "three/tsl"].map(
          (id) => import(pathToFileURL(fromCore.resolve(id)).href) as Promise<object>,
        ),
      )
    ).flatMap((module) => Object.keys(module)),
  ),
].filter((name) => name !== "default");
const refusals = refusalsOf(bindUpstreamExports(names, catalog, classes), names);

vi.mock("../src/web-engine.js", async (original) => ({
  ...(await original<typeof import("../src/web-engine.js")>()),
  upstreamRefusals: async () => refusals,
}));

const { createEngineCatalogPlugin } = await import("../src/engine-catalog.js");

/** An `unsupported` catalog entry the registry does not bind, so its own diagnostic is what throws. */
const unsupported = catalog.entries.find(
  (entry) =>
    entry.source === "three" &&
    entry.status.kind === "unsupported" &&
    entry.kind === "class" &&
    !Object.hasOwn(classes, entry.name),
);
const partial = catalog.entries.find(
  (entry) =>
    entry.source === "three" && entry.status.kind === "partial" && !refusals.has(entry.name),
);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function game(engine?: "threejs" | "threenative"): Promise<string> {
  const root = await makeTempDir("threenative-engine-catalog-");
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fox", type: "module" }));
  if (engine !== undefined)
    await writeFile(
      path.join(root, "threenative.config.ts"),
      `export default { engine: ${JSON.stringify(engine)} };\n`,
    );
  return root;
}

interface IFailure {
  readonly message: string;
  readonly loc?: { readonly line: number; readonly column: number };
}

/** Runs the plugin's transform on one file as Vite would, returning the error or warning it raised. */
async function transform(root: string, file: string, code: string, mode?: "error" | "warn") {
  const plugin = createEngineCatalogPlugin(mode === undefined ? {} : { mode });
  await plugin.configResolved({ root });
  const raised: { error?: IFailure; warning?: string } = {};
  await plugin.transform
    .call(
      {
        error: (failure: IFailure): never => {
          raised.error = failure;
          throw new Error(failure.message);
        },
        warn: (message: string) => {
          raised.warning = message;
        },
      },
      code,
      path.join(root, file),
    )
    .catch(() => undefined);
  return raised;
}

describe("createEngineCatalogPlugin", () => {
  beforeAll(() => {
    expect(unsupported, "the catalog has an unbound unsupported class").toBeDefined();
    expect(partial, "the catalog has a bound partial entry").toBeDefined();
  });

  it("refuses an uncatalogued import at its line with the runtime's code", async () => {
    const root = await game();
    const { error } = await transform(
      root,
      "src/shapes.ts",
      'import { Mesh } from "three";\nimport {\n  BoxGeometry,\n  TetrahedronGeometry,\n} from "three";\n',
    );
    expect(error?.message).toContain("TN_NATIVE_UNCATALOGUED_TETRAHEDRONGEOMETRY");
    expect(error?.message).toContain("src/shapes.ts:4:3");
    expect(error?.loc).toEqual({ file: path.join(root, "src/shapes.ts"), line: 4, column: 2 });
  });

  it("refuses an unsupported entry with that entry's own diagnostic", async () => {
    const root = await game();
    const name = unsupported?.name ?? "";
    const { error } = await transform(root, "src/a.ts", `import { ${name} } from "three";\n`);
    expect(unsupported?.status.kind === "unsupported" && unsupported.status.diagnostic).toBe(
      refusals.get(name),
    );
    expect(error?.message).toContain(`${refusals.get(name)}: ${name}`);
  });

  it("passes a partial entry, an import type, a type-only specifier and an aliased bound name", async () => {
    const root = await game();
    const { error, warning } = await transform(
      root,
      "src/b.ts",
      [
        `import { ${partial?.name} as Thing, Mesh } from "three";`,
        'import type { TetrahedronGeometry } from "three";',
        'import { type AONode, Vector3 } from "three/webgpu";',
        '// import { TetrahedronGeometry } from "three";',
        "",
      ].join("\n"),
    );
    expect({ error, warning }).toEqual({});
  });

  it("checks only the game's own files, not a linked engine package outside its root", async () => {
    const root = await game();
    const source = 'import { TetrahedronGeometry } from "three";\n';
    const linked = await transform(root, "../engine/packages/core/dist/index.js", source);
    const installed = await transform(root, "node_modules/@threenative/core/dist/index.js", source);
    expect({ linked, installed }).toEqual({ linked: {}, installed: {} });
  });

  it("is off under engine threejs and says so once", async () => {
    const root = await game("threejs");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { error } = await transform(
        root,
        "src/c.ts",
        'import { TetrahedronGeometry } from "three";\n',
      );
      expect(error).toBeUndefined();
      expect(info.mock.calls.map((call) => String(call[0]))).toEqual([
        "TN_ENGINE_CATALOG: off (engine threejs)",
      ]);
    } finally {
      info.mockRestore();
    }
  });

  it('downgrades to a warning under mode "warn" and names the override', async () => {
    const root = await game();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { error, warning } = await transform(
        root,
        "src/d.ts",
        'import { TetrahedronGeometry } from "three";\n',
        "warn",
      );
      expect(error).toBeUndefined();
      expect(warning).toContain("TN_NATIVE_UNCATALOGUED_TETRAHEDRONGEOMETRY");
      expect(String(info.mock.calls[0]?.[0])).toMatch(/^TN_ENGINE_CATALOG: warn/u);
    } finally {
      info.mockRestore();
    }
  });

  it("fails a real Vite build at the import line, and the threejs build passes", async () => {
    const { build } = await import("vite");
    const run = async (root: string) =>
      build({
        root,
        logLevel: "silent",
        configFile: false,
        plugins: [createEngineCatalogPlugin()],
        build: {
          write: false,
          lib: { entry: path.join(root, "src/main.ts"), formats: ["es"] },
          rollupOptions: { external: [/^three/u] },
        },
      });
    const source =
      'import { TetrahedronGeometry } from "three";\nexport const t = TetrahedronGeometry;\n';
    const refused = await game();
    await writeFile(path.join(refused, "src/main.ts"), source);
    await expect(run(refused)).rejects.toThrow(
      /TN_NATIVE_UNCATALOGUED_TETRAHEDRONGEOMETRY: TetrahedronGeometry from "three" .*src\/main\.ts:1:10/u,
    );
    const upstream = await game("threejs");
    await writeFile(path.join(upstream, "src/main.ts"), source);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(run(upstream)).resolves.toBeDefined();
    } finally {
      info.mockRestore();
    }
  });
});
