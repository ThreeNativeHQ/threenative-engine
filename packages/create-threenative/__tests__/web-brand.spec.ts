import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { createWebBrandPlugin } from "../src/web-brand.js";

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

    let emitted = "";
    plugin.generateBundle.call({
      emitFile: ({ source }: { source: string }) => {
        emitted = source;
      },
    });
    expect(JSON.parse(emitted)).toMatchObject({
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
});
