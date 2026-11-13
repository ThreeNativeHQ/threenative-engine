// Generates the quarry's geometry from its seed and writes the arms' `.glb` files into an
// ignored `public/assets/`. Nothing this script writes is ever committed: PRD-280 §2 asks for a
// body dense enough to be worth virtualizing, and this tree has already come within one command
// of landing a 700 MB cache.
//
// Run with `pnpm --filter quarry bake`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import { modelPass } from "@threenative/assets";
import {
  BOULDER_SUBDIVISIONS,
  type IGeneratedBody,
  bodyPositionHash,
  buildBoulder,
  buildCliff,
  buildFloor,
  buildGantry,
  buildGrating,
} from "../src/quarry/bodies.js";

/** The slice of the model pass's manifest entry this script reports. */
interface IBakeEntry {
  readonly simplify?: {
    readonly achievedRatio: number;
    readonly requestedRatio: number;
  };
  readonly triangles?: number;
  readonly virtual?: {
    readonly bakeSeconds: number;
    readonly clusters: number;
    readonly levels: number;
    readonly payloadBytes: number;
    readonly stopReason: string;
  };
}

/** The ratio PRD-280 §3 names for the `decimated` arm: what a game does today, in one pass. */
const DECIMATED_RATIO = 0.05;

const here = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(here, "../public/assets");

function toDocument(bodies: readonly IGeneratedBody[]): Document {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("quarry");
  for (const body of bodies) {
    const position = document
      .createAccessor(`${body.name}-position`)
      .setType("VEC3")
      .setArray(body.positions)
      .setBuffer(buffer);
    const normal = document
      .createAccessor(`${body.name}-normal`)
      .setType("VEC3")
      .setArray(body.normals)
      .setBuffer(buffer);
    const index = document
      .createAccessor(`${body.name}-index`)
      .setType("SCALAR")
      .setArray(body.indices)
      .setBuffer(buffer);
    const primitive = document
      .createPrimitive()
      .setAttribute("POSITION", position)
      .setAttribute("NORMAL", normal)
      .setIndices(index);
    const mesh = document.createMesh(body.name).addPrimitive(primitive);
    scene.addChild(document.createNode(body.name).setMesh(mesh));
  }
  return document;
}

/** `simplify` for the decimated arm, `virtual` for the clustered one, neither for dense. */
type ArmPass = { kind: "decimated"; ratio: number } | { kind: "dense" } | { kind: "virtual" };

async function write(
  name: string,
  bodies: readonly IGeneratedBody[],
  arm: ArmPass = { kind: "dense" },
) {
  // The compaction pass is on by default in this tree, and it flattens the scene and joins meshes
  // that share a material: this instrument looks each body up by name, so every body is protected by
  // name. Without it the whole file collapsed into one mesh named after the first body and the route
  // died in `TN_QUARRY_BODY_MISSING` before it drew a frame.
  const protectedNames = bodies.map((body) => body.name);
  const started = Date.now();
  const raw = Buffer.from(await new NodeIO().writeBinary(toDocument(bodies)));
  // `virtual: "none"` on the control arms is load-bearing now that the bake ships on by default:
  // without it `dense` and `decimated` would both carry a cluster DAG and the instrument would be
  // comparing three virtual arms. The gantry and grating fall under the threshold either way.
  const pass = modelPass(
    arm.kind === "decimated"
      ? { compact: { protectedNames }, simplify: { ratio: arm.ratio }, virtual: "none" as const }
      : arm.kind === "virtual"
        ? { compact: { protectedNames }, virtual: { minSourceTriangles: 4096 } }
        : { compact: { protectedNames }, virtual: "none" as const },
  );
  const result = await pass.apply(raw, `${name}.glb`);
  const bytes = Buffer.isBuffer(result) ? result : result.buffer;
  writeFileSync(resolve(outputDirectory, `${name}.glb`), bytes);
  const entry = Buffer.isBuffer(result) ? undefined : (result.entry as IBakeEntry | undefined);
  const sourceTriangles = bodies.reduce((total, body) => total + body.indices.length / 3, 0);
  const achieved = entry?.simplify;
  const virtual = entry?.virtual;
  console.log(
    `${name}.glb  ${(bytes.length / 1e6).toFixed(1)} MB  ` +
      `source ${sourceTriangles.toLocaleString("en-US")} triangles  ` +
      `output ${(entry?.triangles ?? sourceTriangles).toLocaleString("en-US")} triangles  ` +
      `${achieved === undefined ? "no simplify" : `requested ${(achieved.requestedRatio * 100).toFixed(1)}%, achieved ${(achieved.achievedRatio * 100).toFixed(1)}%`}  ` +
      `${virtual === undefined ? "" : `${virtual.clusters.toLocaleString("en-US")} clusters over ${virtual.levels} levels, ${(virtual.payloadBytes / 1e6).toFixed(1)} MB payload, stopped at ${virtual.stopReason}  `}` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

async function main(): Promise<void> {
  mkdirSync(outputDirectory, { recursive: true });
  const floor = buildFloor();
  const cliff = buildCliff();
  const gantry = buildGantry();
  const grating = buildGrating();
  const boulders = BOULDER_SUBDIVISIONS.map((_, source) => buildBoulder(source));
  const bodies = [cliff, ...boulders, gantry, grating];

  // Printed every bake so a disagreement between two machines is caught here rather than in a
  // frame time neither of them can reproduce.
  for (const body of [floor, ...bodies])
    console.log(
      `${body.name.padEnd(10)} ${String(body.indices.length / 3).padStart(9)} triangles  ${bodyPositionHash(body)}`,
    );

  // The control surface goes in its own file and is never simplified: AC5 asks for a floor whose
  // pixels are identical in every arm, and the only way to guarantee that is one set of bytes.
  // The control surface is never clustered: AC5 asks for a floor whose pixels are identical in
  // every arm, and one set of bytes is the only way to guarantee that.
  await write("quarry-floor", [floor]);
  await write("quarry-bodies-dense", bodies);
  await write("quarry-bodies-decimated", bodies, { kind: "decimated", ratio: DECIMATED_RATIO });
  await write("quarry-bodies-virtual", bodies, { kind: "virtual" });
}

await main();
