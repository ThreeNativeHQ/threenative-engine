// The project source (PRD-915): every model, texture and audio file under the game's `assets/`,
// each `src/**/*.story.ts`, and the Scene Bundler. It reads the cook's `assets.manifest.json` for
// the Raw-vs-Cooked rows and `inspectAsset` for the health badges; it writes only on a bundle save.
import { existsSync } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { inspectAsset } from "../inspect.js";
import { writeBundle } from "./bundle.js";
import type { IAssetCatalog, IAssetElement, IAssetLibrarySource } from "./types.js";

export const MODEL_EXTENSIONS = new Set([".glb", ".gltf"]);
export const TEXTURE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".ktx2", ".svg"]);
export const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".ogg"]);
const STORY = /\.story\.ts$/u;
const IGNORED = new Set(["node_modules", "dist", "build", ".git", ".cache"]);

const MIME: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ktx2": "image/ktx2",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".bin": "application/octet-stream",
};

export interface IProjectSourceOptions {
  /** The project root (Vite's root). */
  readonly root: string;
  /** Where the authored assets live (`assets.source` in threenative.config.ts). Default `assets`. */
  readonly source?: string;
  /** Where the cook writes (`public/`). Default `public`. */
  readonly output?: string;
  /** Whether Pose Lab is mounted at `<mount>pose/`. */
  readonly poseLab?: boolean;
}

/** Every file under `dir` (relative to `root`) whose extension passes, depth-first, sorted. */
async function walk(root: string, dir: string, keep: (file: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  const visit = async (relative: string, depth: number): Promise<void> => {
    if (depth > 8 || found.length > 5000) return;
    const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child, depth + 1);
      else if (keep(child)) found.push(child);
    }
  };
  await visit(dir, 0);
  return found.sort((a, b) => a.localeCompare(b));
}

const kindOf = (file: string): string | undefined => {
  const ext = path.extname(file).toLowerCase();
  if (MODEL_EXTENSIONS.has(ext)) return "model";
  if (TEXTURE_EXTENSIONS.has(ext)) return "texture";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return undefined;
};

/** `root/relative` when it stays inside one of `allowed` (relative dirs); undefined otherwise. */
export function containedFile(
  root: string,
  relative: string,
  allowed: readonly string[],
): string | undefined {
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/u).some((part) => part === ".." || part === "")
  )
    return undefined;
  const file = path.resolve(root, relative);
  return allowed.some((dir) => file.startsWith(`${path.resolve(root, dir)}${path.sep}`))
    ? file
    : undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("request body over 1 MB");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

interface IManifestEntry {
  readonly output: string;
  readonly bytes: number;
  readonly triangles?: number;
  readonly vertices?: number;
  readonly format?: string;
  readonly transcodeTargets?: readonly string[];
  readonly lod?: { readonly levels: number; readonly runtime?: { readonly maxPixelError: number } };
}

/** Bytes a texture of this size holds on the GPU with its mip chain: RGBA8, or ~1 B/px compressed. */
export const textureVram = (width: number, height: number, compressed: boolean) =>
  Math.round((width * height * (compressed ? 1 : 4) * 4) / 3);

/** Textures, their GPU estimate, and the geometry health a model's own file shows. */
async function modelFacts(file: string): Promise<{
  textures: number;
  vram: number;
  missing: string[];
  unbound: number;
}> {
  const [{ NodeIO }, { ALL_EXTENSIONS }, { ImageUtils }] = await Promise.all([
    import("@gltf-transform/core"),
    import("@gltf-transform/extensions"),
    import("@gltf-transform/core"),
  ]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  try {
    const { MeshoptDecoder } = await import("meshoptimizer");
    await MeshoptDecoder.ready;
    io.registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  } catch {
    // A raw source GLB needs no decoder; a cooked one without it reports what it can.
  }
  const document = await io.read(file);
  const root = document.getRoot();
  let vram = 0;
  for (const texture of root.listTextures()) {
    const image = texture.getImage();
    const size = image ? ImageUtils.getSize(image, texture.getMimeType()) : null;
    if (size) vram += textureVram(size[0], size[1], texture.getMimeType() === "image/ktx2");
  }
  const missing = new Set<string>();
  for (const mesh of root.listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      if (!primitive.getAttribute("NORMAL")) missing.add("normals");
      const textured =
        primitive.getMaterial()?.getBaseColorTexture() ||
        primitive.getMaterial()?.getNormalTexture();
      if (textured && !primitive.getAttribute("TEXCOORD_0")) missing.add("UVs");
    }
  let unbound = 0;
  for (const animation of root.listAnimations())
    for (const channel of animation.listChannels()) if (!channel.getTargetNode()) unbound += 1;
  return { textures: root.listTextures().length, vram, missing: [...missing], unbound };
}

export function projectSource(options: IProjectSourceOptions): IAssetLibrarySource {
  const root = path.resolve(options.root);
  const source = options.source ?? "assets";
  const output = options.output ?? "public";
  const manifest = async (): Promise<Record<string, IManifestEntry>> => {
    const text = await readFile(path.join(root, output, "assets.manifest.json"), "utf8").catch(
      () => "",
    );
    return text
      ? ((JSON.parse(text) as { entries: Record<string, IManifestEntry> }).entries ?? {})
      : {};
  };
  /** The manifest row of a source file: keyed by its path under the source root. */
  const cookedOf = async (relative: string) => {
    const logical = path.posix.relative(source, relative);
    const entry = (await manifest())[logical];
    if (!entry) return undefined;
    const file = path.join(root, output, entry.output);
    return existsSync(file) ? { entry, file } : undefined;
  };

  /** Whether a model carries skins or clips, read from its glTF JSON only; cached by mtime. */
  const rigged = new Map<string, { mtime: number; animated: boolean }>();
  async function animatedModel(relative: string): Promise<boolean> {
    if (!/\.(glb|gltf)$/iu.test(relative)) return false;
    const file = path.join(root, relative);
    try {
      const { mtimeMs } = await stat(file);
      const hit = rigged.get(file);
      if (hit?.mtime === mtimeMs) return hit.animated;
      let json: { animations?: unknown[]; skins?: unknown[] };
      if (relative.toLowerCase().endsWith(".gltf")) json = JSON.parse(await readFile(file, "utf8"));
      else {
        const handle = await open(file, "r");
        try {
          const head = Buffer.alloc(20);
          await handle.read(head, 0, 20, 0);
          const length = head.readUInt32LE(12);
          if (head.readUInt32LE(0) !== 0x46546c67 || length > 64 * 1024 * 1024) return false;
          const chunk = Buffer.alloc(length);
          await handle.read(chunk, 0, length, 20);
          json = JSON.parse(chunk.toString("utf8"));
        } finally {
          await handle.close();
        }
      }
      const animated = (json.animations?.length ?? 0) > 0 || (json.skins?.length ?? 0) > 0;
      rigged.set(file, { mtime: mtimeMs, animated });
      return animated;
    } catch {
      return false;
    }
  }

  async function catalog(): Promise<IAssetCatalog> {
    const files = await walk(root, source, (file) => kindOf(file) !== undefined);
    const animated = new Set(
      (
        await Promise.all(
          files.map(async (file) =>
            kindOf(file) === "model" && (await animatedModel(file)) ? file : "",
          ),
        )
      ).filter(Boolean),
    );
    const stories = await walk(root, "src", (file) => STORY.test(file));
    const folder = (file: string, base: string) => {
      const dir = path.posix.dirname(path.posix.relative(base, file));
      return dir === "." ? {} : { category: dir };
    };
    const elements: IAssetElement[] = [
      ...files.map((file) => ({
        id: file,
        name: path.posix.basename(file),
        kind: kindOf(file) as string,
        source: "project",
        styleTags: ["project"],
        path: file,
        ...(animated.has(file) ? { animated: true } : {}),
        ...folder(file, source),
      })),
      ...stories.map((file) => ({
        id: file,
        name: path.posix.basename(file).replace(STORY, ""),
        kind: "story",
        source: "project",
        styleTags: ["project"],
        path: file,
        ...folder(file, "src"),
      })),
      { id: "stage", name: "Stage", kind: "stage", source: "project", styleTags: ["project"] },
    ];
    return {
      elements,
      styles: { project: "Project" },
      kinds: {
        model: { pack: "Models", name: "Models" },
        texture: { pack: "Textures", name: "Textures" },
        audio: { pack: "Audio", name: "Audio" },
        story: { pack: "Code stories", name: "Code stories" },
        stage: { pack: "Scene Bundler", name: "Scene Bundler" },
      },
    };
  }

  async function info(relative: string) {
    const file = containedFile(root, relative, [source]);
    if (!file) throw new Error(`not an asset under ${source}/: ${relative}`);
    const kind = kindOf(file);
    const raw = { bytes: (await stat(file)).size };
    const cooked = await cookedOf(relative);
    const cookedStats = cooked
      ? {
          output: path.posix.join(output, cooked.entry.output),
          bytes: (await stat(cooked.file)).size,
          ...(cooked.entry.triangles === undefined ? {} : { triangles: cooked.entry.triangles }),
          ...(cooked.entry.vertices === undefined ? {} : { vertices: cooked.entry.vertices }),
          ...(cooked.entry.format ? { format: cooked.entry.format } : {}),
          ...(cooked.entry.transcodeTargets ? { targets: cooked.entry.transcodeTargets } : {}),
        }
      : undefined;
    if (kind === "texture") {
      const { ImageUtils } = await import("@gltf-transform/core");
      const ext = path.extname(file).toLowerCase();
      let size: [number, number] | null = null;
      try {
        size =
          ext === ".svg"
            ? null
            : (ImageUtils.getSize(new Uint8Array(await readFile(file)), MIME[ext] ?? "") as
                | [number, number]
                | null);
      } catch {
        size = null;
      }
      return {
        path: relative,
        ...(size ? { width: size[0], height: size[1] } : {}),
        format: ext.slice(1),
        raw: { ...raw, ...(size ? { vram: textureVram(size[0], size[1], ext === ".ktx2") } : {}) },
        ...(cookedStats && cooked
          ? {
              cooked: {
                ...cookedStats,
                ...(size
                  ? { vram: textureVram(size[0], size[1], cooked.file.endsWith(".ktx2")) }
                  : {}),
              },
            }
          : {}),
      };
    }
    if (kind !== "model")
      return { path: relative, raw, ...(cookedStats ? { cooked: cookedStats } : {}) };
    const inspection = await inspectAsset(file);
    const facts = await modelFacts(file);
    const cookedFacts = cooked ? await modelFacts(cooked.file).catch(() => undefined) : undefined;
    const minY = inspection.bounds.center.y - inspection.bounds.size.y / 2;
    const health: { level: "ok" | "warn" | "error"; text: string }[] = [];
    if (inspection.units.label === "likely centimetres")
      health.push({
        level: "warn",
        text: `likely centimetres (${inspection.units.longestAxis.toFixed(0)} units): scale 0.01`,
      });
    else if (inspection.units.label === "ambiguous")
      health.push({
        level: "warn",
        text: `units ambiguous (${inspection.units.longestAxis.toFixed(1)} units long)`,
      });
    else health.push({ level: "ok", text: "metres" });
    if (Math.abs(minY) > 0.01)
      health.push({
        level: "warn",
        text: `min.y ${minY >= 0 ? "+" : ""}${(minY * 100).toFixed(1)} cm: ${minY > 0 ? "floats above" : "sinks below"} the floor`,
      });
    else health.push({ level: "ok", text: "grounded (min.y 0)" });
    for (const what of facts.missing) health.push({ level: "error", text: `missing ${what}` });
    if (facts.unbound)
      health.push({ level: "error", text: `${facts.unbound} unbound animation tracks` });
    const log = path.join(path.dirname(file), `${path.parse(file).name}.anim.json`);
    const ops = existsSync(log)
      ? ((JSON.parse(await readFile(log, "utf8")) as { ops?: unknown[] }).ops?.length ?? 0)
      : undefined;
    return {
      path: relative,
      inspection,
      health,
      raw: { ...raw, textures: facts.textures, vram: facts.vram },
      ...(cookedStats
        ? {
            cooked: {
              ...cookedStats,
              ...(cookedFacts ? { textures: cookedFacts.textures, vram: cookedFacts.vram } : {}),
            },
          }
        : {}),
      ...(cooked?.entry.lod
        ? {
            lod: {
              levels: cooked.entry.lod.levels,
              maxPixelError: cooked.entry.lod.runtime?.maxPixelError ?? 1,
            },
          }
        : {}),
      ...(ops === undefined
        ? {}
        : { animLog: { path: path.relative(root, log).split(path.sep).join("/"), ops } }),
      poseLab: options.poseLab === true,
    };
  }

  async function serve(res: ServerResponse, file: string): Promise<void> {
    res.setHeader(
      "content-type",
      MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
    );
    res.setHeader("cache-control", "no-store");
    res.end(await readFile(file));
  }

  return {
    id: "project",
    catalog,
    async handle(route, url, req, res) {
      // `file/<path>` and `cooked/<path>` are path-style, so a .gltf finds its .bin beside it.
      const [head = "", ...rest] = route.split("/");
      const relative = rest.length
        ? decodeURIComponent(rest.join("/"))
        : (url.searchParams.get("path") ?? "");
      if (head === "file") {
        // A .gltf names its .bin and images beside it, so the whole source tree is readable.
        const file = containedFile(root, relative, [source, "src"]);
        if (!file || !existsSync(file)) send(res, 404, { error: `no file ${relative}` });
        else await serve(res, file);
        return true;
      }
      if (head === "cooked") {
        const cooked = await cookedOf(relative);
        if (!cooked) send(res, 404, { error: `${relative} is not cooked yet` });
        else await serve(res, cooked.file);
        return true;
      }
      if (route === "info") {
        send(res, 200, await info(relative));
        return true;
      }
      if (route === "bundle" && req.method === "POST") {
        send(res, 200, await writeBundle(root, source, await body(req)));
        return true;
      }
      return false;
    },
  };
}
