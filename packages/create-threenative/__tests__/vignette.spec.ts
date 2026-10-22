import { readFileSync } from "node:fs";
import path from "node:path";
import { PerspectiveCamera, Scene } from "three";
import { vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEMPLATE_ROOT, templatesShipping } from "../../../test-support/templates.js";
import type { OutputRenderer, WorldEnvironment } from "../template-assets/worldEnvironment.js";

/**
 * The vignette stage of every `worldEnvironment.ts` a game can start from.
 *
 * Unreal 5.8.3 multiplies the exposed linear colour and the bloom by the vignette mask and nothing
 * else (`Engine/Shaders/Private/PostProcessTonemap.usf`). The mask is the `CosineFourthLaw` of
 * `Engine/Shaders/Private/PostProcessCommon.ush`, and `VignetteIntensity` is 0.4 by default
 * (`Engine/Source/Runtime/Engine/Private/Scene.cpp`).
 *
 * The first port multiplied the whole `vec4`. That scaled the alpha too, the canvas composites on
 * alpha, and the emissive sphere at the edge of the frame came out at 210 where Unreal draws 246.
 * No chain stage failed. These tests build the real stage and run its node graph at chosen pixels.
 */

interface IGraph {
  readonly constructor: { readonly name: string };
  readonly aNode?: IGraph;
  readonly bNode?: IGraph;
  readonly cNode?: IGraph;
  readonly node?: IGraph;
  readonly nodes?: readonly IGraph[];
  readonly components?: string;
  readonly method?: string;
  readonly op?: string;
  readonly scope?: string;
  readonly value?: unknown;
  readonly _attributeName?: string;
}
type Value = readonly number[];
interface IPixel {
  readonly width: number;
  readonly height: number;
  readonly u: number;
  readonly v: number;
}
type Next = (input: IGraph | undefined) => Value;

function unsupported(what: string): never {
  throw new Error(`the vignette spec cannot evaluate ${what}`);
}

function broadcast(a: Value, b: Value, f: (x: number, y: number) => number): Value {
  const length = Math.max(a.length, b.length);
  if (![a.length, b.length].every((size) => size === 1 || size === length))
    return unsupported("these vector sizes together");
  return Array.from({ length }, (_, i) =>
    f(a[a.length === 1 ? 0 : i] as number, b[b.length === 1 ? 0 : i] as number),
  );
}

const OPERATORS: Record<string, (x: number, y: number) => number> = {
  "+": (x, y) => x + y,
  "-": (x, y) => x - y,
  "*": (x, y) => x * y,
  "/": (x, y) => x / y,
};
const HANDLERS: Record<string, (node: IGraph, next: Next, pixel: IPixel) => Value> = {
  VarNode: (node, next) => next(node.node),
  ConstNode: ({ value }) =>
    typeof value === "number" ? [value] : (value as { toArray(): number[] }).toArray(),
  SplitNode: (node, next) => {
    const source = next(node.node);
    return [...(node.components ?? "")].map((c) => source["xyzw".indexOf(c)] as number);
  },
  JoinNode: (node, next) => (node.nodes ?? []).flatMap((input) => next(input)),
  ScreenNode: (node, _, pixel) =>
    node.scope === "size" ? [pixel.width, pixel.height] : unsupported(`screen ${node.scope}`),
  AttributeNode: (node, _, pixel) =>
    node._attributeName === "uv"
      ? [pixel.u, pixel.v]
      : unsupported(`attribute ${node._attributeName}`),
  OperatorNode: (node, next) =>
    broadcast(
      next(node.aNode),
      next(node.bNode),
      OPERATORS[node.op ?? ""] ?? unsupported(`operator ${node.op}`),
    ),
  MathNode: (node, next) => {
    const a = next(node.aNode);
    if (node.method === "sqrt") return a.map(Math.sqrt);
    if (node.method === "length") return [Math.hypot(...a)];
    if (node.method === "oneMinus") return a.map((x) => 1 - x);
    if (node.method === "smoothstep") {
      const high = next(node.bNode);
      const t = broadcast(next(node.cNode), a, (x, low) =>
        Math.min(1, Math.max(0, (x - low) / ((high[0] as number) - low))),
      );
      return t.map((x) => x * x * (3 - 2 * x));
    }
    if (node.method === "pow") return broadcast(a, next(node.bNode), Math.pow);
    if (node.method === "dot")
      return [broadcast(a, next(node.bNode), (x, y) => x * y).reduce((sum, x) => sum + x)];
    return unsupported(`math ${node.method}`);
  },
};

/** The value of a TSL expression graph at one pixel. A node it does not know fails the test. */
function evaluate(node: IGraph, pixel: IPixel): Value {
  const handler = HANDLERS[node.constructor.name] ?? unsupported(`node ${node.constructor.name}`);
  return handler(
    node,
    (input) => evaluate(input ?? unsupported(`a ${node.constructor.name} without an input`), pixel),
    pixel,
  );
}

const INPUT = [0.8, 0.5, 0.2] as const;
/** Builds the copy's own vignette stage for `intensity` and returns the frame it makes of one pixel. */
async function vignette(file: string, intensity: number, alpha: number) {
  const { WorldEnvironment: Environment } = (await import(/* @vite-ignore */ file)) as {
    WorldEnvironment: typeof WorldEnvironment;
  };
  let graph: Node | undefined;
  const renderer: OutputRenderer = {
    kind: "webgpu",
    raw: {},
    createRenderChain(options) {
      const stage = options.stages?.find((entry) => entry.name === "vignette");
      if (stage === undefined) throw new Error(`${file} has no vignette stage`);
      graph = stage.build(vec4(...INPUT, alpha), { tier: "high" }) as Node;
      return { applied: { stages: [], dropped: [] }, dispose() {} };
    },
  };
  new Environment({ vignetteAmount: intensity }).apply(
    renderer,
    new Scene(),
    new PerspectiveCamera(),
  );
  if (graph === undefined) throw new Error(`${file} never built its vignette stage`);
  const built = graph as unknown as IGraph;
  return (pixel: IPixel) => evaluate(built, pixel);
}

/** `cos^4` of the view angle whose tangent is the lens radius: the law in its own words. */
function cosineFourth(intensity: number, { width, height, u, v }: IPixel): number {
  const aspect = height / width;
  // The lens is scaled so that the corner of the frame lies on a circle of radius sqrt 2.
  const scale = Math.SQRT2 / Math.hypot(1, aspect);
  const radius = Math.hypot((u - 0.5) * 2, (v - 0.5) * 2 * aspect) * scale;
  return Math.cos(Math.atan(intensity * radius)) ** 4;
}

// `apply` prints the `TN_WORLD_ENVIRONMENT` report of every chain it builds.
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const COPIES = [
  {
    name: "template-assets",
    file: path.resolve("packages/create-threenative/template-assets/worldEnvironment.ts"),
  },
  ...templatesShipping("src/render/worldEnvironment.ts").map((template) => ({
    name: template,
    file: path.join(TEMPLATE_ROOT, template, "src/render/worldEnvironment.ts"),
  })),
];
const FRAMES = [
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 720, height: 1280 },
] as const;

describe.each(COPIES)("$name vignette stage", ({ file }) => {
  it("scales the colour by the mask and leaves the alpha alone, at the centre, the edge and the corner", async () => {
    const frame = await vignette(file, 0.4, 0.6);
    for (const [u, v] of [
      [0.5, 0.5],
      [1, 0.5],
      [0.5, 1],
      [1, 1],
      [0, 0],
    ] as const) {
      const [r, g, b, a] = frame({ width: 1280, height: 720, u, v }) as [
        number,
        number,
        number,
        number,
      ];
      expect(a, `alpha at ${u},${v}`).toBe(0.6);
      const mask = r / INPUT[0];
      expect(g / INPUT[1], `green at ${u},${v}`).toBeCloseTo(mask, 9);
      expect(b / INPUT[2], `blue at ${u},${v}`).toBeCloseTo(mask, 9);
    }
  });

  it("is Unreal's default at the corner: 1 over (1 + 2 * 0.4^2)^2, at any aspect ratio", async () => {
    const frame = await vignette(file, 0.4, 1);
    for (const { width, height } of FRAMES) {
      const [r] = frame({ width, height, u: 1, v: 1 });
      expect((r as number) / INPUT[0], `${width}x${height}`).toBeCloseTo(0.57392, 4);
    }
  });

  it("follows the cosine-fourth law between the centre and the corner", async () => {
    const intensity = 0.4;
    const frame = await vignette(file, intensity, 1);
    const [centre] = frame({ width: 1280, height: 720, u: 0.5, v: 0.5 });
    expect(centre).toBeCloseTo(INPUT[0], 9);
    // The middle of the long edge of a 16:9 frame: lens radius 1.2326, mask 0.6471.
    const [edge] = frame({ width: 1280, height: 720, u: 1, v: 0.5 });
    expect((edge as number) / INPUT[0]).toBeCloseTo(0.64713, 4);
    for (const size of FRAMES)
      for (const [u, v] of [
        [0.5, 0.5],
        [0.75, 0.5],
        [1, 0.5],
        [0.5, 1],
        [0.9, 0.8],
        [1, 1],
      ] as const) {
        const pixel = { ...size, u, v };
        const [r] = frame(pixel);
        expect((r as number) / INPUT[0], `${size.width}x${size.height} at ${u},${v}`).toBeCloseTo(
          cosineFourth(intensity, pixel),
          9,
        );
      }
  });

  it("takes its strength from the option, so 0.2 darkens less than 0.4", async () => {
    const pixel = { width: 1280, height: 720, u: 1, v: 1 };
    const [mild] = (await vignette(file, 0.2, 1))(pixel);
    const [strong] = (await vignette(file, 0.4, 1))(pixel);
    expect(mild as number).toBeCloseTo(INPUT[0] * cosineFourth(0.2, pixel), 9);
    expect(mild as number).toBeGreaterThan(strong as number);
  });
});

describe("the reference harness scaffold", () => {
  // Its `worldEnvironment.ts` cannot load alone: the sibling stages come from the starter at capture
  // time. So the one line that decides the alpha is read from source.
  it("builds its vignette stage from the colour channels and passes the alpha through", () => {
    const source = readFileSync("scripts/unreal-look/scaffold/render/worldEnvironment.ts", "utf8");
    const stage = /name: "vignette",[\s\S]*?build: \(input\) => \{([\s\S]*?)\n {8}\},/u.exec(
      source,
    )?.[1];
    expect(stage, "the vignette stage was not found").toBeDefined();
    expect(stage).toMatch(
      /return vec4\(colour\.rgb\.mul\(vignetteMask\(options\.vignetteAmount\)\), colour\.a\);/u,
    );
  });
});
