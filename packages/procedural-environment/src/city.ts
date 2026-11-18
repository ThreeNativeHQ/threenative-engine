import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Canvas, Image, ImageData } from "@napi-rs/canvas";
import type { Box3, Mesh, Object3D } from "three";

/** One Apex City Kit module: its id, name, category name, description and road sockets (N, E, S, W). */
export interface ICityModule {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly edges: string;
}

export interface IBakeCityOptions {
  /** Directory the GLB is written to; created when missing. */
  readonly out: string;
  /** A module id: `environmentElements({ kind: "city" })` lists all 75 (cross, office, sedan, civic-bridge ...). */
  readonly module: string;
  /** An integer 0 to 4294967295. The same options always write the same bytes. Default 31082, the page's. */
  readonly seed?: number;
  /** Geometry detail: 0 low, 1 standard, 2 high. Default 2. */
  readonly detail?: number;
  /** Surface wetness, 0 to 100. Default 30. */
  readonly wet?: number;
  /** Building floors, an integer 2 to 12. Default 4. */
  readonly floors?: number;
  /** Sign text, at most 24 characters; empty uses the generated name. Default "". */
  readonly text?: string;
  /** Include street fixtures. Default true. */
  readonly dressing?: boolean;
}

type CityParameters = Required<Omit<IBakeCityOptions, "out" | "module">>;

interface IApex {
  build(id: string, parameters: CityParameters): Object3D;
  loadMaps(): Promise<void>;
  readonly modules: readonly {
    id: string;
    name: string;
    category: number;
    description: string;
    edges: string;
  }[];
  readonly categories: readonly string[];
  readonly defaults: CityParameters;
  readonly GLTFExporter: new () => {
    parseAsync(input: Object3D, options: Record<string, unknown>): Promise<ArrayBuffer>;
  };
}

const SOURCE = fileURLToPath(new URL("../vendor/apex/apex-city-kit.js", import.meta.url));
let script: vm.Script | undefined;
let catalog: ICityModule[] | undefined;

/** A Blob that resolves in call order, so the exporter lays the GLB out the same on every run. */
class OrderedBlob {
  readonly bytes: Buffer;
  readonly type: string;
  constructor(parts: readonly unknown[], options?: { type?: string }) {
    this.type = options?.type ?? "";
    this.bytes = Buffer.concat(
      parts.map((part) =>
        typeof part === "string"
          ? Buffer.from(part)
          : ArrayBuffer.isView(part)
            ? Buffer.from(part.buffer, part.byteOffset, part.byteLength)
            : Buffer.from(part as ArrayBuffer),
      ),
    );
  }
  get size(): number {
    return this.bytes.byteLength;
  }
}

class OrderedFileReader {
  result: ArrayBuffer | undefined;
  onloadend: (() => void) | undefined;
  readAsArrayBuffer(blob: OrderedBlob): void {
    queueMicrotask(() => {
      this.result = new Uint8Array(blob.bytes).buffer;
      this.onloadend?.();
    });
  }
}

/** A canvas the page would get from `document.createElement("canvas")`. */
function pageCanvas(): Canvas {
  const canvas = Object.assign(new Canvas(300, 150), {
    style: {},
    toBlob(done: (blob: OrderedBlob) => void, type = "image/png"): void {
      // ponytail: PNG and JPEG only, the two types GLTFExporter writes here; the browser's JPEG quality is 0.92.
      const bytes =
        type === "image/jpeg" ? canvas.encodeSync("jpeg", 92) : canvas.encodeSync("png");
      queueMicrotask(() => done(new OrderedBlob([bytes], { type })));
    },
  });
  // A browser canvas has no `data`; napi's raw-pixel method would send GLTFExporter down its
  // DataTexture path and export a blank image.
  Object.defineProperty(canvas, "data", { value: undefined });
  return canvas;
}

function pageImage(): Image {
  const image = new Image();
  return Object.assign(image, {
    addEventListener(type: string, listener: (event: unknown) => void): void {
      if (type === "load") image.onload = () => listener.call(image, { type });
      else if (type === "error") image.onerror = (error) => listener.call(image, error);
    },
    removeEventListener(): void {},
  });
}

/**
 * A fresh run of the page script: its own three, caches and materials, with only what generation
 * and export touch (a canvas, an image, Blob and FileReader). Warnings stay quiet; an error fails.
 */
function apex(errors: string[] = []): IApex {
  script ??= new vm.Script(readFileSync(SOURCE, "utf8"), { filename: SOURCE });
  const quiet = (): void => {};
  const context = vm.createContext({
    console: {
      log: quiet,
      info: quiet,
      warn: quiet,
      debug: quiet,
      error: (...parts: unknown[]) => errors.push(parts.map(String).join(" ")),
    },
    document: {
      createElement: (tag: string) => {
        if (tag === "canvas") return pageCanvas();
        throw new Error(`bakeCity: the page asked for a <${tag}> element`);
      },
      createElementNS: (_namespace: string, tag: string) => {
        if (tag === "img") return pageImage();
        if (tag === "canvas") return pageCanvas();
        throw new Error(`bakeCity: the page asked for a <${tag}> element`);
      },
    },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    Blob: OrderedBlob,
    FileReader: OrderedFileReader,
    ImageData,
    HTMLCanvasElement: Canvas,
    HTMLImageElement: Image,
  });
  return script.runInContext(context) as IApex;
}

/** The 75 modules of the vendored Apex City Kit, in the page's order. */
export function cityModules(): ICityModule[] {
  if (catalog === undefined) {
    const kit = apex();
    catalog = kit.modules.map(({ id, name, category, description, edges }) => ({
      id,
      name,
      category: kit.categories[category] as string,
      description,
      edges,
    }));
  }
  return catalog.map((module) => ({ ...module }));
}

/** The page's own limits (its layout validator): throws naming the option and its range. */
function checkParameters(parameters: CityParameters): void {
  const { seed, detail, wet, floors, text, dressing } = parameters;
  const fail = (rule: string, value: unknown): never => {
    throw new Error(`bakeCity: ${rule}, got ${JSON.stringify(value)}`);
  };
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295)
    fail("seed must be an integer 0 to 4294967295", seed);
  if (!Number.isInteger(detail) || detail < 0 || detail > 2)
    fail("detail must be 0 (low), 1 (standard) or 2 (high)", detail);
  if (!Number.isFinite(wet) || wet < 0 || wet > 100) fail("wet must be 0 to 100", wet);
  if (!Number.isInteger(floors) || floors < 2 || floors > 12)
    fail("floors must be an integer 2 to 12", floors);
  if (typeof text !== "string" || text.length > 24)
    fail("text must be a string of at most 24 characters", text);
  if (typeof dressing !== "boolean") fail("dressing must be true or false", dressing);
}

interface ICityBake {
  readonly glb: Uint8Array;
  readonly triangles: number;
  readonly bounds: {
    readonly max: readonly [number, number, number];
    readonly min: readonly [number, number, number];
  };
  /** `<module>-<seed>[-f<hash of the other non-default options>].glb` */
  readonly file: string;
}

/**
 * Build one module with the page's generator and export it with the page's GLTFExporter and
 * settings (binary, trs, onlyVisible, textures capped at 1024 px), in a fresh page context.
 */
export async function buildCity(options: IBakeCityOptions): Promise<ICityBake> {
  const errors: string[] = [];
  const kit = apex(errors);
  const { module } = options;
  if (!kit.modules.some((row) => row.id === module))
    throw new Error(`bakeCity: unknown module "${module}"`);
  const parameters: CityParameters = { ...kit.defaults };
  for (const key of Object.keys(parameters) as (keyof CityParameters)[])
    if (options[key] !== undefined) Object.assign(parameters, { [key]: options[key] });
  checkParameters(parameters);
  await kit.loadMaps();
  const group = kit.build(module, parameters);
  const glb = new Uint8Array(
    await new kit.GLTFExporter().parseAsync(group, {
      binary: true,
      trs: true,
      onlyVisible: true,
      maxTextureSize: 1024,
    }),
  );
  if (errors.length > 0) throw new Error(`bakeCity: "${module}" failed: ${errors.join("; ")}`);
  let box: Box3 | undefined;
  let triangles = 0;
  group.updateMatrixWorld(true);
  group.traverse((object) => {
    const { geometry, isMesh } = object as Mesh;
    if (isMesh !== true) return;
    geometry.computeBoundingBox();
    const local = (geometry.boundingBox as Box3).clone().applyMatrix4(object.matrixWorld);
    box = box === undefined ? local : box.union(local);
    triangles += (geometry.index?.count ?? geometry.attributes.position?.count ?? 0) / 3;
  });
  if (box === undefined || triangles === 0)
    throw new Error(`bakeCity: "${module}" built no triangles`);
  const changed = Object.entries(parameters).filter(
    ([key, value]) => key !== "seed" && kit.defaults[key as keyof CityParameters] !== value,
  );
  const tag =
    changed.length === 0
      ? ""
      : `-f${createHash("sha256").update(JSON.stringify(changed)).digest("hex").slice(0, 8)}`;
  return {
    glb,
    triangles,
    bounds: { max: [box.max.x, box.max.y, box.max.z], min: [box.min.x, box.min.y, box.min.z] },
    file: `${module}-${parameters.seed}${tag}.glb`,
  };
}
