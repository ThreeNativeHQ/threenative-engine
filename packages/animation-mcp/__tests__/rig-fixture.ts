import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Document, type Node, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const reader = () => new NodeIO().registerExtensions(ALL_EXTENSIONS);

const IDENTITY = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

/** A rig shaped like the one the recovered recipe was calibrated on: a pelvis root and a right
 * hand bone named the way Mixamo names it. Geometry is the smallest thing glTF accepts. */
function rigDocument(): { document: Document; hand: Node; hips: Node } {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("Scene");
  const hips = document.createNode("mixamorigHips");
  const hand = document
    .createNode("mixamorigRightHand_035")
    .setTranslation([3, 4, 5])
    .setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  hips.addChild(hand);
  scene.addChild(hips);

  const positions = document
    .createAccessor("positions")
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0]))
    .setBuffer(buffer);
  const joints = document
    .createAccessor("joints")
    .setType("VEC4")
    .setArray(new Uint16Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))
    .setBuffer(buffer);
  const weights = document
    .createAccessor("weights")
    .setType("VEC4")
    .setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))
    .setBuffer(buffer);
  const mesh = document
    .createMesh("body")
    .addPrimitive(
      document
        .createPrimitive()
        .setAttribute("POSITION", positions)
        .setAttribute("JOINTS_0", joints)
        .setAttribute("WEIGHTS_0", weights),
    );
  const skin = document
    .createSkin("rig")
    .setSkeleton(hips)
    .addJoint(hips)
    .addJoint(hand)
    .setInverseBindMatrices(
      document
        .createAccessor("inverseBindMatrices")
        .setType("MAT4")
        .setArray(new Float32Array(IDENTITY))
        .setBuffer(buffer),
    );
  hips.addChild(document.createNode("body").setMesh(mesh).setSkin(skin));
  return { document, hand, hips };
}

function vec3Accessor(document: Document, name: string, values: number[]) {
  return document
    .createAccessor(name)
    .setType("VEC3")
    .setArray(new Float32Array(values))
    .setBuffer(document.getRoot().listBuffers()[0] ?? document.createBuffer());
}

/** One rotation channel at `time`, so a clip has a real duration. */
function addRotation(
  document: Document,
  clip: string,
  node: Node,
  duration: number,
  rotation: [number, number, number, number],
): void {
  const times = document
    .createAccessor("times")
    .setType("SCALAR")
    .setArray(new Float32Array([0, duration]))
    .setBuffer(document.getRoot().listBuffers()[0] ?? document.createBuffer());
  const values = document
    .createAccessor("rotation")
    .setType("VEC4")
    .setArray(new Float32Array(Array.from({ length: 8 }, (_, index) => rotation[index % 4] ?? 0)))
    .setBuffer(document.getRoot().listBuffers()[0] ?? document.createBuffer());
  const sampler = document
    .createAnimationSampler()
    .setInput(times)
    .setOutput(values)
    .setInterpolation("LINEAR");
  document
    .createAnimation(clip)
    .addSampler(sampler)
    .addChannel(
      document
        .createAnimationChannel()
        .setTargetNode(node)
        .setTargetPath("rotation")
        .setSampler(sampler),
    );
}

export interface RigFixture {
  /** A pelvis and a right-hand bone, one rotation clip per named clip. */
  readonly host: string;
  /** A single mesh node, the shape a weapon GLB has. */
  readonly prop: string;
  /** The same rig, with a clip whose root bone walks two units. */
  readonly walk: string;
}

/** Writes the three GLBs a spec needs and returns their paths. */
export async function writeRigFixture(
  directory: string,
  clips: readonly string[],
): Promise<RigFixture> {
  await mkdir(directory, { recursive: true });

  const { document, hand } = rigDocument();
  for (const clip of clips)
    addRotation(document, clip, hand, clip.length >= 6 ? 0.863 : 1, [0, 0, 0, 1]);
  const host = path.join(directory, "host.glb");
  await reader().write(host, document);

  const walking = rigDocument();
  const walkTimes = walking.document
    .createAccessor("walkTimes")
    .setType("SCALAR")
    .setArray(new Float32Array([0, 1]))
    .setBuffer(walking.document.getRoot().listBuffers()[0] ?? walking.document.createBuffer());
  const walkValues = vec3Accessor(walking.document, "walkValues", [0, 0, 0, 2, 0, 0]);
  const walkSampler = walking.document
    .createAnimationSampler()
    .setInput(walkTimes)
    .setOutput(walkValues)
    .setInterpolation("LINEAR");
  walking.document
    .createAnimation("RootWalk")
    .addSampler(walkSampler)
    .addChannel(
      walking.document
        .createAnimationChannel()
        .setTargetNode(walking.hips)
        .setTargetPath("translation")
        .setSampler(walkSampler),
    );
  const walkPath = path.join(directory, "walk.glb");
  await reader().write(walkPath, walking.document);

  const propDocument = new Document();
  const propBuffer = propDocument.createBuffer();
  const propScene = propDocument.createScene("Prop");
  const propMesh = propDocument.createMesh("weapon").addPrimitive(
    propDocument.createPrimitive().setAttribute(
      "POSITION",
      propDocument
        .createAccessor("propPositions")
        .setType("VEC3")
        .setArray(new Float32Array([0, 0, 0, 0, 0.1, 0, 0.1, 0, 0]))
        .setBuffer(propBuffer),
    ),
  );
  propScene.addChild(propDocument.createNode("weapon").setMesh(propMesh));
  const prop = path.join(directory, "weapon.glb");
  await reader().write(prop, propDocument);

  return { host, prop, walk: walkPath };
}

export interface IPoseJoint {
  readonly name: string;
  readonly parent?: string;
  readonly translation: [number, number, number];
}

export interface IPoseChannel {
  readonly node: string;
  readonly path: "rotation" | "translation";
  readonly times: readonly number[];
  /** One vector per time: three numbers for translation, four for rotation. */
  readonly values: readonly (readonly number[])[];
}

export interface IPoseFixture {
  readonly clip: string;
  readonly joints: readonly IPoseJoint[];
  readonly channels?: readonly IPoseChannel[];
}

/** A skeleton and one clip, with exactly the channels a spec wants — the shape `animation_verify`
 * reads: no skin, no mesh, no textures. */
export async function writePoseFixture(directory: string, options: IPoseFixture): Promise<string> {
  await mkdir(directory, { recursive: true });
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("Scene");
  const nodes = new Map<string, Node>();
  for (const joint of options.joints)
    nodes.set(joint.name, document.createNode(joint.name).setTranslation([...joint.translation]));
  for (const joint of options.joints) {
    const node = nodes.get(joint.name) as Node;
    const parent = joint.parent === undefined ? undefined : nodes.get(joint.parent);
    (parent ?? scene).addChild(node);
  }
  if (options.channels !== undefined && options.channels.length > 0) {
    const animation = document.createAnimation(options.clip);
    for (const channel of options.channels) {
      const times = document
        .createAccessor(`${channel.node}.${channel.path}.time`)
        .setType("SCALAR")
        .setArray(new Float32Array(channel.times))
        .setBuffer(buffer);
      const width = channel.path === "rotation" ? 4 : 3;
      const values = document
        .createAccessor(`${channel.node}.${channel.path}`)
        .setType(width === 4 ? "VEC4" : "VEC3")
        .setArray(new Float32Array(channel.values.flat()))
        .setBuffer(buffer);
      const sampler = document
        .createAnimationSampler()
        .setInput(times)
        .setOutput(values)
        .setInterpolation("LINEAR");
      animation.addSampler(sampler).addChannel(
        document
          .createAnimationChannel()
          .setTargetNode(nodes.get(channel.node) as Node)
          .setTargetPath(channel.path)
          .setSampler(sampler),
      );
    }
  }
  const file = path.join(directory, "pose.glb");
  await reader().write(file, document);
  return file;
}
