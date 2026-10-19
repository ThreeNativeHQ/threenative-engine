import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { IPlaytestCaptureProvenance } from "@threenative/playtest";
import { softwareAdapterName } from "@threenative/playtest/runner";

interface IDecodedCapture {
  width: number;
  height: number;
  data: Buffer;
}
const { PNG } = createRequire(import.meta.resolve("@threenative/playtest/package.json"))(
  "pngjs",
) as {
  PNG: { sync: { read: (bytes: Buffer) => IDecodedCapture } };
};
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Frozen canonical content; a same-name shortened scenario cannot qualify. */
export function riggingScenario(bytes: Buffer): "correctness" | "lifecycle" | "benchmark" {
  let canonical: string;
  try {
    canonical = JSON.stringify(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new Error("TN_AVBD_QUALIFICATION: invalid scenario JSON.", { cause: error });
  }
  const hash = sha256(Buffer.from(canonical));
  if (hash === "47533aad23e554a9bf1d863870f0033bf51b96c55e5b34b708bc6508adf3e599")
    return "correctness";
  if (hash === "1b6e32e4c39dc7621a348b24265e0ca56bab4e89446124de9ef7848ce9a9f5ac")
    return "lifecycle";
  if (hash === "486cf9766d1cc8d7fd6927e8df2a3c2aaf139befd01a358c7a2a3ad807bb4a25")
    return "benchmark";
  throw new Error("TN_AVBD_QUALIFICATION: scenario content differs from the frozen workload.");
}

export function assertRiggingCapture(
  capture: IPlaytestCaptureProvenance | undefined,
  target: string,
) {
  const adapter = capture?.adapter;
  const identified =
    adapter !== undefined &&
    adapter !== null &&
    typeof adapter === "object" &&
    !Array.isArray(adapter) &&
    ["architecture", "description", "device", "vendor"].some(
      (key) => typeof adapter[key] === "string" && adapter[key].trim() !== "",
    );
  if (
    !identified ||
    capture?.rendererKind !== "webgpu" ||
    capture.target !== (target === "browser" ? "web" : target) ||
    capture.viewport?.width !== 1280 ||
    capture.viewport?.height !== 720 ||
    capture.captureMethod !== (target === "browser" ? "page.screenshot" : "device.screenshot") ||
    softwareAdapterName(adapter) !== undefined
  )
    throw new Error(
      "TN_AVBD_QUALIFICATION: recorded hardware WebGPU capture identity is required.",
    );
}

/** Inspect only existing harness PNGs; no new capture, renderer or device. */
export function riggingPixels(bytes: Buffer) {
  let image: IDecodedCapture;
  try {
    image = PNG.sync.read(bytes);
  } catch (error) {
    throw new Error("TN_AVBD_DRAW: invalid captured PNG.", { cause: error });
  }
  if (image.width !== 1280 || image.height !== 720)
    throw new Error(
      `TN_AVBD_DRAW: frozen capture is 1280x720, received ${image.width}x${image.height}.`,
    );
  const mask = new Uint8Array(image.width * image.height);
  const counts = { sail: 0, flag: 0, rope: 0 };
  let nonblank = 0;
  for (let pixel = 0; pixel < mask.length; pixel++) {
    const offset = pixel * 4;
    const r = image.data.readUInt8(offset);
    const g = image.data.readUInt8(offset + 1);
    const b = image.data.readUInt8(offset + 2);
    if (image.data.readUInt8(offset + 3) === 0) continue;
    nonblank += Number((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.01);
    // These three authored hue regions are disjoint; stage/background hues match none.
    const sail = Number(r >= g + 12 && g >= b + 25);
    const flag = Number(g >= r + 50 && b >= r + 50);
    const rope = Number(r >= g + 40 && b >= g + 40);
    counts.sail += sail;
    counts.flag += flag;
    counts.rope += rope;
    mask[pixel] = sail + flag * 2 + rope * 3;
  }
  for (const [name, minimum] of [
    ["sail", 1024],
    ["flag", 128],
    ["rope", 16],
  ] as const)
    if (counts[name] < minimum)
      throw new Error(
        `TN_AVBD_DRAW: ${name} pixels ${counts[name]} below frozen minimum ${minimum}.`,
      );
  const nonblankPixelRatio = nonblank / mask.length;
  if (nonblankPixelRatio < 0.01)
    throw new Error("TN_AVBD_DRAW: captured nonblank ratio below frozen minimum 0.01.");
  return { counts, mask, image, nonblankPixelRatio, sha256: sha256(bytes) };
}

export function qualifyRiggingDraw(before: Buffer, after: Buffer, requireChange = true) {
  const a = riggingPixels(before);
  const b = riggingPixels(after);
  let changedPixels = 0;
  let changed = 0;
  for (let pixel = 0; pixel < a.mask.length; pixel++) {
    changedPixels += Number(a.mask[pixel] !== b.mask[pixel]);
    const offset = pixel * 4;
    const difference = Math.max(
      Math.abs(a.image.data.readUInt8(offset) - b.image.data.readUInt8(offset)),
      Math.abs(a.image.data.readUInt8(offset + 1) - b.image.data.readUInt8(offset + 1)),
      Math.abs(a.image.data.readUInt8(offset + 2) - b.image.data.readUInt8(offset + 2)),
    );
    changed += Number(difference > 8);
  }
  const changedPixelRatio = changed / a.mask.length;
  if (requireChange && changedPixels < 64)
    throw new Error(
      `TN_AVBD_DRAW: only ${changedPixels} rope/sail/flag pixels changed, expected at least 64.`,
    );
  if (requireChange && changedPixelRatio < 0.001)
    throw new Error("TN_AVBD_DRAW: captured frame difference below frozen minimum 0.001.");
  return {
    before: { counts: a.counts, nonblankPixelRatio: a.nonblankPixelRatio, sha256: a.sha256 },
    after: { counts: b.counts, nonblankPixelRatio: b.nonblankPixelRatio, sha256: b.sha256 },
    changedPixelRatio,
    changedPixels,
    requireChange,
    pass: true,
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , before, after, mode] = process.argv;
  if (before === undefined || after === undefined || (mode !== undefined && mode !== "--lifecycle"))
    throw new Error(
      "TN_AVBD_DRAW: usage verify-capture.ts <before.png> <after.png> [--lifecycle].",
    );
  console.log(
    JSON.stringify({
      kind: "rigging-captured-draw",
      ...qualifyRiggingDraw(readFileSync(before), readFileSync(after), mode !== "--lifecycle"),
    }),
  );
}
