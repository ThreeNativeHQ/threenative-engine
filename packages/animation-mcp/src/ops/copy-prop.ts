import type {
  Accessor,
  Document,
  Material,
  Mesh,
  Node,
  Primitive,
  Texture,
  TextureInfo,
} from "@gltf-transform/core";

/**
 * Copies one document's scene graph into another. glTF has no cross-document node reference and
 * gltf-transform has no merge, so a prop becomes part of the host the only way glTF allows: its
 * meshes, materials and images are rebuilt in the host document.
 *
 * It copies what a prop carries — nodes, meshes, primitives, morph targets, accessors, materials,
 * textures — and fails closed on what a prop should not carry. A silently dropped skin or clip is
 * a character that looks right in the log and is animated wrong in the game.
 */
export function copyScene(host: Document, name: string, source: Document): Node {
  if (source.getRoot().listSkins().length > 0)
    throw new Error("The attached GLB is rigged; attach a prop, or bake it into the host first.");
  if (source.getRoot().listAnimations().length > 0)
    throw new Error(
      "The attached GLB has its own clips; a prop is posed by its bone, not by clips.",
    );
  if (source.getRoot().listCameras().length > 0)
    throw new Error("The attached GLB carries a camera; attach a prop, not a scene.");

  const node = host.createNode(name);
  const scene = source.getRoot().listScenes()[0];
  const children = scene?.listChildren() ?? source.getRoot().listNodes();
  for (const child of children) node.addChild(copyNode(host, child));
  return node;
}

function bufferOf(host: Document) {
  return host.getRoot().listBuffers()[0] ?? host.createBuffer();
}

function copyArray(values: ArrayLike<number> & { constructor: unknown }) {
  const Constructor = values.constructor as new (source: ArrayLike<number>) => never;
  return new Constructor(values);
}

/** Reads every element out, so a sparse accessor — which gltf-transform writes for any array that
 * shares a buffer slice — arrives in the host dense and complete. `getElement` is the only accessor
 * read that already honours sparse storage. */
function denseArray(source: Accessor) {
  const width = source.getElementSize();
  const stored = source.getArray();
  const Constructor = (stored?.constructor ?? Float32Array) as new (length: number) => Float32Array;
  const values = new Constructor(source.getCount() * width);
  const element: number[] = [];
  for (let index = 0; index < source.getCount(); index += 1) {
    source.getElement(index, element);
    values.set(element, index * width);
  }
  return values;
}

function copyAccessor(host: Document, source: Accessor): Accessor {
  if (source.getArray() === null && !source.getSparse())
    throw new Error(`Accessor '${source.getName()}' carries no data.`);
  return host
    .createAccessor(source.getName())
    .setType(source.getType())
    .setArray(denseArray(source))
    .setNormalized(source.getNormalized())
    .setBuffer(bufferOf(host));
}

function copyTexture(host: Document, source: Texture): Texture {
  const texture = host.createTexture(source.getName()).setMimeType(source.getMimeType());
  const image = source.getImage();
  if (image !== null) texture.setImage(new Uint8Array(image));
  return texture;
}

function copyTextureInfo(
  host: Document,
  source: Texture | null,
  info: TextureInfo | null,
  target: TextureInfo | null,
  assign: (texture: Texture | null) => unknown,
): void {
  const texture = source === null ? null : copyTexture(host, source);
  assign(texture);
  if (info === null || target === null) return;
  target
    .setMagFilter(info.getMagFilter())
    .setMinFilter(info.getMinFilter())
    .setWrapS(info.getWrapS())
    .setWrapT(info.getWrapT());
}

function copyMaterial(host: Document, source: Material): Material {
  const material = host
    .createMaterial(source.getName())
    .setAlpha(source.getAlpha())
    .setAlphaCutoff(source.getAlphaCutoff())
    .setAlphaMode(source.getAlphaMode())
    .setBaseColorFactor([...source.getBaseColorFactor()] as [number, number, number, number])
    .setDoubleSided(source.getDoubleSided())
    .setEmissiveFactor([...source.getEmissiveFactor()] as [number, number, number])
    .setMetallicFactor(source.getMetallicFactor())
    .setNormalScale(source.getNormalScale())
    .setOcclusionStrength(source.getOcclusionStrength())
    .setRoughnessFactor(source.getRoughnessFactor());
  const pairs = [
    [
      source.getBaseColorTexture(),
      source.getBaseColorTextureInfo(),
      () => material.getBaseColorTextureInfo(),
      (texture: Texture | null) => material.setBaseColorTexture(texture),
    ],
    [
      source.getEmissiveTexture(),
      source.getEmissiveTextureInfo(),
      () => material.getEmissiveTextureInfo(),
      (texture: Texture | null) => material.setEmissiveTexture(texture),
    ],
    [
      source.getMetallicRoughnessTexture(),
      source.getMetallicRoughnessTextureInfo(),
      () => material.getMetallicRoughnessTextureInfo(),
      (texture: Texture | null) => material.setMetallicRoughnessTexture(texture),
    ],
    [
      source.getNormalTexture(),
      source.getNormalTextureInfo(),
      () => material.getNormalTextureInfo(),
      (texture: Texture | null) => material.setNormalTexture(texture),
    ],
    [
      source.getOcclusionTexture(),
      source.getOcclusionTextureInfo(),
      () => material.getOcclusionTextureInfo(),
      (texture: Texture | null) => material.setOcclusionTexture(texture),
    ],
  ] as const;
  for (const [texture, info, target, assign] of pairs) {
    copyTextureInfo(host, texture, info, target(), assign);
  }
  return material;
}

function copyPrimitive(host: Document, source: Primitive): Primitive {
  const primitive = host.createPrimitive().setMode(source.getMode());
  for (const semantic of source.listSemantics()) {
    const attribute = source.getAttribute(semantic);
    if (attribute !== null) primitive.setAttribute(semantic, copyAccessor(host, attribute));
  }
  const indices = source.getIndices();
  if (indices !== null) primitive.setIndices(copyAccessor(host, indices));
  const material = source.getMaterial();
  if (material !== null) primitive.setMaterial(copyMaterial(host, material));
  for (const target of source.listTargets()) {
    const copy = host.createPrimitiveTarget();
    for (const semantic of target.listSemantics()) {
      const attribute = target.getAttribute(semantic);
      if (attribute !== null) copy.setAttribute(semantic, copyAccessor(host, attribute));
    }
    primitive.addTarget(copy);
  }
  return primitive;
}

function copyMesh(host: Document, source: Mesh): Mesh {
  const mesh = host.createMesh(source.getName());
  for (const primitive of source.listPrimitives())
    mesh.addPrimitive(copyPrimitive(host, primitive));
  return mesh;
}

function copyNode(host: Document, source: Node): Node {
  const node = host
    .createNode(source.getName())
    .setTranslation([...source.getTranslation()] as [number, number, number])
    .setRotation([...source.getRotation()] as [number, number, number, number])
    .setScale([...source.getScale()] as [number, number, number]);
  const mesh = source.getMesh();
  if (mesh !== null) node.setMesh(copyMesh(host, mesh));
  for (const child of source.listChildren()) node.addChild(copyNode(host, child));
  return node;
}
