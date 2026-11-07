// Scaffolds a single template and runs its playtests, so one genre can be verified
// without paying for every template in scripts/verify-template-playtests.ts.
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createProject } from "../packages/create-threenative/src/index.js";
import { runAsync } from "./lib/exec.js";
import { packageLocalFramework } from "./visual-gate.js";

const template = process.argv[2];
if (template === undefined) throw new Error("usage: verify-one-template.ts <template>");

const root = await mkdtemp(path.join(os.tmpdir(), `threenative-${template}-`));
console.info(`scaffold root: ${root}`);
const packageSources = await packageLocalFramework(root);
const target = path.join(root, template);
await createProject({ install: true, packageSources, target, template });
await runAsync("pnpm", ["test"], target);
console.info(`${template}: scaffolded playtests passed at ${target}`);
