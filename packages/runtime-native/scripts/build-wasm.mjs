#!/usr/bin/env node

/**
 * Builds the browser Wasm engines (`build/web/tn-native-engine-web{,-threads}.{mjs,wasm}`) in one command.
 *
 * The default web engine is this file. It needs three things that git does not carry: the
 * `stb`, `cgltf` and `webp-source` sources under `third_party/` and an Emscripten SDK. A web
 * engine built without `cgltf` compiles and then refuses every model, so this script fetches the
 * sources first and then runs the `wasm` CMake preset.
 *
 * Usage: pnpm wasm:build   (from the repository root)
 *   EMSDK=<dir>            Emscripten SDK root; default ~/emsdk
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Each source the Wasm engine compiles, and a file that proves it is provisioned. */
const SOURCES = [
  ['stb', 'third_party/stb/stb_image.h'],
  ['cgltf', 'third_party/cgltf/cgltf.h'],
  ['webp-source', 'third_party/webp-source'],
];

const run = (command, args, env = process.env) =>
  execFileSync(command, args, { cwd: ROOT, env, stdio: 'inherit' });

function emsdkRoot() {
  const root = resolve(process.env.EMSDK ?? join(homedir(), 'emsdk'));
  if (!existsSync(join(root, 'upstream', 'emscripten', 'emcc'))) {
    throw new Error(
      `TN_EMSDK_MISSING: no Emscripten SDK at ${root}. Install it once: ` +
        '`git clone https://github.com/emscripten-core/emsdk ~/emsdk && ~/emsdk/emsdk install latest && ~/emsdk/emsdk activate latest`, ' +
        'or set EMSDK to an existing install.',
    );
  }
  return root;
}

const emsdk = emsdkRoot();
for (const [name, proof] of SOURCES) {
  if (!existsSync(join(ROOT, proof))) run('node', ['scripts/download-deps.mjs', '--only', name]);
}
const env = {
  ...process.env,
  EMSDK: emsdk,
  PATH: `${join(emsdk, 'upstream', 'emscripten')}:${process.env.PATH ?? ''}`,
};
// The single-thread engine, and the threaded one a cross-origin-isolated page loads (PRD-752 phase 4).
for (const preset of ['wasm', 'wasm-threads']) {
  run('cmake', ['--preset', preset], env);
  run('cmake', ['--build', '--preset', preset], env);
}
