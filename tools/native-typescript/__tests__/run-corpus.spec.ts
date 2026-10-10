import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { stageSharedFacade } from "../perry-facade.mjs";
import { renderReference } from "../render-reference.mjs";
import * as corpus from "../run-corpus.mjs";
import {
  discoverCases,
  missingExpectationNote,
  parseExpected,
  runMeasured,
  unsupportedThreeImports,
} from "../run-corpus.mjs";
import { buildEngineBridge } from "../three-bridge.mjs";

const referenceRuntime = vi.hoisted(() => ({
  handler: undefined as ((request: unknown, response: unknown) => void) | undefined,
  launch: vi.fn(),
}));
vi.mock("node:http", () => ({
  createServer: (handler: typeof referenceRuntime.handler) => {
    referenceRuntime.handler = handler;
    return {
      once: () => {},
      listen: (_port: number, _host: string, done: () => void) => done(),
      address: () => ({ port: 1234 }),
      close: (done: () => void) => done(),
    };
  },
}));
vi.mock("tsx/esm/api", () => ({
  tsImport: async () => ({
    launchReferenceBrowser: referenceRuntime.launch,
    threeBuildDir: () =>
      path.dirname(
        createRequire(
          new URL("../../../packages/runtime-native/package.json", import.meta.url),
        ).resolve("three/webgpu"),
      ),
    CAPTURE_TIMEOUT_MS: 90_000,
    SOFTWARE_ADAPTER: /software/i,
  }),
}));

const { PNG } = createRequire(
  new URL("../../../packages/runtime-native/package.json", import.meta.url),
)("pngjs");

describe("shared Perry facade staging", () => {
  it("publishes registry/TSL exports and binds only the numeric native transport", () => {
    const dir = tempDir();
    try {
      const staged = stageSharedFacade(dir, { libDirs: ["/engine"], libs: ["tn-native-shim"] });
      const source = fs.readFileSync(path.join(staged.three, "three.ts"), "utf8");
      expect(source).toContain("bindPerryEngine");
      for (const name of [
        "Scene",
        "PerspectiveCamera",
        "CanvasTexture",
        "Fn",
        "uniform",
        "vec3",
        "DataUtils",
        "pmremTexture",
        "uniformArray",
        "mx_noise_float",
        "cameraViewMatrix",
      ])
        expect(source).toContain(`export const ${name} = bound.${name};`);
      expect(fs.readFileSync(path.join(staged.three, "tsl.ts"), "utf8")).toContain("./three.js");
      const manifest = JSON.parse(
        fs.readFileSync(path.join(staged.adapter, "package.json"), "utf8"),
      );
      expect(manifest.name).toBe("tn-native-transport");
      expect(fs.readFileSync(path.join(staged.adapter, "Cargo.toml"), "utf8")).toContain(
        'path = "native-physics"',
      );
      expect(
        fs.readFileSync(path.join(staged.adapter, "native-physics/Cargo.toml"), "utf8"),
      ).toContain('name = "threenative-native-physics"');
      expect(
        manifest.perry.nativeLibrary.functions.map((entry: { name: string }) => entry.name),
      ).toContain("js_tnp_physics_copy");
      expect(manifest.perry.nativeLibrary.targets.linux.libDirs).toEqual(["/engine"]);
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).perry.allow
          .nativeLibrary,
      ).toEqual(["tn-native-transport"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("render frame comparison", () => {
  it("accepts quantization noise but rejects a changed graph, missing, blank or wrong-size frames", () => {
    const dir = tempDir();
    const reference = path.join(dir, "reference.png");
    const native = path.join(dir, "native.png");
    const write = (file: string, red: number, width = 4, blank = false): void => {
      const png = new PNG({ width, height: 4 });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data.set(i === 0 || i >= 32 ? [0, 0, 0, 0] : [red, 149, 211, blank ? 0 : 255], i);
      }
      fs.writeFileSync(file, PNG.sync.write(png));
    };
    try {
      expect(corpus.compareRenderFrames).toBeTypeOf("function");
      write(reference, 179);
      write(native, 179);
      expect(corpus.compareRenderFrames(reference, native).pixelMismatchRatio).toBe(0);
      write(native, 180);
      expect(() => corpus.compareRenderFrames(reference, native)).not.toThrow();
      write(native, 189);
      expect(() => corpus.compareRenderFrames(reference, native)).toThrow(
        /TN_NATIVE_TS_FRAME_MISMATCH/,
      );
      write(native, 179, 3);
      expect(() => corpus.compareRenderFrames(reference, native)).toThrow(/dimensions differ/);
      write(native, 179, 4, true);
      expect(() => corpus.compareRenderFrames(reference, native)).toThrow(/blank/);
      expect(() => corpus.compareRenderFrames(reference, `${native}.missing`)).toThrow(
        /TN_NATIVE_TS_FRAME_MISSING: native .*native.png.missing/,
      );
      expect(() => corpus.compareRenderFrames(`${reference}.missing`, native)).toThrow(
        /TN_NATIVE_TS_FRAME_MISSING: reference .*reference.png.missing/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reference page (CPU module loading and failure forwarding)", () => {
  const request = (url: string, expectedStatus = 200): string => {
    let contents = "";
    referenceRuntime.handler?.(
      { url },
      {
        writeHead: (status: number, headers: Record<string, string>) => {
          expect(status).toBe(expectedStatus);
          if (status !== 204)
            expect(headers["content-type"]).toBe(url === "/" ? "text/html" : "text/javascript");
        },
        end: (text: string) => {
          contents = text;
        },
      },
    );
    return contents;
  };
  const capture = async (failure?: string, omitImportMap = false): Promise<void> => {
    const handlers = new Map<string, (event: unknown) => void>();
    const { build } = createRequire(
      new URL("../../../packages/runtime-native/package.json", import.meta.url),
    )("esbuild");
    const page = {
      on: (event: string, handler: (event: unknown) => void) => handlers.set(event, handler),
      goto: async () => {
        if (failure) {
          const message = "module load exploded";
          const url = `http://127.0.0.1:1234/${failure === "favicon" ? "favicon.ico" : "fixture.js"}`;
          const events: Record<string, unknown> = {
            console: { type: () => "error", text: () => message },
            requestfailed: {
              url: () => url,
              response: async () => null,
              failure: () => ({ errorText: message }),
            },
            response: { url: () => url, status: () => 404, statusText: () => "Not Found" },
            pageerror: Error(message),
          };
          if (failure === "favicon") {
            request("/favicon.ico", 204);
            handlers.get("response")?.(events.response);
            await handlers.get("requestfailed")?.(events.requestfailed);
          } else {
            await handlers.get(failure)?.(events[failure]);
            return;
          }
        }
        const html = request("/");
        const imports = omitImportMap
          ? {}
          : (JSON.parse(/<script type="importmap">(.*?)<\/script>/s.exec(html)?.[1] ?? "{}")
              .imports ?? {});
        const contents = /<script type="module">(.*?)<\/script>/s.exec(html)?.[1] ?? "";
        // Resolve the REAL served upstream module graph with the page's import map, without a GPU.
        await build({
          stdin: { contents, sourcefile: "/page.js" },
          bundle: true,
          format: "esm",
          write: false,
          logLevel: "silent",
          plugins: [
            {
              name: "browser-imports",
              setup: (builder: import("esbuild").PluginBuild) => {
                builder.onResolve({ filter: /.*/ }, (args) => {
                  let resolved = imports[args.path];
                  if (args.path.startsWith(".") || args.path.startsWith("/"))
                    resolved = new URL(args.path, `http://127.0.0.1${args.importer}`).pathname;
                  if (!resolved) throw Error(`unmapped bare import: ${args.path}`);
                  return { path: resolved, namespace: "served" };
                });
                builder.onLoad({ filter: /.*/, namespace: "served" }, (args) => ({
                  contents: request(args.path),
                  loader: "js",
                }));
              },
            },
          ],
        });
      },
      waitForFunction: async () => {
        if (failure && failure !== "favicon") throw Error("failure was not forwarded");
      },
      evaluate: async () => ({ info: { device: "hardware" } }),
      locator: () => ({ screenshot: async () => Buffer.alloc(0) }),
    };
    referenceRuntime.launch.mockResolvedValue({ newPage: async () => page, close: async () => {} });
    const dir = tempDir();
    try {
      const fixture = path.join(dir, "dynamic-tsl.mts");
      fs.writeFileSync(
        fixture,
        fs
          .readFileSync(new URL("../corpus/dynamic-tsl.ts", import.meta.url), "utf8")
          .replaceAll('"three"', '"file:///pinned/build/three.module.js"')
          .replaceAll('"three/tsl"', '"file:///pinned/build/three.tsl.js"')
          .replaceAll('"three/webgpu"', '"file:///pinned/build/three.webgpu.js"'),
      );
      await renderReference(fixture, path.join(dir, "reference.png"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  it("loads the fixture's real three/tsl dependencies through the served import map and MIME", async () => {
    await capture();
  });
  it("red control: upstream three.tsl.js cannot load without the import map", async () => {
    await expect(capture(undefined, true)).rejects.toThrow(/unmapped bare import: three\/webgpu/);
  });
  it("serves and ignores the browser's favicon request", async () => {
    await capture("favicon");
  });
  it("names the URL and HTTP status of a failed response", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(capture("response")).rejects.toThrow(
        /TN_REFERENCE_RESPONSE_FAILED .*\/fixture.js status=404 Not Found/,
      );
    } finally {
      stderr.mockRestore();
    }
  });
  it.each(["pageerror", "console", "requestfailed"])(
    "fails immediately and names a %s instead of waiting for completion",
    async (event) => {
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(capture(event)).rejects.toThrow(/module load exploded/);
        expect(stderr.mock.calls.flat().join(" ")).toContain("module load exploded");
        if (event === "requestfailed")
          expect(stderr.mock.calls.flat().join(" ")).toMatch(/\/fixture.js status=no-response/);
      } finally {
        stderr.mockRestore();
      }
    },
  );
});

function tempDir(): string {
  return makeTempDirSync("tn-run-corpus-");
}

describe("parseExpected", () => {
  it("defaults to exit 0 and keeps the stdout verbatim when there is no exit line", () => {
    const parsed = parseExpected(Buffer.from("22\n3\n"));
    expect(parsed.exit).toBe(0);
    expect(parsed.stdout.toString()).toBe("22\n3\n");
  });

  it("reads a trailing '# exit <n>' line and removes it from the compared stdout", () => {
    const parsed = parseExpected(Buffer.from("odd: 1\n-1\n# exit 3\n"));
    expect(parsed.exit).toBe(3);
    expect(parsed.stdout.toString()).toBe("odd: 1\n-1\n");
  });
});

describe("discoverCases", () => {
  it("lists the entry cases and excludes helper modules imported by them", () => {
    const names = discoverCases();
    expect(names).toContain("imports-cycle");
    expect(names).not.toContain("imports-cycle-inner");
    expect(names).not.toContain("imports-cycle-outer");
    expect(names).toContain("three-fixture");
    expect(names).toContain("unsupported-export");
    expect(names).toContain("callback-cycle");
    expect(names).toContain("dynamic-tsl");
    expect(names).toContain("dynamic-tsl-unsupported");
    expect(names).toContain("import-identity");
    expect(names).toContain("three-native-minimal");
    expect(names).toContain("three-native-midway-assets");
    expect(names).toHaveLength(21);
  });

  it("turns a top-level .ts with no .expected into a named failure, not a skip", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "lonely.ts"), "console.log(1)\n");
    fs.writeFileSync(path.join(dir, "paired.ts"), "console.log(2)\n");
    fs.writeFileSync(path.join(dir, "paired.expected"), "2\n# exit 0\n");

    expect(discoverCases(undefined, dir)).toEqual(["lonely", "paired"]);
    expect(missingExpectationNote("lonely", dir)).toContain("TN_NATIVE_TS_EXPECTED_MISSING");
    expect(missingExpectationNote("paired", dir)).toBeUndefined();
  });
});

describe("runMeasured", () => {
  it("reports the child's exact peak RSS and exit, and passes stdout through", async () => {
    const dir = tempDir();
    const hog = path.join(dir, "hog.mjs");
    fs.writeFileSync(
      hog,
      "const chunks = [];\nfor (let i = 0; i < 8; i++) { const u = new Uint8Array(32 * 1024 * 1024); u.fill(i + 1); chunks.push(u); }\nprocess.stdout.write(String(chunks.length) + '\\n');\n",
    );

    const measured = await runMeasured(process.execPath, process.env, [hog]);

    expect(measured.stdout.toString()).toBe("8\n");
    expect(measured.status).toBe(0);
    expect(measured.peakRssBytes).toBeGreaterThan(200 * 1024 * 1024);
  });
});

describe("unsupportedThreeImports", () => {
  const catalog = {
    entries: [
      { name: "Mesh", status: { kind: "supported" } },
      {
        name: "Raycaster",
        status: { kind: "unsupported", diagnostic: "TN_NATIVE_UNSUPPORTED_RAYCASTER" },
      },
    ],
  };

  it("passes supported names, aliases included", () => {
    expect(unsupportedThreeImports('import { Mesh, Mesh as M } from "three";', catalog)).toEqual(
      [],
    );
  });

  it("names each refused import with its specifier and the catalog's diagnostic", () => {
    expect(
      unsupportedThreeImports(
        'import { Mesh, Raycaster } from "three";\nimport { Fog as F } from "three/webgpu";',
        catalog,
      ),
    ).toEqual([
      "TN_NATIVE_TS_UNSUPPORTED_EXPORT three#Raycaster (TN_NATIVE_UNSUPPORTED_RAYCASTER)",
      "TN_NATIVE_TS_UNSUPPORTED_EXPORT three/webgpu#Fog (not in the catalog)",
    ]);
  });

  it("admits only the implemented AOT bindings when the VM catalog refuses them", () => {
    const aot = { "three/tsl": ["float"] };
    expect(unsupportedThreeImports('import { float } from "three/tsl";', catalog, aot)).toEqual([]);
    expect(
      unsupportedThreeImports('import { wgslFn } from "three/tsl";', catalog, aot),
    ).toHaveLength(1);
    expect(unsupportedThreeImports('import { float } from "three";', catalog, aot)).toHaveLength(1);
  });

  it("ignores imports from other modules", () => {
    expect(unsupportedThreeImports('import { Raycaster } from "./local";', catalog)).toEqual([]);
  });
});

describe("unsupported dynamic graph red control", () => {
  it("the unsupported corpus refuses an implementation that succeeds or raises a different code", () => {
    const source = fs.readFileSync(
      new URL("../corpus/dynamic-tsl-unsupported.ts", import.meta.url),
      "utf8",
    );
    const body = source.replace(/^import[^\n]+\n/, "");
    const run = (mod: () => void): void => {
      new Function("float", body)(() => ({ mod }));
    };
    expect(() => run(() => {})).toThrow(/did not raise TN_TSL_DYNAMIC_UNSUPPORTED/);
    expect(() =>
      run(() => {
        throw "WRONG_CODE mod";
      }),
    ).toThrow("WRONG_CODE mod");
    expect(() =>
      run(() => {
        throw "TN_TSL_DYNAMIC_UNSUPPORTED mod";
      }),
    ).not.toThrow();
  });
});

// Internal C++ headers determine the stack allocation sizes of the in-process render host.
describe("engine bridge cache", () => {
  it("rebuilds when an internal engine header is newer than the archive", () => {
    const outDir = tempDir();
    buildEngineBridge({ outDir });
    const cachedTime = Date.now() + 60_000;
    for (const name of ["libtn-three-shim.a", "tn_three_shim.o", "tn_three_hooks.o"]) {
      const file = path.join(outDir, name);
      fs.utimesSync(file, cachedTime / 1000, cachedTime / 1000);
    }
    const stat = fs.statSync;
    const probe = vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      const result = stat(...args);
      if (String(args[0]).endsWith("/engine/renderer/renderer.h"))
        result.mtimeMs = cachedTime + 60_000;
      return result;
    });
    try {
      const archive = buildEngineBridge({ outDir });
      expect(fs.statSync(archive).mtimeMs).toBeLessThan(cachedTime);
    } finally {
      probe.mockRestore();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
