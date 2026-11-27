import { readFile, rm } from "node:fs/promises";
import { type Server as HttpServer, createServer as createHttpServer } from "node:http";
import path from "node:path";
import { type ViteDevServer, createServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { createAssetLibraryPlugin } from "../src/asset-library/plugin.js";

const WEB_ENGINE_ID = "\0stand-in-web-engine";
const OAK_UUID = "11111111-1111-4111-8111-111111111111";
const COURTYARD_UUID = "22222222-2222-4222-8222-222222222222";
const OAK_BYTES = Buffer.from("glTF-fake-oak-glb");
const COURTYARD_BYTES = Buffer.from("glTF-fake-courtyard-glb");

interface IMockCf {
  readonly origin: string;
  readonly close: () => Promise<void>;
  catalogCalls: number;
  readonly glbCalls: string[];
  failCatalog: boolean;
}

async function startMockCloudflare(): Promise<IMockCf> {
  const state: {
    origin: string;
    close: () => Promise<void>;
    catalogCalls: number;
    glbCalls: string[];
    failCatalog: boolean;
  } = {
    origin: "",
    close: async () => undefined,
    catalogCalls: 0,
    glbCalls: [],
    failCatalog: false,
  };

  const httpServer: HttpServer = createHttpServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/api/assets/public/catalog.json") {
      state.catalogCalls += 1;
      if (state.failCatalog) {
        res.statusCode = 503;
        res.end("Service Unavailable");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          items: [
            {
              id: OAK_UUID,
              slug: "tree-oak",
              prompt: "Broadleaf Oak (Trees; procedural-environment tree)",
              tags: "tree,broadleaf",
              type: "model",
              origin: "procedural",
              license: "MIT",
              author: "threenative",
              byteSize: OAK_BYTES.byteLength,
            },
            {
              id: COURTYARD_UUID,
              slug: "dungeon-courtyard",
              prompt: "Dungeon Courtyard (Dungeon Kit; runtime scene)",
              tags: "dungeon,scene",
              type: "model",
              origin: "procedural",
              license: "MIT",
              author: "threenative",
              byteSize: COURTYARD_BYTES.byteLength,
            },
          ],
        }),
      );
      return;
    }

    if (pathname === `/api/assets/public/${OAK_UUID}`) {
      state.glbCalls.push(OAK_UUID);
      res.setHeader("content-type", "model/gltf-binary");
      res.end(OAK_BYTES);
      return;
    }

    if (pathname === `/api/assets/public/${COURTYARD_UUID}`) {
      state.glbCalls.push(COURTYARD_UUID);
      res.setHeader("content-type", "model/gltf-binary");
      res.end(COURTYARD_BYTES);
      return;
    }

    res.statusCode = 404;
    res.end("Not Found");
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === "string") throw new Error("mock Cloudflare server failed to bind");
  state.origin = `http://127.0.0.1:${addr.port}`;
  state.close = () =>
    new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  return state;
}

async function startAssetLibrary(
  root: string,
  cfOrigin: string,
): Promise<{
  server: ViteDevServer;
  base: string;
}> {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { port: 0, host: "127.0.0.1", watch: null },
    optimizeDeps: { noDiscovery: true },
    plugins: [
      {
        name: "stand-in-web-engine",
        enforce: "pre",
        resolveId: (source: string) => (source === "three" ? WEB_ENGINE_ID : null),
        load: (id: string) => (id === WEB_ENGINE_ID ? "export const engine = true;" : null),
      },
      createAssetLibraryPlugin({
        cloudflare: cfOrigin,
        procedural: false,
        vfx: false,
      }),
    ],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("dev server has no port");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

describe("asset library cloudflare source", () => {
  let root = "";
  let cf: IMockCf;
  let viteServer: ViteDevServer | undefined;
  let base = "";

  beforeAll(async () => {
    root = await makeTempDir("tn-cf-lib-");
    cf = await startMockCloudflare();
    const started = await startAssetLibrary(root, cf.origin);
    viteServer = started.server;
    base = started.base;
  }, 60_000);

  afterAll(async () => {
    await viteServer?.close();
    await cf?.close();
    // A `beforeAll` directory is outside any test, so `makeTempDir` only removes it at process exit,
    // which a Vitest worker may never reach: the suite's temp guard then counts it as a leak.
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("loads catalog.json lazily without downloading any GLB up front", async () => {
    const res = await fetch(`${base}/__assets/api/catalog`);
    expect(res.status).toBe(200);
    const catalog = (await res.json()) as {
      elements: { id: string; kind: string; category?: string; source?: string; name: string }[];
      kinds: Record<string, { lazy?: boolean; name: string }>;
    };

    expect(cf.catalogCalls).toBe(1);
    expect(cf.glbCalls).toEqual([]);
    expect(catalog.kinds.cloud?.lazy).toBe(true);

    const oak = catalog.elements.find((e) => e.id === "tree-oak");
    const courtyard = catalog.elements.find((e) => e.id === "dungeon-courtyard");
    expect(oak).toMatchObject({
      kind: "cloud",
      source: "cloudflare",
      category: "Trees",
      name: "Broadleaf Oak",
    });
    expect(courtyard).toMatchObject({
      kind: "cloud",
      source: "cloudflare",
      category: "Dungeon Kit",
      name: "Dungeon Courtyard",
    });
  });

  it("lazy-loads a selected GLB once and serves repeat requests from disk cache", async () => {
    const bakeRes = await fetch(`${base}/__assets/api/cloudflare/bake?kind=cloud&id=tree-oak`);
    expect(bakeRes.status).toBe(200);
    const bake = (await bakeRes.json()) as {
      url: string;
      save?: string;
      triangles: number;
    };
    expect(bake.url).toBe(`/__assets/api/cloudflare/file/${OAK_UUID}.glb`);
    expect(bake.save).toBe(`/__assets/api/cloudflare/save?id=${OAK_UUID}&slug=tree-oak`);
    expect(cf.glbCalls).toEqual([]);

    const first = await fetch(`${base}${bake.url}`);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("model/gltf-binary");
    expect(Buffer.from(await first.arrayBuffer())).toEqual(OAK_BYTES);
    expect(cf.glbCalls).toEqual([OAK_UUID]);

    const second = await fetch(`${base}${bake.url}`);
    expect(second.status).toBe(200);
    expect(Buffer.from(await second.arrayBuffer())).toEqual(OAK_BYTES);
    expect(cf.glbCalls).toEqual([OAK_UUID]);

    const saveRes = await fetch(`${base}${bake.save}`, { method: "POST" });
    expect(saveRes.status).toBe(200);
    const saved = (await saveRes.json()) as { written: string };
    expect(saved.written).toBe("assets/models/tree-oak.glb");
    expect(await readFile(path.join(root, saved.written))).toEqual(OAK_BYTES);
    expect(cf.glbCalls).toEqual([OAK_UUID]);
  });

  it("fails open to an empty Cloudflare list when the catalog origin is unreachable", async () => {
    const offlineRoot = await makeTempDir("tn-cf-offline-");
    const deadCf = await startMockCloudflare();
    deadCf.failCatalog = true;
    const { server, base: offlineBase } = await startAssetLibrary(offlineRoot, deadCf.origin);
    try {
      const res = await fetch(`${offlineBase}/__assets/api/catalog`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        elements: { source?: string }[];
        kinds: Record<string, unknown>;
      };
      expect(body.elements.filter((e) => e.source === "cloudflare")).toEqual([]);
      expect(body.kinds.cloud).toBeUndefined();
    } finally {
      await server.close();
      await deadCf.close();
    }
  }, 30_000);
});
