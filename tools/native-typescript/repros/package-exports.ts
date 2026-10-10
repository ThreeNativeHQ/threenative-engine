// Perry 0.5.1520 ignores exports/main when src/index.ts exists.
// Repro setup: copy package-exports-fixture to <out>/node_modules/tn-perry-exports-repro,
// this file to <out>/entry.ts, and write {"type":"module"} to <out>/package.json.
// tsx entry.ts: native (exit 0); strict Perry compile/run: web (exit 0).
// Fork fix: crates/perry/src/commands/compile/resolve.rs must honor exports/import and main before src/index.ts probing.
import { marker } from "tn-perry-exports-repro";
console.log(marker);
