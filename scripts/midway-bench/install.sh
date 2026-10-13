#!/bin/sh
# Packs this checkout's engine packages and installs them into a Midway game copy, as `pnpm sandbox`
# installs them, so the copy runs the engine under test. Build the packages first: pack ships each
# package's existing dist (create-threenative embeds three-native's registry; the Wasm host is
# packages/runtime-native/build/web/).
#
#   sh scripts/midway-bench/install.sh <game-dir> [--no-pack]
#
# Env: MIDWAY_PACKS  where the tarballs go (default ${XDG_CACHE_HOME:-~/.cache}/midway-packs)
set -eu
GAME=${1:?usage: install.sh <game-dir> [--no-pack]}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
PACKS=${MIDWAY_PACKS:-${XDG_CACHE_HOME:-$HOME/.cache}/midway-packs}
mkdir -p "$PACKS"
if [ "${2:-}" != "--no-pack" ]; then
  rm -f "${PACKS:?}"/*.tgz
  cd "$REPO"
  for d in core physics ui assets playtest runtime-native create-threenative; do
    pnpm --filter "./packages/$d" pack --pack-destination "$PACKS" >/dev/null
  done
fi
cd "$GAME"
node --input-type=module - "$PACKS" <<'JS'
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const packs = process.argv[2];
const files = readdirSync(packs);
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const names = {
  core: "@threenative/core", physics: "@threenative/physics", ui: "@threenative/ui",
  assets: "@threenative/assets", playtest: "@threenative/playtest",
  "runtime-native": "@threenative/runtime-native", "create-threenative": "create-threenative",
};
for (const [key, name] of Object.entries(names)) {
  const prefix = name.startsWith("@") ? `threenative-${key}-` : "create-threenative-";
  const found = files.filter((f) => f.startsWith(prefix));
  if (found.length !== 1) throw new Error(`expected one tarball for ${name}, found ${found}`);
  const spec = `file:${path.join(packs, found[0])}`;
  for (const field of ["dependencies", "devDependencies"])
    if (pkg[field]?.[name]) pkg[field][name] = spec;
  pkg.pnpm ??= {};
  pkg.pnpm.overrides ??= {};
  pkg.pnpm.overrides[name] = spec;
}
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
JS
CI=1 pnpm install --no-frozen-lockfile
# vite keeps the pre-bundled engine glue (its minified import names) under a version hash, and a browser caches it
# as immutable: a new Wasm build under an old glue crashes at boot (setVertexBuffer or adapter.info of undefined).
# Restart the dev server after an install, and never serve a game copy that vite cached before it.
rm -rf "${GAME:?}/node_modules/.vite"
