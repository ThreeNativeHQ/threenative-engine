import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { createWebBrandPlugin, withBuildId, withEnginePreload } from "../src/web-brand.js";

const roots: string[] = [];

interface IFakeResponse {
  body: string;
  headers: Record<string, string>;
  setHeader(key: string, value: string): void;
  end(body: string): void;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("web branding adapter", () => {
  it("uses config identity for HTML metadata and the emitted manifest", async () => {
    const root = await makeTempDir("threenative-web-brand-");
    roots.push(root);
    await mkdir(path.join(root, "public"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "brand-game", type: "module" }),
    );
    await writeFile(
      path.join(root, "public/icon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" />\n',
    );
    await writeFile(
      path.join(root, "threenative.config.ts"),
      `export default {
        app: { name: "Branded Quest", icons: { web: { favicon: "public/icon.svg" } } },
        bootSplash: { backgroundColor: "#123456" },
      };\n`,
    );
    const plugin = createWebBrandPlugin();
    await plugin.configResolved({ root });
    const html =
      plugin.transformIndexHtml(`<!doctype html><html><head><title>old</title><link rel="icon" href="data:," /><link rel="icon" href="/old.ico" /></head><body>
      <div data-threenative-launch><span data-threenative-launch-name>old</span></div>
    </body></html>`);
    expect(html).toContain("<title>Branded Quest</title>");
    expect(html).toContain('rel="icon" href="/icon.svg"');
    expect(html.match(/rel="icon"/gu)).toHaveLength(1);
    expect(html).not.toContain("/old.ico");
    expect(html).not.toContain("data:,");
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain("data-threenative-launch-name>Branded Quest");

    const emitted: Record<string, string> = {};
    plugin.generateBundle.call({
      emitFile: ({ fileName, source }: { fileName: string; source: string }) => {
        emitted[fileName] = source;
      },
    });
    expect(JSON.parse(emitted["manifest.webmanifest"] ?? "")).toMatchObject({
      background_color: "#123456",
      icons: [{ purpose: "any", src: "/icon.svg", type: "image/svg+xml" }],
      name: "Branded Quest",
      theme_color: "#123456",
    });
  });
  it("serves the linked manifest from the dev server, where no bundle is emitted", async () => {
    const root = await makeTempDir("threenative-web-brand-dev-");
    roots.push(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "dev-game", type: "module" }),
    );
    await writeFile(
      path.join(root, "threenative.config.ts"),
      'export default { app: { name: "Dev Quest" } };\n',
    );
    const plugin = createWebBrandPlugin();
    await plugin.configResolved({ root });
    let handler:
      | ((req: { url?: string }, res: IFakeResponse, next: () => void) => void)
      | undefined;
    plugin.configureServer({
      middlewares: {
        use: (use) => {
          handler = use;
        },
      },
    });
    const res: IFakeResponse = {
      body: "",
      headers: {},
      setHeader: (k, v) => {
        res.headers[k] = v;
      },
      end: (b) => {
        res.body = b;
      },
    };
    let passed = false;
    handler?.({ url: "/manifest.webmanifest" }, res, () => {
      passed = true;
    });
    // Without this route Vite answers the link with index.html and Chrome logs
    // "Manifest: Line: 1, column: 1, Syntax error." on every dev page load.
    expect(passed).toBe(false);
    expect(res.headers["Content-Type"]).toBe("application/manifest+json");
    expect(JSON.parse(res.body)).toMatchObject({ name: "Dev Quest" });
    handler?.({ url: "/index.html" }, res, () => {
      passed = true;
    });
    expect(passed).toBe(true);
  });
  it("serves the Wasm engine's pages cross-origin isolated, and a ?tnIsolation=0 page without (PRD-752)", async () => {
    const root = await makeTempDir("threenative-web-brand-isolation-");
    roots.push(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "isolated-game", type: "module" }),
    );
    const served = async (
      engine: string,
      hook: "configureServer" | "configurePreviewServer",
      url: string,
    ): Promise<Record<string, string>> => {
      await writeFile(
        path.join(root, "threenative.config.ts"),
        `export default { app: { name: "Isolated" }, engine: "${engine}" };\n`,
      );
      const plugin = createWebBrandPlugin();
      await plugin.configResolved({ root });
      const handlers: ((req: { url?: string }, res: IFakeResponse, next: () => void) => void)[] =
        [];
      plugin[hook]({ middlewares: { use: (use) => void handlers.push(use) } });
      const res: IFakeResponse = {
        body: "",
        headers: {},
        setHeader: (k, v) => {
          res.headers[k] = v;
        },
        end: (b) => {
          res.body = b;
        },
      };
      let next = true;
      for (const handler of handlers) {
        if (!next) break;
        next = false;
        handler({ url }, res, () => {
          next = true;
        });
      }
      return res.headers;
    };
    for (const hook of ["configureServer", "configurePreviewServer"] as const) {
      expect(await served("threenative", hook, "/")).toEqual({
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin",
      });
      expect(
        await served("threenative", hook, "/src/worker.ts?worker_file&type=module"),
      ).toMatchObject({
        "Cross-Origin-Opener-Policy": "same-origin",
      });
      expect(await served("threenative", hook, "/?tnIsolation=0")).toEqual({});
      expect(await served("threenative", hook, "/main.html?a=1&tnIsolation=0")).toEqual({});
      expect(await served("threejs", hook, "/")).toEqual({});
    }
    const plugin = createWebBrandPlugin();
    await plugin.configResolved({ root });
    const emitted: Record<string, string> = {};
    plugin.generateBundle.call({
      emitFile: ({ fileName, source }: { fileName: string; source: string }) => {
        emitted[fileName] = source;
      },
    });
    expect(emitted._headers).toBeUndefined();
    await writeFile(
      path.join(root, "threenative.config.ts"),
      'export default { app: { name: "Isolated" } };\n',
    );
    await plugin.configResolved({ root });
    plugin.generateBundle.call({
      emitFile: ({ fileName, source }: { fileName: string; source: string }) => {
        emitted[fileName] = source;
      },
    });
    expect(emitted._headers).toBe(
      "/*\n  Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Opener-Policy: same-origin\n" +
        "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n",
    );
  });
  it("leaves upstream three alone in a native bundle, whose host is not a browser (PRD-637)", async () => {
    const root = await makeTempDir("threenative-web-brand-native-");
    roots.push(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "native-bundle-game", type: "module" }),
    );
    await writeFile(
      path.join(root, "threenative.config.ts"),
      'export default { app: { name: "Native Bundle" }, engine: "threenative" };\n',
    );
    const routed = async (): Promise<string | null> => {
      const plugin = createWebBrandPlugin();
      await plugin.configResolved({ root });
      return plugin.resolveId("three");
    };
    // The browser build routes three to the Wasm engine, whose module awaits its Wasm at the top
    // level. A native bundle is one script inside a non-async function, so that await fails to
    // parse: `build:android` of a fresh starter died on it.
    expect(await routed()).toBe("\0threenative:web-engine");
    process.env.THREENATIVE_NATIVE_BUNDLE = "android";
    try {
      expect(await routed()).toBeNull();
    } finally {
      // biome-ignore lint/performance/noDelete: an unset variable is absent, not the string "undefined".
      delete process.env.THREENATIVE_NATIVE_BUNDLE;
    }
  });
  it("routes three to the Wasm engine inside a worker bundle too (PRD-752)", async () => {
    // Vite runs only `worker.plugins` on a worker bundle. Without the resolver there, a game booted
    // in a worker ran upstream three, which rejected the engine's skin weights as `unorm32x4`.
    const root = await makeTempDir("threenative-web-brand-worker-");
    roots.push(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "worker-game", type: "module" }),
    );
    await writeFile(
      path.join(root, "threenative.config.ts"),
      'export default { app: { name: "Worker Game" }, engine: "threenative" };\n',
    );
    const plugin = createWebBrandPlugin();
    const config = (await plugin.config({ root })) as {
      worker?: {
        format?: string;
        plugins?: () => { resolveId(source: string, importer?: string): unknown }[];
      };
    };
    await plugin.configResolved({ root });
    // ES output: the engine module awaits its Wasm at the top level.
    expect(config.worker?.format).toBe("es");
    const workerPlugins = config.worker?.plugins?.() ?? [];
    const routed = await Promise.all(workerPlugins.map((each) => each.resolveId("three")));
    expect(routed).toContain("\0threenative:web-engine");
  });
  it("keeps an authored favicon when config has no replacement", async () => {
    const root = await makeTempDir("threenative-web-brand-");
    roots.push(root);
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "compute-probe", type: "module" }),
    );
    const plugin = createWebBrandPlugin();
    await plugin.configResolved({ root });
    const html = plugin.transformIndexHtml(
      '<html><head><link rel="icon" href="data:," /></head><body></body></html>',
    );
    expect(html).toContain('<link rel="icon" href="data:," />');
    expect(html.match(/rel="icon"/gu)).toHaveLength(1);
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
  });

  it("writes the hashed entry script as the build id ctx.assets.memo keys on, and none in dev (PRD-860)", () => {
    const built = withBuildId(
      '<head>\n    <script type="module" crossorigin src="/assets/index-DsA_BRqT.js"></script>\n</head>',
    );
    expect(built).toContain(
      '<script>globalThis.__TN_BUILD_ID__ = "/assets/index-DsA_BRqT.js";</script>',
    );
    expect(built.indexOf("__TN_BUILD_ID__")).toBeLessThan(built.indexOf('type="module"'));
    const dev = '<script type="module" src="/src/main.ts"></script>';
    expect(withBuildId(dev)).toBe(dev);
  });

  it("starts the engine's Wasm with the page, then Rapier, instead of after the entry script ran (PRD-860)", () => {
    const html =
      '<head>\n    <script type="module" crossorigin src="/game/assets/index-A1.js"></script>\n</head>';
    const bundle = {
      "assets/index-A1.js": { fileName: "assets/index-A1.js", type: "chunk", moduleIds: [] },
      "assets/tn-native-engine-web-threads-T1.wasm": {
        fileName: "assets/tn-native-engine-web-threads-T1.wasm",
        type: "asset",
      },
      "assets/tn-native-engine-web-P1.wasm": {
        fileName: "assets/tn-native-engine-web-P1.wasm",
        type: "asset",
      },
      "assets/rapier-R1.js": {
        fileName: "assets/rapier-R1.js",
        type: "chunk",
        moduleIds: ["/n/node_modules/@dimforge/rapier3d-compat/rapier.es.js"],
      },
    };
    const threaded = withEnginePreload(html, bundle, true);
    // Isolated, the threads build; not isolated, nothing (the isolation worker may reload the page).
    expect(threaded).toContain('"/game/assets/tn-native-engine-web-threads-T1.wasm"');
    expect(threaded).not.toContain("web-P1.wasm");
    expect(threaded).toContain('"/game/assets/rapier-R1.js"');
    expect(threaded.indexOf("tn-native-engine-web-threads-T1")).toBeLessThan(
      threaded.indexOf('type="module"'),
    );
    // A repeat visit skips it: a preloaded response loses V8's compiled-code cache, and recompiling the
    // module cost a laptop's repeat visit ~150 ms. The script runs as the page would run it.
    const run = (isolated: boolean, stored: Record<string, string>) => {
      const links: { rel: string; href: string; onload?: () => void }[] = [];
      const source = /<script>([\s\S]*?)<\/script>/u.exec(threaded)?.[1] ?? "";
      new Function("document", "localStorage", "globalThis", source)(
        {
          createElement: () => ({}),
          head: {
            appendChild: (tag: (typeof links)[number]) => {
              links.push(tag);
              return tag;
            },
          },
        },
        {
          getItem: (key: string) => stored[key] ?? null,
          setItem: (key: string, value: string) => {
            stored[key] = value;
          },
        },
        { crossOriginIsolated: isolated },
      );
      return links;
    };
    const stored: Record<string, string> = {};
    const first = run(true, stored);
    expect(first.map((tag) => tag.rel)).toEqual(["preload"]);
    first[0]?.onload?.();
    expect(first.map((tag) => tag.rel)).toEqual(["preload", "modulepreload"]);
    expect(run(true, stored)).toEqual([]);
    expect(run(false, {})).toEqual([]);
    const plain = withEnginePreload(html, bundle, false);
    expect(plain).toContain('"/game/assets/tn-native-engine-web-P1.wasm"');
    expect(plain).not.toContain("threads-T1.wasm");
    // The dev server has no bundle, and a build without the engine has no Wasm to start.
    expect(withEnginePreload(html, undefined, true)).toBe(html);
    expect(
      withEnginePreload(html, { "assets/index-A1.js": bundle["assets/index-A1.js"] }, true),
    ).toBe(html);
  });
});
