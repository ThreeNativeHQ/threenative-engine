import { type IBulkDataHeader, findBulkDataHeaders, resolveBulkDataPayload } from "./bulk-data.js";
import { UAssetError, assertUAsset } from "./errors.js";
import { type IGeometryBuild, assembleGeometry, convertVector } from "./geometry.js";
import {
  type IUe4MeshDescription,
  type Ue4AttributeSet,
  looksLikeMeshDescriptionUe4,
  parseMeshDescriptionUe4,
} from "./mesh-description-ue4.js";
import type { IPackageLayout } from "./package-summary.js";
import { buildGeometryFromRawMesh } from "./raw-mesh-geometry.js";
import { parseRawMesh } from "./raw-mesh.js";
import type { IUAssetBulkDataInfo, IUAssetParseOptions, UAssetMeshLayout } from "./types.js";

type GeometryOptions = Required<
  Pick<IUAssetParseOptions, "convertCoordinates" | "flipWinding" | "flipV">
>;

/** One decoded bulk-data source model, ready to be turned into the parse result. */
export interface IBulkSourceModel {
  layout: UAssetMeshLayout;
  build: IGeometryBuild;
  bulkData: IUAssetBulkDataInfo;
  payloadByteLength: number;
}

function attributeValues(
  set: Ue4AttributeSet,
  name: string,
  required: true,
): Float32Array | Int32Array | Uint8Array | string[];
function attributeValues(
  set: Ue4AttributeSet,
  name: string,
  required: false,
): Float32Array | Int32Array | Uint8Array | string[] | undefined;
function attributeValues(
  set: Ue4AttributeSet,
  name: string,
  required: boolean,
): Float32Array | Int32Array | Uint8Array | string[] | undefined {
  const entry = set.get(name);
  if (entry) return entry.values;
  if (required) {
    throw new UAssetError("MISSING_MESH_ATTRIBUTE", `UE4 MeshDescription is missing ${name}`, {
      attribute: name,
      available: [...set.keys()],
    });
  }
  return undefined;
}

function floatAt(values: Float32Array, index: number, what: string): number {
  const value = values[index];
  if (typeof value !== "number") {
    throw new UAssetError("INVALID_MESH_REFERENCE", `${what} ended before its declared count`, {
      index,
      what,
    });
  }
  return value;
}

function intAt(values: Int32Array, index: number, what: string): number {
  const value = values[index];
  if (typeof value !== "number") {
    throw new UAssetError("INVALID_MESH_REFERENCE", `${what} ended before its declared count`, {
      index,
      what,
    });
  }
  return value;
}

/** Expands a UE4 MeshDescription into render vertices — one output slot per vertex instance,
 * positioned through its vertex, with the instance's own UV and normal. */
function expandUe4Instances(
  description: IUe4MeshDescription,
  options: GeometryOptions,
): {
  positions: Float32Array;
  normals: Float32Array | undefined;
  uvs: Float32Array;
  instanceToOutput: Map<number, number>;
} {
  const positionsByVertex = attributeValues(
    description.vertexAttributes,
    "Position",
    true,
  ) as Float32Array;
  const uvsByInstance = attributeValues(
    description.vertexInstanceAttributes,
    "TextureCoordinate",
    true,
  ) as Float32Array;
  const normalsByInstance = attributeValues(
    description.vertexInstanceAttributes,
    "Normal",
    false,
  ) as Float32Array | undefined;

  // One output slot per **allocated** instance: a holed container's unallocated ids carry no
  // element, so emitting a slot for them would put a hole in the middle of the vertex buffer.
  const instanceIds = description.validVertexInstanceIds;
  const positions = new Float32Array(instanceIds.length * 3);
  const uvs = new Float32Array(instanceIds.length * 2);
  const normals = normalsByInstance ? new Float32Array(instanceIds.length * 3) : undefined;
  const instanceToOutput = new Map<number, number>();

  for (let output = 0; output < instanceIds.length; output += 1) {
    const instanceId = instanceIds[output] ?? -1;
    instanceToOutput.set(instanceId, output);
    const vertexId = intAt(
      description.vertexInstanceVertices,
      instanceId,
      "FMeshVertexInstance.VertexID",
    );
    const [x, y, z] = convertVector(
      floatAt(positionsByVertex, vertexId * 3, "Position"),
      floatAt(positionsByVertex, vertexId * 3 + 1, "Position"),
      floatAt(positionsByVertex, vertexId * 3 + 2, "Position"),
      options.convertCoordinates,
    );
    positions[output * 3] = x;
    positions[output * 3 + 1] = y;
    positions[output * 3 + 2] = z;

    // Attribute arrays stay dense over slots, so they are read at the instance id, not the slot
    // this instance was written into.
    uvs[output * 2] = floatAt(uvsByInstance, instanceId * 2, "TextureCoordinate");
    const v = floatAt(uvsByInstance, instanceId * 2 + 1, "TextureCoordinate");
    uvs[output * 2 + 1] = options.flipV ? 1 - v : v;

    if (normals && normalsByInstance) {
      const [nx, ny, nz] = convertVector(
        floatAt(normalsByInstance, instanceId * 3, "Normal"),
        floatAt(normalsByInstance, instanceId * 3 + 1, "Normal"),
        floatAt(normalsByInstance, instanceId * 3 + 2, "Normal"),
        options.convertCoordinates,
      );
      normals[output * 3] = nx;
      normals[output * 3 + 1] = ny;
      normals[output * 3 + 2] = nz;
    }
  }

  return { positions, normals, uvs, instanceToOutput };
}

/** Builds geometry from a UE4 MeshDescription: every triangle's corners come from the file's
 * own triangle container, and its section from the polygon group its polygon belongs to. */
function buildGeometryFromUe4MeshDescription(
  description: IUe4MeshDescription,
  options: GeometryOptions,
): IGeometryBuild {
  const expanded = expandUe4Instances(description, options);
  const triangleIds = description.validTriangleIds;
  assertUAsset(
    triangleIds.length > 0,
    "UNSUPPORTED_STATIC_MESH_LAYOUT",
    "UE4 MeshDescription contains no triangles",
  );

  const trianglesByGroup = new Map<number, number[]>();
  for (const triangleId of triangleIds) {
    const corners: [number, number, number] = [0, 0, 0];
    for (let corner = 0; corner < 3; corner += 1) {
      const instanceId = intAt(
        description.triangleVertexInstances,
        triangleId * 3 + corner,
        "FMeshTriangle.VertexInstanceIDs",
      );
      const output = expanded.instanceToOutput.get(instanceId);
      if (output === undefined) {
        throw new UAssetError(
          "INVALID_MESH_REFERENCE",
          "Triangle references a vertex instance with no output slot",
          { triangleId, corner, instanceId },
        );
      }
      corners[corner] = output;
    }
    if (options.flipWinding) {
      const second = corners[1];
      corners[1] = corners[2];
      corners[2] = second;
    }
    const polygonId = intAt(description.trianglePolygons, triangleId, "FMeshTriangle.PolygonID");
    const group = intAt(description.polygonGroups, polygonId, "FMeshPolygon.PolygonGroupID");
    const groupTriangles = trianglesByGroup.get(group) ?? [];
    groupTriangles.push(corners[0], corners[1], corners[2]);
    trianglesByGroup.set(group, groupTriangles);
  }

  const slotNames = attributeValues(
    description.polygonGroupAttributes,
    "ImportedMaterialSlotName",
    false,
  ) as string[] | undefined;

  return assembleGeometry(
    expanded.positions,
    expanded.normals,
    expanded.uvs,
    trianglesByGroup,
    (group) => slotNames?.[group] ?? String(group),
    {
      vertices: description.vertexCount,
      vertexInstances: description.validVertexInstanceIds.length,
      triangles: triangleIds.length,
    },
  );
}

function bulkInfo(header: IBulkDataHeader): IUAssetBulkDataInfo {
  return {
    headerOffset: header.headerOffset,
    flags: header.flags,
    storage: header.storage,
    file: header.file,
    compression: header.compression,
    elementCount: header.elementCount,
    sizeOnDisk: header.sizeOnDisk,
    offsetInFile: header.offsetInFile,
    payloadOffset: header.payloadOffset,
  };
}

/** Decodes one resolved bulk payload, trying each source-model form the package can read. The
 * payload is the whole struct, so each parse must consume it from its first byte. */
function decodeSourceModel(
  payload: Uint8Array,
  options: GeometryOptions,
): { layout: UAssetMeshLayout; build: IGeometryBuild; byteLength: number } | undefined {
  if (looksLikeMeshDescriptionUe4(payload)) {
    try {
      const description = parseMeshDescriptionUe4(payload);
      return {
        layout: "mesh-description-ue4",
        build: buildGeometryFromUe4MeshDescription(description, options),
        byteLength: description.byteLength,
      };
    } catch (error) {
      if (!(error instanceof UAssetError)) throw error;
    }
  }
  try {
    const blob = parseRawMesh(payload, 0);
    return {
      layout: "raw-mesh",
      build: buildGeometryFromRawMesh(blob.mesh, options),
      byteLength: blob.byteLength,
    };
  } catch (error) {
    if (!(error instanceof UAssetError)) throw error;
  }
  return undefined;
}

/**
 * The bulk-data path: reads the source model out of the `FByteBulkData` payloads an editor
 * package keeps outside its export bytes. Headers are taken in file order, so LOD0 — the first
 * source model Unreal serializes — is the first candidate that decodes.
 *
 * A payload the caller cannot supply the bytes or codec for is reported rather than skipped:
 * that is a caller-fixable gap, not an unsupported layout, and the two must not read alike.
 */
export function selectBulkSourceModel(
  bytes: Uint8Array,
  layout: IPackageLayout,
  parseOptions: IUAssetParseOptions,
  options: GeometryOptions,
): { selection?: IBulkSourceModel; blockingError?: UAssetError } {
  let blockingError: UAssetError | undefined;
  for (const header of findBulkDataHeaders(bytes, layout, parseOptions.bulkDataFiles)) {
    let payload: Uint8Array;
    try {
      payload = resolveBulkDataPayload(bytes, header, {
        ...(parseOptions.bulkDataFiles === undefined ? {} : { files: parseOptions.bulkDataFiles }),
        ...(parseOptions.zlib === undefined ? {} : { zlib: parseOptions.zlib }),
      });
    } catch (error) {
      if (!(error instanceof UAssetError)) throw error;
      if (error.code === "MISSING_CODEC" || error.code === "MISSING_BULK_DATA_FILE") {
        blockingError ??= error;
      }
      continue;
    }
    const decoded = decodeSourceModel(payload, options);
    if (decoded === undefined) continue;
    return {
      selection: {
        layout: decoded.layout,
        build: decoded.build,
        bulkData: bulkInfo(header),
        payloadByteLength: decoded.byteLength,
      },
    };
  }
  return blockingError === undefined ? {} : { blockingError };
}
