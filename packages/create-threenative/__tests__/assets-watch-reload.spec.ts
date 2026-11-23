// A cook writes many files into `public/` (models, KTX2 images, the pending receipt), and Vite reloaded
// the page for each: 45 reloads in one second on the racing kit, each reload a new WebGPU device, until
// the GPU ran out of memory (VK_ERROR_OUT_OF_DEVICE_MEMORY). The kit's asset watch now drops every
// `public/` update and reloads the page once per settled cook. This runs the generated plugin in a real
// Vite dev server.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";
import { type Plugin, type ViteDevServer, createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { viteConfigText } from "../src/plumbing.js";

interface IWatchOptions {
  readonly onChange?: (summary: { compiled: string[]; failed: string[] }) => void;
}

/** The generated `assetsWatchPlugin`, compiled from the stamped text with its imports injected. */
async function generatedPlugin(watchAssets: (options: IWatchOptions) => unknown): Promise<Plugin> {
  const text = viteConfigText({ react: false, tailwind: false, workerEntry: false });
  const start = text.indexOf("function assetsWatchPlugin");
  const end = text.indexOf("\nexport default");
  const { code } = await transform(text.slice(start, end), { loader: "ts" });
  const factory = new Function(
    "watchAssets",
    "config",
    "webRuntimeDecoders",
    `${code}\nreturn assetsWatchPlugin();`,
  );
  return factory(watchAssets, { assets: {} }, () => ({})) as Plugin;
}

let server: ViteDevServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("the kit's asset watch under a cook", () => {
  it("reloads the page once per settled cook, never once per file written into public/", async () => {
    const root = await makeTempDir("tn-assets-reload-");
    await mkdir(path.join(root, "public"), { recursive: true });
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "index.html"),
      '<script type="module" src="/src/main.js"></script>',
    );
    // A module whose import failed to resolve is re-run by every file Vite sees created, so a cook's
    // every output reloaded the page. A game has one whenever an import names a file not written yet.
    await writeFile(path.join(root, "src/main.js"), 'import "./not-written-yet.js";\n');
    let onChange: IWatchOptions["onChange"];
    const plugin = await generatedPlugin((options) => {
      onChange = options.onChange;
      return { ready: Promise.resolve(), close: () => undefined };
    });
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [plugin],
      server: { port: 0, strictPort: false },
    });
    const reloads: unknown[] = [];
    const hot = server.environments.client.hot;
    const send = hot.send.bind(hot);
    hot.send = ((payload: { type?: string }) => {
      if (payload?.type === "full-reload") reloads.push(payload);
      send(payload as never);
    }) as typeof hot.send;
    await server.listen();
    await server.transformRequest("/src/main.js").catch(() => undefined);

    const seen = new Set<string>();
    server.watcher.on("add", (file: string) => seen.add(path.basename(file)));
    const outputs = [
      "track.glb",
      "track.ktx2",
      ".bake.pending-receipt.json",
      "assets.manifest.json",
    ];
    for (const name of outputs) await writeFile(path.join(root, "public", name), name);
    await expect.poll(() => seen.size, { timeout: 5000 }).toBe(outputs.length);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reloads).toEqual([]);

    // The cook settled: one reload for the whole burst, and none for a burst that published nothing.
    onChange?.({ compiled: [], failed: ["broken.png"] });
    expect(reloads).toEqual([]);
    onChange?.({ compiled: ["track.glb", "track.png"], failed: [] });
    expect(reloads).toEqual([{ type: "full-reload" }]);
  }, 20_000);
});
