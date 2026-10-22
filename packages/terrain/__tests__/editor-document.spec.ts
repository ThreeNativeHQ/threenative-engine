import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request } from "node:http";
import { join } from "node:path";
import { Terrain } from "@threenative/terrain";
import { TerrainEditorController } from "@threenative/terrain/editor";
import { TerrainEditorDocument, terrainEditor } from "@threenative/terrain/editor/server";
import { type ViteDevServer, createServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeTempDirSync } from "../../../test-support/temp-dir.js";
const servers: ViteDevServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});
function fixture(): { root: string; path: string } {
  const root = makeTempDirSync("terrain-editor-");
  const path = join(root, "world.json");
  const terrain = new Terrain({ size: 512, resolution: 129, seed: 73 }).noise({
    id: "hills",
    amplitude: 16,
  });
  writeFileSync(path, JSON.stringify({ version: 1, recipe: terrain.toJSON() }));
  return { root, path };
}
async function api(viewerUrl?: string, onListen?: (server: ViteDevServer) => void) {
  const { root, path } = fixture();
  const editor = terrainEditor({ documentPath: path, ...(viewerUrl ? { viewerUrl } : {}) });
  // The project supplies its editor page; this fixture tests the real Vite middleware/route.
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
  onListen?.(server);
  const activation = await editor.activate();
  const base = `${activation.editorUrl}api/`;
  const get = async () => (await fetch(`${base}document`)).json();
  const post = (value: unknown, headers = {}) =>
    fetch(`${base}document`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(value),
    });
  return { root, path, server, editor, activation, base, get, post };
}

function status(
  url: string,
  headers: Record<string, string>,
  method = "GET",
  data = "",
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (response) => {
      response.resume();
      response.on("error", reject);
      response.on("end", () => {
        const code = response.statusCode ?? 0;
        if (req.closed) resolve(code);
        else {
          req.once("close", () => resolve(code));
          req.destroy();
        }
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

describe("project terrain editor document", () => {
  it("returns the actual ready port and reuses project/session identity", async () => {
    const context = await api();
    const address = context.server.httpServer?.address();
    expect(address && typeof address === "object" ? address.port : 0).toBeGreaterThan(0);
    expect(context.activation.editorUrl).toContain(
      `:${address && typeof address === "object" ? address.port : "missing"}/terrain-editor/`,
    );
    const again = await (await fetch(`${context.base}activate`)).json();
    expect(again).toEqual(context.activation);
    expect((await fetch(context.activation.editorUrl)).status).toBe(200);
  });
  it("rejects stale/invalid multi-command writes atomically and then recovers", async () => {
    const { path, get, post } = await api();
    const before = await get();
    const disk = readFileSync(path, "utf8");
    const failed = await post({
      baseRevision: before.revision,
      commands: [
        { op: "update", id: "hills", patch: { params: { amplitude: 8 } } },
        { op: "update", id: "missing", patch: { enabled: false } },
      ],
    });
    expect(failed.status).toBe(400);
    expect(readFileSync(path, "utf8")).toBe(disk);
    const success = await post({
      baseRevision: before.revision,
      commands: [{ op: "update", id: "hills", patch: { params: { amplitude: 8 } } }],
    });
    expect(success.status).toBe(200);
    const next = await success.json();
    expect(next.revision).not.toBe(before.revision);
    expect(
      (await post({ baseRevision: before.revision, commands: [{ op: "remove", id: "hills" }] }))
        .status,
    ).toBe(409);
    expect((await get()).revision).toBe(next.revision);
    expect(JSON.parse(readFileSync(path, "utf8")).recipe.layers[0].params.amplitude).toBe(8);
  });
  it("retains the last valid disk document, diagnoses invalid external saves and accepts recovery", () => {
    const { path } = fixture();
    const store = new TerrainEditorDocument(path);
    const before = store.snapshot();
    const events: string[] = [];
    store.subscribe((snapshot) => events.push(snapshot.revision));
    writeFileSync(path, "{broken");
    store.refresh();
    expect(store.snapshot().document).toEqual(before.document);
    expect(store.snapshot().diagnostic).toBeTruthy();
    expect(() =>
      store.commit({ baseRevision: before.revision, commands: [{ op: "remove", id: "hills" }] }),
    ).toThrow("Disk document is invalid");
    expect(readFileSync(path, "utf8")).toBe("{broken");
    const terrain = Terrain.fromJSON(before.document.recipe).noise({ id: "hills", amplitude: 12 });
    writeFileSync(path, JSON.stringify({ version: 1, recipe: terrain.toJSON() }));
    store.refresh();
    expect(store.snapshot().diagnostic).toBeNull();
    expect(store.snapshot().revision).not.toBe(before.revision);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(() =>
      store.commit({ baseRevision: before.revision, commands: [{ op: "remove", id: "hills" }] }),
    ).toThrow("Stale base revision");
  });
  it("blocks foreign host/origin, selected paths, malformed bodies and excessive sizes", async () => {
    const { path, base, get, post } = await api();
    const before = await get();
    const disk = readFileSync(path, "utf8");
    expect(
      (
        await post(
          { baseRevision: before.revision, commands: [{ op: "remove", id: "hills" }] },
          { origin: "https://attacker.invalid" },
        )
      ).status,
    ).toBe(403);
    expect(await status(`${base}document`, { host: "attacker.invalid" })).toBe(403);
    expect(
      (
        await post({
          baseRevision: before.revision,
          path: "/tmp/elsewhere",
          commands: [{ op: "remove", id: "hills" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}document`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{broken",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}document`, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      await status(
        `${base}document`,
        { "content-type": "application/json", "content-length": String(64 * 1024 * 1024 + 1) },
        "POST",
        "{}",
      ),
    ).toBe(413);
    expect(readFileSync(path, "utf8")).toBe(disk);
    expect(() => new TerrainEditorDocument("relative.json")).toThrow("absolute");
  });
  it.each(["cameras", "environment", "inspect", "reload", "restore"])(
    "rejects a 10 MiB %s body before parsing or changing the document",
    async (route) => {
      const { base, path } = await api();
      const disk = readFileSync(path, "utf8");
      const response = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{".repeat(10 * 1024 * 1024),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ code: 413, error: "Request exceeds 1 MiB" });
      expect(readFileSync(path, "utf8")).toBe(disk);
    },
  );
  it("bounds chunked small-route bodies without relying on content-length", async () => {
    const { base } = await api();
    expect(
      await status(
        `${base}inspect`,
        { "content-type": "application/json", "transfer-encoding": "chunked" },
        "POST",
        "{".repeat(10 * 1024 * 1024),
      ),
    ).toBe(413);
  });
  it("returns only a status code and compatible error message for rejected edits", async () => {
    const { post, get } = await api();
    const before = await get();
    const response = await post({ baseRevision: "stale", document: before.document });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 409, error: "Stale base revision" });
    expect(await get()).toEqual(before);
  });
  it("keeps the larger request allowance for documents and asset uploads", async () => {
    const { base } = await api();
    for (const route of ["document", "assets"]) {
      const response = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `${" ".repeat(10 * 1024 * 1024)}{broken`,
      });
      expect(response.status).toBe(400);
      const result = await response.json();
      expect(Object.keys(result).sort()).toEqual(["code", "error"]);
      expect(result.error).not.toContain("Request exceeds");
    }
  });
  it("streams accepted revisions and observes complete external file saves", async () => {
    const originalInterval = globalThis.setInterval;
    let heartbeat: (() => void) | undefined;
    const intervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 15000 && typeof callback === "function") heartbeat = () => callback(...args);
        return originalInterval(callback, delay, ...args);
      });
    const cancellation = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const { path, base, get, post } = await api();
      const before = await get();
      const stream = await fetch(`${base}events`, { signal: cancellation.signal });
      reader = stream.body?.getReader();
      if (!reader) throw new Error("Missing editor event stream");
      const eventReader = reader;
      const decoder = new TextDecoder();
      let buffered = "";
      let heartbeatSeen: (() => void) | undefined;
      const nextDocument = async (): Promise<string> => {
        const timeout = setTimeout(
          () => cancellation.abort(new Error("Editor event deadline")),
          5000,
        );
        try {
          for (;;) {
            const end = buffered.indexOf("\n\n");
            if (end < 0) {
              const chunk = await eventReader.read();
              if (chunk.done) throw new Error("Editor event stream ended before a document");
              buffered += decoder.decode(chunk.value, { stream: true });
              continue;
            }
            const frame = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            const fields = frame.split("\n").filter((line) => line !== "" && !line.startsWith(":"));
            if (fields.length === 0) {
              if (frame === ": keepalive") heartbeatSeen?.();
              continue;
            }
            expect(fields).toHaveLength(1);
            const data = fields[0];
            if (!data?.startsWith("data: ")) throw new Error("Expected editor document data event");
            const snapshot = JSON.parse(data.slice(6));
            expect(snapshot.document).toBeTruthy();
            expect(snapshot.revision).toBeTypeOf("string");
            return JSON.stringify(snapshot);
          }
        } finally {
          clearTimeout(timeout);
        }
      };
      const initial = await nextDocument();
      expect(initial).toContain(before.revision);
      const edit = await post({
        baseRevision: before.revision,
        commands: [{ op: "update", id: "hills", patch: { params: { amplitude: 7 } } }],
      });
      const next = await edit.json();
      expect(await nextDocument()).toContain(next.revision);
      expect(heartbeat).toBeTypeOf("function");
      const sawHeartbeat = new Promise<void>((resolve) => {
        heartbeatSeen = resolve;
      });
      const changed = nextDocument();
      heartbeat?.();
      await Promise.race([
        sawHeartbeat,
        changed.then(() => {
          throw new Error("Document preceded heartbeat");
        }),
      ]);
      intervalSpy.mockRestore();
      const externalSave = `${path}.external.tmp`;
      writeFileSync(
        externalSave,
        JSON.stringify({
          ...next.document,
          recipe: Terrain.fromJSON(next.document.recipe)
            .noise({ id: "hills", amplitude: 13 })
            .toJSON(),
        }),
      );
      renameSync(externalSave, path);
      expect(await changed).toContain('"amplitude":13');
    } finally {
      intervalSpy.mockRestore();
      cancellation.abort();
      await reader?.cancel().catch(() => {});
    }
  });
  it("refreshes only the configured document for raw watcher path forms", async () => {
    const { path, root, server } = await api();
    const refresh = vi.spyOn(TerrainEditorDocument.prototype, "refresh");
    try {
      server.watcher.emit("raw", "change", path, {});
      server.watcher.emit("raw", "rename", "world.json", { watchedPath: root });
      server.watcher.emit("raw", "change", "world.json", { watchedPath: path });
      expect(refresh).toHaveBeenCalledTimes(3);
      server.watcher.emit("raw", "change", join(root, "other.json"), {});
      server.watcher.emit("raw", "rename", "other.json", { watchedPath: root });
      server.watcher.emit("raw", "change", "world.json", { watchedPath: 1 });
      server.watcher.emit("raw", "change", "world.json");
      expect(() => {
        server.watcher.emit("raw", "change");
        server.watcher.emit("raw", "change", undefined, { watchedPath: path });
        server.watcher.emit("raw", "change", 1, { watchedPath: path });
        server.watcher.emit("raw", "change", null, { watchedPath: path });
      }).not.toThrow();
      expect(refresh).toHaveBeenCalledTimes(3);
      await server.close();
      server.watcher.emit("raw", "change", path, {});
      expect(refresh).toHaveBeenCalledTimes(3);
    } finally {
      refresh.mockRestore();
    }
  });

  it("starts the dev server on a malformed world.json, reports diagnostic and recovers via reload after file is fixed", async () => {
    const { root, path } = fixture();
    writeFileSync(path, "{broken json");
    const editor = terrainEditor({ documentPath: path });
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [editor],
    });
    servers.push(server);
    await server.listen();
    const address = server.httpServer?.address();
    const controller = new TerrainEditorController(
      `http://127.0.0.1:${(address as { port: number }).port}/terrain-editor/`,
    );

    // Dev server started on malformed file in read-only diagnostic state
    const initialSnapshot = await controller.snapshot();
    expect(initialSnapshot.diagnostic).toBeTruthy();

    // Commit is rejected with 409 while document on disk is invalid
    await expect(
      controller.commit({
        baseRevision: initialSnapshot.revision,
        commands: [{ op: "remove", id: "hills" }],
      }),
    ).rejects.toThrow("Disk document is invalid");

    // Fix file on disk
    const valid = {
      version: 1,
      recipe: new Terrain({ size: 512, resolution: 257, seed: 42 }).toJSON(),
    };
    writeFileSync(path, JSON.stringify(valid, null, 2));

    // Reload from disk recovers
    const reloaded = await controller.reload();
    expect(reloaded.diagnostic).toBeNull();
    expect(reloaded.document.recipe.config.seed).toBe(42);

    // Overwrite with last valid state restores disk if corrupted again
    writeFileSync(path, "corrupted again");
    const restored = await controller.restoreLastValid();
    expect(restored.diagnostic).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8")).recipe.config.seed).toBe(42);
  });

  it("rejects restore when the document never held a valid state and keeps the original", () => {
    const { path } = fixture();
    writeFileSync(path, "{broken since the very first read");
    const store = new TerrainEditorDocument(path);
    expect(store.snapshot().diagnostic).toBeTruthy();
    expect(() => store.restoreLastValid()).toThrow("No valid save to restore");
    expect(readFileSync(path, "utf8")).toBe("{broken since the very first read");
  });

  it("uses an explicitly configured private forward and rejects a failed forward", async () => {
    let target: string | undefined;
    const proxy = createHttpServer((incoming, response) => {
      if (!target) {
        response.writeHead(503);
        response.end("Forward unavailable");
        return;
      }
      const upstream = request(
        new URL(incoming.url ?? "/", target),
        { method: incoming.method, headers: incoming.headers },
        (reply) => {
          response.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.writeHead(502);
        response.end();
      });
      incoming.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("Private forward is not bound");
      const viewerUrl = `http://127.0.0.1:${address.port}/terrain-editor/`;
      const context = await api(viewerUrl, (server) => {
        const bound = server.httpServer?.address();
        if (!bound || typeof bound === "string") throw new Error("Vite is not bound");
        target = `http://127.0.0.1:${bound.port}`;
      });
      expect(context.activation.editorUrl).toBe(viewerUrl);
      const current = await context.get();
      const transaction = JSON.stringify({
        baseRevision: current.revision,
        commands: [{ op: "update", id: "hills", patch: { params: { amplitude: 5 } } }],
      });
      expect(
        await status(
          `${viewerUrl}api/document`,
          { origin: new URL(viewerUrl).origin, "content-type": "application/json" },
          "POST",
          transaction,
        ),
      ).toBe(200);
      expect(await status(`${viewerUrl}api/document`, { origin: "https://attacker.invalid" })).toBe(
        403,
      );
      target = undefined;
      await expect(context.editor.activate()).rejects.toThrow("not ready");
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("does not advertise an editor URL before listening or without a ready project page", async () => {
    const { root, path } = fixture();
    const editor = terrainEditor({ documentPath: path });
    await expect(editor.activate()).rejects.toThrow("not listening");
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
      plugins: [editor],
    });
    servers.push(server);
    await server.listen();
    await expect(editor.activate()).rejects.toThrow("not ready");
  });
  it("rejects stale and malformed export requests before resolving the project cook", async () => {
    const { base, get } = await api();
    const snapshot = await get();
    const send = (value: unknown) =>
      fetch(`${base}export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    const stale = await send({ baseRevision: "stale", preparedWorld: {} });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ code: 409, error: "Stale export revision" });
    const malformed = await send({ baseRevision: snapshot.revision, preparedWorld: [] });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      code: 400,
      error: "Expected preparedWorld glTF JSON",
    });
    const missing = await send({ baseRevision: snapshot.revision, preparedWorld: {} });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("@threenative/assets");
  });
});
