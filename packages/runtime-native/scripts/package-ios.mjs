#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { assertNativeAssetsDecodable, deriveIosWebpSupport } from './asset-preflight.mjs';
import { listFiles, selectManifestAssets } from './asset-manifest.mjs';
import { mobileUiRenderer } from './package-android.mjs';
import { downloadReleaseArtifact } from './install-prebuilt.mjs';

export const NATIVE_ORIENTATIONS = ['landscape', 'portrait', 'sensor'];
/**
 * The iOS-only SDL3 version. Upstream 3.4.16 owns the UIWindowScene lifecycle via its
 * built-in SDLUIKitSceneDelegate (TN3187 opt-in); desktop and Android stay on 3.2.30.
 */
export const SDL3_IOS_VERSION = '3.4.16';
export const DEFAULT_IOS_CONFIG = {
  app: { id: 'com.threenative.game', name: 'ThreeNative', version: '0.1.13', build: 1 },
  display: { orientation: 'landscape', fullscreen: true, keepScreenOn: false, maxFps: 60 },
  window: { title: 'ThreeNative', width: 1280, height: 720, maximized: false, resizable: true },
};
const BINARY_PLIST_MAGIC = Buffer.from('bplist00', 'ascii');
const IOS_ORIENTATIONS = {
  landscape: ['UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'],
  portrait: ['UIInterfaceOrientationPortrait'],
  sensor: [
    'UIInterfaceOrientationPortrait',
    'UIInterfaceOrientationPortraitUpsideDown',
    'UIInterfaceOrientationLandscapeLeft',
    'UIInterfaceOrientationLandscapeRight',
  ],
};

function configValue(value, orientation) {
  const source = value && typeof value === 'object' ? value : {};
  const app = source.app && typeof source.app === 'object' ? source.app : {};
  const display = source.display && typeof source.display === 'object' ? source.display : {};
  const window = source.window && typeof source.window === 'object' ? source.window : {};
  const bootSplash = source.bootSplash && typeof source.bootSplash === 'object' ? source.bootSplash : {};
  const renderer = source.ui === undefined ? 'native' : source.ui?.renderer;
  if (renderer !== 'web' && renderer !== 'native') {
    throw new Error('TN_UI_RENDERER_INVALID: ui.renderer must be web or native.');
  }
  return {
    app: { ...DEFAULT_IOS_CONFIG.app, ...app },
    display: {
      ...DEFAULT_IOS_CONFIG.display,
      ...display,
      orientation: orientation ?? display.orientation ?? DEFAULT_IOS_CONFIG.display.orientation,
    },
    window: { ...DEFAULT_IOS_CONFIG.window, ...window },
    ui: { renderer },
    ...(source.bootSplash === undefined ? {} : { bootSplash: { ...bootSplash } }),
  };
}

function readConfig(configPath) {
  if (configPath === undefined) return configValue();
  try {
    return configValue(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch (error) {
    throw new Error(`TN_CONFIG_FILE_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function convertBinaryInfoPlist(path) {
  const result = spawnSync('plutil', ['-convert', 'xml1', '-o', '-', path], {
    encoding: 'utf8',
  });
  if (result.error) {
    throw new Error(
      `TN_IOS_INFO_PLIST_CONVERT_FAILED: plutil could not convert ${path}: ${result.error.message}`,
    );
  }
  if (result.status !== 0 || !result.stdout?.includes('<plist')) {
    throw new Error(
      `TN_IOS_INFO_PLIST_CONVERT_FAILED: plutil exited with code ${result.status ?? 'unknown'} for ${path}: ${result.stderr || 'no XML output'}`,
    );
  }
  return result.stdout;
}

function readIosInfoPlist(path, convertInfoPlist = convertBinaryInfoPlist) {
  const source = readFileSync(path);
  if (!source.subarray(0, BINARY_PLIST_MAGIC.length).equals(BINARY_PLIST_MAGIC)) {
    return { format: 'xml', source: source.toString('utf8') };
  }
  return { format: 'binary', source: convertInfoPlist(path, source) };
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function plistKey(source, key, value) {
  const rendered = `  <key>${key}</key>\n  <string>${xmlEscape(value)}</string>`;
  const pattern = new RegExp(`\\s*<key>${key}</key>\\s*<(?:string|true|false)>[\\s\\S]*?</(?:string|true|false)>`, 'u');
  if (pattern.test(source)) return source.replace(pattern, `\n${rendered}`);
  return source.replace(/\s*<\/dict>\s*<\/plist>/u, `\n${rendered}\n</dict>\n</plist>`);
}

function plistBoolean(source, key, value) {
  const rendered = `  <key>${key}</key>\n  <${value ? 'true' : 'false'}/>`;
  const pattern = new RegExp(`\\s*<key>${key}</key>\\s*<(?:true|false)\\s*/?>`, 'u');
  if (pattern.test(source)) return source.replace(pattern, `\n${rendered}`);
  return source.replace(/\s*<\/dict>\s*<\/plist>/u, `\n${rendered}\n</dict>\n</plist>`);
}

function plistInteger(source, key, value) {
  const rendered = `  <key>${key}</key>\n  <integer>${value}</integer>`;
  const pattern = new RegExp(`\\s*<key>${key}</key>\\s*<integer>[\\s\\S]*?</integer>`, 'u');
  if (pattern.test(source)) return source.replace(pattern, `\n${rendered}`);
  return source.replace(/\s*<\/dict>\s*<\/plist>/u, `\n${rendered}\n</dict>\n</plist>`);
}

function plistLaunchScreen(source, config) {
  const image = config.bootSplash?.image === undefined ? undefined : 'LaunchImage';
  const icon = config.app.icon ?? config.app.icons?.ios?.dark ?? config.app.icons?.ios?.tinted;
  const hasCatalog = icon !== undefined || config.bootSplash !== undefined;
  const inner = [
    ...(hasCatalog ? ['  <key>UIColorName</key>', '  <string>LaunchBackground</string>'] : []),
    ...(image === undefined ? [] : ['  <key>UIImageName</key>', `  <string>${image}</string>`]),
  ].join('\n');
  const rendered = `  <key>UILaunchScreen</key>\n  <dict>\n${inner}\n  </dict>`;
  const pattern = /\s*<key>UILaunchScreen<\/key>\s*<dict>[\s\S]*?<\/dict>/u;
  return pattern.test(source)
    ? source.replace(pattern, `\n${rendered}`)
    : source.replace(/\s*<\/dict>\s*<\/plist>/u, `\n${rendered}\n</dict>\n</plist>`);
}

/**
 * Legacy generated-host detection for the TN3187 scene opt-in: the Info.plist
 * template must carry the manifest key opening a dict AND the delegate
 * assignment naming SDLUIKitSceneDelegate. XML comments are stripped first so a
 * commented-out pair cannot pass. Field markers only, not an XML structure
 * validator: no nesting proof (manifest → configuration → delegate), and a pass
 * never qualifies an arbitrary plist for Apple launch — real UIKit execution on
 * device/simulator remains required.
 */
export function hasIosSceneManifestFields(source) {
  const text = String(source ?? '').replace(/<!--[\s\S]*?-->/gu, '');
  return /<key>UIApplicationSceneManifest<\/key>\s*<dict>/u.test(text) &&
    /<key>UISceneDelegateClassName<\/key>\s*<string>SDLUIKitSceneDelegate<\/string>/u.test(text);
}

function orientationValue(value = 'landscape') {
  if (typeof value === 'string' && NATIVE_ORIENTATIONS.includes(value)) return value;
  throw new Error(
    'TN_NATIVE_ORIENTATION_INVALID: display.orientation must be landscape, portrait, or sensor.',
  );
}

export function renderIosInfoPlist(source, orientation = 'landscape') {
  const config = configValue(typeof orientation === 'string' ? undefined : orientation, typeof orientation === 'string' ? orientation : undefined);
  const value = orientationValue(config.display.orientation);
  const entries = IOS_ORIENTATIONS[value].map((entry) => `    <string>${entry}</string>`).join('\n');
  const key = /(<key>UISupportedInterfaceOrientations<\/key>\s*<array>)[\s\S]*?(<\/array>)/u;
  if (!key.test(source)) {
    throw new Error(
      'TN_IOS_ORIENTATION_KEYS_MISSING: Info.plist has no UISupportedInterfaceOrientations array.',
    );
  }
  let rendered = source.replace(key, `$1\n${entries}\n  $2`);
  rendered = plistKey(rendered, 'CFBundleIdentifier', config.app.id);
  rendered = plistKey(rendered, 'CFBundleDisplayName', config.app.name);
  rendered = plistKey(rendered, 'CFBundleName', config.app.name);
  rendered = plistKey(rendered, 'CFBundleShortVersionString', config.app.version);
  rendered = plistKey(rendered, 'CFBundleVersion', config.app.build);
  rendered = plistBoolean(rendered, 'TNFullscreen', config.display.fullscreen);
  rendered = plistBoolean(rendered, 'TNKeepScreenOn', config.display.keepScreenOn);
  rendered = plistInteger(rendered, 'TNMaxFps', config.display.maxFps);
  rendered = plistKey(rendered, 'TNUIRenderer', config.ui.renderer);
  rendered = plistKey(rendered, 'TNWindowTitle', config.window.title);
  rendered = plistInteger(rendered, 'TNWindowWidth', config.window.width);
  rendered = plistInteger(rendered, 'TNWindowHeight', config.window.height);
  rendered = plistBoolean(rendered, 'TNWindowResizable', config.window.resizable);
  const launchIcon = config.app.icon ?? config.app.icons?.ios?.dark ?? config.app.icons?.ios?.tinted;
  if (launchIcon !== undefined) {
    rendered = plistKey(rendered, 'CFBundleIconName', 'AppIcon');
  }
  return plistLaunchScreen(rendered, config);
}

function argumentAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1 || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return args[index + 1];
}

function valueAfter(args, flag) {
  return resolve(argumentAfter(args, flag));
}

function checksum(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function findApp(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name.endsWith('.app')) return path;
    if (entry.isDirectory()) {
      const nested = findApp(path);
      if (nested) return nested;
    }
  }
  return undefined;
}

export function compileIosAssets(catalog, output, includeAppIcon = false, execute = spawnSync) {
  const iconArguments = includeAppIcon ? ['--app-icon', 'AppIcon'] : [];
  const result = execute(
    'xcrun',
    [
      'actool',
      '--compile',
      output,
      ...iconArguments,
      '--output-partial-info-plist',
      '/dev/null',
      '--platform',
      'iphonesimulator',
      '--minimum-deployment-target',
      '13.0',
      '--target-device',
      'iphone',
      '--target-device',
      'ipad',
      catalog,
    ],
    { encoding: 'utf8' },
  );
  if (result.error) {
    throw new Error(
      `TN_IOS_ICON_COMPILER_MISSING: xcrun actool is required to compile AppIcon.appiconset: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `TN_IOS_ICON_COMPILE_FAILED: actool exited with code ${result.status ?? 'unknown'}: ${result.stderr || result.stdout || 'no output'}`,
    );
  }
}

function compileIosIcon(catalog, output) {
  return compileIosAssets(catalog, output, true);
}

function assertIosIconSource(icon, label) {
  // Loaded lazily so importing this module (e.g. download-deps.mjs reading SDL3_IOS_VERSION)
  // does not require node_modules; the check still runs synchronously when it is reached.
  const { PNG } = createRequire(import.meta.url)('pngjs');
  let image;
  try {
    image = PNG.sync.read(readFileSync(icon));
  } catch (error) {
    throw new Error(
      `TN_CONFIG_ICON_INVALID: ${label} is not a valid PNG file: ${icon} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (image.width !== 1024 || image.height !== 1024) {
    throw new Error(
      `TN_CONFIG_ICON_DIMENSIONS_INVALID: ${label} must be 1024x1024 for iOS AppIcon metadata; received ${image.width}x${image.height}: ${icon}`,
    );
  }
}

function colorComponents(value) {
  const hex = /^#([0-9a-f]{6})$/iu.exec(value ?? '')?.[1] ?? '000000';
  return {
    blue: Number.parseInt(hex.slice(4, 6), 16) / 255,
    green: Number.parseInt(hex.slice(2, 4), 16) / 255,
    red: Number.parseInt(hex.slice(0, 2), 16) / 255,
  };
}

function writeLaunchColor(catalog, value) {
  const colorset = join(catalog, 'LaunchBackground.colorset');
  mkdirSync(colorset, { recursive: true });
  const components = colorComponents(value);
  writeFileSync(
    join(colorset, 'Contents.json'),
    `${JSON.stringify(
      {
        colors: [
          {
            color: {
              'color-space': 'srgb',
              components: { alpha: 1, ...components },
            },
            idiom: 'universal',
          },
        ],
        info: { author: 'xcode', version: 1 },
      },
      null,
      2,
    )}\n`,
  );
}

function writeAssetCatalogContents(catalog) {
  writeFileSync(
    join(catalog, 'Contents.json'),
    `${JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2)}\n`,
  );
}

function stageIosIcon(output, icon, compileIcon = compileIosIcon, options = {}) {
  if (!existsSync(icon) || !statSync(icon).isFile()) {
    throw new Error(`TN_CONFIG_ICON_MISSING: app.icon does not exist: ${icon}`);
  }
  assertIosIconSource(icon, 'app.icon');
  const temporary = mkdtempSync(join(tmpdir(), 'threenative-ios-icon-'));
  try {
    const catalog = join(temporary, 'Assets.xcassets');
    const appIcon = join(catalog, 'AppIcon.appiconset');
    const compiled = join(temporary, 'compiled');
    mkdirSync(appIcon, { recursive: true });
    mkdirSync(compiled, { recursive: true });
    writeAssetCatalogContents(catalog);
    copyFileSync(icon, join(appIcon, 'AppIcon-1024.png'));
    const appearances = options.variants ?? {};
    const images = [
      {
        filename: 'AppIcon-1024.png',
        idiom: 'universal',
        platform: 'ios',
        scale: '1x',
        size: '1024x1024',
      },
    ];
    for (const [appearance, source] of [['dark', appearances.dark], ['tinted', appearances.tinted]]) {
      if (source === undefined) continue;
      if (!existsSync(source) || !statSync(source).isFile()) {
        throw new Error(`TN_CONFIG_BRAND_IOS_${appearance.toUpperCase()}_MISSING: ${source}`);
      }
      assertIosIconSource(source, `app.icons.ios.${appearance}`);
      const filename = `AppIcon-1024-${appearance}.png`;
      copyFileSync(source, join(appIcon, filename));
      images.push({
        appearances: [{ appearance: 'luminosity', value: appearance }],
        filename,
        idiom: 'universal',
        platform: 'ios',
        scale: '1x',
        size: '1024x1024',
      });
    }
    writeLaunchColor(catalog, options.backgroundColor ?? '#000000');
    writeFileSync(
      join(appIcon, 'Contents.json'),
      `${JSON.stringify(
        {
          images,
          info: { author: 'xcode', version: 1 },
        },
        null,
        2,
      )}\n`,
    );
    compileIcon(catalog, compiled);
    const assetsCar = join(compiled, 'Assets.car');
    if (!existsSync(assetsCar) || !statSync(assetsCar).isFile() || statSync(assetsCar).size === 0) {
      throw new Error('TN_IOS_ICON_COMPILE_FAILED: actool did not produce a usable Assets.car.');
    }
    rmSync(join(output, 'Assets.xcassets'), { force: true, recursive: true });
    copyFileSync(assetsCar, join(output, 'Assets.car'));
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

function stageIosLaunchAssets(output, backgroundColor, compileAssets = compileIosAssets) {
  const temporary = mkdtempSync(join(tmpdir(), 'threenative-ios-launch-'));
  try {
    const catalog = join(temporary, 'Assets.xcassets');
    const compiled = join(temporary, 'compiled');
    mkdirSync(compiled, { recursive: true });
    mkdirSync(catalog, { recursive: true });
    writeAssetCatalogContents(catalog);
    writeLaunchColor(catalog, backgroundColor);
    compileAssets(catalog, compiled);
    const assetsCar = join(compiled, 'Assets.car');
    if (!existsSync(assetsCar) || !statSync(assetsCar).isFile() || statSync(assetsCar).size === 0) {
      throw new Error('TN_IOS_LAUNCH_COMPILE_FAILED: actool did not produce a usable Assets.car.');
    }
    copyFileSync(assetsCar, join(output, 'Assets.car'));
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

/**
 * Stage the built UI bundle into the app bundle, where `WKURLSchemeHandler` serves it.
 *
 * Same two refusals as Android and desktop, because the same two mistakes are possible: a `web`
 * game with no built UI would launch and show nothing over a working game, and a `native` game must
 * carry no bundle at all.
 *
 * Native-only simulator smoke does not qualify WebUI. See the packaged React pixel proof.
 */
export function stageIosUi(ui, renderer, destination) {
  rmSync(destination, { force: true, recursive: true });
  if (renderer !== 'web') {
    if (ui) {
      throw new Error(
        `TN_UI_BUNDLE_UNEXPECTED: a UI bundle was staged for a game whose ui.renderer is '${renderer}'. ` +
          'The native renderer ships no web view; remove the bundle or set ui.renderer to "web".',
      );
    }
    return [];
  }
  if (!ui || !existsSync(ui)) {
    throw new Error(
      `TN_UI_BUNDLE_MISSING: ui.renderer is "web" but no built UI was found at ${ui ?? '(not provided)'}. ` +
        'Build the UI before packaging, or set ui.renderer to "native".',
    );
  }
  if (!statSync(ui).isDirectory()) throw new Error(`TN_UI_BUNDLE_MISSING: not a directory: ${ui}`);
  if (!existsSync(join(ui, 'index.html'))) {
    throw new Error(
      `TN_UI_BUNDLE_MISSING: ${ui} has no index.html, which is the page the overlay loads.`,
    );
  }
  mkdirSync(destination, { recursive: true });
  cpSync(ui, destination, { recursive: true });
  return listFiles(destination);
}

/**
 * Stage the game's compiled assets into the `.app`'s `game` directory.
 *
 * The same selector the other two packagers use, so one cook output left over from a previous
 * bake is dropped here too instead of shipping inside the bundle. iOS ran no preflight at all.
 * Its capability set is not Android's: `CMakeLists.txt` excludes IOS from every libwebp branch,
 * so a WebP texture that packages for Android must still be refused here, while the audio answer
 * is the same on every native target.
 */
export function stageIosAssets(assets, destination) {
  if (!assets || !existsSync(assets)) return [];
  if (!statSync(assets).isDirectory()) {
    throw new Error(`iOS assets path is not a directory: ${assets}`);
  }
  assertNativeAssetsDecodable(assets, {
    target: 'ios',
    capabilities: { webp: deriveIosWebpSupport() },
  });
  const { selected } = selectManifestAssets(assets);
  for (const file of selected) {
    const staged = join(destination, file);
    mkdirSync(dirname(staged), { recursive: true });
    cpSync(join(assets, file), staged);
  }
  return selected;
}

export function stageIosSimulatorApp({
  assets,
  bundle,
  ui = undefined,
  output,
  templateApp,
  orientation = undefined,
  config = undefined,
  compileIcon = compileIosIcon,
  compileAssets = compileIosAssets,
  convertInfoPlist = convertBinaryInfoPlist,
}) {
  const declared = configValue(config, orientation);
  const declaredOrientation = orientationValue(declared.display.orientation);
  for (const [label, path] of [
    ['native bundle', bundle],
    ['verified iOS simulator host', templateApp],
  ]) {
    if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  }
  for (const required of ['Info.plist', 'native-smoke.js', 'threenative-ios']) {
    if (!existsSync(join(templateApp, required))) {
      throw new Error(`Verified iOS simulator host is missing ${required}.`);
    }
  }
  // An old prebuilt archive predates the TN3187 scene opt-in and would ship a non-launching
  // app. Fail closed with the matching-runtime fix instead of silently packaging it: the
  // release lane must rebuild the ios-simulator-arm64 archive from SDL 3.4.16.
  const templatePlist = readIosInfoPlist(join(templateApp, 'Info.plist'), convertInfoPlist);
  if (!hasIosSceneManifestFields(templatePlist.source)) {
    throw new Error(
      'TN_IOS_SCENE_MANIFEST_MISSING: simulator host predates the UIScene adoption; rebuild the ios-simulator-arm64 archive from the matching runtime (SDL 3.4.16) before packaging.',
    );
  }
  rmSync(output, { force: true, recursive: true });
  mkdirSync(dirname(output), { recursive: true });
  cpSync(templateApp, output, { recursive: true });
  cpSync(bundle, join(output, 'native-smoke.js'));
  const game = join(output, 'game');
  rmSync(game, { force: true, recursive: true });
  mkdirSync(game, { recursive: true });
  // The CSS UI has an Android build and no iOS one yet: refused by name, not flattened to native.
  if (declared.ui?.renderer === 'native-css') {
    throw new Error('TN_UI_RENDERER_UNSUPPORTED: ui.renderer "native-css" has no iOS build');
  }
  stageIosUi(ui, mobileUiRenderer(declared.ui?.renderer), join(output, 'ui'));
  const plist = join(output, 'Info.plist');
  const infoPlist = readIosInfoPlist(plist, convertInfoPlist);
  writeFileSync(plist, renderIosInfoPlist(infoPlist.source, declared));
  const iosVariants = declared.app.icons?.ios ?? {};
  const icon = declared.app.icon ?? iosVariants.dark ?? iosVariants.tinted;
  if (icon !== undefined) {
    stageIosIcon(output, icon, compileIcon, {
      backgroundColor: declared.bootSplash?.backgroundColor,
      variants: iosVariants,
    });
  } else if (declared.bootSplash !== undefined) {
    stageIosLaunchAssets(
      output,
      declared.bootSplash.backgroundColor ?? '#000000',
      compileAssets,
    );
  }
  if (declared.bootSplash?.image !== undefined) {
    if (!existsSync(declared.bootSplash.image) || !statSync(declared.bootSplash.image).isFile()) {
      throw new Error(`TN_CONFIG_BRAND_SPLASH_MISSING: ${declared.bootSplash.image}`);
    }
    copyFileSync(declared.bootSplash.image, join(output, 'LaunchImage.png'));
  }
  const assetFiles = stageIosAssets(assets, game);
  const report = {
    assets: assetFiles.map((path) => ({ path, sha256: checksum(join(game, path)) })),
    bundleSha256: checksum(bundle),
    host: 'ios-simulator-arm64',
    infoPlistFormat: infoPlist.format,
    orientation: declaredOrientation,
    appId: declared.app.id,
    appName: declared.app.name,
    version: declared.app.version,
    build: declared.app.build,
    ...(icon === undefined ? {} : { icon }),
    ...(icon === undefined ? {} : { iconArtifact: 'Assets.car' }),
    ...(declared.bootSplash?.image === undefined ? {} : { launchImage: 'LaunchImage.png' }),
    ...(icon === undefined && declared.bootSplash === undefined
      ? {}
      : { launchBackground: declared.bootSplash?.backgroundColor ?? '#000000' }),
    output,
    outputBundleSha256: checksum(join(output, 'native-smoke.js')),
  };
  writeFileSync(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function packageIosSimulator(options) {
  const config = configValue(options.config, options.orientation);
  const orientation = orientationValue(config.display.orientation);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== 'darwin' || arch !== 'arm64') {
    throw new Error(
      `iOS simulator packaging requires a darwin-arm64 host; received ${platform}-${arch}. Device signing remains OPEN.`,
    );
  }
  const temporary = mkdtempSync(join(tmpdir(), 'threenative-ios-host-'));
  try {
    const suppliedArchive = options.archive ?? process.env.THREENATIVE_IOS_SIMULATOR_ARCHIVE;
    let archive;
    if (suppliedArchive) {
      archive = resolve(suppliedArchive);
      const expected = options.sha256 ?? process.env.THREENATIVE_IOS_SIMULATOR_SHA256 ?? '';
      if (!existsSync(archive) || !/^[a-f0-9]{64}$/u.test(expected)) {
        throw new Error('A local iOS simulator host requires an existing archive and SHA-256.');
      }
      const actual = checksum(archive);
      if (actual !== expected) {
        throw new Error(
          `iOS simulator host checksum mismatch: expected ${expected}, received ${actual}.`,
        );
      }
    } else {
      archive = join(temporary, 'threenative-ios.zip');
      writeFileSync(archive, await downloadReleaseArtifact('ios-simulator-arm64'));
    }
    const result = spawnSync('ditto', ['-x', '-k', archive, temporary], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `ditto failed to unpack ${basename(archive)}: ${result.stderr || result.stdout}`,
      );
    }
    const templateApp = findApp(temporary);
    if (!templateApp) throw new Error('Verified iOS simulator archive contains no .app bundle.');
    return stageIosSimulatorApp({
      assets: options.assets ? resolve(options.assets) : undefined,
      bundle: resolve(options.bundle),
      ui: options.ui === undefined ? undefined : resolve(options.ui),
      output: resolve(options.output),
      templateApp,
      orientation,
      config,
    });
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

export function parseIosPackageArgs(args) {
  return {
    assets: args.includes('--assets') ? valueAfter(args, '--assets') : undefined,
    ui: args.includes('--ui') ? valueAfter(args, '--ui') : undefined,
    bundle: valueAfter(args, '--bundle'),
    output: valueAfter(args, '--output'),
    config: args.includes('--config') ? valueAfter(args, '--config') : undefined,
    orientation: args.includes('--orientation')
      ? argumentAfter(args, '--orientation')
      : undefined,
  };
}

export async function runIosPackageCli(args, packageSimulator = packageIosSimulator) {
  const parsed = parseIosPackageArgs(args);
  return packageSimulator({
    archive: process.env.THREENATIVE_IOS_SIMULATOR_ARCHIVE,
    ...parsed,
    config: parsed.config === undefined ? undefined : readConfig(parsed.config),
    sha256: process.env.THREENATIVE_IOS_SIMULATOR_SHA256,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const report = await runIosPackageCli(process.argv.slice(2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
