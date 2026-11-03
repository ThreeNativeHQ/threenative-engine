import { BufferGeometry, Mesh } from "three";
import { float, positionLocal, vec2 } from "three/tsl";
import { MeshBasicNodeMaterial, WGSLNodeBuilder } from "three/webgpu";
import { describe, expect, it } from "vitest";
import { WaveField } from "../src/wave-field.js";

const options = {
  waves: [
    {
      amplitude: 0.42,
      direction: [1, 0] as const,
      wavelength: 7,
      speed: 0.8,
      phase: 0.2,
      steepness: 0.14,
    },
    { amplitude: 0.18, direction: [0.2, 1] as const, wavelength: 2.8, speed: -0.35, phase: -0.6 },
  ],
  domainWarp: [
    {
      direction: [0.8, 0.6] as const,
      displacement: [0.16, -0.08] as const,
      wavelength: 11,
      speed: 0.25,
      phase: 0.4,
    },
  ],
};

type NumericValue = number | readonly number[];

interface IWaveNode {
  readonly isNode?: boolean;
  readonly isAssignNode?: boolean;
  readonly isConstNode?: boolean;
  readonly isJoinNode?: boolean;
  readonly isMathNode?: boolean;
  readonly isOperatorNode?: boolean;
  readonly isSplitNode?: boolean;
  readonly isStackNode?: boolean;
  readonly isUniformNode?: boolean;
  readonly isVarNode?: boolean;
  readonly node?: IWaveNode;
  readonly nodes?: readonly IWaveNode[];
  readonly outputNode?: IWaveNode | null;
  readonly value?: unknown;
  readonly components?: string;
  readonly op?: string;
  readonly method?: string;
  readonly aNode?: IWaveNode;
  readonly bNode?: IWaveNode | null;
  readonly targetNode?: IWaveNode;
  readonly sourceNode?: IWaveNode;
  readonly getOutputNode?: (builder: unknown) => unknown;
}

// r187 TSL returns the call node itself; the r185 proxy wrapper (`.node`) is gone.
interface IWaveGraphInternals {
  readonly shaderNode?: {
    readonly jsFunc?: unknown;
  };
  readonly getOutputNode?: (builder: unknown) => unknown;
}

function graphShaderSource(graph: unknown): string {
  const shaderNode = (graph as IWaveGraphInternals).shaderNode;
  if (typeof shaderNode?.jsFunc !== "function")
    throw new Error("wave graph shader function missing");
  return String(shaderNode.jsFunc);
}

function requireNode(value: unknown, name: string): IWaveNode {
  if (typeof value !== "object" || value === null || (value as IWaveNode).isNode !== true)
    throw new Error(`${name} is not a TSL node.`);
  return value as IWaveNode;
}

function numericValue(value: unknown, name: string): NumericValue {
  if (typeof value === "number") return value;
  if (Array.isArray(value) && value.every((component) => typeof component === "number"))
    return value as number[];
  throw new Error(`${name} is not a numeric TSL value.`);
}

function components(value: NumericValue): readonly number[] {
  return typeof value === "number" ? [value] : value;
}

function binaryOperation(
  left: NumericValue,
  right: NumericValue,
  operation: (left: number, right: number) => number,
): NumericValue {
  if (typeof left === "number" && typeof right === "number") return operation(left, right);
  const leftComponents = components(left);
  const rightComponents = components(right);
  const length = Math.max(leftComponents.length, rightComponents.length);
  if (
    ![leftComponents.length, rightComponents.length].every((size) => size === 1 || size === length)
  )
    throw new Error("TSL numeric evaluator cannot broadcast these vector sizes.");
  return Array.from({ length }, (_, index) =>
    operation(
      leftComponents[leftComponents.length === 1 ? 0 : index] as number,
      rightComponents[rightComponents.length === 1 ? 0 : index] as number,
    ),
  );
}

interface IWaveEvaluationContext {
  readonly positionNode: IWaveNode;
  readonly position: readonly [number, number, number];
  readonly values: Map<IWaveNode, NumericValue>;
}

function evaluateTslGraph(
  root: IWaveNode,
  position: readonly [number, number, number],
): NumericValue {
  const context: IWaveEvaluationContext = {
    positionNode: positionLocal as unknown as IWaveNode,
    position,
    values: new Map(),
  };
  return evaluateNode(root, context);
}

function evaluateNode(candidate: IWaveNode, context: IWaveEvaluationContext): NumericValue {
  if (candidate === context.positionNode) return context.position;
  const hoisted = context.values.get(candidate);
  if (hoisted !== undefined && !candidate.isVarNode) return hoisted;
  if (candidate.isStackNode) return evaluateStack(candidate, context);
  if (candidate.isAssignNode) {
    assignNode(candidate, context);
    return 0;
  }
  if (candidate.isVarNode) return evaluateVariable(candidate, context);
  if (candidate.isConstNode || candidate.isUniformNode)
    return numericValue(candidate.value, "TSL constant");
  if (candidate.isSplitNode) return evaluateSplit(candidate, context);
  if (candidate.constructor?.name === "JoinNode") return evaluateJoin(candidate, context);
  if (candidate.isOperatorNode) return evaluateOperator(candidate, context);
  if (candidate.isMathNode) return evaluateMath(candidate, context);
  if (candidate.node !== undefined) return evaluateNode(candidate.node, context);
  throw new Error(
    `TSL numeric evaluator found an unsupported node: ${candidate.constructor?.name ?? "<unknown>"} (${Object.keys(candidate).join(", ")}).`,
  );
}

function evaluateStack(candidate: IWaveNode, context: IWaveEvaluationContext): NumericValue {
  for (const child of candidate.nodes ?? []) {
    if (child.isAssignNode) assignNode(child, context);
    // r187 hoists an expression into a `let` at its stack position; read it once, there, so a
    // later assignment to a variable it reads (the warp moving x and z) cannot change it.
    else if (!child.isVarNode) context.values.set(child, evaluateNode(child, context));
    else evaluateNode(child, context);
  }
  return candidate.outputNode === null || candidate.outputNode === undefined
    ? 0
    : evaluateNode(candidate.outputNode, context);
}

function evaluateVariable(candidate: IWaveNode, context: IWaveEvaluationContext): NumericValue {
  const assigned = context.values.get(candidate);
  if (assigned !== undefined) return assigned;
  const initial = evaluateNode(requireNode(candidate.node, "TSL variable initializer"), context);
  context.values.set(candidate, initial);
  return initial;
}

function evaluateSplit(candidate: IWaveNode, context: IWaveEvaluationContext): NumericValue {
  const source = components(
    evaluateNode(requireNode(candidate.node, "TSL swizzle source"), context),
  );
  const requested = candidate.components;
  if (requested === undefined) throw new Error("TSL swizzle has no components.");
  const indices = [...requested].map((component) => "xyzw".indexOf(component));
  if (indices.some((index) => index < 0))
    throw new Error("TSL numeric evaluator found an invalid swizzle.");
  const first = source[0];
  if (first === undefined) throw new Error("TSL swizzle source is empty.");
  const selected = indices.map((index) => source[index] ?? first);
  return selected.length === 1 ? (selected[0] as number) : selected;
}

function evaluateJoin(candidate: IWaveNode, context: IWaveEvaluationContext): NumericValue {
  const joined = (candidate.nodes ?? []).flatMap((child) =>
    components(evaluateNode(child, context)),
  );
  return joined.length === 1 ? (joined[0] as number) : joined;
}

function evaluateOperator(candidate: IWaveNode, context: IWaveEvaluationContext): NumericValue {
  const left = evaluateNode(requireNode(candidate.aNode, "TSL operator left operand"), context);
  const right = evaluateNode(requireNode(candidate.bNode, "TSL operator right operand"), context);
  switch (candidate.op) {
    case "+":
      return binaryOperation(left, right, (a, b) => a + b);
    case "-":
      return binaryOperation(left, right, (a, b) => a - b);
    case "*":
      return binaryOperation(left, right, (a, b) => a * b);
    case "/":
      return binaryOperation(left, right, (a, b) => a / b);
    default:
      throw new Error(
        `TSL numeric evaluator does not support operator ${candidate.op ?? "<missing>"}.`,
      );
  }
}

function evaluateMath(candidate: IWaveNode, context: IWaveEvaluationContext): NumericValue {
  const value = evaluateNode(requireNode(candidate.aNode, "TSL math operand"), context);
  const unary = (operation: (component: number) => number): NumericValue =>
    typeof value === "number" ? operation(value) : value.map(operation);
  if (candidate.method === "sin") return unary(Math.sin);
  if (candidate.method === "cos") return unary(Math.cos);
  if (candidate.method === "negate") return unary((component) => -component);
  if (candidate.method === "normalize") {
    const parts = components(value);
    const length = Math.hypot(...parts);
    if (length === 0) throw new Error("TSL numeric evaluator cannot normalize a zero vector.");
    return parts.map((component) => component / length);
  }
  throw new Error(
    `TSL numeric evaluator does not support math method ${candidate.method ?? "<missing>"}.`,
  );
}

function assignNode(candidate: IWaveNode, context: IWaveEvaluationContext): void {
  const target = requireNode(candidate.targetNode, "TSL assignment target");
  const source = evaluateNode(requireNode(candidate.sourceNode, "TSL assignment source"), context);
  context.values.set(target, source);
}

function expandTslGraph(graph: unknown): IWaveNode {
  const graphNode = requireNode(graph, "wave graph call");
  if (typeof graphNode.getOutputNode !== "function")
    throw new Error("wave graph output builder missing");
  const object = new Mesh(new BufferGeometry(), new MeshBasicNodeMaterial());
  const renderer = { getMRT: () => null } as unknown as ConstructorParameters<
    typeof WGSLNodeBuilder
  >[1];
  const builder = new WGSLNodeBuilder(object, renderer) as unknown as {
    setBuildStage: (stage: "setup") => void;
    shaderStage: "vertex" | null;
  };
  builder.shaderStage = "vertex";
  builder.setBuildStage("setup");
  return requireNode(graphNode.getOutputNode(builder), "wave graph output");
}

function numberValue(value: NumericValue): number {
  if (typeof value !== "number") throw new Error("wave graph did not return a scalar");
  return value;
}

function displacementHeight(value: NumericValue): number {
  if (!Array.isArray(value) || value.length < 2 || typeof value[1] !== "number")
    throw new Error("wave graph did not return a numeric position vector");
  return value[1];
}

describe("WaveField", () => {
  it("matches CPU samples to numerically evaluated TSL displacement across 64 points and 8 times", () => {
    const field = new WaveField(options);
    const graph = field.displacementNode();
    const graphRoot = expandTslGraph(graph);
    const points = Array.from({ length: 64 }, (_, index) => {
      const column = index % 8;
      const row = Math.floor(index / 8);
      return [(column - 3.5) * 17.25 + row * 0.61, (row - 3.5) * 14.75 - column * 0.43] as const;
    });

    for (const time of [0, 0.17, 1.5, 9.25, 31.75, 64, 128.5, 240]) {
      field.setTime(time);
      for (const [x, z] of points) {
        const expected = field.sample(x, z, time).height;
        const actual = displacementHeight(evaluateTslGraph(graphRoot, [x, 0, z]));
        expect(actual).toBeCloseTo(expected, 4);
      }
    }
  });

  it("contracts the graph's displacement structure and packed wave parameters", () => {
    const field = new WaveField(options);
    const source = graphShaderSource(field.displacementNode());
    const firstWave = options.waves[0];
    if (firstWave === undefined) throw new Error("test wave missing");

    expect(field.parameters[2]).toBeCloseTo(firstWave.amplitude, 5);
    expect(source).toMatch(/positionLocal\.add\([^;]*height[^;]*\)/u);

    // Amplitude, wave number and steepness reach the graph as values, not as spelling: doubling
    // the packed amplitude of every wave doubles what the graph returns at any point.
    const doubled = new WaveField({
      ...options,
      waves: options.waves.map((wave) => ({
        ...wave,
        amplitude: wave.amplitude * 2,
        steepness: (wave.steepness ?? 0) * 2,
      })),
    });
    for (const [x, z] of [
      [0, 0],
      [3.5, -1.25],
      [-7.75, 12.5],
    ] as const) {
      const single = displacementHeight(
        evaluateTslGraph(expandTslGraph(field.displacementNode()), [x, 0, z]),
      );
      const twice = displacementHeight(
        evaluateTslGraph(expandTslGraph(doubled.displacementNode()), [x, 0, z]),
      );
      expect(twice).toBeCloseTo(single * 2, 4);
      expect(single).toBeCloseTo(field.sample(x, z, 0).height, 4);
    }
  });

  it("uses steepness alongside amplitude in both sampled and graph displacement", () => {
    const base = new WaveField({
      waves: [{ amplitude: 0.4, direction: [1, 0], wavelength: 4, speed: 0 }],
    });
    const steep = new WaveField({
      waves: [{ amplitude: 0.4, direction: [1, 0], wavelength: 4, speed: 0, steepness: 0.5 }],
    });
    const baseHeight = base.sample(1, 0, 0).height;
    const steepHeight = steep.sample(1, 0, 0).height;
    expect(steepHeight - baseHeight).toBeCloseTo(0.5 / (Math.PI / 2), 4);
    // The same difference has to show up in the graph, or steepness is a CPU-only parameter.
    const baseGraph = displacementHeight(
      evaluateTslGraph(expandTslGraph(base.displacementNode()), [1, 0, 0]),
    );
    const steepGraph = displacementHeight(
      evaluateTslGraph(expandTslGraph(steep.displacementNode()), [1, 0, 0]),
    );
    expect(steepGraph - baseGraph).toBeCloseTo(0.5 / (Math.PI / 2), 4);
  });

  it("matches CPU sample normals to the numerically evaluated normal graph", () => {
    const field = new WaveField(options);
    const graphRoot = expandTslGraph(
      field.normalNode({ point: vec2(positionLocal.x, positionLocal.z) }),
    );
    for (const time of [0, 0.17, 1.5, 9.25, 31.75]) {
      field.setTime(time);
      for (const [x, z] of [
        [0, 0],
        [3.5, -1.25],
        [-7.75, 12.5],
        [21.25, 4.5],
      ] as const) {
        const expected = field.sample(x, z, time).normal;
        const actual = components(evaluateTslGraph(graphRoot, [x, 0, z]));
        expect(actual[0]).toBeCloseTo(expected.x, 4);
        expect(actual[1]).toBeCloseTo(expected.y, 4);
        expect(actual[2]).toBeCloseTo(expected.z, 4);
      }
    }
  });

  it("fades only the waves marked detail, and only in the graph", () => {
    const waves = [
      { amplitude: 0.5, direction: [1, 0] as const, wavelength: 8, speed: 0 },
      { amplitude: 0.25, detail: true, direction: [0, 1] as const, wavelength: 1.5, speed: 0 },
    ];
    const field = new WaveField({ waves });
    const full = displacementHeight(
      evaluateTslGraph(expandTslGraph(field.displacementNode()), [1.3, 0, 0.7]),
    );
    const faded = evaluateTslGraph(
      expandTslGraph(field.heightNode({ fade: float(0) })),
      [1.3, 0, 0.7],
    );
    const coarseOnly = new WaveField({ waves: [waves[0] as (typeof waves)[0]] });
    // Faded to nothing, the graph is the coarse wave alone; the CPU sample keeps both, always.
    expect(numberValue(faded)).toBeCloseTo(coarseOnly.sample(1.3, 0.7, 0).height, 5);
    expect(full).toBeCloseTo(field.sample(1.3, 0.7, 0).height, 5);
    expect(full).not.toBeCloseTo(numberValue(faded), 3);
  });

  it("returns a flat upward sample for zero waves and rejects malformed entries", () => {
    const flat = new WaveField({ waves: [] });
    const sample = flat.sample(3, -4, 2);
    expect(sample.height).toBe(0);
    expect(sample.normal.toArray()).toEqual([0, 1, 0]);
    expect(
      () =>
        new WaveField({ waves: [{ amplitude: 1, wavelength: 0, direction: [1, 0], speed: 1 }] }),
    ).toThrow(/wavelength/i);
  });
});

describe("WaveField.heightAt", () => {
  /** The same warp count the shader graph exercises, plus a second, ordered warp. */
  const warped = {
    waves: options.waves,
    domainWarp: [
      ...options.domainWarp,
      {
        waveVector: [0.3, -0.9] as const,
        displacement: [-0.22, 0.11] as const,
        speed: -0.4,
        phase: 1.3,
      },
    ],
  };

  it("returns exactly what sample returns, with and without domain warps", () => {
    for (const config of [{ waves: options.waves }, options, warped]) {
      const field = new WaveField(config);
      for (const [x, z, time] of [
        [0, 0, 0],
        [3.5, -8.25, 1.75],
        [-140.125, 91.5, 37.0625],
        [1e4, -1e4, 900],
      ] as const)
        expect(field.heightAt(x, z, time)).toBeCloseTo(field.sample(x, z, time).height, 10);
    }
  });

  it("rejects the same invalid arguments sample rejects, before doing any work", () => {
    const field = new WaveField(warped);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => field.heightAt(bad, 0, 0)).toThrow(/sample\.x/);
      expect(() => field.heightAt(0, bad, 0)).toThrow(/sample\.z/);
      expect(() => field.heightAt(0, 0, bad)).toThrow(/sample\.time/);
    }
  });

  it("computes no gradient and builds no result object for a scalar query", () => {
    const field = new WaveField(warped);
    // Every derivative on this path goes through `Math.cos`: the warp jacobian and each wave's
    // slope. Counting it is a direct observation that the scalar query computes no normal at all,
    // rather than a claim about it. `Math.sin` is the height itself and must be unchanged.
    const cos = Math.cos;
    const sin = Math.sin;
    let cosines = 0;
    let sines = 0;
    Math.cos = (v: number) => {
      cosines += 1;
      return cos(v);
    };
    Math.sin = (v: number) => {
      sines += 1;
      return sin(v);
    };
    try {
      field.sample(1, 2, 3);
      const sampleCosines = cosines;
      const sampleSines = sines;
      expect(sampleCosines).toBeGreaterThan(0);
      cosines = 0;
      sines = 0;
      const scalar = field.heightAt(1, 2, 3);
      expect(typeof scalar).toBe("number");
      expect(cosines).toBe(0);
      expect(sines).toBe(sampleSines);
    } finally {
      Math.cos = cos;
      Math.sin = sin;
    }
    // The vector path still hands every caller its own vector, never a shared scratch one.
    const first = field.sample(1, 2, 3).normal;
    const second = field.sample(1, 2, 3).normal;
    expect(first).not.toBe(second);
    expect(first.equals(second)).toBe(true);
  });

  it("leaves the old sample normals exactly as they were", () => {
    const field = new WaveField(warped);
    // Regression guard on the refactor: the normal is still the normalised analytic gradient,
    // rotated back out through the warp jacobian, and still unit length.
    for (const [x, z, time] of [
      [0, 0, 0],
      [12.5, 4.25, 3.5],
      [-77, 33, 12],
    ] as const) {
      const { normal } = field.sample(x, z, time);
      expect(normal.length()).toBeCloseTo(1, 12);
      expect(normal.y).toBeGreaterThan(0);
      // Central differences of the scalar path reproduce the same slope the normal encodes.
      const h = 1e-4;
      const dx = (field.heightAt(x + h, z, time) - field.heightAt(x - h, z, time)) / (2 * h);
      const dz = (field.heightAt(x, z + h, time) - field.heightAt(x, z - h, time)) / (2 * h);
      expect(normal.x / normal.y).toBeCloseTo(-dx, 4);
      expect(normal.z / normal.y).toBeCloseTo(-dz, 4);
    }
  });
  // `#evaluateCpu` reads a per-wave amplitude precomputed in the constructor instead of dividing
  // per wave per call. That is only free if the stored double is the one the divide produced, so
  // check the height against the original inline expression rather than against itself. No domain
  // warp here: the warp never touched the amplitude, and leaving it out keeps the oracle the wave
  // loop alone.
  it("matches the pre-hoist amplitude expression bit for bit", () => {
    const field = new WaveField({ waves: options.waves });
    const stride = field.parameters.length / field.waves.length;
    const reference = (x: number, z: number, time: number): number => {
      let height = 0;
      for (let index = 0; index < field.waves.length; index += 1) {
        const offset = index * stride;
        const directionX = field.parameters[offset] as number;
        const directionZ = field.parameters[offset + 1] as number;
        const waveNumber = field.parameters[offset + 3] as number;
        const phase =
          waveNumber * (directionX * x + directionZ * z) -
          time * (field.parameters[offset + 4] as number) +
          (field.parameters[offset + 5] as number);
        const amplitude =
          (field.parameters[offset + 2] as number) +
          (field.parameters[offset + 6] as number) / waveNumber;
        height += amplitude * Math.sin(phase);
      }
      return height;
    };
    expect(stride).toBe(8);
    for (let i = 0; i < 60; i++) {
      const x = -400 + i * 13.37;
      const z = 250 - i * 7.91;
      const t = i * 0.37;
      expect(field.heightAt(x, z, t)).toBe(reference(x, z, t));
    }
  });
});
