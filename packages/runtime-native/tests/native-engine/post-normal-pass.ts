/**
 * PRD-526: a post pass that reads the scene's view-space normals (r185 GTAO, as the starter's high
 * tier wires it through `mrt({ output, normal: normalView })`) renders natively. The renderer draws
 * the normal target itself; without it the post graph is refused with TN_POST_INPUT_MISSING.
 * Two frames of the exported AO node: a box standing on a plane (contact occlusion darkens the
 * frame) and the plane alone (nothing to occlude). The normal target itself is read back
 * (TN_FIXTURE_NORMAL_DUMP) and must hold unit view-space normals that match the faces the camera sees,
 * so a pass that wrote nothing (the depth-derived fallback would still draw an AO frame) cannot pass.
 * A transparent box beside it must be skipped by name, not cost the frame.
 * Usage: post-normal-pass.ts <render-driver> <work-dir>
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { PerspectiveCamera, Texture, Vector3 } from "three";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { texture } from "three/tsl";
import type { FixtureOp, IFixture } from "../../../three-native/src/fixture-format.js";
import { encodeFixture, parseReply } from "../../../three-native/src/fixture-protocol.js";
import { exportTslGraph } from "../../scripts/tsl-export.js";

const [driver, work] = process.argv.slice(2);
if (!driver || !work) throw new Error("Usage: post-normal-pass.ts <render-driver> <work-dir>");
const directory = mkdtempSync(path.join(work, "post-normal-"));
const [width, height] = [320, 240];

const camera = new PerspectiveCamera(60, width / height, 0.1, 100);
camera.position.set(2.5, 3, 4.5);
camera.lookAt(0, 0.4, 0);
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();
/** A world direction in the camera's view space, as normalView holds it. */
const viewDirection = (x: number, y: number, z: number): Vector3 =>
  new Vector3(x, y, z).transformDirection(camera.matrixWorldInverse);
const depth = new Texture();
depth.name = "depth";
const normal = new Texture();
normal.name = "normal";
const graph = path.join(directory, "gtao-normals.json");
const occlusion = ao(texture(depth), texture(normal), camera);
occlusion.radius.value = 1; // a unit box's contact shadow, not the default quarter metre
writeFileSync(graph, JSON.stringify(exportTslGraph(occlusion.getTextureNode())));

function fixture(withBox: boolean): IFixture {
  const set = (id: string, field: string, value: number): FixtureOp => ({
    op: "set",
    id,
    path: field,
    value,
  });
  const ops: FixtureOp[] = [
    { op: "new", id: "scene", class: "Scene", args: [] },
    { op: "new", id: "camera", class: "PerspectiveCamera", args: [60, width / height, 0.1, 100] },
    set("camera", "position.x", 2.5),
    set("camera", "position.y", 3),
    set("camera", "position.z", 4.5),
    { op: "call", id: "camera", method: "lookAt", args: [0, 0.4, 0] },
    { op: "call", id: "camera", method: "updateProjectionMatrix", args: [] },
    { op: "new", id: "material", class: "MeshStandardMaterial", args: [] },
    { op: "new", id: "groundGeometry", class: "PlaneGeometry", args: [12, 12] },
    {
      op: "new",
      id: "ground",
      class: "Mesh",
      args: [{ ref: "groundGeometry" }, { ref: "material" }],
    },
    set("ground", "rotation.x", -Math.PI / 2),
    { op: "call", id: "scene", method: "add", args: [{ ref: "ground" }] },
  ];
  if (withBox) {
    ops.push(
      { op: "new", id: "boxGeometry", class: "BoxGeometry", args: [1.2, 1.2, 1.2] },
      { op: "new", id: "box", class: "Mesh", args: [{ ref: "boxGeometry" }, { ref: "material" }] },
      set("box", "position.y", 0.6),
      { op: "call", id: "scene", method: "add", args: [{ ref: "box" }] },
      // Drawn after the opaque pass and never written to the normal target.
      { op: "new", id: "glassMaterial", class: "MeshStandardMaterial", args: [] },
      { op: "set", id: "glassMaterial", path: "transparent", value: true },
      set("glassMaterial", "opacity", 0.4),
      {
        op: "new",
        id: "glass",
        class: "Mesh",
        args: [{ ref: "boxGeometry" }, { ref: "glassMaterial" }],
      },
      set("glass", "position.x", -2),
      set("glass", "position.y", 0.6),
      { op: "call", id: "scene", method: "add", args: [{ ref: "glass" }] },
    );
  }
  ops.push({ op: "call", id: "scene", method: "updateMatrixWorld", args: [true] });
  return {
    name: withBox ? "post-normal-box" : "post-normal-plane",
    adaptedFrom: "original, a GTAO frame over a box on a plane",
    tolerance: { abs: 0 },
    ops,
    render: {
      scene: "scene",
      camera: "camera",
      width,
      height,
      toneMapping: "none",
      toneMappingExposure: 1,
      outputColorSpace: "srgb",
    },
    observe: [
      { id: "scene", kind: "pixels", metric: { maxPixelMismatchRatio: 0, maxPerceptualDeltaE: 0 } },
    ],
  };
}

function half(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** The normal target of the box frame: every written pixel is a unit vector, and the camera's faces appear. */
function checkNormals(file: string): void {
  const bytes = readFileSync(file);
  if (bytes.length !== width * height * 8)
    throw new Error(`TN_POST_NORMAL_DUMP_SIZE: ${bytes.length} bytes`);
  const faces = [
    ["ground and box top", viewDirection(0, 1, 0)],
    ["box +x face", viewDirection(1, 0, 0)],
    ["box +z face", viewDirection(0, 0, 1)],
  ] as const;
  const seen = new Map<string, number>(faces.map(([name]) => [name, 0]));
  let written = 0;
  let nonUnit = 0;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const n = new Vector3(
      half(bytes.readUInt16LE(pixel * 8)),
      half(bytes.readUInt16LE(pixel * 8 + 2)),
      half(bytes.readUInt16LE(pixel * 8 + 4)),
    );
    if (n.lengthSq() === 0) continue;
    written++;
    if (Math.abs(n.length() - 1) > 0.02) nonUnit++;
    for (const [name, expected] of faces)
      if (n.dot(expected) > 0.99) seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  console.info(
    `normal target: ${written} written, ${nonUnit} not unit, faces ${JSON.stringify([...seen])}`,
  );
  if (written < width * height * 0.3)
    throw new Error(`TN_POST_NORMAL_EMPTY: only ${written} pixels hold a normal`);
  if (nonUnit > written * 0.01)
    throw new Error(`TN_POST_NORMAL_NOT_UNIT: ${nonUnit} of ${written}`);
  for (const [name, count] of seen)
    if (count < 100)
      throw new Error(`TN_POST_NORMAL_FACE_MISSING: ${name} has ${count} matching pixels`);
}

/**
 * A frame with a normal pass must draw its colour programs with an invariant position, so the colour
 * and normal passes rasterise the same triangle edges. Depth-only programs stay unflagged.
 */
function checkInvariantPositions(file: string): void {
  const colour = readFileSync(file, "utf8")
    .split(/^### /mu)
    .filter(Boolean)
    .map((entry) => ({ key: entry.slice(0, entry.indexOf("\n")), text: entry }))
    .filter(({ key }) => !key.startsWith("depth|"));
  if (colour.length === 0)
    throw new Error("TN_POST_NORMAL_NO_PROGRAMS: no colour program compiled");
  const plain = colour.filter(({ text }) => !text.includes("@invariant @builtin(position)"));
  if (plain.length > 0)
    throw new Error(
      `TN_POST_NORMAL_NOT_INVARIANT: ${plain.length} of ${colour.length} colour programs lack @invariant: ${plain.map(({ key }) => key).join(", ")}`,
    );
}

/** Pixels whose red channel is below `level`, after the frame drew something at all. */
function darkPixels(name: string, withBox: boolean, level: number): number {
  const png = path.join(directory, `${name}.png`);
  const normals = path.join(directory, `${name}.normal`);
  const programs = path.join(directory, `${name}.programs`);
  const run = spawnSync(driver as string, [], {
    env: {
      ...process.env,
      TN_FIXTURE_POST_GRAPH: graph,
      ...(withBox ? { TN_FIXTURE_NORMAL_DUMP: normals, TN_FIXTURE_PROGRAM_DUMP: programs } : {}),
    },
    input: `${encodeFixture(fixture(withBox), png).join("\n")}\n`,
    encoding: "utf8",
    timeout: 120_000,
  });
  const replies = run.stdout.trim().split("\n").filter(Boolean).map(parseReply);
  if (run.status !== 0 || replies.length !== 1 || replies[0]?.kind !== "obs" || !existsSync(png))
    throw new Error(`TN_POST_NORMAL_FRAME_FAILED ${name}: ${run.stdout}${run.stderr}`);
  if (withBox) {
    if (!run.stderr.includes("TN_POST_NORMAL_SKIPPED: transparent"))
      throw new Error(
        `TN_POST_NORMAL_SKIP_UNNAMED: the transparent box was not named\n${run.stderr}`,
      );
    checkNormals(normals);
    checkInvariantPositions(programs);
  }
  const { data } = PNG.sync.read(readFileSync(png));
  let dark = 0;
  let bright = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i] as number) < level) dark++;
    else bright++;
  }
  console.info(`${name}: ${dark} pixels below ${level}, ${bright} at or above`);
  return dark;
}

const level = 200;
const box = darkPixels("box", true, level);
const plane = darkPixels("plane", false, level);
if (box < 100)
  throw new Error(`TN_POST_NORMAL_NO_OCCLUSION: only ${box} occluded pixels around the box`);
if (plane > box / 20)
  throw new Error(`TN_POST_NORMAL_NOISE: ${plane} dark pixels on a bare plane (box ${box})`);
console.info("post normal pass ok");
