import { UAssetError } from "./errors.js";

/** FRawMesh serialization version; both known values differ only by one trailing array. */
const RAW_MESH_VER_INITIAL = 0;
const RAW_MESH_VER_REMOVE_ZERO_TRIANGLE_SECTIONS = 1;

const MAX_MESH_TEXTURE_COORDS = 8;
const MAX_ARRAY_ELEMENTS = 200_000_000;

export interface IRawMesh {
  version: number;
  /** Per-face material (section) index. */
  faceMaterialIndices: Int32Array;
  /** Per-vertex positions, three floats each, in Unreal coordinates. */
  vertexPositions: Float32Array;
  vertexCount: number;
  /** Per-wedge vertex index — the instance-to-vertex table. */
  wedgeIndices: Uint32Array;
  wedgeNormals: Float32Array | undefined;
  /** One UV set per non-empty channel, each with `wedgeCount` uv pairs. */
  wedgeUvs: Float32Array[];
}

export interface IRawMeshBlob {
  offset: number;
  byteLength: number;
  mesh: IRawMesh;
}

interface IRawArray {
  readonly count: number;
  readonly start: number;
}

/** Parses an FRawMesh blob at `offset`, per `operator<<(FArchive&, FRawMesh&)`: a version pair
 * then eighteen plain TArrays in a fixed order. A correct parse consumes the blob to its last
 * byte and every count must agree with the wedge/face totals, which is what makes a candidate
 * offset trustworthy rather than a lucky match. Throws `UAssetError` "INVALID_RAW_MESH" when
 * anything disagrees. */
export function parseRawMesh(bytes: Uint8Array, offset = 0): IRawMeshBlob {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = offset;

  function array(elementSize: number, label: string): IRawArray {
    if (pos + 4 > bytes.byteLength) {
      throw rawMeshError(`${label} count is truncated`, { offset, position: pos });
    }
    const count = view.getInt32(pos, true);
    pos += 4;
    if (count < 0 || count > MAX_ARRAY_ELEMENTS) {
      throw rawMeshError(`${label} has an invalid element count`, { offset, count });
    }
    const start = pos;
    const end = pos + count * elementSize;
    if (end > bytes.byteLength) {
      throw rawMeshError(`${label} runs past the payload`, {
        offset,
        count,
        end,
        byteLength: bytes.byteLength,
      });
    }
    pos = end;
    return { count, start };
  }

  const version = view.getInt32(pos, true);
  pos += 4;
  if (version !== RAW_MESH_VER_INITIAL && version !== RAW_MESH_VER_REMOVE_ZERO_TRIANGLE_SECTIONS) {
    throw rawMeshError("Unsupported FRawMesh version", { offset, version });
  }
  const licenseeVersion = view.getInt32(pos, true);
  pos += 4;
  if (licenseeVersion !== 0) {
    throw rawMeshError("FRawMesh licensee version is not the stock layout", {
      offset,
      licenseeVersion,
    });
  }

  const faces = array(4, "FaceMaterialIndices");
  const smoothing = array(4, "FaceSmoothingMasks");
  const vertices = array(12, "VertexPositions");
  const wedges = array(4, "WedgeIndices");
  array(12, "WedgeTangentX");
  array(12, "WedgeTangentY");
  const normals = array(12, "WedgeTangentZ");
  const uvChannels: IRawArray[] = [];
  for (let channel = 0; channel < MAX_MESH_TEXTURE_COORDS; channel += 1) {
    uvChannels.push(array(8, `WedgeTexCoords[${channel}]`));
  }
  array(4, "WedgeColors");
  if (version >= RAW_MESH_VER_REMOVE_ZERO_TRIANGLE_SECTIONS) {
    array(4, "ImportedMaterialNames");
  }
  const byteLength = pos - offset;

  const faceCount = faces.count;
  const wedgeCount = wedges.count;
  const vertexCount = vertices.count;
  validateRawMeshCounts(offset, {
    faceCount,
    wedgeCount,
    vertexCount,
    smoothingCount: smoothing.count,
    normalCount: normals.count,
    uvChannels,
  });
  const nonEmptyUvChannels = uvChannels.filter((channel) => channel.count > 0);

  // Wedge indices must reference real vertices before any geometry is built from them.
  for (let wedge = 0; wedge < wedgeCount; wedge += 1) {
    if (view.getUint32(wedges.start + wedge * 4, true) >= vertexCount) {
      throw rawMeshError("FRawMesh wedge index is out of range for the vertex count", {
        offset,
        wedge,
        vertexCount,
      });
    }
  }

  const faceMaterialIndices = new Int32Array(faceCount);
  for (let face = 0; face < faceCount; face += 1) {
    faceMaterialIndices[face] = view.getInt32(faces.start + face * 4, true);
  }

  const vertexPositions = new Float32Array(vertexCount * 3);
  for (let index = 0; index < vertexCount * 3; index += 1) {
    vertexPositions[index] = view.getFloat32(vertices.start + index * 4, true);
  }

  const wedgeIndices = new Uint32Array(wedgeCount);
  for (let wedge = 0; wedge < wedgeCount; wedge += 1) {
    wedgeIndices[wedge] = view.getUint32(wedges.start + wedge * 4, true);
  }

  const wedgeNormals =
    normals.count > 0 ? copyFloats(view, normals.start, normals.count * 3) : undefined;

  const wedgeUvs = nonEmptyUvChannels.map((channel) =>
    copyFloats(view, channel.start, channel.count * 2),
  );

  return {
    offset,
    byteLength,
    mesh: {
      version,
      faceMaterialIndices,
      vertexPositions,
      vertexCount,
      wedgeIndices,
      wedgeNormals,
      wedgeUvs,
    },
  };
}

/** The cross-count checks that make an FRawMesh parse trustworthy: wedges per face, per-wedge
 * optional channels, at least one UV channel, and non-empty renderable geometry. */
function validateRawMeshCounts(
  offset: number,
  counts: {
    faceCount: number;
    wedgeCount: number;
    vertexCount: number;
    smoothingCount: number;
    normalCount: number;
    uvChannels: readonly IRawArray[];
  },
): void {
  const { faceCount, wedgeCount, vertexCount, smoothingCount, normalCount, uvChannels } = counts;
  if (wedgeCount !== faceCount * 3) {
    throw rawMeshError("FRawMesh wedge count does not match three per face", {
      offset,
      wedgeCount,
      faceCount,
    });
  }
  if (smoothingCount !== 0 && smoothingCount !== faceCount) {
    throw rawMeshError("FRawMesh smoothing-mask count does not match the face count", {
      offset,
      smoothingCount,
      faceCount,
    });
  }
  if (normalCount !== 0 && normalCount !== wedgeCount) {
    throw rawMeshError("FRawMesh normal count does not match the wedge count", {
      offset,
      normalCount,
      wedgeCount,
    });
  }
  if (!uvChannels.some((channel) => channel.count > 0)) {
    throw rawMeshError("FRawMesh has no texture coordinates", { offset });
  }
  for (const channel of uvChannels) {
    if (channel.count !== 0 && channel.count !== wedgeCount) {
      throw rawMeshError("FRawMesh UV channel does not match the wedge count", {
        offset,
        uvCount: channel.count,
        wedgeCount,
      });
    }
  }
  if (wedgeCount === 0 || vertexCount === 0) {
    throw rawMeshError("FRawMesh has no renderable geometry", { offset });
  }
}

function copyFloats(view: DataView, start: number, count: number): Float32Array {
  const values = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    values[index] = view.getFloat32(start + index * 4, true);
  }
  return values;
}

function rawMeshError(message: string, details: Record<string, unknown>): UAssetError {
  return new UAssetError("INVALID_RAW_MESH", message, details);
}

/** Scans for FRawMesh blob candidates. Each candidate is decided by the full validating parse,
 * which must consume the blob exactly and pass every cross-count check, so false positives cost
 * only a rejected attempt. Offsets come back in file order — the first is LOD0. */
export function findRawMeshBlobs(bytes: Uint8Array): IRawMeshBlob[] {
  const blobs: IRawMeshBlob[] = [];
  for (let offset = 0; offset + 20 <= bytes.byteLength; offset += 1) {
    try {
      const blob = parseRawMesh(bytes, offset);
      blobs.push(blob);
      // Skip past this blob so its own interior cannot register as a second candidate.
      offset += blob.byteLength - 1;
    } catch (error) {
      if (!(error instanceof UAssetError)) throw error;
    }
  }
  return blobs;
}
