#!/usr/bin/env node
// PRD-510 phase 2: the TSL builder differential. `--suite tsl-ir` runs the native corpus executable
// (every graph authored with the native TSL builder, printing its typed IR dump) and the upstream
// reference (tsl-corpus/reference.ts, the same graphs in the pinned three's TSL, normalised into the
// IR's syntax), and compares them graph by graph.
//
// One normalisation is applied to the native text: an ordered read (`%n = load v3`, `%n = load
// buf[i]`) is inlined where it is used, as `v3` / `load:buf[i]`. Upstream TSL has no separate read
// statement, so the comparison is of structure and types, not of the IR's read numbering.
//
// Usage: node differential.mjs --suite tsl-ir [--native <corpus executable> | --wasm <abi module .js>]
// `--wasm` runs the JS corpus (tsl-corpus/corpus.js) on the Wasm back end (wasm/tsl-corpus.ts).
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../..");
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

if (option("--suite") !== "tsl-ir") {
  console.error("TN_DIFFERENTIAL_SUITE: usage: differential.mjs --suite tsl-ir [--native <executable>]");
  process.exit(2);
}
const native = path.resolve(
  option("--native") ?? path.join(packageRoot, "build/tn-linux/tn-native-engine-tsl-corpus"),
);

function run(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  if (result.status !== 0) {
    console.error(`TN_DIFFERENTIAL_RUN: ${command} ${commandArgs.join(" ")} exited ${result.status}`);
    console.error(result.stderr);
    process.exit(1);
  }
  return result.stdout;
}

/** `# name` headers split a dump into graphs, in order. */
function graphs(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("# ")) out.push({ name: line.slice(2), lines: [] });
    else if (line.length > 0) out.at(-1)?.lines.push(line);
  }
  return out;
}

function inlineReads(lines) {
  const reads = new Map();
  const out = [];
  for (const line of lines) {
    const read = /^\s*%(\d+) = load (\S+?)(\[.*\])?$/.exec(line);
    if (read) {
      const [, number, target, index] = read;
      reads.set(number, index === undefined ? target : `load:${target}${index}`);
      continue;
    }
    out.push(line.replace(/%(\d+)/g, (whole, number) => reads.get(number) ?? whole));
  }
  // An index may itself name an earlier read.
  return out.map((line) => line.replace(/%(\d+)/g, (whole, number) => reads.get(number) ?? whole));
}

const wasm = option("--wasm");
const nativeText =
  wasm === undefined
    ? run(native, [], packageRoot)
    : run("pnpm", ["exec", "tsx", "tests/native-engine/wasm/tsl-corpus.ts", path.resolve(wasm)], packageRoot);
const nativeGraphs = graphs(nativeText).map((graph) => ({
  ...graph,
  lines: inlineReads(graph.lines),
}));
const referenceGraphs = graphs(
  run("pnpm", ["exec", "tsx", "tests/native-engine/tsl-corpus/reference.ts"], packageRoot),
);

let differ = 0;
const count = Math.max(nativeGraphs.length, referenceGraphs.length);
for (let index = 0; index < count; index += 1) {
  const got = nativeGraphs[index];
  const want = referenceGraphs[index];
  if (got?.name !== want?.name || got.lines.join("\n") !== want.lines.join("\n")) {
    differ += 1;
    console.error(`differs: ${want?.name ?? got?.name}`);
    console.error(`  upstream: ${want?.lines.join("\n            ")}`);
    console.error(`  native:   ${got?.lines.join("\n            ")}`);
  }
}
console.log(`tsl-ir: ${count} graphs, ${differ} differ`);
process.exit(count === 0 || differ !== 0 ? 1 : 0);
