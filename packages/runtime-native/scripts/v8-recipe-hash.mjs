#!/usr/bin/env node

/**
 * The hash that names the Android V8 payload: the release asset `v8-android-<hash>.tgz` and the
 * `android-v8-payload-*` and `android-v8-source-*` cache keys all carry it.
 *
 * It covers only what decides the payload's bytes — the `v8-android` entry of the dependency
 * provisioner and the three files that build the payload — and nothing else. Hashing the whole of
 * `download-deps.mjs` made any edit to that file a new key: on PR #493 an unrelated +29/-11 edit to
 * it missed the published asset and cold-built V8 for two hours in run 39184795139.
 *
 * Usage:
 *   node scripts/v8-recipe-hash.mjs       # print the hash for this checkout
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROVISIONER = 'scripts/download-deps.mjs';

/** Files whose every byte feeds the payload build. Kept explicit: this list is the recipe. */
export const V8_RECIPE_FILES = Object.freeze([
  'scripts/build-android-v8.mjs',
  'scripts/check-android-16kb-alignment.mjs',
  'android/gradle.properties',
]);

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Trailing whitespace is not an input: only the token stream of the entry matters. */
function normalize(text) {
  return text.replace(/[ \t]+$/gmu, '').trimEnd();
}

/**
 * The `'v8-android': { … }` member of the provisioner's DEPS map, from its source text. A brace
 * counter that skips comments and string literals, because the entry is a comment-heavy object and
 * the first closing brace after it is not its own.
 *
 * The entry has to stay plain data. A template literal can hold a `}` this scanner would read as
 * the entry's end, and a regex literal can hold a brace or a quote; neither can be scanned without
 * a JavaScript parser, so both are refused by name instead of hashed as the wrong slice.
 */
export function v8AndroidDependencyEntry(source) {
  const key = source.indexOf("'v8-android': {");
  if (key === -1) throw new Error(`TN_V8_RECIPE_ENTRY_MISSING: no 'v8-android' entry in ${PROVISIONER}`);
  const open = source.indexOf('{', key);
  let depth = 0;
  let quote = '';
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index);
      if (index === -1) break;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index);
      if (index === -1) break;
      index += 1;
      continue;
    }
    if (char === '/' || char === '`') {
      throw new Error(
        `TN_V8_RECIPE_ENTRY_NOT_PLAIN: ${PROVISIONER}'s 'v8-android' entry holds a ${
          char === '`' ? 'template literal' : 'regular expression'
        }; keep it plain data so its brace can be found`,
      );
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return normalize(source.slice(key, index + 1));
    }
  }
  throw new Error(`TN_V8_RECIPE_ENTRY_UNTERMINATED: no closing brace for the 'v8-android' entry`);
}

/**
 * Hash of the recipe. Same bytes anywhere is the same hash, so a self-hosted checkout and a hosted
 * one share a payload.
 */
export function androidV8RecipeHash(root = RUNTIME_ROOT) {
  const parts = V8_RECIPE_FILES.map(
    (relative) => `${relative} ${sha256(readFileSync(join(root, relative)))}`,
  );
  const entry = v8AndroidDependencyEntry(readFileSync(join(root, PROVISIONER), 'utf8'));
  parts.push(`${PROVISIONER}#v8-android ${sha256(entry)}`);
  return sha256(parts.join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${androidV8RecipeHash()}\n`);
}
