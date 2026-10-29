/** PRD-526: execute the authored templates, export real r185 nodes, then compile in C++. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import {
  ACESFilmicToneMapping,
  Data3DTexture,
  FileLoader,
  FloatType,
  PerspectiveCamera,
  REVISION,
  RGBAFormat,
  Scene,
  Texture,
} from "three";
import { denoise } from "three/addons/tsl/display/DenoiseNode.js";
import GTAONode, { ao } from "three/addons/tsl/display/GTAONode.js";
import { lut3D } from "three/addons/tsl/display/Lut3DNode.js";
import { smaa } from "three/addons/tsl/display/SMAANode.js";
import { float, texture, texture3D, uniform, vec2 } from "three/tsl";
import { TempNode } from "three/webgpu";
import { type IRenderChainOptions, RenderChain } from "../../../core/src/render/chain.js";
import { createProject } from "../../../create-threenative/src/index.js";
import { exportTslGraph } from "../../scripts/tsl-export.js";
import { functionFixtures } from "./tsl-function-fixtures.js";

const root = path.resolve(import.meta.dirname, "../../../..");
const templates =
  process.env.TN_POST_TEMPLATES ?? path.join(root, "packages/create-threenative/templates");
const [native, tint, work] = process.argv.slice(2);
if (!native || !tint || !work)
  throw new Error("Usage: template-post-packages.ts <compiler> <tint> <build-dir>");
if (REVISION !== "185") throw new Error(`Expected three r185, got r${REVISION}`);
const directory = mkdtempSync(path.join(work, "template-post-"));
// SMAA embeds two PNG lookup tables. Decode those real tables on CPU; no DOM or GPU is needed
// to construct the shader graph. Do not replace the textures or the antialiasing node.
class CpuImage {
  width = 0;
  height = 0;
  data: Buffer = Buffer.alloc(0);
  onload?: () => void;
  set src(value: string) {
    const encoded = /^data:image\/png;base64,(.*)$/u.exec(value)?.[1];
    if (encoded === undefined)
      throw new Error("TN_TEMPLATE_IMAGE_UNSUPPORTED: expected embedded PNG");
    const image = PNG.sync.read(Buffer.from(encoded, "base64"));
    this.width = image.width;
    this.height = image.height;
    this.data = image.data;
    queueMicrotask(() => this.onload?.());
  }
}
Object.defineProperty(globalThis, "Image", { value: CpuImage, configurable: true });
// TN_POST_ONLY / TN_POST_EXCEPT (comma lists) split the sweep so ctest can name the template whose
// chain develop has moved past the native lowering (see NativeEngine.cmake) without hiding it.
const only = process.env.TN_POST_ONLY?.split(",");
const except = process.env.TN_POST_EXCEPT?.split(",") ?? [];
const names = readdirSync(templates, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      (only === undefined || only.includes(entry.name)) &&
      !except.includes(entry.name) &&
      existsSync(path.join(templates, entry.name, "src/render/postprocessing.ts")),
  )
  .map((entry) => entry.name)
  .sort();
if (names.length === 0) throw new Error(`TN_TEMPLATE_POST_EMPTY: ${templates}`);

/**
 * A template stage that is generated source driving its own render targets (the Unreal bloom's mip chain, local exposure's
 * bilateral grid) runs on the host through the facade, so no single exported graph can say what it draws. The conformance row
 * that draws it on the host and in the browser is its native proof. The sweep checks that the row is still required and
 * desktop-gated, then lowers the rest of the chain with each such stage read from a host texture of its name. `lanes` is what
 * the stage hands the chain: a float gain, or an rgb colour.
 */
const HOST_RUN: Record<string, { row: string; lanes: string }> = {
  // Core's metered exposure: live render targets and per-frame texture swaps, run by the engine player.
  AutoExposureNode: { row: "auto-exposure", lanes: "x" },
  LocalExposureNode: { row: "local-exposure", lanes: "x" },
  UnrealBloomNode: { row: "local-exposure", lanes: "xyz" },
  // The owned engine's live screen-space effects (post_effects.cpp, not a cooked package): core's chain builds them for
  // the kits that take the engine look, and each row draws the effect on the host as well as the browser.
  SSGINode: { row: "realism-ssgi", lanes: "xyzw" },
  SSRNode: { row: "realism-ssr", lanes: "xyzw" },
};
const registry = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../conformance/registry.json"), "utf8"),
) as { tests: { id: string; status: string; required?: boolean; desktopGate?: boolean }[] };

/** Rewrites the host-run stages of `exported` into reads of host textures, and names the parity rows that prove them. */
function standIn(exported: ReturnType<typeof exportTslGraph>): string[] {
  const rows = new Set<string>();
  const count = exported.nodes.length;
  // Owned Wasm/V8 parity proves real GI and neutral AO=1 separately; upstream SSGI parity remains distinct.
  const giOwners = new Set(
    exported.nodes.flatMap((node, id) => (node.kind === "SSGINode" ? [id] : [])),
  );
  for (const node of exported.nodes) {
    if (node.kind !== "PassTextureNode" || !node.dependencies.some((id) => giOwners.has(id)))
      continue;
    if (node.name !== "SSGI_AO" && node.name !== "SSGI_GI")
      throw new Error(`TN_TEMPLATE_POST_HOST_RUN: unknown SSGI output '${node.name}'`);
    node.name = `host_${node.name}`;
  }
  for (let id = 0; id < count; id++) {
    const node = exported.nodes[id];
    if (node === undefined) continue;
    // The chain's real-three context carries the temporal pass's velocity only so TRAANode can unjitter its projection.
    // The host draws that velocity itself and the stages read it by the name `velocity`.
    if (node.kind === "VelocityNode") {
      Object.assign(node, { kind: "TextureNode", name: "velocity", args: [], dependencies: [] });
      continue;
    }
    if (
      node.kind === "ContextNode" &&
      node.operation === "custom-context" &&
      node.name === "velocity"
    ) {
      // Nothing else reads this context, so it is the node it wraps (JSON drops the undefined fields).
      Object.assign(node, { operation: undefined, name: undefined });
      continue;
    }
    const hosted = HOST_RUN[node.kind];
    if (hosted === undefined) continue;
    const row = registry.tests.find((test) => test.id === hosted.row);
    if (!row || row.status !== "implemented" || row.required !== true || row.desktopGate !== true)
      throw new Error(
        `TN_TEMPLATE_POST_HOST_RUN: ${node.kind} has no required, desktop-gated parity row '${hosted.row}'`,
      );
    rows.add(`${node.kind} (${hosted.row})`);
    exported.nodes.push({
      kind: "TextureNode",
      name: `host_${node.kind}`,
      args: [],
      dependencies: [],
    });
    Object.assign(node, {
      kind: "SplitNode",
      lanes: hosted.lanes,
      args: [exported.nodes.length - 1],
      dependencies: [],
    });
  }
  return [...rows];
}

// The owned engine's GTAO takes Unreal's screen reach as `reachPx` (three-native post-effects.ts); upstream three's has
// no such uniform, so the sweep adds it to the node the chain builds and the export cooks it (post_effects.cpp reads it).
Object.defineProperty(GTAONode.prototype, "reachPx", {
  configurable: true,
  get(this: { _reachPx?: { value: number } }) {
    this._reachPx ??= { value: 0 };
    return this._reachPx;
  },
});

class UnloweredPostNode extends TempNode {
  static get type(): string {
    return "UnloweredPostNode";
  }
  constructor(readonly input: unknown) {
    super("vec4");
  }
}

async function run(
  command: string,
  args: string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function checkSmaaTables(exported: ReturnType<typeof exportTslGraph>): void {
  const images = exported.nodes.find((node) => node.kind === "SMAANode")?.post?.images;
  const expected = [
    "53872ecb0c233e03f3bae14e37ce5572698ef0923dc83efd488ac03f7c668400",
    "0280946a134416770d72b6550f87767d26de6a28b148332cea81a9f75b88fff4",
  ];
  if (
    !images ||
    images.length !== 2 ||
    images.some(
      (image, index) =>
        createHash("sha256").update(Buffer.from(image.bytes)).digest("hex") !== expected[index],
    )
  ) {
    throw new Error("TN_SMAA_LOOKUP_MISMATCH: expected the decoded r185 PNG pixels");
  }
}

function checkPostModules(name: string, modules: string[]): void {
  if (modules.length === 0) throw new Error(`${name}: native package contains no shader modules`);
  const expectedModules: Record<string, number> = { GTAONode: 4, DenoiseNode: 4, SMAANode: 10 };
  if (name in expectedModules && modules.length !== expectedModules[name]) {
    throw new Error(`${name}: expected ${expectedModules[name]} modules, got ${modules.length}`);
  }
}

async function compile(name: string, output: unknown, hosted = false): Promise<boolean> {
  const input = path.join(directory, `${name}.json`);
  const prefix = path.join(directory, name);
  const exported = exportTslGraph(output);
  const accounted = hosted ? standIn(exported) : [];
  if (name === "SMAANode") checkSmaaTables(exported);
  writeFileSync(input, JSON.stringify(exported));
  const compiled = await run(native as string, [name, input, prefix]);
  if (compiled.status !== 0) {
    console.error(
      compiled.stderr || compiled.stdout || `${name}: compiler exited ${compiled.status}`,
    );
    return false;
  }
  const modules: string[] = JSON.parse(readFileSync(`${prefix}.modules.json`, "utf8"));
  const expected = { FnNode: 2, RTTNode: 4, BloomNode: 26, SharpenNode: 4 }[name];
  if (expected !== undefined && modules.length !== expected)
    throw new Error(`${name}: expected ${expected} native modules, got ${modules.length}`);
  // A loop body reads at an explicit mip; a plain sample there has no implicit derivatives to pick one.
  // The fixture's loop body holds one read, so the package holds one: a statement the importer lowered twice would sum it twice.
  if (name === "TextureLevel") {
    const reads = modules.reduce(
      (count, m) => count + (readFileSync(m, "utf8").match(/textureSampleLevel\(/gu)?.length ?? 0),
      0,
    );
    if (reads !== 1)
      throw new Error(
        `TextureLevel: expected 1 explicit-level sample in the native package, got ${reads}`,
      );
  }
  if (name === "FnNode") {
    const shader = readFileSync(modules[1] as string, "utf8");
    for (const operation of ["for (", "if (", " = "])
      if (!shader.includes(operation)) throw new Error(`FnNode: missing ${operation}`);
  }
  checkPostModules(name, modules);
  // A colour grade samples a 3D table at `0.5/size + rgb * (1 - 1/size)`; a 2D bind would not compile.
  if (
    name === "Lut3DNode" &&
    !modules.some((m) => /texture_3d<f32>/u.test(readFileSync(m, "utf8")))
  )
    throw new Error("Lut3DNode: no texture_3d binding in the native package");
  for (const module of modules) {
    const validated = await run(tint as string, [
      module,
      "--format",
      "wgsl",
      "-o",
      `${module}.validated`,
    ]);
    if (validated.status !== 0) {
      console.error(`${name}: Tint refused ${path.basename(module)}\n${validated.stderr}`);
      return false;
    }
  }
  console.info(`${name}: native package + Tint (${modules.length} modules)`);
  if (accounted.length > 0)
    console.info(`${name}: host-run stages, proven by their parity row: ${accounted.join(", ")}`);
  return true;
}

// A live positive control exercises JS export, native IR, package layouts and Tint even while a
// template is refused. No template stage is replaced by this graph.
const source = new Texture();
source.name = "scene";
let failures = (await compile("export-control", texture(source, vec2(0.25, 0.75)).mul(0.5)))
  ? 0
  : 1;
/** mulberry32: the seeded Math.random the native DenoiseNode draws its noise permutation from. */
function seeded<T>(build: () => T): T {
  let state = 1;
  const random = Math.random;
  Math.random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  try {
    return build();
  } finally {
    Math.random = random;
  }
}

/** PRD-531 slice 4: the native live effect equals what three's node exported. */
async function compareLive(name: string, kind: string): Promise<boolean> {
  const compared = await run(native as string, [
    "--live",
    kind,
    path.join(directory, `${name}.json`),
  ]);
  if (compared.status !== 0) console.error(compared.stderr || compared.stdout);
  else console.info(compared.stdout.trim());
  return compared.status === 0;
}

const lowering = process.env.TN_POST_LOWERING;
if (lowering) {
  const camera = new PerspectiveCamera(60, 4 / 3, 0.1, 1000);
  camera.updateProjectionMatrix();
  const depth = new Texture();
  depth.name = "depth";
  const input = texture(source);
  const nodes = {
    ...functionFixtures(source),
    GTAONode: () => ao(texture(depth), null, camera).getTextureNode(),
    DenoiseNode: () => seeded(() => denoise(input, texture(depth), null, camera)),
    SMAANode: () => smaa(input),
    Lut3DNode: () => {
      const table = new Data3DTexture(new Float32Array(2 * 2 * 2 * 4), 2, 2, 2);
      table.type = FloatType;
      table.format = RGBAFormat;
      return lut3D(input, texture3D(table), 2, float(0.5));
    },
  };
  if (!(lowering in nodes)) throw new Error(`Unknown lowering ${lowering}`);
  const output = nodes[lowering as keyof typeof nodes]();
  if (!(await compile(lowering, output))) failures++;
  const live = ["GTAONode", "DenoiseNode", "SMAANode"].includes(lowering);
  if (live && !(await compareLive(lowering, lowering))) failures++;
  if (lowering === "GTAONode" || lowering === "DenoiseNode") {
    const normal = new Texture();
    normal.name = "normal";
    const ambient = ao(texture(depth), texture(normal), camera).getTextureNode();
    const graph =
      lowering === "GTAONode"
        ? ambient
        : seeded(() => denoise(ambient, texture(depth), texture(normal), camera));
    if (!(await compile(`${lowering}-normals`, graph))) failures++;
    if (!(await compareLive(`${lowering}-normals`, lowering))) failures++;
  }
  console.info(`TN_POST_LOWERING ${lowering} failures=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}
let noPostChains = 0;
// Native-export carrier only: the real native importer/shader implements reachPx; upstream Three does not.
Object.defineProperty(GTAONode.prototype, "reachPx", {
  configurable: true,
  get() {
    const value = uniform(0);
    Object.defineProperty(this, "reachPx", { value });
    return value;
  },
});
for (const name of names) {
  // Compile the same complete authored source tree a user receives, including canonical shared files.
  const generated = path.join(directory, "generated", name);
  await createProject({ target: generated, template: name, install: false }, directory, templates);
  symlinkSync(
    path.join(root, "packages/create-threenative/node_modules"),
    path.join(generated, "node_modules"),
    "dir",
  );
  const authored = await import(
    pathToFileURL(path.join(generated, "src/render/postprocessing.ts")).href
  );
  for (const tier of ["high", "medium", "low"] as const) {
    const label = `${name}-${tier}`;
    let output: unknown;
    let pendingTable = false;
    const renderer = {
      kind: "webgpu" as const,
      raw: { toneMapping: 0, toneMappingExposure: 1, info: {} },
      width: 320,
      height: 240,
      setOutputNode(node: unknown) {
        output = node;
        return {
          isCurrent: () => output === node,
          dispose: () => {
            output = undefined;
          },
        };
      },
      clearOutputNode() {
        output = undefined;
      },
      createRenderChain(options: Omit<IRenderChainOptions, "renderer">) {
        const chain = new RenderChain(renderer, options);
        // A template's `.cube` table is a file that lands after the chain that reads it, so its
        // `lut:pending` is the transient first build. A tier that sets a stage's intensity to zero
        // turned it off by design. Any other drop, or a pending table that never lands, is a stage
        // the native lowering refused.
        const dropped = chain.applied.dropped.filter(
          (stage) => stage.reason !== "lut:pending" && !/Intensity:0$/u.test(stage.reason),
        );
        pendingTable = chain.applied.dropped.some((stage) => stage.reason === "lut:pending");
        if (dropped.length > 0) {
          chain.dispose();
          throw new Error(dropped.map((stage) => `${stage.name}: ${stage.reason}`).join("; "));
        }
        return chain;
      },
    };
    let controller: { dispose(): void } | undefined;
    // `FileLoader` fetches a URL relative to a page; read the template's `public/` file instead.
    FileLoader.prototype.load = function load(url, onLoad) {
      const text = readFileSync(path.join(generated, "public", url), "utf8");
      queueMicrotask(() => onLoad?.(text));
    };
    try {
      const camera = new PerspectiveCamera(60, 4 / 3, 0.1, 1000);
      camera.updateProjectionMatrix();
      controller = authored.setupPost(renderer, new Scene(), camera, { tier });
      // The template's own loader reads the table; the chain is rebuilt once it lands.
      for (let wait = 0; pendingTable && wait < 200; wait++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      if (pendingTable) throw new Error("grade: lut:pending (the table never loaded)");
      if (output === undefined) {
        // A tier that turns every stage off (snow, rts-low) takes WorldEnvironment's direct tone
        // mapping and installs no pass; it passes only when its preset proves it asked for none.
        const quality = await import(
          pathToFileURL(path.join(generated, "src/render/quality.ts")).href
        );
        const preset = quality.qualityPreset(tier);
        if (
          [
            "ssgiEnabled",
            "gtaoEnabled",
            "godraysEnabled",
            "ssrEnabled",
            "sharpenEnabled",
            "bloomEnabled",
            "autoExposureEnabled",
          ].some((key) => preset[key] === true) ||
          (preset.vignetteAmount ?? 0) !== 0 ||
          (preset.authoredStageNames?.length ?? 0) !== 0 ||
          renderer.raw.toneMapping !== ACESFilmicToneMapping ||
          renderer.raw.toneMappingExposure !== preset.exposure
        )
          throw new Error(`TN_TEMPLATE_POST_EMPTY: ${name} requested a post graph`);
        console.info(`${label}: no post chain (WorldEnvironment direct tone mapping)`);
        noPostChains++;
        continue;
      }
      if (output === undefined)
        throw new Error("TN_TEMPLATE_POST_EMPTY: no output graph installed");
      if (process.env.TN_POST_RED_CONTROL === "1") output = new UnloweredPostNode(output);
      if (!(await compile(label, output, true))) failures++;
    } catch (error) {
      failures++;
      console.error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      controller?.dispose();
    }
  }
}
console.info(
  `TN_TEMPLATE_POST_PACKAGES templates=${names.length} graphs=${names.length * 3 - noPostChains} noPostChains=${noPostChains} accounted=${names.length * 3} failures=${failures}`,
);
process.exitCode = failures === 0 ? 0 : 1;
