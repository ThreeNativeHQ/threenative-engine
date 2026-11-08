import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, test } from 'vitest';

import { stageAndroidAssets } from '../scripts/package-android.mjs';
import { minimalGlb } from './fixtures/minimal-glb.mjs';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('Android staging replaces stale game assets with every public file', () => {
  const root = makeTempDirSync('threenative-android-assets-');
  roots.push(root);
  const assets = join(root, 'public');
  const destination = join(root, 'apk-assets', 'game');
  mkdirSync(join(assets, 'textures'), { recursive: true });
  mkdirSync(join(assets, 'models'), { recursive: true });
  mkdirSync(destination, { recursive: true });
  const model = minimalGlb();
  writeFileSync(join(assets, 'textures', 'x.png'), 'texture');
  writeFileSync(join(assets, 'models', 'level.glb'), model);
  writeFileSync(join(destination, 'stale.bin'), 'stale');

  assert.deepEqual(stageAndroidAssets(assets, destination), ['models/level.glb', 'textures/x.png']);
  assert.equal(readFileSync(join(destination, 'textures', 'x.png'), 'utf8'), 'texture');
  assert.deepEqual(readFileSync(join(destination, 'models', 'level.glb')), model);
  assert.equal(existsSync(join(destination, 'stale.bin')), false);
});

test('Android staging allows a missing public directory and rejects a file', () => {
  const root = makeTempDirSync('threenative-android-assets-missing-');
  roots.push(root);
  const destination = join(root, 'apk-assets', 'game');
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'stale.bin'), 'stale');

  assert.deepEqual(stageAndroidAssets(join(root, 'missing'), destination), []);
  assert.equal(existsSync(join(destination, 'stale.bin')), false);
  assert.equal(existsSync(destination), true);

  const file = join(root, 'not-a-directory');
  writeFileSync(file, 'no');
  assert.throws(() => stageAndroidAssets(file, destination), /not a directory/u);
});
