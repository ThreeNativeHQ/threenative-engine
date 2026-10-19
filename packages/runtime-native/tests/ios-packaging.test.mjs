import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PNG } from 'pngjs';
import { afterEach, test } from 'vitest';

import {
  SDL3_IOS_VERSION,
  compileIosAssets,
  hasIosSceneManifestFields,
  packageIosSimulator,
  renderIosInfoPlist,
  runIosPackageCli,
  stageIosSimulatorApp,
} from '../scripts/package-ios.mjs';
import { SDL3_ANDROID_VERSION } from '../scripts/package-android.mjs';
import { PREBUILT_ASSET_NAMES } from '../scripts/install-prebuilt.mjs';
import { minimalGlb } from './fixtures/minimal-glb.mjs';

const roots = [];
const VALID_PNG = PNG.sync.write(new PNG({ height: 1024, width: 1024 }));
const SMALL_PNG = PNG.sync.write(new PNG({ height: 16, width: 16 }));
const infoPlist = `<plist><dict>
  <key>UISupportedInterfaceOrientations</key>
  <array>
    <string>UIInterfaceOrientationLandscapeLeft</string>
    <string>UIInterfaceOrientationLandscapeRight</string>
  </array>
  <key>UIApplicationSceneManifest</key>
  <dict>
    <key>UIApplicationSupportsMultipleScenes</key>
    <false/>
    <key>UISceneConfigurations</key>
    <dict>
      <key>UIWindowSceneSessionRoleApplication</key>
      <array>
        <dict>
          <key>UISceneConfigurationName</key>
          <string>Default Configuration</string>
          <key>UISceneDelegateClassName</key>
          <string>SDLUIKitSceneDelegate</string>
        </dict>
      </array>
    </dict>
  </dict>
</dict></plist>`;
const binaryInfoPlist = Buffer.from(
  [
    'YnBsaXN0MDDfEBkBAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fHSAhIiQlJicoJikqKywtLjE0Nl8QE0J1aWxkTWFjaGluZU9TQnVpbGRfEBlDRkJ1bmRsZURldmVsb3BtZW50UmVnaW9uXxATQ0ZCdW5kbGVEaXNwbGF5TmFtZV8QEkNGQnVuZGxlRXhlY3V0YWJsZV8QEkNGQnVuZGxlSWRlbnRpZmllcl8QHUNGQnVuZGxlSW5mb0RpY3Rpb25hcnlWZXJzaW9uXENGQnVuZGxlTmFtZV8QE0NGQnVuZGxlUGFja2FnZVR5cGVfEBpDRkJ1bmRsZVNob3J0VmVyc2lvblN0cmluZ18QGkNGQnVuZGxlU3VwcG9ydGVkUGxhdGZvcm1zXxAPQ0ZCdW5kbGVWZXJzaW9uWkRUQ29tcGlsZXJfEA9EVFBsYXRmb3JtQnVpbGReRFRQbGF0Zm9ybU5hbWVfEBFEVFBsYXRmb3JtVmVyc2lvblpEVFNES0J1aWxkWURUU0RLTmFtZVdEVFhjb2RlXERUWGNvZGVCdWlsZF8QEkxTUmVxdWlyZXNJUGhvbmVPU18QEE1pbmltaW1PU1ZlcnNpb25eVUlEZXZpY2VGYW1pbHleVUlMYXVuY2hTY3JlZW5fEBxVSVJlcXVpcmVkRGV2aWNlQ2FwYWJpbGl0aWVzXxAgVUlTdXBwb3J0ZWRJbnRlcmZhY2VPcmllbnRhdGlvbnNWMjRHNzIwUmVuW1RocmVlTmF0aXZlXxAPdGhyZWVuYXRpdmUtaW9zXxAXZGV2LnRocmVlbmF0aXZlLnJ1bnRpbWVTNi4wVEFQUExWMC4xLjEzoSNfEA9pUGhvbmVTaW11bGF0b3JRMV8QImNvbS5hcHBsZS5jb21waWxlcnMubGx2bS5jbGFuZy4xXzBVMjJGNzZfEA9pcGhvbmVzaW11bGF0b3JUMTguNV8QE2lwaG9uZXNpbXVsYXRvcjE4LjVUMTY0MFQxNkY2CVQxNC4woi8wEAEQAtEyM1tVSUNvbG9yTmFtZV8QElROTGF1bmNoQmFja2dyb3VuZKE1VW1ldGFsojc4XxAjVUlJbnRlcmZhY2VPcmllbnRhdGlvbkxhbmRzY2FwZUxlZnRfECRVSUludGVyZmFjZU9yaWVudGF0aW9uTGFuZHNjYXBlUmlnaHQACAA9AFMAbwCFAJoArwDPANwA8gEPASwBPgFJAVsBagF+AYkBkwGbAagBvQHQAd8B7gINAjACNwI6AkYCWAJyAnYCewKCAoQClgKYAr0CwwLVAtoC8AL1AvoC+wMAAwMDBQMHAwoDFgMrAy0DMwM2A1wAAAAAAAACAQAAAAAAAAA5AAAAAAAAAAAAAAAAAAADgw==',
  ].join(''),
  'base64',
);
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('iOS actool receives a partial-info-plist output sink when compiling an app icon', () => {
  const root = makeTempDirSync('threenative-ios-actool-output-');
  roots.push(root);
  const catalog = join(root, 'Assets.xcassets');
  const output = join(root, 'compiled');
  mkdirSync(catalog, { recursive: true });
  mkdirSync(output, { recursive: true });

  let args;
  compileIosAssets(catalog, output, true, (_command, invocationArgs) => {
    args = invocationArgs;
    writeFileSync(join(output, 'Assets.car'), 'compiled-assets');
    return { status: 0, stderr: '', stdout: '' };
  });

  const partialInfoPlist = args.indexOf('--output-partial-info-plist');
  assert.notEqual(partialInfoPlist, -1);
  assert.equal(args[partialInfoPlist + 1], '/dev/null');
});

test('iOS launch screens reference named assets only when packaging compiles their catalog', () => {
  const host = readFileSync(new URL('../ios/Info.plist', import.meta.url), 'utf8');
  assert.doesNotMatch(host, /<key>UI(?:Color|Image)Name<\/key>/u);
  assert.doesNotMatch(renderIosInfoPlist(host), /<key>UI(?:Color|Image)Name<\/key>/u);
  for (const config of [
    { bootSplash: {} },
    { app: { icon: 'icon.png' } },
    { app: { icons: { ios: { dark: 'dark.png' } } } },
  ]) {
    const plist = renderIosInfoPlist(host, config);
    assert.equal((plist.match(/<key>UILaunchScreen<\/key>/gu) ?? []).length, 1);
    assert.match(plist, /<key>UIColorName<\/key>\s*<string>LaunchBackground<\/string>/u);
  }
});

test('iOS names the app icon only when a branded icon source is actually compiled', () => {
  const host = readFileSync(new URL('../ios/Info.plist', import.meta.url), 'utf8');
  assert.doesNotMatch(
    renderIosInfoPlist(host, { app: { icons: { ios: {} } } }),
    /<key>CFBundleIconName<\/key>/u,
  );
  for (const config of [
    { app: { icon: 'icon.png' } },
    { app: { icons: { ios: { dark: 'dark.png' } } } },
    { app: { icons: { ios: { tinted: 'tinted.png' } } } },
  ]) {
    assert.match(
      renderIosInfoPlist(host, config),
      /<key>CFBundleIconName<\/key>\s*<string>AppIcon<\/string>/u,
    );
  }
});

test('iOS staging converts Xcode binary Info.plist archives before applying metadata', () => {
  const root = makeTempDirSync('threenative-ios-binary-plist-');
  roots.push(root);
  const templateApp = join(root, 'template.app');
  const output = join(root, 'game.app');
  const bundle = join(root, 'game.js');
  mkdirSync(templateApp, { recursive: true });
  writeFileSync(join(templateApp, 'Info.plist'), binaryInfoPlist);
  writeFileSync(join(templateApp, 'threenative-ios'), 'prebuilt-host');
  writeFileSync(join(templateApp, 'native-smoke.js'), 'old-game');
  writeFileSync(bundle, 'new-game');

  let convertedPath;
  const report = stageIosSimulatorApp({
    bundle,
    orientation: 'portrait',
    output,
    templateApp,
    convertInfoPlist: (path, source) => {
      convertedPath = { path, source };
      return infoPlist;
    },
  });

  assert.equal(convertedPath.path, join(output, 'Info.plist'));
  assert.equal(convertedPath.source.subarray(0, 8).toString('ascii'), 'bplist00');
  assert.equal(report.infoPlistFormat, 'binary');
  assert.equal(report.orientation, 'portrait');
  assert.match(readFileSync(join(output, 'Info.plist'), 'utf8'), /UIInterfaceOrientationPortrait/u);
});

test('iOS app staging preserves WebUI selection, its files and the host launch contract', () => {
  const root = makeTempDirSync('threenative-ios-web-ui-');
  const templateApp = join(root, 'template.app');
  const output = join(root, 'game.app');
  const ui = join(root, 'built-ui');
  const bundle = join(root, 'game.js');
  mkdirSync(templateApp);
  mkdirSync(ui);
  writeFileSync(join(templateApp, 'Info.plist'), infoPlist);
  writeFileSync(join(templateApp, 'threenative-ios'), 'prebuilt-host');
  writeFileSync(join(templateApp, 'native-smoke.js'), 'old-game');
  writeFileSync(bundle, 'game');
  for (const [name, body] of Object.entries({ 'index.html': '<script src="ui.js"></script>',
    'ui.js': 'console.log("React bundle")', 'ui.css': 'body{margin:0}' })) {
    writeFileSync(join(ui, name), body);
  }
  const inputs = { bundle, output, templateApp, config: { ui: { renderer: 'web' } } };
  stageIosSimulatorApp({ ...inputs, ui });
  assert.match(readFileSync(join(output, 'Info.plist'), 'utf8'),
    /<key>TNUIRenderer<\/key>\s*<string>web<\/string>/u);
  for (const name of ['index.html', 'ui.js', 'ui.css']) {
    assert.deepEqual(readFileSync(join(output, 'ui', name)), readFileSync(join(ui, name)));
  }
  assert.throws(() => stageIosSimulatorApp(inputs), /TN_UI_BUNDLE_MISSING/u);
  stageIosSimulatorApp({ ...inputs, config: { ui: { renderer: 'native' } } });
  assert.equal(existsSync(join(output, 'ui')), false);
  assert.match(readFileSync(join(output, 'Info.plist'), 'utf8'),
    /<key>TNUIRenderer<\/key>\s*<string>native<\/string>/u);
  assert.throws(() => stageIosSimulatorApp({ ...inputs, config: { ui: { renderer: 'invalid' } } }),
    /TN_UI_RENDERER_INVALID/u);
});

test('staging replaces the bundle and records every packaged game asset checksum', () => {
  const root = makeTempDirSync('threenative-ios-stage-');
  roots.push(root);
  const templateApp = join(root, 'template.app');
  const output = join(root, 'dist', 'game.app');
  const bundle = join(root, 'game.js');
  const assets = join(root, 'public');
  mkdirSync(templateApp);
  mkdirSync(join(templateApp, 'game'), { recursive: true });
  mkdirSync(join(assets, 'models'), { recursive: true });
  mkdirSync(join(assets, 'textures'), { recursive: true });
  const model = minimalGlb();
  writeFileSync(join(templateApp, 'Info.plist'), infoPlist);
  writeFileSync(join(templateApp, 'threenative-ios'), 'prebuilt-host');
  writeFileSync(join(templateApp, 'native-smoke.js'), 'old-game');
  writeFileSync(join(templateApp, 'game', 'stale.bin'), 'stale');
  writeFileSync(bundle, 'new-game');
  writeFileSync(join(assets, 'models', 'level.glb'), model);
  writeFileSync(join(assets, 'textures', 'x.png'), 'texture');

  const report = stageIosSimulatorApp({ assets, bundle, orientation: 'portrait', output, templateApp });
  assert.equal(readFileSync(join(output, 'threenative-ios'), 'utf8'), 'prebuilt-host');
  assert.equal(readFileSync(join(output, 'native-smoke.js'), 'utf8'), 'new-game');
  assert.equal(readFileSync(join(output, 'game', 'textures', 'x.png'), 'utf8'), 'texture');
  assert.equal(existsSync(join(output, 'game', 'stale.bin')), false);
  assert.equal(report.host, 'ios-simulator-arm64');
  assert.equal(report.infoPlistFormat, 'xml');
  assert.equal(report.orientation, 'portrait');
  assert.match(readFileSync(join(output, 'Info.plist'), 'utf8'), /UIInterfaceOrientationPortrait/u);
  assert.doesNotMatch(
    readFileSync(join(output, 'Info.plist'), 'utf8'),
    /UIInterfaceOrientationLandscape/u,
  );
  assert.equal(report.bundleSha256, createHash('sha256').update('new-game').digest('hex'));
  assert.deepEqual(report.assets, [
    {
      path: 'models/level.glb',
      sha256: createHash('sha256').update(model).digest('hex'),
    },
    {
      path: 'textures/x.png',
      sha256: createHash('sha256').update('texture').digest('hex'),
    },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(`${output}.json`, 'utf8')), report);

  writeFileSync(join(output, 'game', 'textures', 'x.png'), 'corrupted');
  assert.notEqual(
    createHash('sha256')
      .update(readFileSync(join(output, 'game', 'textures', 'x.png')))
      .digest('hex'),
    report.assets.find(({ path }) => path === 'textures/x.png').sha256,
  );
});

test('iOS no-config staging preserves the compatibility version in the artifact', () => {
  const root = makeTempDirSync('threenative-ios-defaults-');
  roots.push(root);
  const templateApp = join(root, 'template.app');
  const output = join(root, 'game.app');
  const bundle = join(root, 'game.js');
  mkdirSync(templateApp, { recursive: true });
  writeFileSync(join(templateApp, 'Info.plist'), infoPlist);
  writeFileSync(join(templateApp, 'threenative-ios'), 'prebuilt-host');
  writeFileSync(join(templateApp, 'native-smoke.js'), 'old-game');
  writeFileSync(bundle, 'new-game');

  const report = stageIosSimulatorApp({ bundle, output, templateApp });
  const plist = readFileSync(join(output, 'Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>0\.1\.13<\/string>/u);
  assert.equal(report.version, '0.1.13');
  assert.equal(report.launchBackground, undefined);
});

test('iOS staging allows missing assets, clears stale files, and rejects a file path', () => {
  const root = makeTempDirSync('threenative-ios-assets-missing-');
  roots.push(root);
  const templateApp = join(root, 'template.app');
  const output = join(root, 'game.app');
  const bundle = join(root, 'game.js');
  mkdirSync(join(templateApp, 'game'), { recursive: true });
  writeFileSync(join(templateApp, 'Info.plist'), infoPlist);
  writeFileSync(join(templateApp, 'threenative-ios'), 'prebuilt-host');
  writeFileSync(join(templateApp, 'native-smoke.js'), 'old-game');
  writeFileSync(join(templateApp, 'game', 'stale.bin'), 'stale');
  writeFileSync(bundle, 'new-game');

  const report = stageIosSimulatorApp({
    assets: join(root, 'missing'),
    bundle,
    output,
    templateApp,
  });
  assert.deepEqual(report.assets, []);
  assert.equal(existsSync(join(output, 'game')), true);
  assert.equal(existsSync(join(output, 'game', 'stale.bin')), false);

  const file = join(root, 'not-a-directory');
  writeFileSync(file, 'no');
  assert.throws(
    () => stageIosSimulatorApp({ assets: file, bundle, output, templateApp }),
    /not a directory/u,
  );
});

test('iOS staging maps configured app fields and compiles a declared icon into the app artifact', () => {
  const root = makeTempDirSync('threenative-ios-icon-');
  roots.push(root);
  const templateApp = join(root, 'template.app');
  const output = join(root, 'game.app');
  const bundle = join(root, 'game.js');
  const icon = join(root, 'icon.png');
  const dark = join(root, 'icon-dark.png');
  const tinted = join(root, 'icon-tinted.png');
  const launch = join(root, 'launch.png');
  mkdirSync(templateApp, { recursive: true });
  writeFileSync(join(templateApp, 'Info.plist'), infoPlist);
  writeFileSync(join(templateApp, 'threenative-ios'), 'prebuilt-host');
  writeFileSync(join(templateApp, 'native-smoke.js'), 'old-game');
  writeFileSync(bundle, 'new-game');
  writeFileSync(icon, VALID_PNG);
  writeFileSync(dark, VALID_PNG);
  writeFileSync(tinted, VALID_PNG);
  writeFileSync(launch, VALID_PNG);

  const report = stageIosSimulatorApp({
    assets: undefined,
    bundle,
    config: {
      app: {
        id: 'com.studio.vulpine',
        name: 'Vulpine',
        version: '9.8.7',
        build: 42,
        icon,
        icons: { ios: { dark, tinted } },
      },
      bootSplash: { backgroundColor: '#0d1b2a', image: launch },
      display: { orientation: 'portrait', fullscreen: false, keepScreenOn: true, maxFps: 120 },
      window: { title: 'Vulpine Window', width: 1111, height: 777, resizable: false },
    },
    output,
    templateApp,
    compileIcon: (catalog, compiled) => {
      const plist = readFileSync(join(output, 'Info.plist'), 'utf8');
      const colorName = /<key>UIColorName<\/key>\s*<string>([^<]+)<\/string>/u.exec(plist)?.[1];
      assert.ok(colorName, 'the launch screen names its compiled background color');
      const color = JSON.parse(readFileSync(join(catalog, `${colorName}.colorset/Contents.json`), 'utf8'));
      assert.deepEqual(color.colors[0].color.components, {
        alpha: 1,
        blue: 42 / 255,
        green: 27 / 255,
        red: 13 / 255,
      });
      assert.deepEqual(JSON.parse(readFileSync(join(catalog, 'Contents.json'), 'utf8')), {
        info: { author: 'xcode', version: 1 },
      });
      assert.equal(readFileSync(join(catalog, 'AppIcon.appiconset/AppIcon-1024.png')).equals(VALID_PNG), true);
      assert.equal(readFileSync(join(catalog, 'AppIcon.appiconset/AppIcon-1024-dark.png')).equals(VALID_PNG), true);
      assert.equal(readFileSync(join(catalog, 'AppIcon.appiconset/AppIcon-1024-tinted.png')).equals(VALID_PNG), true);
      assert.match(readFileSync(join(catalog, 'AppIcon.appiconset/Contents.json'), 'utf8'), /"value": "tinted"/u);
      writeFileSync(join(compiled, 'Assets.car'), Buffer.from('compiled-app-icon'));
    },
  });

  assert.equal(readFileSync(join(output, 'native-smoke.js'), 'utf8'), 'new-game');
  assert.equal(readFileSync(join(output, 'Assets.car'), 'utf8'), 'compiled-app-icon');
  assert.deepEqual(readFileSync(join(output, 'LaunchImage.png')), VALID_PNG);
  assert.equal(existsSync(join(output, 'Assets.xcassets')), false);
  assert.deepEqual(
    {
      appId: report.appId,
      appName: report.appName,
      version: report.version,
      build: report.build,
      orientation: report.orientation,
    },
    {
      appId: 'com.studio.vulpine',
      appName: 'Vulpine',
      version: '9.8.7',
      build: 42,
      orientation: 'portrait',
    },
  );
  const plist = readFileSync(join(output, 'Info.plist'), 'utf8');
  for (const pattern of [
    /<key>CFBundleIdentifier<\/key>\s*<string>com\.studio\.vulpine<\/string>/u,
    /<key>CFBundleDisplayName<\/key>\s*<string>Vulpine<\/string>/u,
    /<key>CFBundleName<\/key>\s*<string>Vulpine<\/string>/u,
    /<key>CFBundleShortVersionString<\/key>\s*<string>9\.8\.7<\/string>/u,
    /<key>CFBundleVersion<\/key>\s*<string>42<\/string>/u,
    /<string>UIInterfaceOrientationPortrait<\/string>/u,
    /<key>TNFullscreen<\/key>\s*<false\/>/u,
    /<key>TNKeepScreenOn<\/key>\s*<true\/>/u,
    /<key>TNMaxFps<\/key>\s*<integer>120<\/integer>/u,
    /<key>TNWindowTitle<\/key>\s*<string>Vulpine Window<\/string>/u,
    /<key>TNWindowWidth<\/key>\s*<integer>1111<\/integer>/u,
    /<key>TNWindowHeight<\/key>\s*<integer>777<\/integer>/u,
    /<key>TNWindowResizable<\/key>\s*<false\/>/u,
    /<key>CFBundleIconName<\/key>\s*<string>AppIcon<\/string>/u,
    /<key>UILaunchScreen<\/key>[\s\S]*?<key>UIColorName<\/key>\s*<string>LaunchBackground<\/string>/u,
    /<key>UIImageName<\/key>\s*<string>LaunchImage<\/string>/u,
  ]) {
    assert.match(plist, pattern);
  }
  assert.doesNotMatch(plist, /UIInterfaceOrientationLandscape/u);
  assert.match(
    readFileSync(new URL('../ios/main.mm', import.meta.url), 'utf8'),
    /config\.maxFps\s*=\s*info\[@"TNMaxFps"\][^;]*\[info\[@"TNMaxFps"\] unsignedIntValue\]/u,
  );
  assert.equal(report.icon, icon);
  assert.equal(report.iconArtifact, 'Assets.car');
});

test('iOS icon staging rejects a source that does not match its 1024x1024 metadata', () => {
  const root = makeTempDirSync('threenative-ios-icon-dimensions-');
  roots.push(root);
  const templateApp = join(root, 'template.app');
  const output = join(root, 'game.app');
  const bundle = join(root, 'game.js');
  const icon = join(root, 'icon.png');
  mkdirSync(templateApp, { recursive: true });
  writeFileSync(join(templateApp, 'Info.plist'), infoPlist);
  writeFileSync(join(templateApp, 'threenative-ios'), 'prebuilt-host');
  writeFileSync(join(templateApp, 'native-smoke.js'), 'old-game');
  writeFileSync(bundle, 'new-game');
  writeFileSync(icon, SMALL_PNG);

  assert.throws(
    () =>
      stageIosSimulatorApp({
        bundle,
        config: {
          app: {
            id: 'com.studio.vulpine',
            name: 'Vulpine',
            version: '1.2.3',
            build: 1,
            icon,
          },
        },
        compileIcon: (_catalog, compiled) => {
          writeFileSync(join(compiled, 'Assets.car'), 'compiled-app-icon');
        },
        output,
        templateApp,
      }),
    /TN_CONFIG_ICON_DIMENSIONS_INVALID.*1024x1024/u,
  );
});

test('iOS packaging fails closed off darwin-arm64 and on a corrupt local host', async () => {
  await assert.rejects(
    packageIosSimulator({ arch: 'x64', bundle: 'game.js', output: 'game.app', platform: 'linux' }),
    /requires a darwin-arm64 host.*linux-x64.*Device signing remains OPEN/u,
  );

  const root = makeTempDirSync('threenative-ios-checksum-');
  roots.push(root);
  const archive = join(root, 'host.zip');
  writeFileSync(archive, 'corrupt');
  await assert.rejects(
    packageIosSimulator({
      arch: 'arm64',
      archive,
      bundle: join(root, 'game.js'),
      output: join(root, 'game.app'),
      platform: 'darwin',
      sha256: '0'.repeat(64),
    }),
    /checksum mismatch/u,
  );
});

test('iOS simulator packaging stages the UI bundle the build selected', async () => {
  // The CLI hands the packager `--ui` for a web renderer; `packageIosSimulator` must carry it to
  // staging. Dropping it made the packager declare `web` from the resolved config and then fail
  // TN_UI_BUNDLE_MISSING with the bundle sitting on disk, which is the packaged-game defect.
  const root = makeTempDirSync('threenative-ios-forward-ui-');
  roots.push(root);
  const templateApp = join(root, 'stub-host.app');
  const bin = join(root, 'bin');
  const archive = join(root, 'host.zip');
  const bundle = join(root, 'game.js');
  const ui = join(root, 'built-ui');
  const output = join(root, 'dist', 'game.app');
  mkdirSync(templateApp, { recursive: true });
  writeFileSync(join(templateApp, 'Info.plist'), infoPlist);
  writeFileSync(join(templateApp, 'threenative-ios'), 'prebuilt-host');
  writeFileSync(join(templateApp, 'native-smoke.js'), 'old-game');
  writeFileSync(bundle, 'new-game');
  mkdirSync(ui, { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<script src="ui.js"></script>');
  writeFileSync(join(ui, 'ui.js'), 'console.log("React bundle")');
  // `ditto` is Apple-only; host extraction is not under test, so a stub copies the prepared app.
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'ditto'), `#!/usr/bin/env node
const { cpSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
cpSync(process.env.TN_STUB_IOS_APP, join(args[args.length - 1], 'stub-host.app'), { recursive: true });
`);
  chmodSync(join(bin, 'ditto'), 0o755);
  writeFileSync(archive, 'host-archive');

  const previousPath = process.env.PATH;
  const previousStub = process.env.TN_STUB_IOS_APP;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  process.env.TN_STUB_IOS_APP = templateApp;
  try {
    const report = await packageIosSimulator({
      arch: 'arm64',
      archive,
      bundle,
      config: { ui: { renderer: 'web' } },
      output,
      platform: 'darwin',
      sha256: createHash('sha256').update('host-archive').digest('hex'),
      ui,
    });
    assert.equal(report.output, output);
    assert.deepEqual(readFileSync(join(output, 'ui', 'index.html')), readFileSync(join(ui, 'index.html')));
    assert.deepEqual(readFileSync(join(output, 'ui', 'ui.js')), readFileSync(join(ui, 'ui.js')));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousStub === undefined) delete process.env.TN_STUB_IOS_APP;
    else process.env.TN_STUB_IOS_APP = previousStub;
  }
});

test('iOS CLI forwards the declared orientation before host validation', async () => {
  const forwarded = [];
  const report = await runIosPackageCli(
    ['--bundle', 'game.js', '--output', 'game.app', '--orientation', 'portrait'],
    async (options) => {
      forwarded.push(options);
      return { orientation: options.orientation };
    },
  );
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].orientation, 'portrait');
  assert.equal(report.orientation, 'portrait');
});

test('the published package includes the iOS packager without C++ source', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.files.includes('scripts/package-ios.mjs'));
  // The engine player's JavaScript sources ship for the desktop bundler; they are not C++.
  const shipped = manifest.files.filter((path) => path !== 'src/engine/player/*.mjs');
  assert.ok(!shipped.some((path) => /^(?:src|include|cmake|ios\/main\.mm)/u.test(path)));
});

test('release lane locks and launches the packed simulator host with physics controls', () => {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/native-release.yml', import.meta.url),
    'utf8',
  );
  for (const token of [
    'build-ios-simulator:',
    'generateReleaseManifest',
    'RELEASE_SHA: ${{ needs.validate-tag.outputs.candidate_sha }}',
    'clean-consumer-ios:',
    'build --target ios',
    'physics-wrong-height.playtest.json',
    'physics-mask.playtest.json',
    'THREENATIVE_PHYSICS_CONTROL=wrong-gravity',
    'TN_PLAYTEST_POSITION_REACH_ASSERTION_FAILED',
    'xcrun simctl list devices available',
    'xcrun simctl boot "$device"',
    'xcrun simctl bootstatus "$device" -b',
    'test ! -e "$TN_IOS_TOOLCHAIN_LOG"',
  ]) {
    assert.match(workflow, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
  }
  assert.equal(PREBUILT_ASSET_NAMES['ios-simulator-arm64'], 'threenative-ios-simulator-arm64.zip');
  assert.match(workflow, /^permissions:\n {2}contents: read$/mu);
  assert.match(workflow, /publish:[\s\S]*permissions:\n {6}contents: write/u);
  assert.match(workflow, /gh release create[\s\S]*--prerelease[\s\S]*--latest=false/u);
  assert.match(
    workflow,
    /finalize:[\s\S]*needs: \[validate-tag, clean-consumer, clean-consumer-windows\]/u,
  );
  assert.match(workflow, /cleanup-failed-release:[\s\S]*gh release delete/u);
});

test('simulator verification builds only the arm64 architecture carried by the host archive', () => {
  const verifier = readFileSync(
    new URL('../scripts/verify-ios-simulator.mjs', import.meta.url),
    'utf8',
  );
  assert.match(verifier, /-DPLATFORM=SIMULATORARM64/);
  assert.match(verifier, /-DCMAKE_OSX_ARCHITECTURES=arm64/);
  assert.match(verifier, /result\.stdout[\s\S]*result\.stderr/);
});

test('iOS render preserves the TN3187 scene manifest across orientations', () => {
  const host = readFileSync(new URL('../ios/Info.plist', import.meta.url), 'utf8');
  assert.equal(hasIosSceneManifestFields(host), true);
  for (const orientation of ['landscape', 'portrait', 'sensor']) {
    const plist = renderIosInfoPlist(host, { display: { orientation } });
    assert.equal(hasIosSceneManifestFields(plist), true);
  }
});

test('iOS scene guard rejects a wrong delegate and a comment spoof', () => {
  const wrongDelegate = infoPlist.replaceAll('SDLUIKitSceneDelegate', 'CustomDelegate');
  assert.equal(hasIosSceneManifestFields(wrongDelegate), false);
  const commentSpoof =
    '<plist><dict><key>UISupportedInterfaceOrientations</key><array></array>' +
    '<!-- UIApplicationSceneManifest SDLUIKitSceneDelegate --></dict></plist>';
  assert.equal(hasIosSceneManifestFields(commentSpoof), false);
  const commentKeypairSpoof =
    '<plist><dict><!-- <key>UIApplicationSceneManifest</key><dict></dict>' +
    '<key>UISceneDelegateClassName</key><string>SDLUIKitSceneDelegate</string> --></dict></plist>';
  assert.equal(hasIosSceneManifestFields(commentKeypairSpoof), false);
  const root = makeTempDirSync('threenative-ios-wrong-delegate-');
  roots.push(root);
  const templateApp = join(root, 'template.app');
  const bundle = join(root, 'game.js');
  mkdirSync(templateApp, { recursive: true });
  writeFileSync(join(templateApp, 'threenative-ios'), 'prebuilt-host');
  writeFileSync(join(templateApp, 'native-smoke.js'), 'old-game');
  writeFileSync(bundle, 'new-game');
  for (const [label, plist] of [['wrong-delegate', wrongDelegate], ['comment-spoof', commentSpoof], ['comment-keypair-spoof', commentKeypairSpoof]]) {
    writeFileSync(join(templateApp, 'Info.plist'), plist);
    assert.throws(
      () => stageIosSimulatorApp({ bundle, output: join(root, `${label}.app`), templateApp }),
      /TN_IOS_SCENE_MANIFEST_MISSING/u,
      label,
    );
  }
});

test('iOS selects SDL 3.4.16 while Android and desktop stay on 3.2.30', () => {
  assert.equal(SDL3_IOS_VERSION, '3.4.16');
  assert.equal(SDL3_ANDROID_VERSION, '3.2.30');
  const lock = JSON.parse(
    readFileSync(new URL('../native-deps.lock.json', import.meta.url), 'utf8'),
  );
  const versionOf = (name) => lock.components.find((entry) => entry.name === name)?.version;
  assert.equal(versionOf('sdl3-ios'), '3.4.16');
  assert.equal(versionOf('sdl3'), '3.2.30');
  assert.equal(versionOf('sdl3-android'), '3.2.30');
  const downloader = readFileSync(
    new URL('../scripts/download-deps.mjs', import.meta.url),
    'utf8',
  );
  assert.match(downloader, /import \{ SDL3_IOS_VERSION \} from '\.\/package-ios\.mjs'/u);
  assert.match(downloader, /const iosDeps = \[[^\]]*'sdl3-ios'[^\]]*\]/u);
  const cmake = readFileSync(new URL('../CMakeLists.txt', import.meta.url), 'utf8');
  assert.match(cmake, /MYSTRAL_PLATFORM STREQUAL "ios"\)\s*\n\s*set\(SDL3_DIR \$\{THIRD_PARTY_DIR\}\/sdl3-ios\)/u);
  const verifier = readFileSync(
    new URL('../scripts/verify-ios-simulator.mjs', import.meta.url),
    'utf8',
  );
  assert.match(verifier, /download-deps\.mjs', '--only', 'sdl3-ios'/u);
});

test('iOS staging rejects a prebuilt host that predates the scene manifest', () => {
  const root = makeTempDirSync('threenative-ios-legacy-host-');
  roots.push(root);
  const templateApp = join(root, 'template.app');
  const output = join(root, 'game.app');
  const bundle = join(root, 'game.js');
  mkdirSync(templateApp, { recursive: true });
  writeFileSync(
    join(templateApp, 'Info.plist'),
    '<plist><dict><key>UISupportedInterfaceOrientations</key><array></array></dict></plist>',
  );
  writeFileSync(join(templateApp, 'threenative-ios'), 'prebuilt-host');
  writeFileSync(join(templateApp, 'native-smoke.js'), 'old-game');
  writeFileSync(bundle, 'new-game');
  assert.throws(
    () => stageIosSimulatorApp({ bundle, output, templateApp }),
    /TN_IOS_SCENE_MANIFEST_MISSING/u,
  );
});

test('iOS staging runs the same gate, with iOS capabilities rather than Android ones', () => {
  // `CMakeLists.txt` excludes IOS from every libwebp branch, so a WebP texture that packages for
  // Android has to be refused here. Correcting the Android WebP claim must not quietly make the
  // iOS one wrong in the other direction.
  const root = makeTempDirSync('threenative-ios-asset-gate-');
  roots.push(root);
  const templateApp = join(root, 'template.app');
  const bundle = join(root, 'game.js');
  const assets = join(root, 'public');
  mkdirSync(templateApp, { recursive: true });
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(templateApp, 'Info.plist'), infoPlist);
  writeFileSync(join(templateApp, 'threenative-ios'), 'prebuilt-host');
  writeFileSync(join(templateApp, 'native-smoke.js'), 'old-game');
  writeFileSync(bundle, 'new-game');

  const glb = (json) => {
    const chunk = Buffer.from(JSON.stringify(json), 'utf8');
    const padded = Buffer.concat([chunk, Buffer.alloc((4 - (chunk.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12);
    header.write('glTF', 0, 'ascii');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + padded.length, 8);
    const chunkHeader = Buffer.alloc(8);
    chunkHeader.writeUInt32LE(padded.length, 0);
    chunkHeader.write('JSON', 4, 'ascii');
    return Buffer.concat([header, chunkHeader, padded]);
  };
  writeFileSync(
    join(assets, 'enemy.glb'),
    glb({ asset: { version: '2.0' }, images: [{ mimeType: 'image/webp' }] }),
  );
  assert.throws(
    () =>
      stageIosSimulatorApp({ assets, bundle, output: join(root, 'game.app'), templateApp }),
    (error) => {
      assert.match(error.message, /cannot be decoded by the ios target/u);
      assert.match(error.message, /excludes IOS/u);
      return true;
    },
  );
});
