import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { Plugin } from "vite";
import { validatePlacementOverrides } from "../core/placements.js";
import { type PatchCommand, Terrain, TerrainEvaluator } from "../core/terrain.js";
import type { ITerrainDocument } from "../core/types.js";
import type { IPlacementOverride } from "../core/types.js";
import { AssetStore } from "./assetStore.js";
import {
  type IAssetLimits,
  type IAssetOperation,
  type IAssetResult,
  type IProjectAsset,
  type ISurfaceMappings,
  surfaceSpace,
  validateAsset,
  validateAssets,
  validateSurfaces,
} from "./assets.js";
import {
  type ICameraResult,
  type ISavedCamera,
  runCameraOperation,
  validateCameras,
} from "./cameras.js";
import {
  type IEnvironment,
  type IEnvironmentResult,
  checkEnvironmentAssets,
  runEnvironmentOperation,
  validateEnvironment,
} from "./environment.js";
import {
  type ISpatialObservation,
  type ISpatialQuery,
  inspectSpatial,
  validateSpatialReference,
} from "./spatialInspector.js";

const PREFIX = "/terrain-editor/";
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_REFERENCES = 16;

export interface IAuthoringDocument {
  version: 1;
  recipe: ITerrainDocument;
  placementOverrides?: Record<string, IPlacementOverride>;
  /** Saved reference registrations. Authoring metadata: never evaluated, never exported. */
  references?: ReturnType<typeof validateSpatialReference>[];
  /** Saved editor observation cameras. Authoring metadata: never evaluated, never exported. */
  cameras?: ISavedCamera[];
  /** Which saved camera is live; absent or `null` is the ordinary editor camera. */
  activeCamera?: string | null;
  /** Preview environment overrides; absent fields keep the project's own render-source values. */
  environment?: IEnvironment;
  /** Registered models, images and environment files: metadata only, the files live on disk. */
  assets?: IProjectAsset[];
  /** Imported images that replace named surface inputs of the project's render source. */
  surfaces?: ISurfaceMappings;
}
export interface IEditorSnapshot {
  revision: string;
  document: IAuthoringDocument;
  diagnostic: string | null;
}
export interface IEditorActivation {
  editorUrl: string;
  projectId: string;
  sessionId: string;
  revision: string;
}

function validate(value: unknown): IAuthoringDocument {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an authoring document");
  const input = value as Record<string, unknown>;
  if (
    input.version !== 1 ||
    Object.keys(input).some(
      (key) =>
        ![
          "version",
          "recipe",
          "placementOverrides",
          "references",
          "cameras",
          "activeCamera",
          "environment",
          "assets",
          "surfaces",
        ].includes(key),
    )
  )
    throw new Error("Unsupported authoring document fields/version");
  const recipe = Terrain.fromJSON(input.recipe as ITerrainDocument).toJSON();
  const document: IAuthoringDocument = { version: 1, recipe };
  if (input.placementOverrides !== undefined)
    document.placementOverrides = validatePlacementOverrides(input.placementOverrides);
  if (input.references !== undefined) {
    if (!Array.isArray(input.references) || input.references.length > MAX_REFERENCES)
      throw new Error(`A document holds at most ${MAX_REFERENCES} saved references`);
    document.references = input.references.map((entry) => validateSpatialReference(entry));
  }
  if (input.cameras !== undefined) document.cameras = validateCameras(input.cameras);
  if (input.activeCamera !== undefined) {
    // An active camera that no longer exists is not a stale document: it falls back to the editor camera.
    const active = input.activeCamera;
    if (active !== null) {
      if (
        typeof active !== "string" ||
        !(document.cameras ?? []).some((entry) => entry.id === active)
      )
        throw new Error("activeCamera must name a saved camera");
    }
    document.activeCamera = active;
  }
  if (input.assets !== undefined) document.assets = validateAssets(input.assets);
  if (input.surfaces !== undefined)
    document.surfaces = validateSurfaces(input.surfaces, document.assets ?? []);
  if (input.environment !== undefined) {
    document.environment = validateEnvironment(input.environment);
    checkEnvironmentAssets(document.environment, document.assets ?? []);
  }
  if (Buffer.byteLength(JSON.stringify(document)) > MAX_BYTES)
    throw new Error("Authoring document exceeds 64 MiB");
  return document;
}
function revision(document: IAuthoringDocument): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex");
}
class EditorError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Project-local terrain document authority; no renderer or game dependency.
 * @requires npm i -D @threenative/terrain
 * @situation validate atomic revision-based project-local terrain document edits
 * @constraint Node authoring only; documentPath is a configured absolute regular file; input is bounded to 64 MiB
 * @example const document = new TerrainEditorDocument("/project/terrain/world.json"); const snapshot = document.snapshot();
 * @override the project chooses its document path; revisions come from validated content
 */
export class TerrainEditorDocument {
  readonly path: string;
  #snapshot: IEditorSnapshot;
  #listeners = new Set<(snapshot: IEditorSnapshot) => void>();
  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error("Document path must be absolute");
    this.path = resolve(path);
    const document = this.#read();
    this.#snapshot = { document, revision: revision(document), diagnostic: null };
  }
  #read(): IAuthoringDocument {
    const info = lstatSync(this.path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES)
      throw new Error("Document must be a regular file of at most 64 MiB");
    return validate(JSON.parse(readFileSync(this.path, "utf8")));
  }
  snapshot(): IEditorSnapshot {
    return structuredClone(this.#snapshot);
  }
  subscribe(listener: (snapshot: IEditorSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #emit(): void {
    for (const listener of this.#listeners) listener(this.snapshot());
  }
  refresh(): void {
    try {
      const document = this.#read();
      const nextRevision = revision(document);
      if (nextRevision === this.#snapshot.revision && this.#snapshot.diagnostic === null) return;
      this.#snapshot = { document, revision: nextRevision, diagnostic: null };
    } catch (error) {
      this.#snapshot.diagnostic = error instanceof Error ? error.message : String(error);
    }
    this.#emit();
  }
  commit(input: unknown): IEditorSnapshot {
    this.refresh();
    if (this.#snapshot.diagnostic)
      throw new EditorError(409, "Disk document is invalid; restore a valid save before editing");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Expected a transaction");
    const request = input as Record<string, unknown>;
    if (Object.keys(request).some((key) => !["baseRevision", "commands", "document"].includes(key)))
      throw new Error("Unknown transaction fields");
    if (request.baseRevision !== this.#snapshot.revision)
      throw new EditorError(409, "Stale base revision");
    if ((request.commands === undefined) === (request.document === undefined))
      throw new Error("Supply commands or document, exclusively");
    let next: IAuthoringDocument;
    if (request.commands !== undefined) {
      if (
        !Array.isArray(request.commands) ||
        !request.commands.length ||
        request.commands.length > 512
      )
        throw new Error("Expected 1–512 patch commands");
      const terrain = Terrain.fromJSON(this.#snapshot.document.recipe);
      terrain.applyPatch(request.commands as PatchCommand[]);
      next = validate({ ...this.#snapshot.document, recipe: terrain.toJSON() });
    } else next = validate(request.document);
    const nextRevision = revision(next);
    if (nextRevision === this.#snapshot.revision) return this.snapshot();
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    // ponytail: synchronous local transactions serialize HTTP edits; external editors must save atomically.
    // The revision check detects completed external saves, not a non-cooperating writer racing rename.
    try {
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT")
          throw new AggregateError(
            [error, cleanupError],
            "Document save and temporary-file cleanup failed",
          );
      }
      throw error;
    }
    this.#snapshot = { document: next, revision: nextRevision, diagnostic: null };
    this.#emit();
    return this.snapshot();
  }
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new EditorError(415, "Expected application/json");
  if (Number(request.headers["content-length"]) > MAX_BYTES)
    throw new EditorError(413, "Request exceeds 64 MiB");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BYTES) throw new EditorError(413, "Request exceeds 64 MiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

/**
 * Mount the optional terrain document API on an existing loopback Vite server.
 * @requires npm i -D @threenative/terrain vite
 * @situation share terrain recipe edits between an agent and the live terrain editor
 * @constraint dev tooling only; serve a project-owned /terrain-editor/index.html; no runtime import
 * @example const editor = terrainEditor({ documentPath: resolve("terrain/world.json") });
 * @override documentPath and optional configured viewerUrl belong to the project
 */
export function terrainEditor(options: {
  documentPath: string;
  viewerUrl?: string;
  /** Where registered files are stored; defaults to `assets/` beside the document. */
  assetsDir?: string;
  /** Explicit byte, decoded-dimension and triangle limits for imports. */
  assetLimits?: Partial<IAssetLimits>;
}): Plugin & {
  activate(): Promise<IEditorActivation>;
} {
  const viewer = options.viewerUrl ? new URL(options.viewerUrl) : undefined;
  if (
    viewer &&
    (!["http:", "https:"].includes(viewer.protocol) ||
      viewer.username ||
      viewer.password ||
      viewer.search ||
      viewer.hash ||
      !viewer.pathname.endsWith(PREFIX))
  )
    throw new Error("Viewer URL must be an explicit HTTP(S) forwarded terrain-editor URL");
  const document = new TerrainEditorDocument(options.documentPath);
  const evaluator = new TerrainEvaluator();
  const store = new AssetStore(
    options.assetsDir ?? resolve(dirname(document.path), "assets"),
    options.assetLimits,
  );
  const projectId = createHash("sha256").update(document.path).digest("hex");
  const sessionId = randomUUID();
  let origin: string | undefined;
  let url: string | undefined;
  const clients = new Set<ServerResponse>();
  const unsubscribe = document.subscribe((snapshot) => {
    for (const response of clients)
      if (!response.write(`data: ${JSON.stringify(snapshot)}\n\n`)) response.end();
  });
  const activation = (): IEditorActivation => {
    if (!origin || !url) throw new EditorError(503, "Editor server is not listening");
    return { editorUrl: url, projectId, sessionId, revision: document.snapshot().revision };
  };
  const activate = async (): Promise<IEditorActivation> => {
    const value = activation();
    let response: Response;
    try {
      response = await fetch(value.editorUrl, { signal: AbortSignal.timeout(5000) });
    } catch (error) {
      throw new EditorError(
        503,
        `Editor URL is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok || !(await response.text()).includes("terrain-editor"))
      throw new EditorError(503, "Project terrain editor route is not ready");
    return value;
  };
  return {
    name: "threenative-terrain-editor",
    activate,
    config: () => (viewer ? { server: { allowedHosts: [viewer.hostname] } } : {}),
    configureServer(vite) {
      if (
        vite.config.server.host &&
        !["127.0.0.1", "localhost", "::1"].includes(String(vite.config.server.host))
      )
        throw new Error("Terrain editor writes require a loopback bind");
      const http = vite.httpServer;
      if (!http) throw new Error("Terrain editor requires a listening loopback HTTP server");
      http.once("listening", () => {
        const address = http.address();
        if (
          !address ||
          typeof address === "string" ||
          !["127.0.0.1", "::1"].includes(address.address)
        )
          throw new Error("Terrain editor writes require a loopback bind");
        origin = `http://${address.address === "::1" ? "[::1]" : address.address}:${address.port}`;
        url = viewer?.href ?? new URL(PREFIX, origin).href;
        console.log(`Terrain editor: ${url}`);
      });
      vite.watcher.add(document.path);
      const refresh = (path: string): void => {
        if (resolve(path) === document.path) document.refresh();
      };
      vite.watcher.on("add", refresh).on("change", refresh).on("unlink", refresh);
      const heartbeat = setInterval(() => {
        for (const response of clients) if (!response.write(": keepalive\n\n")) response.end();
      }, 15000);
      heartbeat.unref();
      http.once("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        for (const response of clients) response.end();
        vite.watcher.off("add", refresh).off("change", refresh).off("unlink", refresh);
      });
      vite.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0];
        if (!path?.startsWith(`${PREFIX}api/`)) return next();
        void (async () => {
          try {
            if (!origin) throw new EditorError(503, "Server is not ready");
            const remote = request.socket.remoteAddress;
            if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote ?? ""))
              throw new EditorError(403, "Loopback clients only");
            const requestUrl = new URL(`http://${request.headers.host}`);
            const local = new URL(origin);
            const localhost = new URL(origin.replace("127.0.0.1", "localhost"));
            const hosts = [local.host, localhost.host, ...(viewer ? [viewer.host] : [])];
            const origins = [local.origin, localhost.origin, ...(viewer ? [viewer.origin] : [])];
            if (!hosts.includes(requestUrl.host)) throw new EditorError(403, "Untrusted host");
            if (request.headers.origin && !origins.includes(request.headers.origin))
              throw new EditorError(403, "Untrusted origin");
            if (request.method === "GET" && path === `${PREFIX}api/activate`) {
              json(response, 200, await activate());
              return;
            }
            if (request.method === "GET" && path === `${PREFIX}api/document`) {
              json(response, 200, document.snapshot());
              return;
            }
            if (request.method === "GET" && path === `${PREFIX}api/events`) {
              response.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-store",
                connection: "keep-alive",
              });
              clients.add(response);
              response.on("close", () => clients.delete(response));
              response.write(`data: ${JSON.stringify(document.snapshot())}\n\n`);
              return;
            }
            if (request.method === "POST" && path === `${PREFIX}api/document`) {
              json(response, 200, document.commit(await body(request)));
              return;
            }
            if (request.method === "POST" && path === `${PREFIX}api/cameras`) {
              const transaction = await body(request);
              if (
                !transaction ||
                typeof transaction !== "object" ||
                Array.isArray(transaction) ||
                Object.keys(transaction).some((key) => !["baseRevision", "operation"].includes(key))
              )
                throw new Error("Expected { baseRevision, operation }");
              const cameras = transaction as { baseRevision?: unknown; operation?: unknown };
              const current = document.snapshot();
              if (cameras.baseRevision !== current.revision)
                throw new EditorError(409, "Stale base revision");
              // Cameras are authoring metadata: no evaluator, no erosion and no collider rebuild.
              const result: ICameraResult = runCameraOperation(
                {
                  cameras: current.document.cameras ?? [],
                  activeCamera: current.document.activeCamera ?? null,
                },
                cameras.operation,
              );
              const next = validate({
                ...current.document,
                cameras: result.cameras,
                activeCamera: result.activeCamera,
              });
              // Reads and no-op updates leave the document, and its revision, untouched.
              const changed =
                JSON.stringify(result.cameras) !== JSON.stringify(current.document.cameras ?? []) ||
                result.activeCamera !== (current.document.activeCamera ?? null);
              const revision = changed
                ? document.commit({ baseRevision: current.revision, document: next }).revision
                : current.revision;
              json(response, 200, { ...result, revision });
              return;
            }
            if (request.method === "GET" && path.startsWith(`${PREFIX}api/assets/`)) {
              // Only a file some registered entry names, never a caller-built path.
              const name = decodeURIComponent(path.slice(`${PREFIX}api/assets/`.length));
              const entry = (document.snapshot().document.assets ?? []).find(
                (asset) => asset.path === name,
              );
              if (!entry) throw new EditorError(404, `No registered asset file '${name}'`);
              const bytes = store.read(entry.path);
              response.writeHead(200, {
                "content-type": "application/octet-stream",
                // The file name carries its hash, so a replacement is a different URL.
                "cache-control": "public, max-age=31536000, immutable",
                "x-content-type-options": "nosniff",
              });
              response.end(bytes);
              return;
            }
            if (request.method === "POST" && path === `${PREFIX}api/assets`) {
              const transaction = await body(request);
              if (
                !transaction ||
                typeof transaction !== "object" ||
                Array.isArray(transaction) ||
                Object.keys(transaction).some((key) => !["baseRevision", "operation"].includes(key))
              )
                throw new Error("Expected { baseRevision, operation }");
              const asset = transaction as { baseRevision?: unknown; operation?: IAssetOperation };
              const current = document.snapshot();
              if (asset.baseRevision !== current.revision)
                throw new EditorError(409, "Stale base revision");
              const operation = asset.operation;
              if (!operation || typeof operation !== "object" || typeof operation.op !== "string")
                throw new Error("Expected an asset operation");
              const assets = current.document.assets ?? [];
              let next = assets;
              const surfaces = current.document.surfaces ?? {};
              let nextSurfaces = surfaces;
              let touched: IProjectAsset | null = null;
              if (operation.op === "register" || operation.op === "upload") {
                // A browser page may only upload bytes; reading a path is the trusted local agent's.
                if (operation.op === "register" && request.headers.origin)
                  throw new EditorError(
                    403,
                    "Registering a local path is for the local agent, not a page",
                  );
                const bytes =
                  operation.op === "register"
                    ? store.readSource(operation.path)
                    : Buffer.from(String(operation.data), "base64");
                const name =
                  operation.op === "register"
                    ? basename(operation.path)
                    : String(operation.name ?? operation.id);
                const stored = store.store(operation.id, name, bytes, operation);
                const existing = assets.find((entry) => entry.id === stored.id);
                if (existing && existing.sha256 !== stored.sha256 && operation.replace !== true)
                  throw new EditorError(
                    409,
                    `Asset '${stored.id}' already exists; pass replace: true or choose a new id`,
                  );
                if (existing?.sha256 === stored.sha256) touched = existing;
                else {
                  touched = existing
                    ? { ...stored, adjust: existing.adjust ?? stored.adjust }
                    : stored;
                  next = [...assets.filter((entry) => entry.id !== stored.id), touched];
                }
              } else if (operation.op === "adjust") {
                const existing = assets.find((entry) => entry.id === operation.id);
                if (!existing || existing.kind !== "model")
                  throw new EditorError(404, `No registered model '${operation.id}'`);
                touched = validateAsset({ ...existing, adjust: operation.adjust });
                next = assets.map((entry) =>
                  entry.id === touched?.id ? (touched as IProjectAsset) : entry,
                );
              } else if (operation.op === "remove") {
                touched = assets.find((entry) => entry.id === operation.id) ?? null;
                if (!touched) throw new EditorError(404, `No registered asset '${operation.id}'`);
                const used = Object.entries(surfaces).filter(
                  ([, mapping]) => mapping.asset === operation.id,
                );
                if (used.length)
                  throw new EditorError(
                    409,
                    `Asset '${operation.id}' is mapped to ${used.map(([input]) => input).join(", ")}; unmap it first`,
                  );
                const env = current.document.environment;
                const drawn = [
                  env?.sky?.image === operation.id ? "environment.sky.image" : "",
                  env?.lighting?.image === operation.id ? "environment.lighting.image" : "",
                ].filter(Boolean);
                if (drawn.length)
                  throw new EditorError(
                    409,
                    `Asset '${operation.id}' is used by ${drawn.join(", ")}; clear it first`,
                  );
                // The palette entry goes; the stored file and anything that referenced it stay.
                next = assets.filter((entry) => entry.id !== operation.id);
              } else if (operation.op === "map") {
                // The input's channel decides its colour space; an unknown channel is refused by name.
                surfaceSpace(operation.input);
                touched = assets.find((entry) => entry.id === operation.asset) ?? null;
                if (!touched || touched.kind !== "image")
                  throw new EditorError(404, `No registered image '${operation.asset}'`);
                nextSurfaces = { ...surfaces, [operation.input]: { asset: touched.id } };
              } else if (operation.op === "unmap") {
                if (!surfaces[operation.input])
                  throw new EditorError(404, `Surface input '${operation.input}' has no mapping`);
                nextSurfaces = Object.fromEntries(
                  Object.entries(surfaces).filter(([input]) => input !== operation.input),
                );
              } else if (operation.op !== "list") throw new Error("Unknown asset operation");
              const changed =
                JSON.stringify(next) !== JSON.stringify(assets) ||
                JSON.stringify(nextSurfaces) !== JSON.stringify(surfaces);
              const revision = changed
                ? document.commit({
                    baseRevision: current.revision,
                    document: JSON.parse(
                      JSON.stringify({
                        ...current.document,
                        assets: next,
                        surfaces: Object.keys(nextSurfaces).length ? nextSurfaces : undefined,
                      }),
                    ),
                  }).revision
                : current.revision;
              const result: IAssetResult = {
                op: operation.op,
                assets: next,
                surfaces: nextSurfaces,
                asset: touched,
              };
              json(response, 200, { ...result, revision });
              return;
            }
            if (request.method === "POST" && path === `${PREFIX}api/environment`) {
              const transaction = await body(request);
              if (
                !transaction ||
                typeof transaction !== "object" ||
                Array.isArray(transaction) ||
                Object.keys(transaction).some((key) => !["baseRevision", "operation"].includes(key))
              )
                throw new Error("Expected { baseRevision, operation }");
              const environment = transaction as { baseRevision?: unknown; operation?: unknown };
              const current = document.snapshot();
              if (environment.baseRevision !== current.revision)
                throw new EditorError(409, "Stale base revision");
              // Appearance only: no evaluator, no erosion and no collider rebuild.
              const result: IEnvironmentResult = runEnvironmentOperation(
                current.document.environment ?? {},
                environment.operation,
              );
              const changed =
                JSON.stringify(result.environment) !==
                JSON.stringify(current.document.environment ?? {});
              const next = { ...current.document };
              if (Object.keys(result.environment).length) next.environment = result.environment;
              else next.environment = undefined;
              const revision = changed
                ? document.commit({
                    baseRevision: current.revision,
                    document: JSON.parse(JSON.stringify(next)),
                  }).revision
                : current.revision;
              json(response, 200, { ...result, revision });
              return;
            }
            if (request.method === "POST" && path === `${PREFIX}api/inspect`) {
              const transaction = await body(request);
              if (
                !transaction ||
                typeof transaction !== "object" ||
                Array.isArray(transaction) ||
                Object.keys(transaction).some((key) => !["baseRevision", "query"].includes(key))
              )
                throw new Error("Expected { baseRevision, query }");
              const snapshot = document.snapshot();
              const inspection = transaction as { baseRevision?: unknown; query?: unknown };
              if (inspection.baseRevision !== snapshot.revision)
                throw new EditorError(409, "Stale base revision");
              // The headless evaluator is the same one the GUI renders from, so both agree.
              const state = evaluator.evaluate(snapshot.document.recipe);
              const result: ISpatialObservation = inspectSpatial(
                state,
                snapshot.revision,
                inspection.query as ISpatialQuery,
              );
              json(response, 200, { result });
              return;
            }
            throw new EditorError(405, "Unsupported terrain editor route/method");
          } catch (error) {
            json(response, error instanceof EditorError ? error.status : 400, {
              error: error instanceof Error ? error.message : String(error),
              snapshot: document.snapshot(),
            });
          }
        })();
      });
    },
  };
}
