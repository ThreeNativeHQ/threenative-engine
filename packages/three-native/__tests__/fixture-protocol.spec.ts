import { describe, expect, it } from "vitest";

import type { FixtureArg, FixtureNumberName, IFixture } from "../src/fixture-format.js";
import {
  decodeArg,
  decodeNumbers,
  decodeText,
  encodeArg,
  encodeFixture,
  encodeObservation,
  namedNumber,
  parseReply,
} from "../src/fixture-protocol.js";

/** Every argument the format can carry, including the three JSON cannot write. */
const ARGUMENTS: readonly FixtureArg[] = [
  0,
  -0,
  1.5,
  -1 / 3,
  Number.NaN,
  { num: "Infinity" },
  { num: "-Infinity" },
  { num: "-0" },
  "plain",
  "three r160 → 0.185.1",
  "",
  true,
  false,
  null,
  { ref: "m" },
  { refs: ["bone0", "bone1"] },
  { refs: [] },
  { array: [0, 1, 65535, 3], type: "Uint16Array" },
  { array: [0.25, -0, 1e-30], type: "Float32Array" },
  { array: [], type: "Uint8Array" },
  { record: { depth: 0.026, bevelEnabled: true, name: "a=b;c d", extrudePath: null } },
  { record: {} },
];

describe("argument encoding", () => {
  it("encodes a gltf op as its id and percent-encoded path", () => {
    const lines = encodeFixture({
      ...({} as IFixture),
      name: "g",
      adaptedFrom: "original",
      tolerance: { abs: 0 },
      ops: [{ op: "gltf", id: "model", file: "examples/a b/model.glb" }],
      observe: [],
    });
    expect(lines).toContain("gltf model s:examples%2Fa%20b%2Fmodel.glb");
  });

  it("refuses a record field that is not a scalar", () => {
    expect(() => decodeArg("o:shape=r:s")).toThrow("TN_PROTOCOL_ARG_INVALID");
    expect(() => decodeArg("o:depth")).toThrow("TN_PROTOCOL_ARG_INVALID");
  });

  it("refuses an array token that names no typed array", () => {
    expect(() => decodeArg("a:Int64Array:0000000000000000")).toThrow("TN_PROTOCOL_ARG_INVALID");
  });

  it("round-trips every argument type", () => {
    for (const argument of ARGUMENTS) {
      const encoded = encodeArg(argument);
      expect(encoded, `${String(argument)} must not contain a space`).not.toContain(" ");
      const decoded = decodeArg(encoded);
      // The wire carries the value, not the JSON spelling: `{ "num": "NaN" }` comes back as NaN.
      const expected =
        typeof argument === "object" && argument !== null && "num" in argument
          ? namedNumber(argument.num as FixtureNumberName)
          : argument;
      if (typeof expected === "number" && Number.isNaN(expected))
        expect(Number.isNaN(decoded as number)).toBe(true);
      else expect(decoded).toEqual(expected);
    }
  });

  it("keeps -0 distinct from 0", () => {
    expect(encodeArg(-0)).toBe("n:8000000000000000");
    expect(encodeArg(0)).toBe("n:0000000000000000");
    expect(Object.is(decodeArg("n:8000000000000000") as number, -0)).toBe(true);
    expect(Object.is(decodeArg("n:0000000000000000") as number, -0)).toBe(false);
  });

  it("keeps NaN, Infinity and -0 on the wire", () => {
    expect(encodeArg({ num: "NaN" })).toBe("n:7ff8000000000000");
    expect(encodeArg({ num: "Infinity" })).toBe("n:7ff0000000000000");
    expect(encodeArg({ num: "-Infinity" })).toBe("n:fff0000000000000");
    expect(encodeArg({ num: "-0" })).toBe("n:8000000000000000");
  });

  it("percent-encodes a string so no token can hold a space", () => {
    expect(encodeArg("a b/c")).toBe("s:a%20b%2Fc");
    expect(decodeArg(encodeArg("a b/c"))).toBe("a b/c");
  });

  it("refuses a token the protocol does not define", () => {
    expect(() => decodeArg("x:1")).toThrow(/TN_PROTOCOL_ARG_INVALID/u);
    expect(() => decodeArg("n:0")).toThrow(/TN_FIXTURE_BITS_INVALID/u);
    expect(() => decodeArg("r:")).toThrow(/TN_PROTOCOL_ARG_INVALID/u);
  });
});

describe("observation values", () => {
  it("writes numbers as binary64 bits with a decimal beside them", () => {
    expect(encodeObservation("number", -0)).toEqual({ value: "n:8000000000000000", decimal: "-0" });
    expect(encodeObservation("numbers", [1, -0, Number.POSITIVE_INFINITY])).toEqual({
      value: "n:3ff0000000000000,n:8000000000000000,n:7ff0000000000000",
      decimal: "1, -0, Infinity",
    });
  });

  it("reads a number list back in order, -0 and NaN included", () => {
    const values = decodeNumbers(encodeObservation("numbers", [-0, Number.NaN, 2]).value);
    expect(Object.is(values[0], -0)).toBe(true);
    expect(Number.isNaN(values[1] as number)).toBe(true);
    expect(values[2]).toBe(2);
  });

  it("writes booleans, strings and canonical JSON", () => {
    expect(encodeObservation("boolean", false).value).toBe("b:0");
    expect(encodeObservation("string", "YZX").value).toBe("s:YZX");
    expect(encodeObservation("json", { b: 1, a: 2 }).value).toBe(
      "s:%7B%22a%22%3A2%2C%22b%22%3A1%7D",
    );
    expect(decodeText(encodeObservation("json", { b: 1, a: 2 }).value)).toBe('{"a":2,"b":1}');
  });

  it("refuses a value whose type does not match its kind", () => {
    expect(() => encodeObservation("number", "1")).toThrow(/TN_OBSERVATION_INVALID/u);
    expect(() => encodeObservation("numbers", 1)).toThrow(/TN_OBSERVATION_INVALID/u);
    expect(() => encodeObservation("numbers", new DataView(new ArrayBuffer(8)))).toThrow(
      /TN_OBSERVATION_INVALID/u,
    );
    expect(() => encodeObservation("numbers", ["1"])).toThrow(/TN_OBSERVATION_INVALID/u);
    expect(() => encodeObservation("boolean", 0)).toThrow(/TN_OBSERVATION_INVALID/u);
    expect(() => encodeObservation("string", 1)).toThrow(/TN_OBSERVATION_INVALID/u);
  });
});

describe("the fixture script", () => {
  const fixture: IFixture = {
    name: "sample",
    adaptedFrom: "original",
    tolerance: { abs: 0 },
    ops: [
      { op: "new", id: "m", class: "Matrix4", args: [] },
      { op: "call", id: "m", method: "makeRotationX", args: [0.5] },
      { op: "new", id: "v", class: "Vector3", args: [1, 2, 3] },
      { op: "call", id: "v", method: "applyMatrix4", args: [{ ref: "m" }], result: "v2" },
      { op: "set", id: "v", path: "position.x", value: -0 },
    ],
    observe: [
      { id: "m", path: "elements", kind: "numbers" },
      { id: "v2", method: "length", kind: "number" },
      { id: "v2", kind: "numbers" },
    ],
  };

  it("writes one command per line, with `-` for an absent result or source", () => {
    expect(encodeFixture(fixture)).toEqual([
      "fixture sample",
      "new m Matrix4",
      "call m makeRotationX - n:3fe0000000000000",
      "new v Vector3 n:3ff0000000000000 n:4000000000000000 n:4008000000000000",
      "call v applyMatrix4 v2 r:m",
      "set v position.x n:8000000000000000",
      "observe 0 m elements - numbers",
      "observe 1 v2 - length number",
      "observe 2 v2 - - numbers",
      "end",
    ]);
  });
});

describe("driver replies", () => {
  it("reads an observation reply", () => {
    expect(parseReply("obs 3 numbers n:3ff0000000000000,n:8000000000000000")).toEqual({
      kind: "obs",
      index: 3,
      observation: "numbers",
      value: "n:3ff0000000000000,n:8000000000000000",
    });
  });

  it("reads an unsupported reply with and without an index", () => {
    expect(parseReply("unsupported 2 no%20such%20method")).toEqual({
      kind: "unsupported",
      index: 2,
      reason: "no such method",
    });
    expect(parseReply("unsupported - not%20built%20in")).toEqual({
      kind: "unsupported",
      index: null,
      reason: "not built in",
    });
  });

  it("reads an error reply", () => {
    expect(parseReply("error TN_NATIVE_ENGINE_UNAVAILABLE%3A%20no%20engine")).toEqual({
      kind: "error",
      message: "TN_NATIVE_ENGINE_UNAVAILABLE: no engine",
    });
  });

  it("refuses a line that is not a reply, so a wrong driver cannot read as a pass", () => {
    expect(() => parseReply("")).toThrow(/TN_PROTOCOL_REPLY_INVALID/u);
    expect(() => parseReply("obs 0 colour s:red")).toThrow(/TN_PROTOCOL_REPLY_INVALID/u);
    expect(() => parseReply("obs 0 number")).toThrow(/TN_PROTOCOL_REPLY_INVALID/u);
    expect(() => parseReply("everything is fine")).toThrow(/TN_PROTOCOL_REPLY_INVALID/u);
  });
});

describe("the render line", () => {
  const fixture = {
    name: "render-order",
    adaptedFrom: "original",
    tolerance: { abs: 0 },
    render: {
      scene: "scene",
      camera: "camera",
      width: 4,
      height: 2,
      toneMapping: "aces",
      toneMappingExposure: 1,
      outputColorSpace: "srgb",
    },
    ops: [{ op: "new", id: "scene", class: "Scene", args: [] }],
    observe: [
      { id: "camera", path: "projectionMatrix.elements", kind: "numbers" },
      {
        id: "scene",
        kind: "pixels",
        metric: { maxPixelMismatchRatio: 0.01, maxPerceptualDeltaE: 0.02 },
      },
    ],
  } as unknown as IFixture;

  it("comes after the numeric observations and right before the pixels one", () => {
    // Rendering switches the camera to WebGPU clip space; the reference takes its numbers in Node.
    const lines = encodeFixture(fixture, "/tmp/frame.png");
    const render = lines.findIndex((line) => line.startsWith("render "));
    expect(lines[render - 1]).toMatch(/^observe 0 camera /u);
    expect(lines[render + 1]).toMatch(/^observe 1 scene - - pixels$/u);
    expect(lines[render]).toBe(
      `render scene camera 4 2 aces ${encodeArg(1)} srgb s:${encodeURIComponent("/tmp/frame.png")}`,
    );
  });

  it("is absent without a frame path, so a driver that cannot render is never asked", () => {
    expect(encodeFixture(fixture).some((line) => line.startsWith("render "))).toBe(false);
  });
});
