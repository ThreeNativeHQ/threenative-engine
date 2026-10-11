import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Terrain } from "@threenative/terrain";
import {
  SURFACE_CHANNELS,
  TerrainEditorController,
  surfaceSpace,
} from "@threenative/terrain/editor";
import { TerrainEditorDocument, terrainEditor } from "@threenative/terrain/editor/server";
import { type ViteDevServer, createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { buildGlb } from "./fixtures/glb.mjs";
import {
  buildPng,
  jpegHeader,
  openExr,
  radianceHdr,
  solidPng,
  webpLossless,
} from "./fixtures/png.mjs";

const servers: ViteDevServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function api(assetLimits?: { maxBytes?: number }) {
  const root = makeTempDirSync("terrain-assets-");
  const path = join(root, "world.json");
  const recipe = new Terrain({ size: 256, resolution: 65, seed: 73 })
    .noise({ id: "hills", amplitude: 12 })
    .toJSON();
  writeFileSync(path, JSON.stringify({ version: 1, recipe }));
  const editor = terrainEditor({
    documentPath: path,
    assetsDir: join(root, "assets"),
    assetLimits,
  });
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      editor,
      {
        name: "test-editor-page",
        configureServer(vite: ViteDevServer) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== "/terrain-editor/") return next();
            res.setHeader("content-type", "text/html");
            res.end("<html data-terrain-editor>Project editor</html>");
          });
        },
      },
    ],
  });
  servers.push(server);
  await server.listen();
  const controller = new TerrainEditorController((await editor.activate()).editorUrl);
  const operate = async (operation: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(new URL("assets", controller.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ baseRevision: (await controller.snapshot()).revision, operation }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { root, path, controller, operate, files: () => storedFiles(join(root, "assets")) };
}

function storedFiles(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
    : [];
}

describe("editor model assets", () => {
  it("registers a local file and an upload to the same stored, measured entry", async () => {
    const { root, path, controller, operate, files } = await api();
    const bytes = buildGlb();
    const source = join(root, "download.glb");
    writeFileSync(source, bytes);
    const before = await controller.snapshot();

    // The agent path: a local file, with the provenance an asset-MCP result carries.
    const local = await operate({
      op: "register",
      id: "feet-tree",
      path: source,
      license: "CC0-1.0",
      source: "fixture://strata",
    });
    expect(local.status).toBe(200);
    const entry = local.body.asset;
    expect(entry).toMatchObject({
      id: "feet-tree",
      kind: "model",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      triangles: 24,
      license: "CC0-1.0",
      adjust: { scale: 1, pivot: "base" },
    });
    // Measured through the node hierarchy: the scaled trunk and crown, not the unit cube.
    expect(entry.bounds.min).toEqual([-0.6, 0, -0.6]);
    expect(entry.bounds.max[1]).toBeCloseTo(2.4);
    expect(entry.diagnostics.join(" ")).toMatch(/camera.*inactive|inactive.*camera/u);
    expect(entry.diagnostics.join(" ")).toMatch(/light/u);
    expect(entry.path).toMatch(/^models\/[a-f0-9]{12}-feet-tree\.glb$/u);
    expect(files()).toEqual([entry.path.split("/")[1]]);

    // The file is served from a hash-addressed URL, byte for byte.
    const served = await fetch(new URL(`assets/${entry.path}`, controller.baseUrl));
    expect(Buffer.from(await served.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(served.headers.get("cache-control")).toMatch(/immutable/u);

    // The GUI path: the same bytes, base64, land on the same entry and change nothing.
    const upload = await operate({
      op: "upload",
      id: "feet-tree",
      name: "download.glb",
      data: Buffer.from(bytes).toString("base64"),
    });
    expect(upload.status).toBe(200);
    expect(upload.body.revision).toBe(local.body.revision);
    expect(files()).toHaveLength(1);

    // Both survive a reload from disk, and the recipe never moved.
    const reloaded = new TerrainEditorDocument(path).snapshot();
    expect(reloaded.document.assets).toEqual([entry]);
    expect(reloaded.document.recipe).toEqual(before.document.recipe);
  });

  it("refuses a conflicting name, replaces on request, adjusts, and removes without erasing", async () => {
    const { root, controller, operate, files } = await api();
    const first = join(root, "a.glb");
    const second = join(root, "b.glb");
    writeFileSync(first, buildGlb());
    writeFileSync(second, buildGlb({ unit: 3.28084 }));
    await operate({ op: "register", id: "tree", path: first });
    const start = (await controller.snapshot()).revision;

    const conflict = await operate({ op: "register", id: "tree", path: second });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatch(/already exists.*replace: true/u);
    expect((await controller.snapshot()).revision).toBe(start);
    expect(files()).toHaveLength(2); // the refused file was written but is not an entry: harmless, hash-named

    const replaced = await operate({ op: "register", id: "tree", path: second, replace: true });
    expect(replaced.body.asset.bounds.max[1]).toBeCloseTo(2.4 * 3.28084, 4);
    // Source units: feet to metres is a placement adjustment, never an edit of the file.
    const adjusted = await operate({
      op: "adjust",
      id: "tree",
      adjust: { scale: 1 / 3.28084, pivot: "base" },
    });
    expect(adjusted.body.asset.adjust.scale).toBeCloseTo(0.3048, 4);
    expect(
      (await operate({ op: "adjust", id: "tree", adjust: { scale: -1, pivot: "base" } })).status,
    ).toBe(400);
    expect(
      (await operate({ op: "adjust", id: "tree", adjust: { scale: 1, pivot: "middle" } })).status,
    ).toBe(400);

    const filesBefore = files();
    const removed = await operate({ op: "remove", id: "tree" });
    expect(removed.body.assets).toEqual([]);
    expect(files()).toEqual(filesBefore); // the palette entry goes, the art stays
    expect((await controller.snapshot()).document.assets).toEqual([]);
    expect((await operate({ op: "remove", id: "tree" })).status).toBe(404);
  });

  it("reports an invalid or unsupported file by name and keeps the valid art", async () => {
    const { root, controller, operate, files } = await api({ maxBytes: 4096 });
    const good = join(root, "good.glb");
    writeFileSync(good, buildGlb());
    await operate({ op: "register", id: "good", path: good });
    const valid = await controller.snapshot();
    const stored = files();
    const attempt = async (name: string, bytes: Uint8Array) => {
      const file = join(root, name);
      writeFileSync(file, bytes);
      return operate({ op: "register", id: "bad", path: file });
    };

    const garbage = await attempt(
      "garbage.glb",
      new TextEncoder().encode("not a model at all, really"),
    );
    expect(garbage.status).toBe(400);
    expect(garbage.body.error).toMatch(/not a supported/u);
    const truncated = await attempt("short.glb", buildGlb().subarray(0, 60));
    expect(truncated.status).toBe(400);
    const external = await attempt("external.glb", buildGlb({ external: true }));
    expect(external.body.error).toMatch(/external buffer 'missing-textures\.bin'/u);
    const nan = await attempt("nan.glb", buildGlb({ nan: true }));
    expect(nan.body.error).toMatch(/non-finite vertex/u);
    const huge = await attempt("huge.glb", new Uint8Array(5000).fill(1));
    expect(huge.body.error).toMatch(/limit is 4096/u);

    // Escapes: a relative path, a link, and a page (an Origin header) asking to read a path.
    expect((await operate({ op: "register", id: "bad", path: "../etc/passwd" })).status).toBe(400);
    const link = join(root, "link.glb");
    symlinkSync(good, link);
    expect((await operate({ op: "register", id: "bad", path: link })).body.error).toMatch(
      /regular file/u,
    );
    const fromPage = await operate(
      { op: "register", id: "bad", path: good },
      { origin: new URL(controller.baseUrl).origin },
    );
    expect(fromPage.status).toBe(403);
    // A caller cannot walk the served files either.
    const walk = await fetch(new URL("assets/..%2F..%2Fworld.json", controller.baseUrl));
    expect(walk.status).toBe(404);

    expect((await controller.snapshot()).document).toEqual(valid.document);
    expect(files()).toEqual(stored);
    expect(readFileSync(good).length).toBeGreaterThan(0);
  });
});

describe("editor image assets and surface mappings", () => {
  it("measures every supported image format from its own bytes", async () => {
    const { root, operate } = await api();
    const register = async (id: string, name: string, bytes: Uint8Array) => {
      const file = join(root, name);
      writeFileSync(file, bytes);
      return operate({ op: "register", id, path: file });
    };
    const png = await register("albedo", "a.png", solidPng(16, 8, [200, 30, 30, 255]));
    expect(png.body.asset).toMatchObject({ kind: "image", format: "png", width: 16, height: 8 });
    expect(png.body.asset.path).toMatch(/^images\/[a-f0-9]{12}-albedo\.png$/u);
    expect(png.body.asset.diagnostics).toBeUndefined();
    const jpeg = await register("photo", "p.jpg", jpegHeader(640, 480));
    expect(jpeg.body.asset).toMatchObject({ format: "jpeg", width: 640, height: 480 });
    const webp = await register("sheet", "s.webp", webpLossless(256, 128));
    expect(webp.body.asset).toMatchObject({ format: "webp", width: 256, height: 128 });
    const hdr = await register("sky", "s.hdr", radianceHdr(64, 32));
    expect(hdr.body.asset).toMatchObject({
      kind: "environment",
      format: "hdr",
      width: 64,
      height: 32,
    });
    const exr = await register("sky-exr", "s.exr", openExr(128, 64));
    expect(exr.body.asset).toMatchObject({
      kind: "environment",
      format: "exr",
      width: 128,
      height: 64,
    });
    // A size that block compression would reject is reported while the file is still in hand.
    const odd = await register("odd", "o.png", solidPng(10, 6, [1, 2, 3, 255]));
    expect(odd.body.asset.diagnostics.join(" ")).toMatch(/multiple of 4/u);
  });

  it("refuses a damaged, truncated, oversize or unsupported image by name", async () => {
    const { root, controller, operate } = await api({ maxBytes: 1 << 20 });
    const before = (await controller.snapshot()).revision;
    const attempt = async (name: string, bytes: Uint8Array) => {
      const file = join(root, name);
      writeFileSync(file, bytes);
      return operate({ op: "register", id: "bad", path: file });
    };
    const good = solidPng(8, 8, [10, 20, 30, 255]);
    const flipped = good.slice();
    flipped[good.length - 20] = (flipped[good.length - 20] ?? 0) ^ 0xff; // inside IDAT: the checksum no longer matches
    expect((await attempt("flipped.png", flipped)).body.error).toMatch(
      /IDAT chunk fails its checksum/u,
    );
    expect((await attempt("cut.png", good.slice(0, good.length - 30))).status).toBe(400);
    expect((await attempt("no-end.png", good.slice(0, good.length - 12))).body.error).toMatch(
      /end marker/u,
    );
    expect((await attempt("cut.jpg", jpegHeader(8, 8).slice(0, 9))).status).toBe(400);
    expect((await attempt("big.png", solidPng(8, 8, [0, 0, 0, 255]).slice(0, 8))).status).toBe(400);
    expect(
      (await attempt("text.png", new TextEncoder().encode("GIF89a not supported"))).body.error,
    ).toMatch(/not a supported/u);
    // The limit is the project's: a 20000-pixel header is refused with the limit named.
    const wide = new Uint8Array(jpegHeader(20000, 10));
    expect((await attempt("wide.jpg", wide)).body.error).toMatch(/limit is 16384 pixels/u);
    expect((await controller.snapshot()).revision).toBe(before);
  });

  it("maps images to named surface inputs with the right colour space and survives replacement", async () => {
    const { root, path, controller, operate, files } = await api();
    const register = async (id: string, bytes: Uint8Array, extra: object = {}) => {
      const file = join(root, `${id}.png`);
      writeFileSync(file, bytes);
      return operate({ op: "register", id, path: file, ...extra });
    };
    await register("bark-colour", solidPng(8, 8, [200, 30, 30, 255]));
    await register("bark-normal", solidPng(8, 8, [128, 128, 255, 255]));
    expect(surfaceSpace("bark.albedo")).toBe("srgb");
    for (const channel of ["normal", "roughness", "ao", "height", "opacity", "metalness"])
      expect(surfaceSpace(`bark.${channel}`), channel).toBe("linear");
    expect(Object.keys(SURFACE_CHANNELS)).toHaveLength(7);

    const colour = await operate({ op: "map", input: "bark.albedo", asset: "bark-colour" });
    expect(colour.status).toBe(200);
    const normal = await operate({ op: "map", input: "bark.normal", asset: "bark-normal" });
    expect(normal.body.surfaces).toEqual({
      "bark.albedo": { asset: "bark-colour" },
      "bark.normal": { asset: "bark-normal" },
    });
    expect(new TerrainEditorDocument(path).snapshot().document.surfaces).toEqual(
      normal.body.surfaces,
    );

    // Refusals: an input that is not <surface>.<channel>, an unknown image, a model as a surface.
    const start = (await controller.snapshot()).revision;
    for (const operation of [
      { op: "map", input: "bark.shine", asset: "bark-colour" },
      { op: "map", input: "bark", asset: "bark-colour" },
      { op: "map", input: "Bark.albedo", asset: "bark-colour" },
    ])
      expect((await operate(operation)).status, JSON.stringify(operation)).toBe(400);
    expect((await operate({ op: "map", input: "bark.albedo", asset: "missing" })).status).toBe(404);
    const model = join(root, "m.glb");
    writeFileSync(model, buildGlb());
    await operate({ op: "register", id: "a-model", path: model });
    const modelStart = (await controller.snapshot()).revision;
    expect((await operate({ op: "map", input: "bark.albedo", asset: "a-model" })).status).toBe(404);
    expect((await controller.snapshot()).revision).toBe(modelStart);
    expect(modelStart).not.toBe(start);

    // Replacing the art keeps the mapping and changes the hash-named file, so nothing stale is served.
    const oldPath = normal.body.assets.find((a: { id: string }) => a.id === "bark-normal").path;
    const swapped = await register("bark-normal", solidPng(8, 8, [255, 128, 128, 255]), {
      replace: true,
    });
    expect(swapped.body.asset.path).not.toBe(oldPath);
    expect(swapped.body.surfaces["bark.normal"]).toEqual({ asset: "bark-normal" });
    expect(files()).toContain(oldPath.split("/")[1]);
    expect((await register("bark-normal", solidPng(8, 8, [1, 1, 1, 255]))).status).toBe(409);

    // A mapped image cannot be removed from under its surface; unmap first, then the file stays.
    const refused = await operate({ op: "remove", id: "bark-colour" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/mapped to bark\.albedo; unmap it first/u);
    await operate({ op: "unmap", input: "bark.albedo" });
    expect((await operate({ op: "unmap", input: "bark.albedo" })).status).toBe(404);
    const removed = await operate({ op: "remove", id: "bark-colour" });
    expect(removed.status).toBe(200);
    expect(removed.body.surfaces).toEqual({ "bark.normal": { asset: "bark-normal" } });
  });
});
