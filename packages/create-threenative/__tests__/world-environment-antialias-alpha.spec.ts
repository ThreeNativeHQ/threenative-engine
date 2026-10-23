import { PerspectiveCamera, Scene } from "three";
import { vec4 } from "three/tsl";
import type { Node } from "three/webgpu";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type ChainStage,
  type IWorldEnvironmentOptions,
  type OutputRenderer,
  WorldEnvironment,
} from "../template-assets/worldEnvironment.js";

type ChainOptions = Parameters<NonNullable<OutputRenderer["createRenderChain"]>>[0];

beforeEach(() => {
  // SMAA loads its two lookup images when it is built.
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      onload = () => {};
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function antialiasStage(options: IWorldEnvironmentOptions): ChainStage {
  let chain: ChainOptions | undefined;
  const renderer: OutputRenderer = {
    kind: "webgpu",
    raw: { info: { engine: {} } },
    createRenderChain(received) {
      chain = received;
      return { applied: { stages: received.request?.stages ?? [], dropped: [] }, dispose() {} };
    },
  };
  new WorldEnvironment(options).apply(renderer, new Scene(), new PerspectiveCamera());
  const stage = chain?.stages?.find((entry) => entry.name === "antialias");
  if (stage === undefined) throw new Error("antialias stage missing");
  return stage;
}

const kind = (node: unknown): string => (node as object).constructor.name;
const children = (node: unknown): Node[] => [
  ...(node as { getChildren(): Iterable<Node> }).getChildren(),
];

/**
 * Follows the alpha channel of a vec4 node down through its wrappers and joins. It stops at the node alpha is read from, or at
 * the first operation that computes it (a division, for example).
 */
function alphaSource(node: Node): Node {
  let current = node;
  for (;;) {
    if (kind(current) === "VarNode") current = children(current)[0] as Node;
    else if (kind(current) === "JoinNode") current = children(current).at(-1) as Node;
    else if (kind(current) === "SplitNode" && Reflect.get(current, "components") === "w")
      return children(current)[0] as Node;
    else return current;
  }
}

/** The alpha of an antialias stage is the filter's own: no squeeze scales it on the way in or out. */
for (const filter of ["smaa", "fxaa"] as const) {
  it(`${filter} filters alpha as drawn and never scales it with the colour's weight`, () => {
    const stage = antialiasStage({ screenSpaceAA: filter });
    const input = vec4(100000, 100000, 100000, 1) as unknown as Node;
    const out = stage.build(input as never, {} as never) as unknown as Node;
    // On the way out: alpha comes from the filter node, not from a division.
    const filtered = alphaSource(out);
    expect(kind(filtered)).toBe(filter === "smaa" ? "SMAANode" : "FXAANode");
    // On the way in: the texture the filter reads carries the frame's own alpha.
    const rendered = children(filtered)[0] as Node;
    expect(alphaSource(children(rendered).at(-1) as Node)).toBe(input);
  });
}
