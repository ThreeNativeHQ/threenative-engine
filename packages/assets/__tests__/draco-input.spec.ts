import { NodeIO } from "@gltf-transform/core";
import type { Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRDracoMeshCompression } from "@gltf-transform/extensions";
import draco3dgltf from "draco3dgltf";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFixtureDocument } from "../../../test-support/generate-fixture-model.js";
import { modelPass } from "../src/passes/model.js";

/**
 * Draco is an input format, never an output: a user's existing Draco `.glb` dropped into
 * `assets/` decodes here and ships again as EXT_meshopt_compression, so the runtime needs
 * only the one decoder wiring. These tests generate their Draco fixture offline through
 * gltf-transform's own Draco bindings rather than committing a binary blob.
 */

async function writeDocument(document: Document): Promise<Buffer> {
  await MeshoptEncoder.ready;
  const binary = await new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      "meshopt.encoder": MeshoptEncoder,
      "meshopt.decoder": MeshoptDecoder,
    })
    .writeBinary(document);
  return Buffer.from(binary);
}

async function readExtensions(buffer: Buffer): Promise<ReadonlySet<string>> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "meshopt.encoder": MeshoptEncoder,
    "meshopt.decoder": MeshoptDecoder,
    "draco3d.decoder": await draco3dgltf.createDecoderModule(),
    "draco3d.encoder": await draco3dgltf.createEncoderModule(),
  });
  const document = (await io.readJSON(await io.binaryToJSON(buffer))).getRoot();
  return new Set(document.listExtensionsUsed().map((extension) => extension.extensionName));
}

async function dracoFixture(): Promise<Buffer> {
  const document = buildFixtureDocument({ textured: false });
  // Marking the compression extension required makes the writer run every primitive's
  // geometry through the Draco encoder at write time.
  document.createExtension(KHRDracoMeshCompression).setRequired(true);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "draco3d.encoder": await draco3dgltf.createEncoderModule() });
  return Buffer.from(await io.writeBinary(document));
}

describe("modelPass with a Draco input", () => {
  afterEach(() => vi.restoreAllMocks());

  it("should re-emit a Draco input as a Meshopt output", async () => {
    const input = await dracoFixture();
    // Sanity: the fixture really is Draco on the way in.
    expect([...(await readExtensions(input))]).toContain("KHR_draco_mesh_compression");

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await modelPass().apply(input, "legacy.glb");

    expect(Buffer.isBuffer(result)).toBe(false);
    if (!Buffer.isBuffer(result)) {
      const extensions = await readExtensions(result.buffer);
      expect(extensions.has("EXT_meshopt_compression")).toBe(true);
      expect(extensions.has("KHR_draco_mesh_compression")).toBe(false);
      expect(result.entry?.triangles).toBe(20);
    }
  });

  it("should leave the file untouched when every sub-pass is off", async () => {
    const input = await dracoFixture();
    const result = await modelPass({
      compact: false,
      passes: {
        dedup: false,
        meshopt: false,
        prune: false,
        quantize: false,
        reorder: false,
        restTracks: false,
      },
      virtual: "none",
    }).apply(input, "legacy.glb");
    // The negative control for the re-emission test: no transform, no re-emission — which
    // is exactly what would ship if the pass were skipped.
    expect(Buffer.isBuffer(result)).toBe(true);
    expect((result as Buffer).equals(input)).toBe(true);
  });
});
