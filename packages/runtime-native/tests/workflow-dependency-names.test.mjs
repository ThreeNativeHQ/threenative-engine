import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const runtimeRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowRoot = join(runtimeRoot, '..', '..', '.github', 'workflows');

/** The dependency names `download-deps.mjs` actually knows, read from the script itself. */
function knownDependencies() {
  const source = readFileSync(join(runtimeRoot, 'scripts', 'download-deps.mjs'), 'utf8');
  const start = source.indexOf('const DEPS = {');
  assert.ok(start > 0, 'download-deps.mjs must declare a DEPS map');
  const names = new Set();
  // Top-level keys of the DEPS literal: two-space indented `'name': {`.
  for (const match of source.slice(start).matchAll(/^ {2}['"]?([\w.-]+)['"]?:\s*\{/gmu))
    names.add(match[1]);
  assert.ok(names.size > 5, `expected several dependencies, parsed ${names.size}`);
  // Some implemented `--only` names are not DEPS entries: `gradle-wrapper` (one checksummed file)
  // and `skia-android` (a bounded source build) live in the allowlist and run through an explicit
  // `depName === '...'` branch. Accept such a name only when that branch exists, so a name nothing
  // implements still fails.
  for (const match of source.matchAll(/if\s*\(\s*depName\s*===\s*['"]([\w.-]+)['"]\s*\)/gu))
    names.add(match[1]);
  return names;
}

// The Android lane spent every run failing on `Unknown dependency: cgltf` — a workflow asking
// download-deps for something it has never had, for a source file (`src/gltf/gltf_loader.cpp`)
// that no CMake target compiles. Nothing connected the two lists, so the workflow could name
// anything at all and only a CI run would say otherwise.
test('every dependency a workflow fetches is one download-deps knows', () => {
  const known = knownDependencies();
  const unknown = [];
  for (const file of readdirSync(workflowRoot)) {
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
    const workflow = readFileSync(join(workflowRoot, file), 'utf8');
    for (const match of workflow.matchAll(/download-deps\.mjs\s+--only\s+([\w.-]+)/gu)) {
      if (!known.has(match[1])) unknown.push(`${file}: --only ${match[1]}`);
    }
  }
  assert.deepEqual(unknown, []);
});
