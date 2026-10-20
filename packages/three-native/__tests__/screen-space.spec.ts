import { describe, expect, it } from "vitest";
import { type IScreenSpaceTsl, defineScreenSpaceReflections } from "../src/addons/screen-space.js";

/** A node that answers every property read and call with another node: enough to run the graph body. */
function chain(): unknown {
  const node: unknown = new Proxy(() => undefined, {
    get: (_target, key) => (key === "then" ? undefined : node),
    apply: () => node,
  });
  return node;
}

/** The engine TSL table as the effect uses it; the scene camera's projection must come from `uniform`. */
function stubTsl() {
  const updates: (() => number)[] = [];
  const initial: number[] = [];
  const read: string[] = [];
  const names: readonly (keyof IScreenSpaceTsl)[] = [
    "clamp",
    "dot",
    "float",
    "int",
    "max",
    "min",
    "mix",
    "normalize",
    "reflect",
    "rtt",
    "smoothstep",
    "uv",
    "vec2",
    "vec3",
    "vec4",
  ];
  const tsl: Record<string, unknown> = Object.fromEntries(
    names.map((name) => [name, () => chain()]),
  );
  tsl.Break = () => undefined;
  tsl.Fn = (body: () => unknown) => () => body();
  tsl.If = (_condition: unknown, body: () => void) => {
    body();
    return { Else: (other: () => void) => other() };
  };
  tsl.Loop = (_options: unknown, body: (indices: { i: unknown }) => void) => body({ i: chain() });
  tsl.uniform = (value: number) => {
    initial.push(value);
    const node = chain() as { onRenderUpdate?: unknown };
    return new Proxy(node as object, {
      get: (target, key) =>
        key === "onRenderUpdate"
          ? (callback: () => number) => {
              updates.push(callback);
              return target;
            }
          : (target as Record<string | symbol, unknown>)[key],
    });
  };
  // The quad's own orthographic camera: reading these is the bug this test pins.
  for (const name of ["cameraProjectionMatrix", "cameraNear", "cameraFar"])
    Object.defineProperty(tsl, name, {
      get: () => {
        read.push(name);
        return chain();
      },
    });
  return { tsl: tsl as unknown as IScreenSpaceTsl, updates, initial, read };
}

describe("defineScreenSpaceReflections", () => {
  const camera = {
    near: 0.25,
    projectionMatrix: { elements: Array.from({ length: 16 }, (_, i) => i + 1) },
  };

  it("reads the scene camera's projection through uniforms refreshed every render", () => {
    const { tsl, updates, initial, read } = stubTsl();
    defineScreenSpaceReflections(tsl)(chain(), chain(), chain(), { camera });
    // The six projection terms and the near plane, taken from the camera, not from the quad's own.
    expect(initial).toContain(1);
    expect(initial).toEqual(expect.arrayContaining([1, 6, 9, 10, 11, 15, 0.25]));
    expect(read).toEqual([]);
    camera.projectionMatrix.elements[10] = 99;
    camera.near = 0.5;
    expect(updates.map((update) => update())).toEqual(expect.arrayContaining([99, 0.5]));
  });

  it("refuses a call that names no camera", () => {
    const { tsl } = stubTsl();
    expect(() => defineScreenSpaceReflections(tsl)(chain(), chain(), chain(), {} as never)).toThrow(
      /TN_NATIVE_SSR_CAMERA/,
    );
  });
});
