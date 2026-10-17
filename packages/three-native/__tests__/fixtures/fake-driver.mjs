#!/usr/bin/env node
/**
 * A native driver that answers from the recorded goldens.
 *
 * It exists so the differential runner's three paths are provable without a native binary:
 *
 *   TN_FAKE_DRIVER_MODE=echo        (default) answer every observation with the golden value
 *   TN_FAKE_DRIVER_MODE=perturb     answer, then flip one bit of one number
 *   TN_FAKE_DRIVER_MODE=unsupported refuse the fixture
 *   TN_FAKE_DRIVER_MODE=error       fail the way a driver fails
 *   TN_FAKE_DRIVER_MODE=short       answer fewer observations than the fixture asserts
 *
 * Reads the line protocol on stdin, writes one reply per observation on stdout, exits 0.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPATIBILITY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tests",
  "compatibility",
);
const MODE = process.env.TN_FAKE_DRIVER_MODE ?? "echo";

/** One bit of one number: the smallest possible disagreement a native engine can have. */
function perturb(value) {
  const [first, ...rest] = value.split(",");
  // BigInt: a 64-bit pattern does not survive a JS number, and `^ 1` on one is nonsense.
  const bits = BigInt(`0x${first.slice(2)}`) ^ 1n;
  return [`n:${bits.toString(16).padStart(16, "0")}`, ...rest].join(",");
}

const commands = readFileSync(0, "utf8").split("\n");
const name = commands
  .find((line) => line.startsWith("fixture "))
  ?.slice("fixture ".length)
  .trim();
if (name === undefined) process.exit(1);

const observations = commands
  .filter((line) => line.startsWith("observe "))
  .map((line) => {
    const [, index, id, fixturePath, method, kind] = line.split(" ");
    return {
      index: Number(index),
      id,
      path: fixturePath === "-" ? undefined : fixturePath,
      method: method === "-" ? undefined : method,
      kind,
    };
  });

const [version] = readdirSync(path.join(COMPATIBILITY, "goldens")).sort();
const golden = JSON.parse(
  readFileSync(path.join(COMPATIBILITY, "goldens", version, `${name}.json`), "utf8"),
);

if (MODE === "unsupported") {
  process.stdout.write(
    `unsupported - ${encodeURIComponent(`${name} is not built into the fake driver`)}\n`,
  );
  process.exit(0);
}
if (MODE === "error") {
  process.stdout.write(
    `error ${encodeURIComponent("TN_NATIVE_ENGINE_UNAVAILABLE: no engine in this process")}\n`,
  );
  process.exit(0);
}

const answered = MODE === "short" ? observations.slice(0, 1) : observations;
for (const observation of answered) {
  const recorded = golden.observations[observation.index];
  if (recorded === undefined) process.exit(1);
  const value =
    MODE === "perturb" && observation.index === 0 ? perturb(recorded.value) : recorded.value;
  process.stdout.write(`obs ${observation.index} ${recorded.kind} ${value}\n`);
}
