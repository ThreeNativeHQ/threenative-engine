import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { androidGradleEnvironment, androidGradleFailure } from '../scripts/package-android.mjs';
import { makeTempDirSync } from '../../../test-support/temp-dir.js';

const jdk = (version) => () => ({ stderr: `openjdk version "${version}" 2026-10-24\n`, stdout: '' });

test('a Gradle failure on a JDK it cannot run on names the JDK and the fix', () => {
  assert.match(
    androidGradleFailure(1, {}, jdk('27.0.1.0.3')),
    /Gradle exited with code 1\. TN_ANDROID_JDK_UNSUPPORTED: java is JDK 27.*JAVA_HOME/u,
  );
  assert.equal(androidGradleFailure(1, {}, jdk('17.0.20.1')), 'Gradle exited with code 1.');
  assert.equal(androidGradleFailure(1, {}, () => ({})), 'Gradle exited with code 1.');
});

test('the default SDK path that doctor reports reaches Gradle', () => {
  const home = makeTempDirSync('android-home-');
  mkdirSync(join(home, 'Android', 'Sdk'), { recursive: true });
  assert.equal(androidGradleEnvironment({}, { home }).ANDROID_HOME, join(home, 'Android', 'Sdk'));
});

test('a named SDK wins, and a missing default adds nothing', () => {
  const named = { ANDROID_SDK_ROOT: '/sdk' };
  assert.equal(androidGradleEnvironment(named, { home: '/nonexistent' }), named);
  assert.equal(androidGradleEnvironment({}, { home: '/nonexistent' }).ANDROID_HOME, undefined);
});
