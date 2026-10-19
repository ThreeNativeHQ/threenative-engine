#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { downloadReleaseArtifact, releaseManifestUrl, verifyChecksum } from './install-prebuilt.mjs';
import { listFiles, selectManifestAssets } from './asset-manifest.mjs';
import { assertAndroidAssetsDecodable, deriveAndroidWebpSupport } from './asset-preflight.mjs';
import {
  assertAndroidArtifact16KbAlignment,
  resolveZipalignCandidates,
} from './check-android-16kb-alignment.mjs';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const GRADLE_WRAPPER_URL =
  'https://raw.githubusercontent.com/gradle/gradle/v8.13.0/gradle/wrapper/gradle-wrapper.jar';
export const GRADLE_WRAPPER_SHA256 =
  '81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f';

export const ANDROID_ABIS = ['arm64-v8a', 'x86_64'];
export const ANDROID_ENGINES = ['quickjs', 'v8'];

/**
 * The Android submission API level Google Play requires of a new app or update.
 *
 * PRD-212 phase 1. It is the one literal the packaging layer owns; the shipped
 * `android/app/build.gradle.kts` carries the same number, and `assertAndroidSubmissionTargetSdk`
 * refuses a build whose rendered project is below it. Raise both together — Play raises the floor
 * on its own schedule, and a build that silently drops below it ships an artifact that is
 * rejected at upload.
 */
export const ANDROID_SUBMISSION_TARGET_SDK = 36;

/** The `targetSdk` a Gradle Android project source declares, if it declares one. */
export function androidGradleTargetSdk(source) {
  const match = /targetSdk\s*=\s*(\d+)/u.exec(String(source ?? ''));
  return match === null ? undefined : Number(match[1]);
}

/**
 * Refuse a rendered Android project whose `targetSdk` is below the submission floor.
 *
 * Fail closed on a missing `targetSdk`: an unparsable project is a project whose submission level
 * nobody can vouch for, which is exactly what this gate exists to catch.
 */
export function assertAndroidSubmissionTargetSdk(source, required = ANDROID_SUBMISSION_TARGET_SDK) {
  const declared = androidGradleTargetSdk(source);
  if (declared === undefined) {
    throw new Error(
      `TN_ANDROID_TARGET_SDK_MISSING: android/app/build.gradle.kts declares no targetSdk; submission requires API ${required}.`,
    );
  }
  if (declared < required) {
    throw new Error(
      `TN_ANDROID_TARGET_SDK_BELOW_SUBMISSION: targetSdk ${declared} is below the required API ${required}; update android/app/build.gradle.kts before packaging a release.`,
    );
  }
  return declared;
}

/**
 * The four Gradle project properties a consumer-owned release signs with.
 *
 * PRD-212 phase 3. The names are the contract between the game's build environment and
 * `android/app/build.gradle.kts`; `packages/create-threenative/src/doctor.ts` predicts the same four
 * in their `ORG_GRADLE_PROJECT_` transport spelling, and a test fails if the two lists drift.
 * Values are read here only to hand them to the signing subprocess and are never logged or
 * serialized into the packaging config.
 */
export const ANDROID_RELEASE_SIGNING_PROPERTIES = Object.freeze({
  keystore: 'threenativeKeystore',
  keyAlias: 'threenativeKeystoreAlias',
  keystorePassword: 'threenativeKeystorePassword',
  keyPassword: 'threenativeKeyPassword',
});

/**
 * Resolve the signing inputs from the build environment, resolving the keystore against the
 * consumer project rather than the engine's Android project directory.
 *
 * Returns the password values so they can be forwarded to Gradle; callers must not print them.
 */
export function androidReleaseSigning(environment = process.env, projectRoot = undefined) {
  const read = (property) => (environment[`ORG_GRADLE_PROJECT_${property}`] ?? '').trim();
  const keystore = read(ANDROID_RELEASE_SIGNING_PROPERTIES.keystore);
  const resolvedKeystore =
    keystore.length === 0 || projectRoot === undefined ? keystore : resolve(projectRoot, keystore);
  const values = {
    keystore: resolvedKeystore,
    keyAlias: read(ANDROID_RELEASE_SIGNING_PROPERTIES.keyAlias),
    keystorePassword: read(ANDROID_RELEASE_SIGNING_PROPERTIES.keystorePassword),
    keyPassword: read(ANDROID_RELEASE_SIGNING_PROPERTIES.keyPassword),
  };
  const missing = Object.entries(values)
    .filter(([, value]) => value.length === 0)
    .map(([role]) => `ORG_GRADLE_PROJECT_${ANDROID_RELEASE_SIGNING_PROPERTIES[role]}`);
  return {
    ...values,
    complete: missing.length === 0,
    missing,
  };
}

/** The environment Gradle sees, with the four signing properties rewritten to resolved values. */
export function androidSigningGradleEnvironment(signing, environment = process.env) {
  return {
    ...environment,
    ORG_GRADLE_PROJECT_threenativeKeystore: signing.keystore,
    ORG_GRADLE_PROJECT_threenativeKeystoreAlias: signing.keyAlias,
    ORG_GRADLE_PROJECT_threenativeKeystorePassword: signing.keystorePassword,
    ORG_GRADLE_PROJECT_threenativeKeyPassword: signing.keyPassword,
  };
}

/** Locate an Android build tool on `PATH`, then in the SDK's `build-tools/<version>/`. */
export function findAndroidBuildTool(name, environment = process.env) {
  const suffix = process.platform === 'win32' ? '.bat' : '';
  const onPath = spawnSync(`${name}${suffix}`, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000,
  });
  if (onPath.error === undefined && onPath.status !== null) return `${name}${suffix}`;
  const roots = [environment.ANDROID_HOME, environment.ANDROID_SDK_ROOT]
    .filter((root) => typeof root === 'string' && root.length > 0)
    .concat(join(homedir(), 'Android', 'Sdk'));
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const buildTools = join(root, 'build-tools');
    if (!existsSync(buildTools)) continue;
    const versions = readdirSync(buildTools).sort((left, right) =>
      right.localeCompare(left, 'en', { numeric: true }),
    );
    for (const version of versions) {
      const candidate = join(buildTools, version, `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
    const direct = join(root, 'tools', 'bin', `${name}${suffix}`);
    if (existsSync(direct)) return direct;
  }
  return undefined;
}

function onlySelfSignedCertificateErrors(output) {
  const errors = /^Error:[ \t]*\r?\n((?:[^\r\n]+\r?\n)+)/mu.exec(output)?.[1]
    .trim().split(/\r?\n/u).map((line) => line.trim()) ?? [];
  const selfSigned = 'This jar contains entries whose signer certificate is self-signed.';
  return errors.includes(selfSigned) && errors.every((line) =>
    line === selfSigned ||
    /^This jar contains entries whose certificate chain is invalid\. Reason: PKIX path building failed: .*: unable to find valid certification path to requested target$/u.test(line),
  );
}

/**
 * Prove a release artifact is really signed, targets the submission SDK and is not debuggable.
 *
 * `verifyReleaseSignature` is the injectable seam the integration lane uses to stand in for the
 * SDK tools; on a real build the signature is read with `apksigner` (APK) or `jarsigner` (AAB), and
 * a missing verifier is a blocker rather than a silent pass. An APK is additionally read back with
 * `aapt`, so the gate checks the artifact itself — its packaged `targetSdkVersion` and absence of
 * `application-debuggable` — rather than trusting the Gradle source. Nothing here reads a signing
 * value except the tool invocations Gradle already owns.
 */
export function verifyAndroidReleaseArtifact(artifact, request, options = {}) {
  const environment = options.environment ?? process.env;
  const run = options.spawnSync ?? spawnSync;
  if (options.verifyReleaseSignature !== undefined) {
    return options.verifyReleaseSignature(artifact, request);
  }
  const locate = (name) =>
    options.findBuildTool !== undefined
      ? options.findBuildTool(name)
      : findAndroidBuildTool(name, environment);
  const tool = request.format === 'aab' ? 'jarsigner' : 'apksigner';
  const executable = locate(tool);
  if (executable === undefined) {
    throw new Error(
      `TN_ANDROID_SIGNATURE_TOOL_MISSING: ${tool} is unavailable, so the ${request.format} signature cannot be verified. Install the Android build-tools, or set ANDROID_HOME.`,
    );
  }
  const args = tool === 'apksigner'
    ? ['verify', '--print-certs', artifact]
    : ['-J-Duser.language=en', '-J-Duser.country=US', '-verify', '-strict', artifact];
  const result = run(executable, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // Android signing certificates are normally self-signed (jarsigner warning bit 4).
  // That bit also covers expired certificates, so accept only the named self-signed errors.
  // Strict verification still rejects unsigned entries (bit 16) and invalid signatures.
  // An entirely unsigned archive can exit 0, so positive signature evidence is required too.
  const signatureValid = tool === 'apksigner'
    ? result.status === 0
    : (result.status === 0 || (result.status === 4 && onlySelfSignedCertificateErrors(output))) &&
      /^jar verified(?:\.|, with signer errors\.)\r?$/mu.test(output);
  if (!signatureValid) {
    throw new Error(
      `TN_ANDROID_SIGNATURE_INVALID: ${tool} rejected ${artifact}: ${output.trim() || 'unknown reason'}`,
    );
  }
  const facts = { output };
  if (request.format === 'aab') return facts;
  // The APK's own badging is the artifact-level half of the phase-1 gate: a project whose source
  // says 36 but whose packaged manifest says 35 is what a source-only check misses.
  const aapt = locate('aapt');
  if (aapt === undefined) {
    throw new Error(
      `TN_ANDROID_BADGING_TOOL_MISSING: aapt is unavailable, so the release APK's targetSdk and debuggable state cannot be read. Install the Android build-tools, or set ANDROID_HOME.`,
    );
  }
  const badging = run(aapt, ['dump', 'badging', artifact], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (badging.error) throw badging.error;
  const badgingText = `${badging.stdout ?? ''}${badging.stderr ?? ''}`;
  if (badging.status !== 0) {
    throw new Error(`TN_ANDROID_BADGING_FAILED: aapt could not read ${artifact}.`);
  }
  const targetSdk = /targetSdkVersion:'(\d+)'/u.exec(badgingText)?.[1];
  if (targetSdk === undefined) {
    throw new Error(`TN_ANDROID_BADGING_INCOMPLETE: aapt reported no targetSdkVersion for ${artifact}.`);
  }
  if (Number(targetSdk) < ANDROID_SUBMISSION_TARGET_SDK) {
    throw new Error(
      `TN_ANDROID_TARGET_SDK_BELOW_SUBMISSION: packaged targetSdk ${targetSdk} is below the required API ${ANDROID_SUBMISSION_TARGET_SDK}.`,
    );
  }
  if (/application-debuggable/u.test(badgingText)) {
    throw new Error(`TN_ANDROID_ARTIFACT_DEBUGGABLE: ${artifact} is debuggable.`);
  }
  return { output, targetSdk: Number(targetSdk) };
}



/**
 * The QuickJS prebuilt set. Unchanged, and still the meaning of the unqualified release keys.
 *
 * `libmystral-runtime.so` here is the QuickJS-linked runtime: the interpreter is compiled *into*
 * it, which is why the V8 set below needs a different runtime binary rather than the same one plus
 * a library.
 */
/**
 * The Android SDL3 version, owned here because this file is the one that ships.
 *
 * It was written out by hand in four places and a bump left three of them naming an archive that
 * no longer existed. `download-deps.mjs` imports it rather than the other way round: that script
 * is a development-time provisioning path and is deliberately not in the published package, so a
 * published install importing it fails at require time — which is what the clean-room Android
 * test caught.
 *
 * 3.2.30 is the first release in this line whose 64-bit Android libraries carry 16 KB LOAD
 * alignment, which Android 15 and later require. Do not go back.
 */
export const SDL3_ANDROID_VERSION = '3.2.30';

export const ANDROID_PREBUILT_ASSETS = {
  'android-arm64-v8a-runtime': 'jniLibs/arm64-v8a/libmystral-runtime.so',
  'android-arm64-v8a-sdl3': 'jniLibs/arm64-v8a/libSDL3.so',
  'android-sdl3-aar': `SDL3-${SDL3_ANDROID_VERSION}.aar`,
  'android-x86_64-runtime': 'jniLibs/x86_64/libmystral-runtime.so',
  'android-x86_64-sdl3': 'jniLibs/x86_64/libSDL3.so',
};

/**
 * The V8 prebuilt set, added 2026-08-16 by PRD-130 Phase 4.
 *
 * Before this, the prebuilt path could not express V8 at all: it shipped four files, none of them
 * V8, so a project built from a release artifact got QuickJS **whatever the default said**. Flipping
 * the engine default without this would have produced a default only operators with an NDK ever
 * received.
 *
 * The runtime binary is engine-qualified rather than shared, because it genuinely differs — 60.4 MB
 * linked against V8 against 66.6 MB with QuickJS compiled in. Publishing one runtime and bolting a
 * library onto it would produce a process that reports the wrong engine, which is exactly the class
 * of failure `--expect-engine` exists to catch.
 */
export const ANDROID_PREBUILT_V8_ASSETS = {
  'android-arm64-v8a-runtime-v8': 'jniLibs/arm64-v8a/libmystral-runtime.so',
  'android-arm64-v8a-sdl3': 'jniLibs/arm64-v8a/libSDL3.so',
  'android-arm64-v8a-v8': 'jniLibs/arm64-v8a/libv8android.so',
  'android-arm64-v8a-libcxx': 'jniLibs/arm64-v8a/libc++_shared.so',
  'android-arm64-v8a-v8-snapshot': 'assets/v8/arm64-v8a/snapshot_blob.bin',
  'android-sdl3-aar': `SDL3-${SDL3_ANDROID_VERSION}.aar`,
  'android-x86_64-runtime-v8': 'jniLibs/x86_64/libmystral-runtime.so',
  'android-x86_64-sdl3': 'jniLibs/x86_64/libSDL3.so',
  'android-x86_64-v8': 'jniLibs/x86_64/libv8android.so',
  'android-x86_64-libcxx': 'jniLibs/x86_64/libc++_shared.so',
  'android-x86_64-v8-snapshot': 'assets/v8/x86_64/snapshot_blob.bin',
};

/** The prebuilt set one engine needs. The engine name is the same one the source path uses. */
export function androidPrebuiltAssets(engine = 'v8') {
  const name = String(engine).toLowerCase();
  if (!ANDROID_ENGINES.includes(name)) {
    throw new Error(`Unknown Android JS engine '${engine}'; expected one of ${ANDROID_ENGINES.join(', ')}.`);
  }
  return name === 'v8' ? ANDROID_PREBUILT_V8_ASSETS : ANDROID_PREBUILT_ASSETS;
}
export const NATIVE_ORIENTATIONS = ['landscape', 'portrait', 'sensor'];

function androidPaths(root = runtimeRoot) {
  return {
    androidRoot: join(root, 'android'),
    androidManifest: join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
    androidStrings: join(root, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml'),
    androidTheme: join(root, 'android', 'app', 'src', 'main', 'res', 'values', 'themes.xml'),
    androidBranding: join(root, 'android', 'app', 'src', 'main', 'res', 'values', 'branding.xml'),
    androidGradle: join(root, 'android', 'app', 'build.gradle.kts'),
    androidAdaptiveIcon: join(
      root,
      'android',
      'app',
      'src',
      'main',
      'res',
      'mipmap-anydpi-v26',
      'ic_launcher.xml',
    ),
    androidIcon: join(
      root,
      'android',
      'app',
      'src',
      'main',
      'res',
      'mipmap-xxxhdpi',
      'ic_launcher.png',
    ),
    androidForeground: join(
      root,
      'android',
      'app',
      'src',
      'main',
      'res',
      'drawable-nodpi',
      'ic_launcher_foreground.png',
    ),
    androidMonochrome: join(
      root,
      'android',
      'app',
      'src',
      'main',
      'res',
      'drawable-nodpi',
      'ic_launcher_monochrome.png',
    ),
    androidSplash: join(
      root,
      'android',
      'app',
      'src',
      'main',
      'res',
      'drawable-nodpi',
      'tn_boot_splash.png',
    ),
  };
}

export const DEFAULT_ANDROID_CONFIG = {
  app: { id: 'com.threenative.game', name: 'ThreeNative', version: '0.1.0', build: 1 },
  display: { orientation: 'landscape', fullscreen: true, keepScreenOn: false, maxFps: 60, backgroundMode: 'pause' },
  window: { title: 'ThreeNative', width: 1280, height: 720, maximized: false, resizable: true },
  // `native` is PRD-216's CanvasLayer renderer: no WebView, no CSS, no second process. A game
  // that never states a renderer therefore ships no overlay, which is what acceptance criterion 5
  // asks for. Templates state `web` explicitly.
  ui: { renderer: 'native' },
};

function configValue(value, orientation) {
  const source = value && typeof value === 'object' ? value : {};
  const app = source.app && typeof source.app === 'object' ? source.app : {};
  const display = source.display && typeof source.display === 'object' ? source.display : {};
  const window = source.window && typeof source.window === 'object' ? source.window : {};
  const bootSplash = source.bootSplash && typeof source.bootSplash === 'object' ? source.bootSplash : {};
  const ui = source.ui && typeof source.ui === 'object' ? source.ui : {};
  return {
    ui: { ...DEFAULT_ANDROID_CONFIG.ui, ...ui },
    app: { ...DEFAULT_ANDROID_CONFIG.app, ...app },
    display: {
      ...DEFAULT_ANDROID_CONFIG.display,
      ...display,
      orientation: orientation ?? display.orientation ?? DEFAULT_ANDROID_CONFIG.display.orientation,
    },
    window: { ...DEFAULT_ANDROID_CONFIG.window, ...window },
    ...(source.bootSplash === undefined ? {} : { bootSplash: { ...bootSplash } }),
  };
}

export function readAndroidConfig(configPath) {
  if (configPath === undefined) return configValue();
  try {
    return configValue(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch (error) {
    throw new Error(`TN_CONFIG_FILE_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function setXmlAttribute(tag, name, value) {
  const attribute = `android:${name}`;
  const pattern = new RegExp(`\\s${attribute}="[^"]*"`, 'u');
  if (value === undefined) return tag.replace(pattern, '');
  const rendered = ` ${attribute}="${xmlEscape(value)}"`;
  return pattern.test(tag) ? tag.replace(pattern, rendered) : tag.replace(/>$/u, `${rendered}>`);
}

function upsertApplicationMetadata(source, name, value) {
  const rendered = `        <meta-data android:name="${name}" android:value="${xmlEscape(value)}" />`;
  const existing = new RegExp(`\\n[ \\t]*<meta-data\\b[^>]*android:name="${name}"[^>]*/>`, 'gu');
  const withoutExisting = source.replace(existing, '');
  return withoutExisting.replace(/\s*<\/application>/u, `\n${rendered}\n    </application>`);
}

function orientationValue(value = 'landscape') {
  if (typeof value === 'string' && NATIVE_ORIENTATIONS.includes(value)) return value;
  throw new Error(
    'TN_NATIVE_ORIENTATION_INVALID: display.orientation must be landscape, portrait, or sensor.',
  );
}

function androidIcons(config) {
  const app = config.app ?? {};
  return app.icons?.android ?? {};
}

function hasAndroidIcon(config) {
  return iconForeground(config) !== undefined;
}

function appIcon(config) {
  return config.app?.icon;
}

function iconForeground(config) {
  return androidIcons(config).foreground ?? appIcon(config);
}

function iconMonochrome(config) {
  return androidIcons(config).monochrome ?? iconForeground(config);
}

function iconBackground(config) {
  return androidIcons(config).background ?? config.bootSplash?.backgroundColor ?? '#000000';
}

function bootSplashBackground(config) {
  return config.bootSplash?.backgroundColor ?? '#000000';
}

function setThemeItem(source, name, value) {
  const item = new RegExp(`<item\\s+name="${name}">[\\s\\S]*?<\\/item>`, 'u');
  const rendered = `<item name="${name}">${value}</item>`;
  if (item.test(source)) return source.replace(item, rendered);
  return source.replace(/\s*<\/style>/u, `\n        ${rendered}\n    </style>`);
}

export function renderAndroidBrandingResources(config) {
  const icons = androidIcons(config);
  const hasIcon = hasAndroidIcon(config);
  const adaptive = hasIcon
    ? `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/tn_icon_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
`
    : undefined;
  const colors = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="tn_icon_background">${xmlEscape(iconBackground(config))}</color>
    <color name="tn_boot_splash_background">${xmlEscape(bootSplashBackground(config))}</color>
</resources>
`;
  return {
    adaptive,
    colors,
    foreground: icons.foreground ?? appIcon(config),
    monochrome: icons.monochrome ?? icons.foreground ?? appIcon(config),
    splash: config.bootSplash?.image,
  };
}

/**
 * Insert or replace an `<activity>`-scoped `<property>` element.
 *
 * `<property>` is not `<meta-data>`: the platform reads compat properties only from the former, so
 * `upsertApplicationMetadata` cannot express this.
 */
function upsertActivityProperty(source, name, value) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const existing = new RegExp(`\\s*<property\\s+android:name="${escapedName}"[^>]*/>`, 'u');
  const element = `\n            <property android:name="${name}" android:value="${value}" />`;
  if (existing.test(source)) return source.replace(existing, element);
  const activity = /<activity\b[^>]*>/u.exec(source);
  if (!activity) return source;
  return source.replace(activity[0], `${activity[0]}${element}`);
}

export function renderAndroidManifest(source, orientation = 'landscape') {
  const config = configValue(typeof orientation === 'string' ? undefined : orientation, typeof orientation === 'string' ? orientation : undefined);
  const value = orientationValue(config.display.orientation);
  const application = /<application\b[^>]*>/u.exec(source);
  if (!application) throw new Error('TN_ANDROID_MANIFEST_APPLICATION_MISSING: no application was found.');
  const activity = /<activity\b[^>]*>/u.exec(source);
  if (!activity) throw new Error('TN_ANDROID_MANIFEST_ACTIVITY_MISSING: no activity was found.');
  let rendered = source.replace(
    application[0],
    setXmlAttribute(application[0], 'icon', config.app.icon === undefined ? undefined : '@mipmap/ic_launcher'),
  );
  rendered = rendered.replace(
    /<application\b[^>]*>/u,
    (tag) => setXmlAttribute(tag, 'icon', hasAndroidIcon(config) ? '@mipmap/ic_launcher' : undefined),
  );
  rendered = rendered.replace(
    /<application\b[^>]*>/u,
    (tag) => setXmlAttribute(tag, 'roundIcon', hasAndroidIcon(config) ? '@mipmap/ic_launcher' : undefined),
  );
  const renderedActivity = setXmlAttribute(
    activity[0],
    'screenOrientation',
    value,
  );
  rendered = rendered.replace(activity[0], renderedActivity);
  // Opt out of the platform's orientation override.
  //
  // Android 16+ applies `SCREEN_ORIENTATION_FULL_USER` on top of an app's declared orientation for
  // apps it considers non-adaptive, which is why a manifest reading
  // `android:screenOrientation="landscape"` still came up portrait on a Pixel 8 —
  // `dumpsys activity activities` showed `overrideOrientation=SCREEN_ORIENTATION_FULL_USER` and the
  // window simply followed the device. This property is the documented way to decline that
  // override, and it is only set when the game actually asked for a fixed orientation: a game
  // configured `sensor` wants the platform behaviour and must not opt out of it.
  if (value !== 'sensor') {
    rendered = upsertActivityProperty(
      rendered,
      'android.window.PROPERTY_COMPAT_ALLOW_ORIENTATION_OVERRIDE',
      'false',
    );
  }
  rendered = upsertApplicationMetadata(rendered, 'TN_KEEP_SCREEN_ON', String(config.display.keepScreenOn));
  rendered = upsertApplicationMetadata(rendered, 'TN_MAX_FPS', String(config.display.maxFps));
  // `display.backgroundMode`. Carried as metadata beside the others so the activity can hand it to
  // the native host, which decides whether the render loop parks when the player leaves. Fail
  // closed on a value nobody defined: an unrecognized mode ships as 'pause'.
  rendered = upsertApplicationMetadata(
    rendered,
    'TN_BACKGROUND_MODE',
    config.display.backgroundMode === 'continue' ? 'continue' : 'pause',
  );
  // `ui.renderer`. The activity reads this to decide whether to attach the WebView overlay at all,
  // so a game that did not opt in ships no overlay and no extra process. Fail closed on a value
  // nobody defined: anything but 'web' is the native renderer.
  rendered = upsertApplicationMetadata(
    rendered,
    'TN_UI_RENDERER',
    mobileUiRenderer(config.ui.renderer),
  );
  rendered = upsertApplicationMetadata(rendered, 'TN_WINDOW_TITLE', '@string/window_title');
  rendered = upsertApplicationMetadata(rendered, 'TN_FULLSCREEN', String(config.display.fullscreen));
  // Also carried as metadata, not only as `android:screenOrientation`: the activity re-requests it
  // in `onCreate`, because the manifest attribute alone did not hold a landscape game in landscape
  // on a Pixel 8.
  return upsertApplicationMetadata(rendered, 'TN_ORIENTATION', config.display.orientation);
}

export function renderAndroidStrings(source, config) {
  const value = configValue(config);
  let rendered = source.replace(/(<string\s+name="app_name">)[\s\S]*?(<\/string>)/u, `$1${xmlEscape(value.app.name)}$2`);
  if (!/<string\s+name="window_title">/u.test(rendered)) {
    rendered = rendered.replace(/\s*<\/resources>/u, `\n    <string name="window_title">${xmlEscape(value.window.title)}</string>\n</resources>`);
  } else {
    rendered = rendered.replace(/(<string\s+name="window_title">)[\s\S]*?(<\/string>)/u, `$1${xmlEscape(value.window.title)}$2`);
  }
  return rendered;
}

export function renderAndroidTheme(source, config) {
  const value = configValue(config);
  const fullscreen = String(value.display.fullscreen);
  const parent = value.display.fullscreen ? 'android:Theme.NoTitleBar.Fullscreen' : 'android:Theme.NoTitleBar';
  let rendered = source.replace(/(parent=")[^"]*(")/u, `$1${parent}$2`);
  const item = /<item\s+name="android:windowFullscreen">[\s\S]*?<\/item>/u;
  rendered = item.test(rendered)
    ? rendered.replace(item, `<item name="android:windowFullscreen">${fullscreen}</item>`)
    : rendered.replace(/\s*<\/style>/u, `\n        <item name="android:windowFullscreen">${fullscreen}</item>\n    </style>`);
  rendered = setThemeItem(rendered, 'android:windowSplashScreenBackground', '@color/tn_boot_splash_background');
  if (hasAndroidIcon(config)) {
    rendered = setThemeItem(rendered, 'android:windowSplashScreenAnimatedIcon', '@drawable/ic_launcher_foreground');
  }
  if (configValue(config).bootSplash?.image !== undefined) {
    rendered = setThemeItem(rendered, 'android:windowSplashScreenBrandingImage', '@drawable/tn_boot_splash');
  }
  return rendered;
}

export function renderAndroidBuildGradle(source, config) {
  const value = configValue(config);
  let rendered = source.replace(/(namespace\s*=\s*")[^"]*(")/u, `$1${value.app.id}$2`);
  rendered = rendered.replace(/(applicationId\s*=\s*")[^"]*(")/u, `$1${value.app.id}$2`);
  rendered = rendered.replace(/(versionCode\s*=\s*)\d+/u, `$1${value.app.build}`);
  return rendered.replace(/(versionName\s*=\s*")[^"]*(")/u, `$1${value.app.version}$2`);
}

function restoreFile(file, original) {
  if (original === undefined) rmSync(file, { force: true });
  else writeFileSync(file, original);
}

function installAndroidFiles(config, root = runtimeRoot) {
  const {
    androidManifest,
    androidStrings,
    androidTheme,
    androidBranding,
    androidGradle,
    androidAdaptiveIcon,
    androidIcon,
    androidForeground,
    androidMonochrome,
    androidSplash,
  } = androidPaths(root);
  const branding = renderAndroidBrandingResources(config);
  const requiredAssets = [
    [branding.foreground, 'TN_CONFIG_BRAND_ANDROID_FOREGROUND_MISSING'],
    [branding.monochrome, 'TN_CONFIG_BRAND_ANDROID_MONOCHROME_MISSING'],
    [branding.splash, 'TN_CONFIG_BRAND_SPLASH_MISSING'],
  ];
  for (const [file, code] of requiredAssets) {
    if (file !== undefined && (!existsSync(file) || !statSync(file).isFile())) {
      throw new Error(`${code}: declared Android brand asset does not exist: ${file}`);
    }
  }
  const originals = new Map([
    [androidManifest, readFileSync(androidManifest)],
    [androidStrings, readFileSync(androidStrings)],
    [androidTheme, readFileSync(androidTheme)],
    [androidGradle, readFileSync(androidGradle)],
  ]);
  const generated = [androidBranding, androidAdaptiveIcon, androidForeground, androidMonochrome, androidSplash];
  const generatedOriginals = new Map(
    generated.map((file) => [file, existsSync(file) ? readFileSync(file) : undefined]),
  );
  const iconOriginal = existsSync(androidIcon) ? readFileSync(androidIcon) : undefined;
  writeFileSync(androidManifest, renderAndroidManifest(originals.get(androidManifest).toString('utf8'), config));
  writeFileSync(androidStrings, renderAndroidStrings(originals.get(androidStrings).toString('utf8'), config));
  writeFileSync(androidTheme, renderAndroidTheme(originals.get(androidTheme).toString('utf8'), config));
  writeFileSync(androidGradle, renderAndroidBuildGradle(originals.get(androidGradle).toString('utf8'), config));
  writeFileSync(androidBranding, branding.colors);
  if (branding.adaptive !== undefined) {
    mkdirSync(dirname(androidAdaptiveIcon), { recursive: true });
    writeFileSync(androidAdaptiveIcon, branding.adaptive);
  } else {
    rmSync(androidAdaptiveIcon, { force: true });
  }
  if (branding.foreground !== undefined) {
    mkdirSync(dirname(androidForeground), { recursive: true });
    copyFileSync(branding.foreground, androidForeground);
  } else {
    rmSync(androidForeground, { force: true });
  }
  if (branding.monochrome !== undefined) {
    mkdirSync(dirname(androidMonochrome), { recursive: true });
    copyFileSync(branding.monochrome, androidMonochrome);
  } else {
    rmSync(androidMonochrome, { force: true });
  }
  if (branding.splash !== undefined) {
    mkdirSync(dirname(androidSplash), { recursive: true });
    copyFileSync(branding.splash, androidSplash);
  } else {
    rmSync(androidSplash, { force: true });
  }
  if (branding.foreground !== undefined) {
    mkdirSync(dirname(androidIcon), { recursive: true });
    copyFileSync(branding.foreground, androidIcon);
  } else {
    rmSync(androidIcon, { force: true });
  }
  return () => {
    for (const [file, original] of originals) restoreFile(file, original);
    restoreFile(androidIcon, iconOriginal);
    for (const [file, original] of generatedOriginals) restoreFile(file, original);
  };
}

export async function prepareAndroidPrebuilts(options = {}) {
  // Defaults to the engine the source path defaults to. Two names for one choice is how the flag
  // gets forgotten, so the prebuilt path takes the same engine names the Gradle property does.
  const engine = String(options.engine ?? 'v8').toLowerCase();
  const assets = androidPrebuiltAssets(engine);
  // Name the source the download will really read. `downloadReleaseArtifact` prefers
  // THREENATIVE_PREBUILT_MANIFEST over the release URL, so reporting the URL when the env hook is
  // set sends a reader to a 404 that had nothing to do with their failure.
  const expectedSource =
    options.manifestPath ??
    process.env.THREENATIVE_PREBUILT_MANIFEST ??
    options.manifestUrl ??
    releaseManifestUrl(options.version);
  const downloadOptions = {
    ...options,
    manifestUrl: options.manifestUrl ?? releaseManifestUrl(options.version),
  };
  const downloads = await Promise.all(
    Object.keys(assets).map(async (key) => {
      try {
        return [key, await downloadReleaseArtifact(key, downloadOptions)];
      } catch (error) {
        throw new Error(
          `Android prebuilt '${key}' expected from '${expectedSource}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
  const prebuiltRoot = resolve(options.outputRoot ?? join(runtimeRoot, 'android', 'prebuilt'));
  for (const [key, contents] of downloads) {
    const output = join(prebuiltRoot, assets[key]);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, contents);
  }
  return prebuiltRoot;
}

export async function ensureGradleWrapper(options = {}) {
  const output = resolve(
    options.output ?? join(runtimeRoot, 'android', 'gradle', 'wrapper', 'gradle-wrapper.jar'),
  );
  const expected = options.sha256 ?? GRADLE_WRAPPER_SHA256;
  if (existsSync(output)) {
    verifyChecksum(readFileSync(output), expected, 'gradle-wrapper');
    return output;
  }
  const url = new URL(options.url ?? GRADLE_WRAPPER_URL);
  if (url.protocol !== 'https:' && process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT !== '1') {
    throw new Error('Gradle wrapper URL must use HTTPS.');
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Gradle wrapper fetch failed: HTTP ${response.status}.`);
  const contents = Buffer.from(await response.arrayBuffer());
  verifyChecksum(contents, expected, 'gradle-wrapper');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, contents);
  return output;
}

export function stageAndroidAssets(
  assets,
  destination = join(runtimeRoot, 'android', 'app', 'build', 'generated', 'threenative', 'assets', 'game'),
  runtimeSource = runtimeRoot,
) {
  rmSync(destination, { force: true, recursive: true });
  mkdirSync(destination, { recursive: true });
  if (!assets || !existsSync(assets)) return [];
  if (!statSync(assets).isDirectory()) {
    throw new Error(`Android assets path is not a directory: ${assets}`);
  }
  // Read the assets before copying them. Everything this catches — OGG the decoder rejects, WebP
  // the runtime was built without, interleaved buffers WebGPU refuses to make a pipeline for —
  // otherwise ships in an APK that installs, launches and draws nothing.
  // Derived from the runtime this build is about to pack, not declared here. A hardcoded claim
  // goes stale the moment the build changes under it, which is exactly what happened to WebP.
  assertAndroidAssetsDecodable(assets, { webp: deriveAndroidWebpSupport(runtimeSource) });
  const { selected: files } = selectManifestAssets(assets);
  for (const file of files) {
    const output = join(destination, file);
    mkdirSync(dirname(output), { recursive: true });
    cpSync(join(assets, file), output);
  }
  return files;
}

/**
 * Flatten `ui.renderer` for the Android host, which reads a flat string.
 *
 * `native-css` survives the flattening: the activity reads it to extract the staged stylesheets
 * and hand them to the runtime's CSS UI instead of attaching a WebView. Whether the runtime has
 * that backend at all is `androidCssUiGradleArgs`'s question.
 */
export function mobileUiRenderer(renderer) {
  if (renderer === 'native-css') return 'native-css';
  return renderer === 'web' ? 'web' : 'native';
}

/**
 * The Gradle switch a `native-css` game needs, or a named refusal.
 *
 * The CSS UI is linked only when the runtime is compiled with `-PthreenativeCssUi=true`, which only
 * a source build can do: no published Android prebuilt carries it, and a game packaged against one
 * would install, launch and paint no HUD with clean logs.
 */
export function androidCssUiGradleArgs(renderer, sourceCheckout) {
  if (renderer !== 'native-css') return [];
  if (!sourceCheckout) {
    throw new Error(
      'TN_CSS_UI_HOST_MISSING: ui.renderer is "native-css" but the prebuilt Android runtime was not built with ' +
        'TN_ENABLE_CSS_UI (no published prebuilt has the CSS backend); build from a runtime source checkout ' +
        'with --allow-source-build, or choose another renderer.',
    );
  }
  return ['-PthreenativeCssUi=true'];
}

/**
 * Stage the built UI bundle so `WebViewAssetLoader` can serve it from an HTTPS-like origin.
 *
 * Fail closed both ways. A game whose renderer is `web` and whose UI never built would install,
 * launch and show a blank overlay over a working game — the most expensive shape of "it looks
 * broken and the logs are clean". And a game whose renderer is `native` must ship no UI bundle
 * at all, because acceptance criterion 5 is that opting out costs nothing.
 */
export function stageAndroidUi(ui, renderer, destination) {
  rmSync(destination, { force: true, recursive: true });
  if (renderer !== 'web' && renderer !== 'native-css') {
    if (ui) {
      throw new Error(
        `TN_UI_BUNDLE_UNEXPECTED: a UI bundle was staged for a game whose ui.renderer is '${renderer}'. ` +
          'The native renderer ships no WebView; remove the bundle or set ui.renderer to "web".',
      );
    }
    return [];
  }
  if (!ui || !existsSync(ui)) {
    throw new Error(
      `TN_UI_BUNDLE_MISSING: ui.renderer is "${renderer}" but no built UI was found at ${ui ?? '(not provided)'}. ` +
        'Build the UI before packaging, or set ui.renderer to "native".',
    );
  }
  if (!statSync(ui).isDirectory()) throw new Error(`TN_UI_BUNDLE_MISSING: not a directory: ${ui}`);
  const files = listFiles(ui);
  // `native-css` stages stylesheets (and the fonts and images beside them) that the runtime's CSS
  // engine paints; there is no page to load.
  if (renderer === 'native-css' && !files.some((file) => file.endsWith('.css'))) {
    throw new Error(
      `TN_UI_BUNDLE_MISSING: ui.renderer is "native-css" but ${ui} has no .css, which is what the native CSS engine paints.`,
    );
  }
  if (renderer === 'web' && !files.includes('index.html')) {
    throw new Error(
      `TN_UI_BUNDLE_MISSING: ${ui} has no index.html, which is the page the overlay loads.`,
    );
  }
  mkdirSync(destination, { recursive: true });
  for (const file of files) {
    const output = join(destination, file);
    mkdirSync(dirname(output), { recursive: true });
    cpSync(join(ui, file), output);
  }
  return files;
}

export const ANDROID_BUILD_MODES = ['debug', 'release'];
export const ANDROID_BUILD_FORMATS = ['apk', 'aab'];

/**
 * Resolve a requested mode/format pair into the Gradle task and the artifact it must produce.
 *
 * PRD-212 phase 2. `debug/apk` stays the default; a release APK and a release AAB are the two
 * explicit routes. An AAB is a Play submission shape, so `debug/aab` is refused before any work.
 */
export function androidBuildRequest(mode = 'debug', format = 'apk') {
  const resolvedMode = String(mode).toLowerCase();
  const resolvedFormat = String(format).toLowerCase();
  if (!ANDROID_BUILD_MODES.includes(resolvedMode)) {
    throw new Error(
      `TN_ANDROID_BUILD_MODE_INVALID: unknown mode '${mode}'; expected debug or release.`,
    );
  }
  if (!ANDROID_BUILD_FORMATS.includes(resolvedFormat)) {
    throw new Error(
      `TN_ANDROID_BUILD_FORMAT_INVALID: unknown format '${format}'; expected apk or aab.`,
    );
  }
  if (resolvedFormat === 'aab' && resolvedMode !== 'release') {
    throw new Error('TN_ANDROID_BUILD_UNSUPPORTED: --format aab requires --mode release.');
  }
  const task =
    resolvedFormat === 'aab'
      ? 'bundleRelease'
      : resolvedMode === 'release'
        ? 'assembleRelease'
        : 'assembleDebug';
  return { format: resolvedFormat, mode: resolvedMode, task };
}

/**
 * The ABI override the packager hands Gradle.
 *
 * A release is what Play installs on a phone, where only `arm64-v8a` runs, so release names that
 * one slice; the `x86_64` emulator dev lane lives in debug, which keeps Gradle's both-ABI default. An explicit
 * `-PthreenativeAbis` from the caller wins in both modes — no default overrides a named set.
 */
export function androidAbiGradleArgs(mode, extraGradleArgs = []) {
  const namesAbis = extraGradleArgs.some((arg) =>
    /^(?:-P|--project-prop=)threenativeAbis=/u.test(arg),
  );
  return mode === 'release' && !namesAbis ? ['-PthreenativeAbis=arm64-v8a'] : [];
}

/**
 * The ABI set a Gradle invocation builds: its last `-PthreenativeAbis`, or `undefined` for Gradle's
 * own default. The 16 KB census checks exactly this set, so a release (arm64-v8a) or an
 * emulator-only (x86_64) build is not failed for the slice it deliberately left out.
 */
export function androidRequestedAbis(gradleArgs) {
  const value = gradleArgs
    .map((arg) => /^(?:-P|--project-prop=)threenativeAbis=(.*)$/u.exec(arg)?.[1])
    .filter((entry) => entry !== undefined)
    .at(-1);
  return value
    ?.split(',')
    .map((abi) => abi.trim())
    .filter((abi) => abi.length > 0);
}

/**
 * The exact artifacts a resolved request may produce, in preference order.
 *
 * A release APK is signed, so only `app-release.apk` satisfies it; `app-release-unsigned.apk` is a
 * failed release and is named separately so the refusal can say so. A debug request is the only
 * route that accepts `app-debug.apk`, which is how a debug artifact stops being reported as a
 * release.
 */
export function androidArtifactCandidates(packageRoot, request) {
  const outputs = join(packageRoot, 'android', 'app', 'build', 'outputs');
  if (request.format === 'aab') return [join(outputs, 'bundle', 'release', 'app-release.aab')];
  if (request.mode === 'debug') return [join(outputs, 'apk', 'debug', 'app-debug.apk')];
  return [join(outputs, 'apk', 'release', 'app-release.apk')];
}

/** The unsigned release APK AGP emits when no signing config is applied. */
export function androidUnsignedReleaseApk(packageRoot) {
  return join(packageRoot, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
}

/**
 * Align the finished APK's uncompressed libraries to 16 KB, then re-sign it.
 *
 * AGP 8.2.2 stores shared libraries uncompressed but aligns them to 4 KB, so a device with 16 KB
 * pages cannot map them straight out of the archive — the census below caught exactly that on
 * `lib/arm64-v8a/libSDL3.so`, at offset 0x11d000. Alignment is an archive property, not a
 * compiler one, so no amount of correctly built `.so` files fixes it; the SDK's own `zipalign -P 16`
 * does, and `apksigner` puts the signature back afterwards because zipalign rewrites the archive.
 *
 * Fails closed: no zipalign, no apksigner, or a non-zero exit is an error, never a skip. An APK
 * that silently ships 4 KB-aligned libraries is the defect this whole path exists to prevent.
 */
function alignAndroidArchive(apkPath, options = {}) {
  const spawn = options.spawnSync ?? spawnSync;
  const zipalign =
    options.zipalign ??
    resolveZipalignCandidates().find(
      (candidate) => candidate === 'zipalign' || existsSync(candidate),
    );
  if (zipalign === undefined)
    throw new Error(
      'No zipalign found. Install Android SDK build-tools, or set TN_ZIPALIGN, so the packaged ' +
        'APK can be aligned to 16 KB.',
    );
  const aligned = `${apkPath}.aligned`;
  rmSync(aligned, { force: true });
  const alignResult = spawn(zipalign, ['-P', '16', '-f', '4', apkPath, aligned], {
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (alignResult.error) throw alignResult.error;
  if (alignResult.status !== 0)
    throw new Error(`${zipalign} exited with code ${alignResult.status ?? 'unknown'}.`);
  const apksigner = zipalign === 'zipalign' ? 'apksigner' : join(dirname(zipalign), 'apksigner');
  const keystore =
    options.keystore ?? join(process.env.HOME ?? homedir(), '.android', 'debug.keystore');
  // A fresh machine has no default debug key here even after Gradle's own debug build, so it is
  // created with AGP's documented debug parameters. A keystore the consumer named is never invented.
  if (options.keystore === undefined && !existsSync(keystore)) {
    mkdirSync(dirname(keystore), { recursive: true });
    const javaHome = process.env.JAVA_HOME;
    const keytool =
      javaHome && existsSync(join(javaHome, 'bin', 'keytool')) ? join(javaHome, 'bin', 'keytool') : 'keytool';
    const keyResult = spawn(
      keytool,
      ['-genkeypair', '-keystore', keystore, '-storepass', 'android', '-alias', 'androiddebugkey',
        '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
        '-dname', 'CN=Android Debug,O=Android,C=US'],
      { encoding: 'utf8', stdio: 'inherit' },
    );
    if (keyResult.error) throw keyResult.error;
    if (keyResult.status !== 0)
      throw new Error(`${keytool} could not create the debug keystore at ${keystore}.`);
  }
  if (!existsSync(keystore))
    throw new Error(
      `Cannot re-sign the aligned APK: no keystore at ${keystore}. Run a Gradle debug build once ` +
        'to create the debug keystore, or pass an explicit keystore.',
    );
  const signResult = spawn(
    apksigner,
    [
      'sign',
      '--ks',
      keystore,
      '--ks-pass',
      'env:TN_ANDROID_KEYSTORE_PASSWORD',
      '--ks-key-alias',
      options.keystoreAlias ?? 'androiddebugkey',
      '--key-pass',
      'env:TN_ANDROID_KEY_PASSWORD',
      aligned,
    ],
    {
      encoding: 'utf8',
      stdio: 'inherit',
      env: {
        ...process.env,
        TN_ANDROID_KEYSTORE_PASSWORD: options.keystorePassword ?? 'android',
        TN_ANDROID_KEY_PASSWORD: options.keyPassword ?? 'android',
      },
    },
  );
  if (signResult.error) throw signResult.error;
  if (signResult.status !== 0)
    throw new Error(`${apksigner} exited with code ${signResult.status ?? 'unknown'}.`);
  renameSync(aligned, apkPath);
  rmSync(`${aligned}.idsig`, { force: true });
  return zipalign;
}

export async function packageAndroid(
  bundle,
  requestedOutput,
  assets,
  orientation = undefined,
  config = undefined,
  options = {},
) {
  // Source identity must not depend on whether downloaded dependencies are already present.
  // Otherwise a partially provisioned checkout silently takes the consumer download path.
  const packageRoot = resolve(
    options.runtimeRoot ?? process.env.THREENATIVE_RUNTIME_SOURCE ?? runtimeRoot,
  );
  const { androidRoot } = androidPaths(packageRoot);
  // Validate the request before any asset work or Gradle: an unsupported mode/format pair must
  // fail with a named reason, not after a ten-minute build produces the wrong artifact.
  const request = androidBuildRequest(options.mode, options.format);
  const environment = options.environment ?? process.env;
  const signing =
    request.mode === 'release'
      ? androidReleaseSigning(environment, options.projectRoot)
      : undefined;
  if (signing !== undefined && !signing.complete) {
    // Never fall back to debug keys or an unsigned release. The names are safe to print; the
    // values never are.
    throw new Error(
      `TN_ANDROID_SIGNING_INCOMPLETE: release signing inputs are not set: ${signing.missing.join(', ')}. Export them from the game's build environment (see packages/runtime-native/README.md).`,
    );
  }
  const sourceCheckout = existsSync(join(packageRoot, 'CMakeLists.txt'));
  if (sourceCheckout && options.allowSourceBuild !== true) {
    throw new Error(
      `Android build resolved a source checkout at ${packageRoot} with no explicit opt-in. ` +
        'Pass --allow-source-build (or { allowSourceBuild: true }) for a maintainer build; ' +
        'consumer builds use the prebuilt path from a published install.',
    );
  }
  if (sourceCheckout && !existsSync(join(packageRoot, 'third_party', 'sdl3-android', `SDL3-${SDL3_ANDROID_VERSION}.aar`))) {
    throw new Error(
      `Android source checkout at ${packageRoot} is missing SDL3-${SDL3_ANDROID_VERSION}.aar. ` +
        'Provision the maintainer dependencies with node scripts/download-deps.mjs --android from the runtime checkout, then retry --allow-source-build.',
    );
  }
  const declared = configValue(config, orientation);
  orientationValue(declared.display.orientation);
  const cssUiGradleArgs = androidCssUiGradleArgs(declared.ui.renderer, sourceCheckout);
  const gradlew = join(androidRoot, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (!existsSync(gradlew)) throw new Error(`Android Gradle wrapper is missing: ${gradlew}`);
  if (!existsSync(bundle)) throw new Error(`Missing native bundle: ${bundle}`);
  const ensureWrapper =
    options.ensureGradleWrapper ??
    (() => ensureGradleWrapper({ output: join(androidRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar') }));
  await ensureWrapper();
  if (!sourceCheckout) {
    const preparePrebuilts =
      options.prepareAndroidPrebuilts ??
      (() => prepareAndroidPrebuilts({ outputRoot: join(packageRoot, 'android', 'prebuilt') }));
    try {
      await preparePrebuilts();
    } catch (error) {
      // Name the cause and the way out. The bare HTTP status told a person which URL failed and
      // nothing about why a published install can never satisfy it.
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n\nThis install has no runtime source checkout at ${packageRoot}, so it tried to download\nprebuilt Android artifacts from a GitHub release. Point the packager at a source\ncheckout of @threenative/runtime-native instead:\n\n  THREENATIVE_RUNTIME_SOURCE=/path/to/packages/runtime-native pnpm exec threenative build --target android --allow-source-build\n`,
        { cause: error },
      );
    }
  }
  const generatedAssets = join(
    packageRoot,
    'android',
    'app',
    'build',
    'generated',
    'threenative',
    'assets',
  );
  rmSync(generatedAssets, { force: true, recursive: true });
  const assetBundle = join(
    generatedAssets,
    'scripts',
    'main.js',
  );
  mkdirSync(dirname(assetBundle), { recursive: true });
  copyFileSync(bundle, assetBundle);
  stageAndroidAssets(assets, join(generatedAssets, 'game'), packageRoot);
  stageAndroidUi(options.ui, mobileUiRenderer(declared.ui.renderer), join(generatedAssets, 'ui'));
  const restoreFiles = installAndroidFiles(declared, packageRoot);
  try {
    // The subject of the build, after branding rewrote it: the submission floor is a property of
    // the project Gradle is about to compile, not of a constant the packager hopes still matches it.
    assertAndroidSubmissionTargetSdk(readFileSync(androidPaths(packageRoot).androidGradle, 'utf8'));
    const command = process.platform === 'win32' ? gradlew : 'sh';
    // Build variants the app already understands — `-PthreenativeJsEngine=v8`,
    // `-PthreenativeVsync=false` — are only reachable if something can pass them through. Without
    // this the properties exist in `build.gradle.kts` and no caller can ever set them.
    const extraGradleArgs = (process.env.THREENATIVE_GRADLE_ARGS ?? '')
      .split(' ')
      .filter((entry) => entry.length > 0);
    const baseArgs = [
      request.task,
      '-x',
      'buildAndroidFirstProofBundle',
      ...androidAbiGradleArgs(request.mode, extraGradleArgs),
      ...cssUiGradleArgs,
      ...extraGradleArgs,
    ];
    const args = process.platform === 'win32' ? baseArgs : [gradlew, ...baseArgs];
    const spawn = options.spawnSync ?? spawnSync;
    const result = spawn(command, args, {
      cwd: androidRoot,
      encoding: 'utf8',
      // The signing values reach Gradle only as project properties from the game's environment; the
      // keystore path was resolved against the consumer project above. Nothing here logs them.
      ...(signing === undefined
        ? {}
        : { env: androidSigningGradleEnvironment(signing, environment) }),
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Gradle exited with code ${result.status ?? 'unknown'}.`);
    const candidates = androidArtifactCandidates(packageRoot, request);
    const artifact = candidates.find((candidate) => existsSync(candidate));
    if (artifact === undefined) {
      if (
        request.mode === 'release' &&
        request.format === 'apk' &&
        existsSync(androidUnsignedReleaseApk(packageRoot))
      ) {
        throw new Error(
          'TN_ANDROID_RELEASE_UNSIGNED: Gradle produced an unsigned release APK, so signing did not apply. Check the four signing property values; a release never falls back to debug keys.',
        );
      }
      throw new Error(
        `TN_ANDROID_ARTIFACT_MISSING: Gradle ${request.task} produced no ${request.format} at ${candidates.join(' or ')}.`,
      );
    }
    const output = requestedOutput ? resolve(requestedOutput) : artifact;
    if (output !== artifact) {
      mkdirSync(dirname(output), { recursive: true });
      copyFileSync(artifact, output);
    }
    // APKs are aligned to 16 KB and censused on the artifact that ships. A release APK is re-signed
    // with the consumer's own key, never the debug keystore; an AAB is left to Gradle's signing.
    if (request.format === 'apk') {
      if (options.alignArchive !== false) {
        alignAndroidArchive(output, {
          ...(options.align ?? {}),
          ...(request.mode === 'release'
            ? {
                keystore: signing.keystore,
                keystoreAlias: signing.keyAlias,
                keystorePassword: signing.keystorePassword,
                keyPassword: signing.keyPassword,
              }
            : {}),
        });
      }
      // The 16 KB census runs on the artifact that ships, not on the build directory it came from.
      const abis = androidRequestedAbis(baseArgs);
      const census = assertAndroidArtifact16KbAlignment(output, {
        ...(abis === undefined ? {} : { abis }),
        ...(options.artifact16Kb ?? {}),
      });
      for (const library of census.libraries) {
        console.log(
          `  16 KB ok: ${library.entry} (${library.compression}, offset 0x${library.dataOffset.toString(16)}, ` +
            `LOAD ${library.alignments.map((value) => `0x${value.toString(16)}`).join(', ')})`,
        );
      }
      console.log(
        `ThreeNative Android APK: ${output} — ${census.libraries.length} native libraries 16 KB clean` +
          `${census.zipalign ? `, archive offsets confirmed by ${census.zipalign}` : ''}`,
      );
    }
    if (request.mode === 'release') {
      // Signature and non-debuggable proof come from the shipped artifact, after any alignment.
      verifyAndroidReleaseArtifact(output, request, options);
    }
    return output;
  } finally {
    restoreFiles();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const bundleIndex = process.argv.indexOf('--bundle');
  const outputIndex = process.argv.indexOf('--output');
  const assetsIndex = process.argv.indexOf('--assets');
  const orientationIndex = process.argv.indexOf('--orientation');
  const configIndex = process.argv.indexOf('--config');
  const uiIndex = process.argv.indexOf('--ui');
  const projectRootIndex = process.argv.indexOf('--project-root');
  const modeIndex = process.argv.indexOf('--mode');
  const formatIndex = process.argv.indexOf('--format');
  const allowSourceBuild = process.argv.includes('--allow-source-build');
  if (
    bundleIndex === -1 ||
    !process.argv[bundleIndex + 1] ||
    process.argv[bundleIndex + 1].startsWith('--')
  ) {
    console.error(
      'Usage: package-android.mjs --bundle FILE [--output FILE] [--assets DIR] [--ui DIR] [--orientation landscape|portrait|sensor] [--config FILE] [--mode debug|release] [--format apk|aab] [--project-root DIR] [--allow-source-build]',
    );
    process.exitCode = 1;
  } else if (
    assetsIndex !== -1 &&
    (!process.argv[assetsIndex + 1] || process.argv[assetsIndex + 1].startsWith('--'))
  ) {
    console.error('--assets requires a value.');
    process.exitCode = 1;
  } else if (
    outputIndex !== -1 &&
    (!process.argv[outputIndex + 1] || process.argv[outputIndex + 1].startsWith('--'))
  ) {
    console.error('--output requires a value.');
    process.exitCode = 1;
  } else if (
    orientationIndex !== -1 &&
    (!process.argv[orientationIndex + 1] || process.argv[orientationIndex + 1].startsWith('--'))
  ) {
    console.error('--orientation requires a value.');
    process.exitCode = 1;
  } else if (
    configIndex !== -1 &&
    (!process.argv[configIndex + 1] || process.argv[configIndex + 1].startsWith('--'))
  ) {
    console.error('--config requires a value.');
    process.exitCode = 1;
  } else if (uiIndex !== -1 && (!process.argv[uiIndex + 1] || process.argv[uiIndex + 1].startsWith('--'))) {
    console.error('--ui requires a value.');
    process.exitCode = 1;
  } else {
    try {
      const configPath = configIndex === -1 ? undefined : resolve(process.argv[configIndex + 1]);
      await packageAndroid(
        resolve(process.argv[bundleIndex + 1]),
        outputIndex === -1 ? undefined : process.argv[outputIndex + 1],
        assetsIndex === -1 ? undefined : resolve(process.argv[assetsIndex + 1]),
        orientationIndex === -1 ? undefined : process.argv[orientationIndex + 1],
        readAndroidConfig(configPath),
        {
          ...(uiIndex === -1 ? {} : { ui: resolve(process.argv[uiIndex + 1]) }),
          ...(modeIndex === -1 ? {} : { mode: process.argv[modeIndex + 1] }),
          ...(formatIndex === -1 ? {} : { format: process.argv[formatIndex + 1] }),
          // The consumer project root: a relative keystore path in the environment must resolve
          // against the game, not the engine's Android project the packager runs inside.
          ...(projectRootIndex === -1
            ? {}
            : { projectRoot: resolve(process.argv[projectRootIndex + 1]) }),
          // Maintainer route for source-checkout builds: the guard requires an
          // explicit opt-in, and this flag is its CLI spelling.
          ...(allowSourceBuild ? { allowSourceBuild: true } : {}),
        },
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
