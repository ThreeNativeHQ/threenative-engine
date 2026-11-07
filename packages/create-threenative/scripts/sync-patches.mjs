// Copies the dependency patches a scaffold applies from their one manifest.
//
// The list used to be spelled three times: here, in `copyFrameworkPatches`, and inline in the
// `prepack` one-liner. A three-version bump then needed all three edited or a tarball shipped a
// patch no kit names.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY = path.resolve(PACKAGE, "..", "..");
const DIRECTORY = path.join(PACKAGE, "template-assets", "patches");
const MANIFEST = path.join(DIRECTORY, "manifest.json");

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
if (manifest.version !== 1) throw new Error("TN_FRAMEWORK_PATCH_MANIFEST: version must be 1.");
if (!Array.isArray(manifest.patches)) {
  throw new Error("TN_FRAMEWORK_PATCH_MANIFEST: patches must be an array.");
}
const names = new Set();
for (const patch of manifest.patches) {
  if (typeof patch?.name !== "string" || typeof patch?.source !== "string") {
    throw new Error("TN_FRAMEWORK_PATCH_MANIFEST: every patch needs a name and a source.");
  }
  if (names.has(patch.name)) {
    throw new Error(`TN_FRAMEWORK_PATCH_MANIFEST: '${patch.name}' is listed twice.`);
  }
  names.add(patch.name);
}

mkdirSync(DIRECTORY, { recursive: true });
// A patch this repository no longer applies must not survive in a tarball from an earlier build.
for (const file of readdirSync(DIRECTORY)) {
  if (file !== "manifest.json" && !names.has(file))
    rmSync(path.join(DIRECTORY, file), { force: true });
}
for (const patch of manifest.patches) {
  const source = path.resolve(REPOSITORY, patch.source);
  const destination = path.join(DIRECTORY, patch.name);
  // A source checkout has the bytes; a packed install already carries the copy and has no sources.
  if (existsSync(source)) copyFileSync(source, destination);
  else if (!existsSync(destination)) {
    throw new Error(`TN_FRAMEWORK_PATCH_MISSING: ${patch.source} is absent and no copy ships.`);
  }
}
// stderr, not stdout: `pnpm pack --json` parses stdout, and a prepack that logs there corrupts it.
process.stderr.write(
  `framework patches: ${manifest.patches.map((patch) => patch.name).join(", ")}\n`,
);
