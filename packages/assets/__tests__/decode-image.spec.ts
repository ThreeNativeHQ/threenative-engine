import { describe, expect, it } from "vitest";
import { rgbaPng } from "../../../test-support/png.js";
import { decodeImageBytes } from "../src/passes/decode-image.js";

/**
 * A glTF buffer view is padded to four bytes, and three's GLTFExporter counts that padding inside
 * the image's own view, so an embedded PNG arrives with up to three zero bytes after IEND. The
 * image is still the image; anything else after IEND is still a corrupt file.
 */
describe("decodeImageBytes", () => {
  const png = rgbaPng({ height: 4, width: 4 });

  it("decodes a PNG that carries glTF zero padding after IEND", async () => {
    for (const pad of [1, 2, 3]) {
      const decoded = await decodeImageBytes(
        Buffer.concat([png, Buffer.alloc(pad)]),
        "world.glb#texture#0",
      );
      expect([decoded.width, decoded.height]).toEqual([4, 4]);
    }
  });

  it("still refuses trailing bytes that are not padding", async () => {
    await expect(
      decodeImageBytes(Buffer.concat([png, Buffer.from([1, 2, 3])]), "x.png"),
    ).rejects.toThrow("TN_ASSETS_TEXTURE_CONTAINER");
  });
});
