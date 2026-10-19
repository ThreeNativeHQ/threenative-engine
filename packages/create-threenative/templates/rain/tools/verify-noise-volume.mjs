// Proves `src/render/noise-volume.ts` is the reference study's volume, byte for byte.
//
//   node --import tsx tools/verify-noise-volume.mjs <tempest.html>
//
// The generated module is imported and run; `rng` and `noiseVolume` are cut out of the study file
// and called in a `node:vm` context holding nothing but `Math`, `Uint8Array` and `Float32Array`,
// because the comparison is over pure data and neither side may reach a browser, a GPU or the
// framework. Fails closed: a missing file, a function the study no longer has, or one differing byte
// is an error, and the full 1 MiB is compared rather than a sample of it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { NOISE_SIZE, createNoiseVolume } from "../src/render/noise-volume.ts";

const [source] = process.argv.slice(2);
if (source === undefined) {
  console.error("usage: node --import tsx tools/verify-noise-volume.mjs <tempest.html>");
  process.exit(2);
}

/** The text of `function <name>` from `from`, up to its own closing brace. */
function functionSource(text, name) {
  const start = text.indexOf(`function ${name}`);
  if (start === -1) throw new Error(`TN_SOURCE_MISSING: ${name} is not in the study`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "{") {
      depth += 1;
      opened = true;
    } else if (text[index] === "}" && opened) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`TN_SOURCE_UNBALANCED: ${name} never closes`);
}

const study = readFileSync(source, "utf8");
const reference = runInNewContext(
  `(() => {${study.match(/const mix=[^\n]*/u)[0]}
${functionSource(study, "rng")}
${functionSource(study, "noiseVolume")}
return noiseVolume();})()`,
  { Math, Uint8Array, Float32Array },
);
const expected = reference.data;
const actual = createNoiseVolume().data;

if (actual.length !== expected.length || expected.length !== NOISE_SIZE ** 3 * 4) {
  throw new Error(`TN_NOISE_SIZE: ${expected.length} source bytes, ${actual.length} generated`);
}
for (let index = 0; index < expected.length; index += 1) {
  if (actual[index] !== expected[index]) {
    throw new Error(
      `TN_NOISE_BYTE: index ${index} is ${actual[index]}, source has ${expected[index]}`,
    );
  }
}
const digest = createHash("sha256").update(actual).digest("hex");
console.log(`TN_NOISE_MATCH ${actual.length} bytes sha256=${digest}`);
