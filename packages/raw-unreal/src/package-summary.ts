import { BinaryReader } from "./binary.js";
import { UAssetError, assertUAsset } from "./errors.js";

/** Unreal's legacy package tag: every editor `.uasset`/`.umap` starts with it, little-endian. */
export const PACKAGE_FILE_TAG = 0x9e2a83c1;

/** FEditorObjectVersion's GUID as serialized bytes — four little-endian uint32 words:
 * E4B068ED-F494-42E9-A231-DA0B2E46BB41. The custom-version list's position in
 * `FPackageFileSummary` varies with `LegacyFileVersion`, so instead of modeling every variant
 * the entry is located by scanning the summary prefix for these exact 16 bytes — the same
 * approach the engine-free asset importer uses. */
const EDITOR_OBJECT_VERSION_GUID_BYTES = Uint8Array.from([
  0xed,
  0x68,
  0xb0,
  0xe4, // E4B068ED
  0xe9,
  0x42,
  0x94,
  0xf4, // F49442E9
  0x0b,
  0xda,
  0x31,
  0xa2, // A231DA0B
  0x41,
  0xbb,
  0x46,
  0x2e, // 2E46BB41
]);

/** How far into the package the GUID scan reaches: the summary and its custom-version list sit
 * well inside the first 4 KiB of a header. */
const SUMMARY_SCAN_BYTES = 4096;

export interface IPackageSummary {
  packageTag: number;
  legacyFileVersion: number;
  legacyUE3Version: number;
  fileVersionUE4?: number;
  fileVersionUE5?: number;
  licenseeVersion?: number;
  editorObjectVersion?: number;
}

function findEditorObjectVersion(bytes: Uint8Array, from: number): number | undefined {
  const limit = Math.min(bytes.byteLength - 20, from + SUMMARY_SCAN_BYTES);
  for (let position = from; position >= 0 && position < limit; position += 1) {
    let matched = true;
    for (let index = 0; index < 16; index += 1) {
      if (bytes[position + index] !== EDITOR_OBJECT_VERSION_GUID_BYTES[index]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return view.getInt32(position + 16, true);
    }
  }
  return undefined;
}

/** Reads the fixed prefix of `FPackageFileSummary` — the legacy tag and the engine version
 * fields — and locates the `FEditorObjectVersion` custom-version entry. The rest of the summary
 * (name map, export map, dependency graph) belongs to a full package index; this package's
 * payload readers locate data by self-validating signature scans instead. */
export function readPackageSummary(bytes: Uint8Array): IPackageSummary {
  if (bytes.byteLength < 4) {
    throw new UAssetError("TRUNCATED_PACKAGE", "Unreal package is too small", {
      byteLength: bytes.byteLength,
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packageTag = view.getUint32(0, true);
  if (packageTag !== PACKAGE_FILE_TAG) {
    throw new UAssetError(
      "INVALID_PACKAGE_TAG",
      "Input is not a legacy Unreal package (.uasset/.umap)",
      {
        tag: `0x${packageTag.toString(16)}`,
      },
    );
  }
  if (bytes.byteLength < 16) {
    throw new UAssetError("TRUNCATED_PACKAGE", "Unreal package summary is truncated", {
      byteLength: bytes.byteLength,
    });
  }

  const legacyFileVersion = view.getInt32(4, true);
  const legacyUE3Version = view.getInt32(8, true);
  const fileVersionUE4 = view.getInt32(12, true);
  // FileVersionUE5 exists only from LegacyFileVersion −8 onward, and it moves the licensee field.
  const licenseeOffset = legacyFileVersion <= -8 ? 20 : 16;
  if (bytes.byteLength < licenseeOffset + 4) {
    throw new UAssetError("TRUNCATED_PACKAGE", "Unreal package summary is truncated", {
      byteLength: bytes.byteLength,
    });
  }
  const fileVersionUE5 = legacyFileVersion <= -8 ? view.getInt32(16, true) : undefined;
  const licenseeVersion = view.getInt32(licenseeOffset, true);

  const afterLicensee = licenseeOffset + 4;
  const editorObjectVersion = findEditorObjectVersion(bytes, afterLicensee);

  return {
    packageTag,
    legacyFileVersion,
    legacyUE3Version,
    fileVersionUE4,
    ...(fileVersionUE5 === undefined ? {} : { fileVersionUE5 }),
    ...(licenseeVersion === undefined ? {} : { licenseeVersion }),
    ...(editorObjectVersion === undefined ? {} : { editorObjectVersion }),
  };
}

/**
 * The parts of `FPackageFileSummary` a bulk-data reader needs: how long the header is, where the
 * export data that carries `FByteBulkData` headers begins, and where the bulk payload region
 * starts. `readPackageSummary` deliberately reads only the fixed prefix; this walk reads the
 * whole summary, which is the only way to learn `BulkDataStartOffset`.
 */
export interface IPackageLayout extends IPackageSummary {
  /** End of the package header — the first byte of export data. */
  totalHeaderSize: number;
  /** First byte of the bulk-data region, the anchor every end-of-file payload offset is fixed
   * up against. */
  bulkDataStartOffset: number;
  nameCount: number;
  nameOffset: number;
  exportCount: number;
  exportOffset: number;
}

/** Version gates named the way Unreal names them, so the walk reads as the engine's own. */
const VER_WORLD_LEVEL_INFO = 224;
const VER_CHUNKID_ARRAY = 326;
const VER_ENGINE_VERSION_OBJECT = 336;
const VER_STRING_ASSET_REFERENCES_MAP = 384;
const VER_COMPATIBLE_ENGINE_VERSION = 444;
const VER_SERIALIZE_TEXT_IN_PACKAGES = 459;
const VER_NAME_HASHES_SERIALIZED = 504;
const VER_PRELOAD_DEPENDENCIES = 507;
const VER_ADDED_SEARCHABLE_NAMES = 510;
const VER_PACKAGE_SUMMARY_LOCALIZATION_ID = 516;
const VER_ADDED_PACKAGE_OWNER = 518;
const VER_REMOVE_LINKER_PACKAGE_OWNER = 520;
const UE5_NAMES_REFERENCED_FROM_EXPORT_DATA = 1001;
const UE5_PAYLOAD_TOC = 1002;
const UE5_ADD_SOFTOBJECTPATH_LIST = 1008;
const UE5_DATA_RESOURCES = 1009;

/** The oldest `LegacyFileVersion` this walk models. UE 5.5 moved to −9 and replaced the package
 * GUID with a saved hash; that variant is not modelled, so the walk declines rather than
 * guessing at offsets it has never been checked against. */
const OLDEST_MODELLED_LEGACY_VERSION = -8;

function readEngineVersion(reader: BinaryReader): void {
  reader.skip(2 + 2 + 2 + 4, "FEngineVersion");
  reader.fstring("FEngineVersion branch");
}

function walkSummary(bytes: Uint8Array, summary: IPackageSummary): IPackageLayout {
  const reader = new BinaryReader(bytes);
  const { legacyFileVersion, fileVersionUE4 = 0, fileVersionUE5 } = summary;
  reader.seek(legacyFileVersion <= -8 ? 24 : 20);

  if (legacyFileVersion <= -2) {
    const customVersionCount = reader.int32("custom-version count");
    assertUAsset(
      customVersionCount >= 0 && customVersionCount <= 512,
      "INVALID_PACKAGE_SUMMARY",
      "Invalid custom-version count",
      { customVersionCount },
    );
    reader.skip(customVersionCount * 20, "custom-version list");
  }

  const totalHeaderSize = reader.int32("TotalHeaderSize");
  reader.fstring("FolderName");
  reader.skip(4, "PackageFlags");
  const nameCount = reader.int32("NameCount");
  const nameOffset = reader.int32("NameOffset");
  if (fileVersionUE5 !== undefined && fileVersionUE5 >= UE5_ADD_SOFTOBJECTPATH_LIST) {
    reader.skip(8, "SoftObjectPaths");
  }
  if (fileVersionUE4 >= VER_PACKAGE_SUMMARY_LOCALIZATION_ID) reader.fstring("LocalizationId");
  if (fileVersionUE4 >= VER_SERIALIZE_TEXT_IN_PACKAGES) reader.skip(8, "GatherableTextData");
  const exportCount = reader.int32("ExportCount");
  const exportOffset = reader.int32("ExportOffset");
  reader.skip(8, "ImportCount and ImportOffset");
  reader.skip(4, "DependsOffset");
  if (fileVersionUE4 >= VER_STRING_ASSET_REFERENCES_MAP) reader.skip(8, "SoftPackageReferences");
  if (fileVersionUE4 >= VER_ADDED_SEARCHABLE_NAMES) reader.skip(4, "SearchableNamesOffset");
  reader.skip(4, "ThumbnailTableOffset");
  reader.skip(16, "package Guid");
  if (fileVersionUE4 >= VER_ADDED_PACKAGE_OWNER) {
    reader.skip(16, "PersistentGuid");
    if (fileVersionUE4 < VER_REMOVE_LINKER_PACKAGE_OWNER) reader.skip(16, "OwnerPersistentGuid");
  }
  const generationCount = reader.int32("GenerationCount");
  assertUAsset(
    generationCount >= 0 && generationCount <= 4096,
    "INVALID_PACKAGE_SUMMARY",
    "Invalid generation count",
    { generationCount },
  );
  reader.skip(generationCount * 8, "generation list");
  if (fileVersionUE4 >= VER_ENGINE_VERSION_OBJECT) readEngineVersion(reader);
  else reader.skip(4, "EngineChangelist");
  if (fileVersionUE4 >= VER_COMPATIBLE_ENGINE_VERSION) readEngineVersion(reader);
  reader.skip(4, "CompressionFlags");
  const compressedChunkCount = reader.int32("CompressedChunkCount");
  assertUAsset(
    compressedChunkCount >= 0 && compressedChunkCount <= 65_536,
    "INVALID_PACKAGE_SUMMARY",
    "Invalid compressed-chunk count",
    { compressedChunkCount },
  );
  reader.skip(compressedChunkCount * 16, "compressed-chunk list");
  reader.skip(4, "PackageSource");
  const additionalPackagesToCook = reader.int32("AdditionalPackagesToCook count");
  assertUAsset(
    additionalPackagesToCook >= 0 && additionalPackagesToCook <= 65_536,
    "INVALID_PACKAGE_SUMMARY",
    "Invalid additional-packages-to-cook count",
    { additionalPackagesToCook },
  );
  for (let index = 0; index < additionalPackagesToCook; index += 1) {
    reader.fstring("AdditionalPackagesToCook entry");
  }
  if (legacyFileVersion > -7) reader.skip(4, "NumTextureAllocations");
  reader.skip(4, "AssetRegistryDataOffset");
  reader.ensure(8, "BulkDataStartOffset");
  const bulkDataStartOffset = Number(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(reader.pos, true),
  );
  reader.skip(8, "BulkDataStartOffset");
  if (fileVersionUE4 >= VER_WORLD_LEVEL_INFO) reader.skip(4, "WorldTileInfoDataOffset");
  if (fileVersionUE4 >= VER_CHUNKID_ARRAY) {
    const chunkIdCount = reader.int32("ChunkID count");
    assertUAsset(
      chunkIdCount >= 0 && chunkIdCount <= 65_536,
      "INVALID_PACKAGE_SUMMARY",
      "Invalid chunk-id count",
      { chunkIdCount },
    );
    reader.skip(chunkIdCount * 4, "ChunkID list");
  }
  if (fileVersionUE4 >= VER_PRELOAD_DEPENDENCIES) reader.skip(8, "PreloadDependencies");
  if (fileVersionUE5 !== undefined) {
    if (fileVersionUE5 >= UE5_NAMES_REFERENCED_FROM_EXPORT_DATA) {
      reader.skip(4, "NamesReferencedFromExportDataCount");
    }
    if (fileVersionUE5 >= UE5_PAYLOAD_TOC) reader.skip(8, "PayloadTocOffset");
    if (fileVersionUE5 >= UE5_DATA_RESOURCES) reader.skip(4, "DataResourceOffset");
  }

  // The one invariant that decides whether the walk was right: the summary ends exactly where
  // it says its name table begins. Checked against 5,713 real editor packages from UE 4.6 to
  // UE 5.3; a walk that lands anywhere else is a variant this code does not model.
  assertUAsset(
    reader.pos === nameOffset,
    "INVALID_PACKAGE_SUMMARY",
    "Package summary does not end where its name table begins",
    { summaryEnd: reader.pos, nameOffset, fileVersionUE4, fileVersionUE5, legacyFileVersion },
  );
  assertUAsset(
    totalHeaderSize > 0 &&
      totalHeaderSize <= bytes.byteLength &&
      bulkDataStartOffset >= totalHeaderSize &&
      bulkDataStartOffset <= bytes.byteLength,
    "INVALID_PACKAGE_SUMMARY",
    "Package header and bulk-data offsets do not bracket the package",
    { totalHeaderSize, bulkDataStartOffset, byteLength: bytes.byteLength },
  );

  return {
    ...summary,
    totalHeaderSize,
    bulkDataStartOffset,
    nameCount,
    nameOffset,
    exportCount,
    exportOffset,
  };
}

/**
 * Walks the whole `FPackageFileSummary` for the offsets bulk data is addressed against, and
 * returns `undefined` when the walk cannot be trusted — an unmodelled legacy version, or a
 * summary that does not end on its own name table. Declining is the point: an offset guessed
 * from a mis-walked summary would send the bulk reader somewhere plausible and wrong.
 */
export function readPackageLayout(bytes: Uint8Array): IPackageLayout | undefined {
  let summary: IPackageSummary;
  try {
    summary = readPackageSummary(bytes);
  } catch {
    return undefined;
  }
  if (summary.legacyFileVersion < OLDEST_MODELLED_LEGACY_VERSION) return undefined;
  try {
    return walkSummary(bytes, summary);
  } catch (error) {
    if (error instanceof UAssetError) return undefined;
    throw error;
  }
}
