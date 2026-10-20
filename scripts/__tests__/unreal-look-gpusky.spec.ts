import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { MIE_G, bakeSkyRadiance, medium } from "../unreal-look/scaffold/render/atmosphere.js";

// Resolve the overlay as a consumer of core: root scripts do not install three.
const coreRequire = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const webgpuPath = coreRequire.resolve("three/webgpu");
const tslPath = coreRequire.resolve("three/tsl");
vi.mock("three", () => import(webgpuPath));
vi.mock("three/tsl", () => import(tslPath));
vi.mock("three/webgpu", () => import(webgpuPath));
const {
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  NodeMaterial,
  WGSLNodeBuilder,
  WebGPURenderer,
} = await import(webgpuPath);
const { float } = await import(tslPath);
// The overlay is generated consumer source, excluded from the root TypeScript project.
const overlayPath = "../unreal-look/scaffold/render/gpuSky.js";
const {
  atmosphereFogColour,
  createGpuSky,
  GpuSkyNode,
  gpuHg,
  gpuMedium,
  skyAnglesToUv,
  skyUvToAngles,
} = await import(overlayPath);

// Evaluate the actual scalar/vector TSL expressions on the CPU, independently of their WGSL emitter.
function evaluate(node: unknown): number[] {
  const n = node as {
    isConstNode?: boolean;
    isConvertNode?: boolean;
    isVarNode?: boolean;
    value: number | { toArray(): number[] };
    convertTo: string;
    node: unknown;
    nodes?: unknown[];
    aNode?: unknown;
    bNode?: unknown;
    cNode?: unknown;
    condNode?: unknown;
    ifNode?: unknown;
    elseNode?: unknown;
    op?: string;
    method?: string;
    constructor: { name: string };
  };
  if (n.isConstNode) return typeof n.value === "number" ? [n.value] : n.value.toArray();
  const broadcast = (a: number[], count: number) =>
    Array.from({ length: count }, (_, i) => (a.length === 1 ? a[0] : a[i])) as number[];
  if (n.isVarNode) return evaluate(n.node);
  if (n.isConvertNode)
    return broadcast(evaluate(n.node), Number(n.convertTo.match(/\d/)?.[0] ?? 1));
  if (n.nodes) return n.nodes.flatMap(evaluate);
  if (n.op || n.method) {
    const args = [n.aNode, n.bNode, n.cNode].filter(Boolean).map(evaluate);
    const count = Math.max(...args.map((a) => a.length));
    const [a, b, c] = args.map((v) => broadcast(v, count));
    return (a as number[]).map((x, i) => {
      const y = b?.[i] ?? 0;
      const z = c?.[i] ?? 0;
      switch (n.op ?? n.method) {
        case "+":
          return x + y;
        case "-":
          return x - y;
        case "*":
          return x * y;
        case "/":
          return x / y;
        case "<":
          return Number(x < y);
        case "exp":
          return Math.exp(x);
        case "pow":
          return x ** y;
        case "clamp":
          return Math.max(y, Math.min(z, x));
        default:
          throw new Error(`Unknown TSL operation ${n.op ?? n.method}`);
      }
    });
  }
  if (n.condNode) return evaluate(evaluate(n.condNode)[0] ? n.ifNode : n.elseNode);
  throw new Error(`Unknown TSL node ${n.constructor.name}`);
}

function compile(material: object) {
  const renderer = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
  Reflect.set(renderer.backend, "renderer", renderer);
  vi.spyOn(Reflect.get(renderer.backend, "capabilities"), "getUniformBufferLimit").mockReturnValue(
    65_536,
  );
  vi.spyOn(renderer, "hasFeature").mockReturnValue(false);
  const builder = new WGSLNodeBuilder(new Mesh(new PlaneGeometry(2, 2), material), renderer);
  Reflect.set(builder, "camera", new PerspectiveCamera());
  Reflect.set(builder, "scene", new Scene());
  builder.build();
  return Reflect.get(builder, "fragmentShader") as string;
}

describe("GPU Unreal sky", () => {
  it("compiles all four RTT graphs and the background graph to WGSL without a GPU", () => {
    const start = performance.now();
    const sky = new GpuSkyNode(new Vector3(0.5, Math.sqrt(0.75), 0), new Scene(), true, true);
    try {
      for (const m of sky.materials) {
        const shader = compile(m);
        expect(shader).toContain("@fragment");
        expect(shader).not.toMatch(/NaN|Infinity|undefined/);
      }
      const background = new NodeMaterial();
      background.fragmentNode = sky.backgroundNode;
      expect(compile(background)).toContain("@fragment");
      console.log(
        `GPU sky graph construction + WGSL generation: ${(performance.now() - start).toFixed(1)} ms (no GPU execution)`,
      );
    } finally {
      sky.dispose();
    }
  });

  it("renders once, reuses idle LUTs and refreshes sky/clouds plus the CPU environment on sun movement", () => {
    const sun = new Vector3(0.5, Math.sqrt(0.75), 0);
    const refresh = vi.fn();
    const sky = new GpuSkyNode(sun, new Scene(), false, true, refresh);
    const renderer = new WebGPURenderer({ canvas: new EventTarget() as HTMLCanvasElement });
    vi.spyOn(renderer, "render").mockImplementation(() => {});
    const frame = { renderer };
    try {
      sky.updateBefore(frame);
      expect(renderer.render).toHaveBeenCalledTimes(4);
      sky.updateBefore(frame);
      expect(renderer.render).toHaveBeenCalledTimes(4);
      expect(refresh).not.toHaveBeenCalled();
      sun.set(0, 1, 0);
      sky.updateBefore(frame);
      expect(renderer.render).toHaveBeenCalledTimes(6);
      expect(refresh).toHaveBeenCalledOnce();
      expect(renderer.getRenderTarget()).toBeNull();
      vi.mocked(renderer.render).mockImplementationOnce(() => {
        throw new Error("draw failed");
      });
      sun.set(1, 0, 0);
      expect(() => sky.updateBefore(frame)).toThrow("draw failed");
      expect(renderer.getRenderTarget()).toBeNull();
      sky.updateBefore(frame);
      expect(refresh).toHaveBeenCalledTimes(3);
    } finally {
      sky.dispose();
      vi.restoreAllMocks();
    }
    expect(() => sky.updateBefore(frame)).toThrow("disposed");
  });

  it("keeps CPU and GPU environment fog colours independent of clouds", async () => {
    // CPU environment writes need only an ImageData canvas; no browser or GPU.
    class Canvas {
      pixels = new Uint8ClampedArray(0);
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return {
          createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
          putImageData: (image: { data: Uint8ClampedArray }) => {
            this.pixels = image.data;
          },
        };
      }
    }
    vi.stubGlobal("OffscreenCanvas", Canvas);
    try {
      // sky.ts is an overlay: its heightFog.js arrives only when a starter is scaffolded.
      const source = readFileSync(
        new URL("../unreal-look/scaffold/render/sky.ts", import.meta.url),
        "utf8",
      );
      expect(source.indexOf("data: radiance.slice()")).toBeLessThan(
        source.indexOf("if (clouds) bakeCloudRadiance"),
      );
      expect(source).toContain("texture.userData.clearRadiance = clearRadiance");
      expect(source).toContain("atmosphereFogColour(sky.userData.clearRadiance)");
      for (const degrees of [60, 15]) {
        const elevation = (degrees * Math.PI) / 180;
        const sun = new Vector3(Math.cos(elevation), Math.sin(elevation), 0);
        const a = createGpuSky(new Scene(), sun, true, false);
        const b = createGpuSky(new Scene(), sun, true, true);
        try {
          expect(a).toBeDefined();
          expect(b).toBeDefined();
          const clearFog = atmosphereFogColour(a?.environment.userData.clearRadiance);
          const cloudyFog = atmosphereFogColour(b?.environment.userData.clearRadiance);
          expect(cloudyFog.toArray()).toEqual(clearFog.toArray());
          expect(clearFog.b).toBeGreaterThan(clearFog.r * 2);
          expect(b?.environment.image.pixels).not.toEqual(a?.environment.image.pixels);
        } finally {
          a?.node.dispose();
          b?.node.dispose();
          a?.environment.dispose();
          b?.environment.dispose();
        }
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("round-trips zenith and sun-relative longitude, including the grazing view", () => {
    for (const zenith of [0, 0.3, Math.PI / 2, 1.575, 2, Math.PI])
      for (const longitude of [0, 0.5, Math.PI, 2 * Math.PI]) {
        const [u, v] = skyAnglesToUv(zenith, longitude);
        const [z, a] = skyUvToAngles(u, v);
        expect(z).toBeCloseTo(zenith, 12);
        expect(a).toBeCloseTo(longitude, 12);
      }
  });

  it("evaluates GPU medium and phase expressions against CPU formulas", () => {
    for (const h of [0, 0.06, 5, 15, 25, 40, 60]) {
      const cpu = medium(h);
      const gpu = gpuMedium(float(h));
      evaluate(gpu.ray).forEach((v: number, c: number) =>
        expect(v).toBeCloseTo(cpu.ray[c] ?? 0, 12),
      );
      expect(evaluate(gpu.mie)[0]).toBeCloseTo(cpu.mie, 12);
      evaluate(gpu.ext).forEach((v: number, c: number) =>
        expect(v).toBeCloseTo(cpu.ext[c] ?? 0, 12),
      );
    }
    const sun = new Vector3(0.5, Math.sqrt(0.75), 0);
    for (const d of [new Vector3(0, 1, 0), new Vector3(1, 0, 0), new Vector3(0, -1, 0)]) {
      const cosine = d.dot(sun);
      expect(evaluate(gpuHg(float(cosine), MIE_G))[0]).toBeCloseTo(
        (1 - MIE_G ** 2) / (4 * Math.PI * (1 + MIE_G ** 2 - 2 * MIE_G * cosine) ** 1.5),
        12,
      );
    }
  });

  it("measures the retained low-resolution environment bake", () => {
    const sun = { x: 0.5, y: Math.sqrt(0.75), z: 0 };
    const start = performance.now();
    const data = bakeSkyRadiance(sun, 64, 32);
    const lowMs = performance.now() - start;
    const fullStart = performance.now();
    bakeSkyRadiance(sun, 256, 128);
    const fullMs = performance.now() - fullStart;
    console.log(
      `CPU environment 64x32: ${lowMs.toFixed(1)} ms; full CPU sky 256x128: ${fullMs.toFixed(1)} ms; removed ${(fullMs - lowMs).toFixed(1)} ms in node`,
    );
    expect(data.length).toBe(64 * 32 * 3);
    expect(data.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  });
});
