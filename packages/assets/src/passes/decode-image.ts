import { PNG } from "pngjs";
import { parsePng } from "../png.js";

/**
 * Decodes an encoded image's bytes to tight 8-bit RGBA for the Basis encoder, which takes
 * decoded pixels through its Node-side `imageDecoder` hook. PNG and JPEG are pure-JS decoders
 * already in the dependency tree; WebP is not, so it goes through `sharp` — declared but
 * previously unused, native, and confined to this build-time package (PRD-485). Containers none
 * of the three reads throw: a source this step cannot encode fails the build naming the file,
 * never silently ships uncompressed.
 */
export async function decodeImageBytes(
  input: Buffer,
  logicalPath: string,
): Promise<{ data: Uint8Array; height: number; width: number }> {
  const bytes = withoutGlbPadding(input);
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const { decode } = await import("jpeg-js");
    const image = decode(bytes, { useTArray: true });
    assertRgba(image.data.length, image.width, image.height, logicalPath);
    return { data: new Uint8Array(image.data), height: image.height, width: image.width };
  }
  if (parsePng(bytes) !== undefined) {
    const image = PNG.sync.read(bytes);
    assertRgba(image.data.length, image.width, image.height, logicalPath);
    return { data: new Uint8Array(image.data), height: image.height, width: image.width };
  }
  // RIFF container, `WEBP` form type — what an EXT_texture_webp image carries out of Fab.
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    const sharp = (await import("sharp")).default;
    try {
      const { data, info } = await sharp(bytes)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      assertRgba(data.length, info.width, info.height, logicalPath);
      return { data, height: info.height, width: info.width };
    } catch (error) {
      throw new Error(
        `TN_ASSETS_TEXTURE_UNREADABLE: '${logicalPath}' is a WebP the decoder could not read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `TN_ASSETS_TEXTURE_CONTAINER: '${logicalPath}' is not a PNG, JPEG or WebP the KTX2 encoder can read; convert it to .png or .jpg.`,
  );
}

/**
 * A glTF buffer view is padded to four bytes and three's GLTFExporter counts the padding inside the
 * image's own view, so an embedded PNG can end in up to three zero bytes after IEND (the chunk's
 * last twelve bytes). Those are not part of the image; any other trailing byte still is corruption.
 */
function withoutGlbPadding(bytes: Buffer): Buffer {
  for (let pad = 1; pad <= 3; pad += 1) {
    const end = bytes.length - pad;
    if (
      bytes.length > 12 + pad &&
      bytes.toString("ascii", end - 8, end - 4) === "IEND" &&
      bytes.subarray(end).every((byte) => byte === 0)
    )
      return bytes.subarray(0, end);
  }
  return bytes;
}

function assertRgba(length: number, width: number, height: number, logicalPath: string): void {
  if (width <= 0 || height <= 0 || length !== width * height * 4) {
    throw new Error(
      `TN_ASSETS_TEXTURE_UNDECODABLE: '${logicalPath}' did not decode to 8-bit RGBA (${width}x${height}, ${length} bytes).`,
    );
  }
}
