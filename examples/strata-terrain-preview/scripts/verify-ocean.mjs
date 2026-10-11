import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectCapture } from "../../../packages/runtime-native/conformance/metrics.mjs";

assert(process.argv[2], "Pass the target's capture directory");
const directory = resolve(process.argv[2]);
for (const [left, right, label] of [
  ["coastal-ocean-early", "coastal-ocean", "waves"],
  ["coastal-ocean", "coastal-sun-alt", "sun"],
]) {
  const a = inspectCapture(readFileSync(resolve(directory, `${left}.png`)));
  const b = inspectCapture(readFileSync(resolve(directory, `${right}.png`)));
  assert(
    a.width * 9 === a.height * 16 && b.width === a.width && b.height === a.height,
    "Shared scenario captures must be one 16:9 size",
  );
  const scale = a.width / 1280;
  let waterPixels = 0;
  let changed = 0;
  // Camera-matched water region in the shared 16:9 coastal view, authored at 1280 wide and scaled; exclude white foam.
  for (let y = Math.round(468 * scale); y < Math.round(700 * scale); y++)
    for (let x = Math.round(900 * scale); x < Math.round(1260 * scale); x++) {
      const i = (y * a.width + x) * 4;
      if (a.png.data[i + 2] <= a.png.data[i] + 15 || b.png.data[i + 2] <= b.png.data[i] + 15)
        continue;
      waterPixels++;
      const difference = [0, 1, 2].reduce(
        (sum, c) => sum + Math.abs(a.png.data[i + c] - b.png.data[i + c]),
        0,
      );
      if (difference > 12) changed++;
    }
  assert(waterPixels > 10000 * scale * scale, `${label}: water region was not observed`);
  assert(
    changed / waterPixels > 0.01,
    `${label}: water did not visibly change (${changed}/${waterPixels})`,
  );
  console.log(
    JSON.stringify({ oceanVisual: label, waterPixels, changedRatio: changed / waterPixels }),
  );
}

// The sheltered pool was filled with opaque white foam in round 8. Observe its water, not the sky.
const lagoon = inspectCapture(readFileSync(resolve(directory, "coastal-horizon-sea.png")));
const lagoonScale = lagoon.width / 1280;
let lagoonPixels = 0;
let bluePixels = 0;
for (let y = Math.round(600 * lagoonScale); y < Math.round(700 * lagoonScale); y++)
  for (let x = Math.round(940 * lagoonScale); x < Math.round(1220 * lagoonScale); x++) {
    const i = (y * lagoon.width + x) * 4;
    const [r, g, b] = lagoon.png.data.subarray(i, i + 3);
    lagoonPixels++;
    if (b > r + 20 && g > r + 12) bluePixels++;
  }
assert(lagoonPixels > 10000 * lagoonScale * lagoonScale, "lagoon: water region was not observed");
assert(
  bluePixels / lagoonPixels > 0.7,
  `lagoon: opaque foam obscures sheltered water (${bluePixels}/${lagoonPixels})`,
);
console.log(
  JSON.stringify({ oceanVisual: "sheltered-water", blueRatio: bluePixels / lagoonPixels }),
);
