import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,  } from 'node:fs';

import { dirname, join } from 'node:path';
import { afterEach, test } from 'vitest';

import {
  ANDROID_RELEASE_SIGNING_PROPERTIES,
  packageAndroid,
  androidBuildRequest,
  androidArtifactCandidates,
  androidReleaseSigning,
  androidUnsignedReleaseApk,
  verifyAndroidReleaseArtifact,
} from '../scripts/package-android.mjs';

const roots = [];
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAXUlEQVR4AaXBQRHEAAgEwclWHGDivIBckIWG3Hf/dD/frz9MdOK2BhedOHEkjsTRG524rcFFJ25rcOJIHImjd2tw0YnbGlx04sSROBJHb3TitgYXnbitwYkjcSSO/o/fGRJxtqYFAAAAAElFTkSuQmCC',
  'base64',
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('Android packaging allows AGP to strip native debug symbols', () => {
  const gradle = readFileSync(new URL('../android/app/build.gradle.kts', import.meta.url), 'utf8');
  assert.doesNotMatch(gradle, /keepDebugSymbols/u);
});

function copyRuntimeFile(runtime, relative) {
  const destination = join(runtime, relative);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(new URL(`../${relative}`, import.meta.url), destination);
}

function createFakeAndroidRuntime() {
  const runtime = makeTempDirSync('threenative-android-package-');
  roots.push(runtime);
  for (const relative of [
    'android/app/build.gradle.kts',
    'android/app/src/main/AndroidManifest.xml',
    'android/app/src/main/res/values/strings.xml',
    'android/app/src/main/res/values/themes.xml',
  ]) {
    copyRuntimeFile(runtime, relative);
  }
  const wrapper = join(runtime, 'android', 'gradlew');
  writeFileSync(
    wrapper,
    `#!/bin/sh
set -eu
task="\${1:-assembleDebug}"
case "$task" in
  assembleDebug) out="app/build/outputs/apk/debug/app-debug.apk" ;;
  assembleRelease)
    if [ -n "\${ORG_GRADLE_PROJECT_threenativeKeystore:-}" ]; then
      out="app/build/outputs/apk/release/app-release.apk"
      printf '%s' "$ORG_GRADLE_PROJECT_threenativeKeystore" > app/build/last-keystore.txt
    else
      out="app/build/outputs/apk/release/app-release-unsigned.apk"
    fi ;;
  bundleRelease) out="app/build/outputs/bundle/release/app-release.aab" ;;
  *) echo "unexpected Gradle task: $task" >&2; exit 2 ;;
esac
mkdir -p "$(dirname "$out")" app/build
printf '%s' "$task" > app/build/last-task.txt
jar --create --file "$out" \\
  -C app/src/main AndroidManifest.xml \\
  -C app/src/main/res values/strings.xml \\
  -C app/src/main/res values/themes.xml \\
  -C app/src/main/res values/branding.xml \\
  -C app build.gradle.kts \\
  -C app/build/generated/threenative/assets scripts/main.js
if [ -f app/src/main/res/mipmap-xxxhdpi/ic_launcher.png ]; then
  jar --update --file "$out" \\
    -C app/src/main/res mipmap-xxxhdpi/ic_launcher.png
fi
for resource in \\
  mipmap-anydpi-v26/ic_launcher.xml \\
  drawable-nodpi/ic_launcher_foreground.png \\
  drawable-nodpi/ic_launcher_monochrome.png \\
  drawable-nodpi/tn_boot_splash.png; do
  if [ -f "app/src/main/res/$resource" ]; then
    jar --update --file "$out" \\
      -C app/src/main/res "$resource"
  fi
done
if [ -f app/build/generated/threenative/assets/game/level.bin ]; then
  jar --update --file "$out" \\
    -C app/build/generated/threenative/assets game/level.bin
fi
# Native libraries for the ABIs the build asked for, exactly as build.gradle.kts resolves them:
# \`-PthreenativeAbis\` when given, both 64-bit ABIs otherwise. PRD-221's census refuses to credit an
# artifact that omits a requested ABI, so these stand in for them and give the gate something to read.
abis="arm64-v8a x86_64"
for arg in "$@"; do
  case "$arg" in -PthreenativeAbis=*) abis=$(printf '%s' "\${arg#*=}" | tr ',' ' ');; esac
done
for abi in $abis; do
  mkdir -p "app/build/fake-libs/lib/$abi"
  printf 'runtime' > "app/build/fake-libs/lib/$abi/libmystral-runtime.so"
  jar --update --file "$out" -C app/build/fake-libs "lib/$abi/libmystral-runtime.so"
done
`,

  );
  chmodSync(wrapper, 0o755);
  return runtime;
}

// A stand-in for the consumer's build environment: the four ORG_GRADLE_PROJECT_ properties the
// doctor predicts and the packager forwards. The keystore path is relative on purpose so a test can
// assert the packager resolves it against the consumer project, not the engine.
const SIGNING_ENV = Object.freeze({
  ORG_GRADLE_PROJECT_threenativeKeystore: 'release/my-release.keystore',
  ORG_GRADLE_PROJECT_threenativeKeystoreAlias: 'release',
  ORG_GRADLE_PROJECT_threenativeKeystorePassword: 'store-password-sentinel',
  ORG_GRADLE_PROJECT_threenativeKeyPassword: 'key-password-sentinel',
});

function releaseOptions(projectRoot, overrides = {}) {
  return {
    projectRoot,
    environment: { ...SIGNING_ENV },
    // The integration lane stands in for apksigner/jarsigner; the real verification path is a
    // separate test below. The seam is the only thing faked here.
    verifyReleaseSignature: () => ({ verified: true }),
    // The fake wrapper ships stand-in libraries, so the injected ELF reader answers the census;
    // the real 16 KB alignment path has its own PRD-221 tests below.
    alignArchive: false,
    artifact16Kb: { runObjdump: () => ALIGNED_LOAD, zipalign: false },
    ...overrides,
  };
}

function artifactEntry(apk, entry) {
  return execFileSync('unzip', ['-p', apk, entry]);
}

// A wrapper that ignores the requested task and always produces the debug artifact. It is the
// exact failure mode PRD-212 phase 2 forbids: a release request answered with app-debug.apk.
function createDebugOnlyAndroidRuntime() {
  const runtime = createFakeAndroidRuntime();
  const wrapper = join(runtime, 'android', 'gradlew');
  writeFileSync(
    wrapper,
    `#!/bin/sh
set -eu
out="app/build/outputs/apk/debug/app-debug.apk"
mkdir -p "$(dirname "$out")" app/build
jar --create --file "$out" -C app/src/main AndroidManifest.xml
`,
  );
  chmodSync(wrapper, 0o755);
  return runtime;
}

function runActivityMetadataProbe() {
  const root = makeTempDirSync('threenative-android-metadata-');
  roots.push(root);
  const sources = {
    'android/os/Bundle.java': `package android.os;

import java.util.HashMap;
import java.util.Map;

public final class Bundle {
  private final Map<String, Object> values = new HashMap<>();

  public void putBoolean(String key, boolean value) { values.put(key, value); }
  public void putInt(String key, int value) { values.put(key, value); }
  public void putString(String key, String value) { values.put(key, value); }
  public boolean getBoolean(String key, boolean fallback) {
    Object value = values.get(key);
    return value instanceof Boolean ? (Boolean) value : fallback;
  }
  public String getString(String key, String fallback) {
    Object value = values.get(key);
    return value instanceof String ? (String) value : fallback;
  }
  public int getInt(String key, int fallback) {
    Object value = values.get(key);
    return value instanceof Integer ? (Integer) value : fallback;
  }
  // The one-argument overload. applyOrientation calls it, and without it here this whole probe
  // failed to compile, so the orientation fix shipped with no compiling test at all.
  public String getString(String key) { return getString(key, null); }
}
`,
    'android/content/pm/ApplicationInfo.java': `package android.content.pm;

import android.os.Bundle;

public final class ApplicationInfo {
  public Bundle metaData;
}
`,
    'android/content/pm/PackageManager.java': `package android.content.pm;

import android.os.Bundle;

public final class PackageManager {
  public static final int GET_META_DATA = 0x00000080;
  private final Bundle metadata;
  public int lastFlags;

  public PackageManager(Bundle metadata) { this.metadata = metadata; }

  public ApplicationInfo getApplicationInfo(String packageName, int flags) throws NameNotFoundException {
    lastFlags = flags;
    ApplicationInfo info = new ApplicationInfo();
    if ((flags & GET_META_DATA) != 0) info.metaData = metadata;
    return info;
  }

  public static final class NameNotFoundException extends Exception {
    private static final long serialVersionUID = 1L;
  }
}
`,
    'android/content/Intent.java': `package android.content;

public final class Intent {
  private final java.util.Map<String, Object> extras = new java.util.HashMap<>();
  public String getStringExtra(String key) {
    Object value = extras.get(key);
    return value instanceof String ? (String) value : null;
  }
  public boolean getBooleanExtra(String key, boolean fallback) {
    Object value = extras.get(key);
    return value instanceof Boolean ? ((Boolean) value).booleanValue() : fallback;
  }
  public Intent putExtra(String key, String value) { extras.put(key, value); return this; }
  public Intent putExtra(String key, boolean value) { extras.put(key, Boolean.valueOf(value)); return this; }
}
`,
    'android/view/MotionEvent.java': `package android.view;

public class MotionEvent {}
`,
    'android/view/WindowManager.java': `package android.view;

public interface WindowManager {
  final class LayoutParams {
    public static final int FLAG_KEEP_SCREEN_ON = 0x00000080;
  }
}
`,
    'android/os/Build.java': `package android.os;

public final class Build {
  public static final class VERSION { public static int SDK_INT = 35; }
  public static final class VERSION_CODES { public static final int R = 30; }
}
`,
    // The packaged `assets/` tree, as AssetManager lists it: a directory lists its children, a
    // file lists nothing and opens.
    'android/content/res/AssetManager.java': `package android.content.res;

public final class AssetManager {
  public static final java.util.Map<String, String> files = new java.util.HashMap<>();
  public String[] list(String path) {
    java.util.TreeSet<String> children = new java.util.TreeSet<>();
    for (String file : files.keySet()) {
      if (file.startsWith(path + "/")) children.add(file.substring(path.length() + 1).split("/")[0]);
    }
    return children.toArray(new String[0]);
  }
  public java.io.InputStream open(String path) throws java.io.IOException {
    String body = files.get(path);
    if (body == null) throw new java.io.FileNotFoundException(path);
    return new java.io.ByteArrayInputStream(body.getBytes(java.nio.charset.StandardCharsets.UTF_8));
  }
}
`,
    'android/util/Log.java': `package android.util;

public final class Log {
  public static int i(String tag, String message) { return 0; }
  public static int w(String tag, String message) { return 0; }
}
`,
    'android/view/Choreographer.java': `package android.view;

// Minimal API-faithful stand-in for the platform vsync source. Production arms it on resume
// and removes the callback on pause/destroy; the probe only needs the calls to resolve.
public final class Choreographer {
  private static final Choreographer instance = new Choreographer();
  public static Choreographer getInstance() { return instance; }
  public void postFrameCallback(FrameCallback callback) {}
  public void removeFrameCallback(FrameCallback callback) {}
  public interface FrameCallback {
    public abstract void doFrame(long frameTimeNanos);
  }
}
`,
    'android/view/Surface.java': `package android.view;

public final class Surface {
  public static final int FRAME_RATE_COMPATIBILITY_DEFAULT = 0;
  public float requestedFrameRate = -1.0f;
  public int requestCount = 0;
  public boolean isValid() { return true; }
  public void setFrameRate(float frameRate, int compatibility) {
    requestedFrameRate = frameRate;
    requestCount += 1;
  }
}
`,
    'android/view/SurfaceHolder.java': `package android.view;

public interface SurfaceHolder {
  Surface getSurface();
  void addCallback(Callback callback);
  interface Callback {
    void surfaceCreated(SurfaceHolder holder);
    void surfaceChanged(SurfaceHolder holder, int format, int width, int height);
    void surfaceDestroyed(SurfaceHolder holder);
  }
}
`,
    'android/view/Window.java': `package android.view;

public final class Window {
  private int flags;
  public void addFlags(int value) { flags |= value; }
  public void clearFlags(int value) { flags &= ~value; }
  public boolean hasFlag(int value) { return (flags & value) != 0; }
  public View getDecorView() { return new View(); }
}
`,
    'android/graphics/Insets.java': `package android.graphics;

public final class Insets {
  public final int top;
  public final int right;
  public final int bottom;
  public final int left;
  public Insets(int top, int right, int bottom, int left) {
    this.top = top;
    this.right = right;
    this.bottom = bottom;
    this.left = left;
  }
}
`,
    'android/view/View.java': `package android.view;

public class View {
  public WindowInsets getRootWindowInsets() { return null; }
}
`,
    'android/view/WindowInsets.java': `package android.view;

import android.graphics.Insets;

public final class WindowInsets {
  public Insets getInsets(int types) { return new Insets(0, 0, 0, 0); }
  public static final class Type {
    public static int systemBars() { return 1; }
    public static int displayCutout() { return 2; }
  }
}
`,
    'android/content/pm/ActivityInfo.java': `package android.content.pm;

public final class ActivityInfo {
  public static final int SCREEN_ORIENTATION_UNSPECIFIED = -1;
  public static final int SCREEN_ORIENTATION_SENSOR_LANDSCAPE = 6;
  public static final int SCREEN_ORIENTATION_SENSOR_PORTRAIT = 7;
  public static final int SCREEN_ORIENTATION_FULL_USER = 13;
}
`,
    'org/libsdl/app/SDLSurface.java': `package org.libsdl.app;

import android.view.Surface;
import android.view.SurfaceHolder;

public final class SDLSurface {
  private final Surface surface = new Surface();
  private final SurfaceHolder holder = new SurfaceHolder() {
    public Surface getSurface() { return surface; }
    public void addCallback(SurfaceHolder.Callback callback) { callback.surfaceCreated(this); }
  };
  public SurfaceHolder getHolder() { return holder; }
}
`,
    'org/libsdl/app/SDLActivity.java': `package org.libsdl.app;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.Window;
import java.io.File;

public class SDLActivity {
  protected static SDLSurface mSurface = new SDLSurface();
  private PackageManager packageManager = new PackageManager(null);
  private final Intent intent = new Intent();
  private final Window window = new Window();

  protected void onCreate(Bundle state) {}
  protected void onResume() {}
  protected void onPause() {}
  protected void onDestroy() {}
  public void onTrimMemory(int level) {}
  protected String[] getLibraries() { return new String[0]; }
  protected String getMainFunction() { return ""; }
  protected String[] getArguments() { return new String[0]; }
  public PackageManager getPackageManager() { return packageManager; }
  public String getPackageName() { return "com.example.game"; }
  public Intent getIntent() { return intent; }
  public Window getWindow() { return window; }
  private int externalFilesDirCalls;
  public File getExternalFilesDir(String type) {
    externalFilesDirCalls += 1;
    File directory = new File(System.getProperty("java.io.tmpdir"), "tn-external-files");
    directory.mkdirs();
    return directory;
  }
  public int externalFilesDirCallCount() { return externalFilesDirCalls; }
  public File getFilesDir() { return new File(System.getProperty("java.io.tmpdir")); }
  private final android.content.res.AssetManager assets = new android.content.res.AssetManager();
  public android.content.res.AssetManager getAssets() { return assets; }
  public int requestedOrientation = Integer.MIN_VALUE;
  public void setRequestedOrientation(int orientation) { requestedOrientation = orientation; }
  public void setOrientationBis(int width, int height, boolean resizable, String hint) {
    requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_USER;
  }
  public void configureMetadata(Bundle metadata) { packageManager = new PackageManager(metadata); }
  public void runOnUiThread(Runnable action) { action.run(); }
  public boolean dispatchTouchEvent(android.view.MotionEvent event) { return false; }
  public float requestedFrameRate() { return mSurface.getHolder().getSurface().requestedFrameRate; }
  public int frameRateRequestCount() { return mSurface.getHolder().getSurface().requestCount; }
}
`,
    'com/threenative/runtime/TnUiOverlay.java': `package com.threenative.runtime;

// A stand-in for the real transparent WebView. The probe cares only about whether the activity
// decides to attach one, which is what ui.renderer controls and what acceptance criterion 5 of
// PRD-217 turns on: a game that did not opt in ships no overlay and no extra process.
public final class TnUiOverlay {
  public static int attachCount = 0;
  public static String lastPosted = null;

  public static TnUiOverlay attach(Object activity) {
    attachCount += 1;
    return new TnUiOverlay();
  }

  public static TnUiOverlay attachInFrame(Object activity) {
    attachCount += 1;
    return new TnUiOverlay();
  }

  public boolean isInFrame() { return false; }
  public boolean dispatchTouchEvent(android.view.MotionEvent event) { return false; }
  public void releaseProducer() {}
  public void postToPage(String frame) { lastPosted = frame; }
}
`,
    'com/threenative/runtime/MetadataProbe.java': `package com.threenative.runtime;

import android.os.Bundle;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.view.WindowManager;

public final class MetadataProbe {
  private static final class ProbeActivity extends MystralActivity {
    public void create() { onCreate(null); }
    public void resume() { onResume(); }
    public String[] arguments() { return getArguments(); }
    public void applySdlOrientation() { setOrientationBis(1080, 2400, true, ""); }
  }

  private static void require(boolean value, String message) {
    if (!value) throw new AssertionError(message);
  }

  public static void main(String[] args) {
    Bundle metadata = new Bundle();
    metadata.putBoolean("TN_KEEP_SCREEN_ON", true);
    metadata.putString("TN_WINDOW_TITLE", "Fox \\\"Deluxe\\\"");
    metadata.putBoolean("TN_FULLSCREEN", false);
    metadata.putString("TN_ORIENTATION", "landscape");
    metadata.putInt("TN_MAX_FPS", 120);

    ProbeActivity activity = new ProbeActivity();
    activity.configureMetadata(metadata);
    activity.create();
    java.io.File mailbox = new java.io.File(
      System.getProperty("java.io.tmpdir"), "tn-mailbox-" + System.nanoTime());
    activity.getIntent().putExtra("TN_PLAYTEST_MAILBOX_ROOT", mailbox.getAbsolutePath());
    String[] arguments = activity.arguments();

    require((activity.getPackageManager().lastFlags & PackageManager.GET_META_DATA) != 0,
      "activity must request PackageManager.GET_META_DATA");
    require(activity.getWindow().hasFlag(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON),
      "keep-screen-on metadata was not applied");
    require("Fox \\\"Deluxe\\\"".equals(arguments[3]),
      "window title metadata was not retrieved");
    require("false".equals(arguments[4]), "fullscreen metadata was not retrieved");
    require("120".equals(arguments[6]), "max-fps metadata was not forwarded to native");
    require(mailbox.isDirectory(), "an explicit playtest mailbox must exist before native startup");
    require(mailbox.getAbsolutePath().equals(arguments[2]),
      "the created playtest mailbox must be forwarded to native");
    require(activity.externalFilesDirCallCount() == 1,
      "Android must initialize app external storage even when the runner supplies a mailbox path");
    require(activity.requestedFrameRate() == 120.0f,
      "max-fps metadata was not requested from the Android surface");
    int requestsBeforeResume = activity.frameRateRequestCount();
    activity.resume();
    require(activity.frameRateRequestCount() > requestsBeforeResume,
      "the Android surface frame-rate request was not reapplied on resume");
    // Android 16+ overrides a manifest orientation for apps it treats as non-adaptive, which is
    // how a landscape-declared game launched portrait on a Pixel 8. Re-requesting it in onCreate
    // is the belt to the manifest property's braces; this asserts that it happens.
    require(activity.requestedOrientation == ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE,
      "declared landscape orientation was not re-requested in onCreate");
    activity.applySdlOrientation();
    require(activity.requestedOrientation == ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE,
      "SDL window creation overwrote the declared landscape orientation");

    // PRD-217 acceptance criterion 5: a game that did not ask for the web UI renderer ships no
    // overlay at all. The metadata above never mentions TN_UI_RENDERER.
    require(TnUiOverlay.attachCount == 0,
      "a game with no ui.renderer must ship no overlay");

    metadata.putString("TN_UI_RENDERER", "web");
    ProbeActivity web = new ProbeActivity();
    web.configureMetadata(metadata);
    web.create();
    require(TnUiOverlay.attachCount == 1, "ui.renderer web must attach the overlay");
    web.postUiOverlayMessage("{\\"type\\":\\"tn:state\\"}");
    require("{\\"type\\":\\"tn:state\\"}".equals(TnUiOverlay.lastPosted),
      "the runtime's bridge frame must reach the overlay");

    // Anything the packager did not write is the native renderer, not a guess at the expensive one.
    metadata.putString("TN_UI_RENDERER", "webview");
    ProbeActivity typo = new ProbeActivity();
    typo.configureMetadata(metadata);
    typo.create();
    require(TnUiOverlay.attachCount == 1, "an unrecognised ui.renderer must not attach an overlay");
    require("".equals(typo.arguments()[7]), "only native-css hands the runtime a CSS UI root");

    // native-css: no WebView, and the packaged ui/ tree extracted to a real directory whose path
    // reaches the runtime, replacing whatever a previous launch left there.
    android.content.res.AssetManager.files.put("ui/index-abc.css", ".hud{color:red}");
    android.content.res.AssetManager.files.put("ui/fonts/Noto.ttf", "font");
    java.io.File stale = new java.io.File(System.getProperty("java.io.tmpdir"), "tn-ui-css/old.css");
    stale.getParentFile().mkdirs();
    try { new java.io.FileOutputStream(stale).close(); } catch (java.io.IOException e) { throw new AssertionError(e); }
    metadata.putString("TN_UI_RENDERER", "native-css");
    ProbeActivity css = new ProbeActivity();
    css.configureMetadata(metadata);
    css.create();
    require(TnUiOverlay.attachCount == 1, "ui.renderer native-css must not attach a WebView overlay");
    java.io.File root = new java.io.File(css.arguments()[7]);
    require(root.getName().equals("tn-ui-css"), "the CSS UI root must be forwarded to native");
    require(new java.io.File(root, "index-abc.css").length() == 15, "the stylesheet was not extracted");
    require(new java.io.File(root, "fonts/Noto.ttf").isFile(), "a nested font was not extracted");
    require(!stale.exists(), "a previous launch's stylesheet must not survive extraction");
  }
}
`,
    // This probe JVM ships no native library, so only the JNI boundary is stubbed: the two
    // frame-arming native declarations on the onResume/onPause/onDestroy path become no-op
    // Java bodies in this compiled fixture. Every line of production Java — onResume,
    // arm/disarm, requestPreferredFrameRate — compiles and runs unmodified, so the
    // frame-rate-reapply-after-resume assertions below exercise the real resume path.
    // Match counts fail closed: a rename or another native on this path breaks loudly here
    // instead of silently testing a stale copy. JNI-backed behavior has its own real-APK proof.
    'MystralActivity.java': (() => {
      const production = readFileSync(
        new URL('../android/app/src/main/java/com/mystral/engine/MystralActivity.java', import.meta.url),
        'utf8',
      );
      const boundaries = [
        'private static native void nativeOnPresentationFramesStarted();',
        'private static native void nativeOnPresentationFramesStopped();',
      ];
      for (const declaration of boundaries) {
        assert.equal(
          production.split(declaration).length - 1,
          1,
          `expected exactly one JNI boundary declaration: ${declaration}`,
        );
      }
      const fixture = production
        .replace(boundaries[0], 'private static void nativeOnPresentationFramesStarted() {}')
        .replace(boundaries[1], 'private static void nativeOnPresentationFramesStopped() {}');
      assert.doesNotMatch(fixture, /native void nativeOnPresentationFrames(Started|Stopped)\(\)/u);
      for (const retained of [
        'private static native void nativeOnPresentationFrame(long frameTimeNanos);',
        'private static native void nativeOnTrimMemory(int level);',
      ]) {
        assert.equal(
          fixture.split(retained).length - 1,
          1,
          `only the resume-path boundary is stubbed, JNI stays native: ${retained}`,
        );
      }
      return fixture;
    })(),
  };
  const sourcePaths = [];
  for (const [relative, source] of Object.entries(sources)) {
    const file = join(root, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
    sourcePaths.push(file);
  }
  const classes = join(root, 'classes');
  mkdirSync(classes);
  execFileSync('javac', ['-d', classes, ...sourcePaths], { stdio: 'pipe' });
  execFileSync('java', ['-cp', classes, 'com.threenative.runtime.MetadataProbe'], {
    stdio: 'pipe',
  });
}

test('Android activity retrieves config metadata through PackageManager', () => {
  runActivityMetadataProbe();
});

test('real Android packaging emits configured and no-config artifacts through the default path', async () => {
  const root = makeTempDirSync('threenative-android-package-project-');
  roots.push(root);
  const runtime = createFakeAndroidRuntime();
  const bundle = join(root, 'game.js');
  const icon = join(root, 'icon.png');
  const foreground = join(root, 'foreground.png');
  const monochrome = join(root, 'monochrome.png');
  const splash = join(root, 'launch.png');
  const assets = join(root, 'public');
  const configuredOutput = join(root, 'dist', 'fox.apk');
  writeFileSync(bundle, 'export default { start() {} };\n');
  writeFileSync(icon, VALID_PNG);
  writeFileSync(foreground, VALID_PNG);
  writeFileSync(monochrome, VALID_PNG);
  writeFileSync(splash, VALID_PNG);
  mkdirSync(assets);
  writeFileSync(join(assets, 'level.bin'), 'level');

  const packageOptions = {
    runtimeRoot: runtime,
    ensureGradleWrapper: async () => undefined,
    prepareAndroidPrebuilts: async () => undefined,
    // The fixture's stand-in libraries are not compiled objects, so the ELF reader is injected.
    // Everything else in the 16 KB census — the archive parse, the per-ABI roll call — runs real.
    artifact16Kb: { runObjdump: () => ALIGNED_LOAD, zipalign: false },
    // The fixture archive is assembled by hand at the offsets the census reads, so the real
    // zipalign/apksigner pass has nothing to do here. It has its own tests below.
    alignArchive: false,
  };
  const config = {
    app: {
      id: 'com.studio.foxgame',
      name: 'Fox',
      version: '1.2.3',
      build: 7,
      icon,
      icons: { android: { foreground, monochrome, background: '#111827' } },
    },
    bootSplash: { backgroundColor: '#0d1b2a', image: splash },
    display: { orientation: 'portrait', fullscreen: false, keepScreenOn: true, maxFps: 120 },
    window: { title: 'Fox Desktop', width: 1024, height: 576, resizable: false },
  };

  await packageAndroid(bundle, configuredOutput, assets, undefined, config, packageOptions);
  const manifest = artifactEntry(configuredOutput, 'AndroidManifest.xml').toString('utf8');
  const strings = artifactEntry(configuredOutput, 'values/strings.xml').toString('utf8');
  const theme = artifactEntry(configuredOutput, 'values/themes.xml').toString('utf8');
  const gradle = artifactEntry(configuredOutput, 'build.gradle.kts').toString('utf8');

  assert.match(manifest, /android:screenOrientation="portrait"/u);
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/u);
  const application = /<application\b[\s\S]*?<\/application>/u.exec(manifest)?.[0];
  const activity = /<activity\b[\s\S]*?<\/activity>/u.exec(manifest)?.[0];
  assert.ok(application);
  assert.ok(activity);
  assert.match(application, /TN_KEEP_SCREEN_ON" android:value="true"/u);
  assert.match(application, /TN_FULLSCREEN" android:value="false"/u);
  assert.match(application, /TN_MAX_FPS" android:value="120"/u);
  assert.match(application, /TN_WINDOW_TITLE" android:value="@string\/window_title"/u);
  assert.doesNotMatch(activity, /TN_KEEP_SCREEN_ON|TN_FULLSCREEN|TN_WINDOW_TITLE/u);
  assert.match(strings, /<string name="app_name">Fox<\/string>/u);
  assert.match(strings, /<string name="window_title">Fox Desktop<\/string>/u);
  assert.match(theme, /android:windowFullscreen">false</u);
  assert.match(theme, /android:windowSplashScreenBackground">@color\/tn_boot_splash_background</u);
  assert.match(theme, /android:windowSplashScreenAnimatedIcon">@drawable\/ic_launcher_foreground</u);
  assert.match(theme, /android:windowSplashScreenBrandingImage">@drawable\/tn_boot_splash</u);
  assert.match(gradle, /applicationId = "com\.studio\.foxgame"/u);
  assert.match(gradle, /versionCode = 7/u);
  assert.match(gradle, /versionName = "1\.2\.3"/u);
  assert.deepEqual(artifactEntry(configuredOutput, 'mipmap-xxxhdpi/ic_launcher.png'), VALID_PNG);
  assert.deepEqual(artifactEntry(configuredOutput, 'drawable-nodpi/ic_launcher_foreground.png'), VALID_PNG);
  assert.deepEqual(artifactEntry(configuredOutput, 'drawable-nodpi/ic_launcher_monochrome.png'), VALID_PNG);
  assert.deepEqual(artifactEntry(configuredOutput, 'drawable-nodpi/tn_boot_splash.png'), VALID_PNG);
  assert.match(
    artifactEntry(configuredOutput, 'mipmap-anydpi-v26/ic_launcher.xml').toString('utf8'),
    /android:drawable="@drawable\/ic_launcher_monochrome"/u,
  );
  assert.match(
    artifactEntry(configuredOutput, 'values/branding.xml').toString('utf8'),
    /tn_boot_splash_background.*#0d1b2a/u,
  );
  assert.equal(artifactEntry(configuredOutput, 'scripts/main.js').toString('utf8'), readFileSync(bundle, 'utf8'));
  assert.equal(artifactEntry(configuredOutput, 'game/level.bin').toString('utf8'), 'level');

  const defaultOutput = await packageAndroid(
    bundle,
    undefined,
    undefined,
    undefined,
    undefined,
    packageOptions,
  );
  const defaultManifest = artifactEntry(defaultOutput, 'AndroidManifest.xml').toString('utf8');
  const defaultStrings = artifactEntry(defaultOutput, 'values/strings.xml').toString('utf8');
  assert.match(defaultManifest, /android:screenOrientation="landscape"/u);
  assert.match(defaultManifest, /TN_KEEP_SCREEN_ON" android:value="false"/u);
  assert.match(defaultManifest, /TN_FULLSCREEN" android:value="true"/u);
  assert.match(defaultManifest, /TN_MAX_FPS" android:value="60"/u);
  assert.match(defaultStrings, /<string name="app_name">ThreeNative<\/string>/u);
});

/**
 * PRD-375 phase 1 — the brand on the artifact a player installs.
 *
 * The configured test above proves the debug path. `release` is the mode the artifact a store
 * hands out is built in, and it is the one the whole phase is about: if the game's icon or splash
 * only survives `assembleDebug`, the release still wears the engine's face. Branding staging is
 * mode-independent (`installAndroidFiles` runs before the Gradle invocation), so this exercises the
 * release task, the release artifact and the release-only verification the packager runs on it.
 * Signature and 16 KB alignment have their own real tests below; here the signature verifier is the
 * injected seam and alignment is off, because the fixture archive is assembled by hand.
 */
test('a release-mode artifact preserves the configured icon, splash and identity resources', async () => {
  const root = makeTempDirSync('threenative-android-release-brand-');
  roots.push(root);
  const runtime = createFakeAndroidRuntime();
  const bundle = join(root, 'game.js');
  const foreground = join(root, 'foreground.png');
  const monochrome = join(root, 'monochrome.png');
  const splash = join(root, 'launch.png');
  const output = join(root, 'dist', 'fox.apk');
  // Distinct bytes per variant: if the packager copied one asset into another's slot, comparing
  // each packaged entry against its own declared source is what catches it.
  writeFileSync(bundle, 'export default { start() {} };\n');
  writeFileSync(foreground, Buffer.concat([VALID_PNG, Buffer.from('foreground')]));
  writeFileSync(monochrome, Buffer.concat([VALID_PNG, Buffer.from('monochrome')]));
  writeFileSync(splash, Buffer.concat([VALID_PNG, Buffer.from('splash')]));

  const config = {
    app: {
      id: 'com.studio.foxgame',
      name: 'Fox',
      version: '1.2.3',
      build: 7,
      icons: { android: { foreground, monochrome, background: '#111827' } },
    },
    bootSplash: { backgroundColor: '#0d1b2a', image: splash },
  };

  await packageAndroid(bundle, output, undefined, undefined, config, {
    runtimeRoot: runtime,
    ensureGradleWrapper: async () => undefined,
    prepareAndroidPrebuilts: async () => undefined,
    mode: 'release',
    format: 'apk',
    ...releaseOptions('/consumer/fox'),
  });

  const manifest = artifactEntry(output, 'AndroidManifest.xml').toString('utf8');
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/u);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher"/u);
  assert.match(
    artifactEntry(output, 'values/strings.xml').toString('utf8'),
    /<string name="app_name">Fox<\/string>/u,
  );
  const gradle = artifactEntry(output, 'build.gradle.kts').toString('utf8');
  assert.match(gradle, /applicationId = "com\.studio\.foxgame"/u);
  assert.match(gradle, /versionCode = 7/u);
  assert.match(gradle, /versionName = "1\.2\.3"/u);
  const branding = artifactEntry(output, 'values/branding.xml').toString('utf8');
  assert.match(branding, /tn_icon_background.*#111827/u);
  assert.match(branding, /tn_boot_splash_background.*#0d1b2a/u);
  assert.deepEqual(artifactEntry(output, 'mipmap-xxxhdpi/ic_launcher.png'), readFileSync(foreground));
  assert.deepEqual(
    artifactEntry(output, 'drawable-nodpi/ic_launcher_foreground.png'),
    readFileSync(foreground),
  );
  assert.deepEqual(
    artifactEntry(output, 'drawable-nodpi/ic_launcher_monochrome.png'),
    readFileSync(monochrome),
  );
  assert.deepEqual(artifactEntry(output, 'drawable-nodpi/tn_boot_splash.png'), readFileSync(splash));
  assert.match(
    artifactEntry(output, 'mipmap-anydpi-v26/ic_launcher.xml').toString('utf8'),
    /android:drawable="@drawable\/ic_launcher_foreground"/u,
  );
});

test('an Android App Bundle release carries the same configured brand resources', async () => {
  const root = makeTempDirSync('threenative-android-release-brand-aab-');
  roots.push(root);
  const runtime = createFakeAndroidRuntime();
  const bundle = join(root, 'game.js');
  const foreground = join(root, 'foreground.png');
  const monochrome = join(root, 'monochrome.png');
  const splash = join(root, 'launch.png');
  const output = join(root, 'dist', 'fox.aab');
  writeFileSync(bundle, 'export default { start() {} };\n');
  writeFileSync(foreground, Buffer.concat([VALID_PNG, Buffer.from('foreground')]));
  writeFileSync(monochrome, Buffer.concat([VALID_PNG, Buffer.from('monochrome')]));
  writeFileSync(splash, Buffer.concat([VALID_PNG, Buffer.from('splash')]));
  const config = {
    app: {
      id: 'com.studio.foxgame',
      name: 'Fox',
      icons: { android: { foreground, monochrome } },
    },
    bootSplash: { image: splash },
  };

  await packageAndroid(bundle, output, undefined, undefined, config, {
    runtimeRoot: runtime,
    ensureGradleWrapper: async () => undefined,
    prepareAndroidPrebuilts: async () => undefined,
    mode: 'release',
    format: 'aab',
    ...releaseOptions('/consumer/fox'),
  });

  assert.match(
    artifactEntry(output, 'AndroidManifest.xml').toString('utf8'),
    /android:icon="@mipmap\/ic_launcher"/u,
  );
  assert.deepEqual(
    artifactEntry(output, 'drawable-nodpi/ic_launcher_monochrome.png'),
    readFileSync(monochrome),
  );
  assert.deepEqual(artifactEntry(output, 'drawable-nodpi/tn_boot_splash.png'), readFileSync(splash));
});

test('a declared Android icon variant whose file is missing is refused before Gradle runs', async () => {
  const root = makeTempDirSync('threenative-android-release-brand-missing-');
  roots.push(root);
  const runtime = createFakeAndroidRuntime();
  const bundle = join(root, 'game.js');
  const foreground = join(root, 'foreground.png');
  writeFileSync(bundle, 'export default { start() {} };\n');
  writeFileSync(foreground, VALID_PNG);

  // A consumer bypassing config validation (a stale resolved config, a hand-written call) must not
  // get a release that silently drops the monochrome variant back to the engine default.
  const config = {
    app: {
      id: 'com.studio.foxgame',
      name: 'Fox',
      icons: { android: { foreground, monochrome: join(root, 'missing-monochrome.png') } },
    },
  };

  await assert.rejects(
    packageAndroid(bundle, undefined, undefined, undefined, config, {
      runtimeRoot: runtime,
      ensureGradleWrapper: async () => undefined,
      prepareAndroidPrebuilts: async () => undefined,
      mode: 'release',
      format: 'apk',
      ...releaseOptions('/consumer/fox'),
    }),
    /TN_CONFIG_BRAND_ANDROID_MONOCHROME_MISSING/u,
  );
  // The refusal is before Gradle, so no ten-minute build produced the wrong icon.
  assert.equal(existsSync(join(runtime, 'android', 'app', 'build', 'last-task.txt')), false);
});

/**
 * The consumer route out of a 404 that no consumer can fix.
 *
 * `install-prebuilt.mjs` builds a GitHub release URL from the package version. That release was
 * never published for 0.2.0, and the repository is private, so **every** published install fetching
 * it gets `HTTP 404` — the documented `pnpm build:android` cannot work for anybody. The mechanism
 * to sidestep it already existed as `options.runtimeRoot`; it was simply unreachable from a shell.
 */
test('THREENATIVE_RUNTIME_SOURCE points the packager at a runtime source checkout', async () => {
  const root = makeTempDirSync('threenative-android-runtime-source-');
  roots.push(root);
  const runtime = createFakeAndroidRuntime();
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');

  const previous = process.env.THREENATIVE_RUNTIME_SOURCE;
  process.env.THREENATIVE_RUNTIME_SOURCE = runtime;
  try {
    // No `runtimeRoot` option at all: the env var alone has to be what selects this checkout.
    // If it is ignored, the packager looks at the real installed package and this rejects.
    const output = await packageAndroid(bundle, undefined, undefined, undefined, undefined, {
      ensureGradleWrapper: async () => undefined,
      prepareAndroidPrebuilts: async () => undefined,
      artifact16Kb: { runObjdump: () => ALIGNED_LOAD, zipalign: false },
    // The fixture archive is assembled by hand at the offsets the census reads, so the real
    // zipalign/apksigner pass has nothing to do here. It has its own tests below.
    alignArchive: false,
    });
    assert.ok(output.startsWith(runtime), `expected an artifact under ${runtime}, got ${output}`);
  } finally {
    if (previous === undefined) delete process.env.THREENATIVE_RUNTIME_SOURCE;
    else process.env.THREENATIVE_RUNTIME_SOURCE = previous;
  }
});

test('a failed prebuilt download names the cause and the environment variable that fixes it', async () => {
  const root = makeTempDirSync('threenative-android-prebuilt-404-');
  roots.push(root);
  const runtime = createFakeAndroidRuntime();
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');

  await assert.rejects(
    packageAndroid(bundle, undefined, undefined, undefined, undefined, {
      runtimeRoot: runtime,
      ensureGradleWrapper: async () => undefined,
      prepareAndroidPrebuilts: async () => {
        throw new Error("Prebuilt release manifest fetch failed for 'android-arm64-v8a-sdl3': HTTP 404.");
      },
    }),
    (error) => {
      // The original status is kept: it is still the fact that a fetch failed.
      assert.match(error.message, /HTTP 404/u);
      // And it now says why a published install can never satisfy it, and what to do instead.
      assert.match(error.message, /THREENATIVE_RUNTIME_SOURCE=/u);
      return true;
    },
  );
});

// PRD-212 phase 2: an explicit mode/format selects the Gradle task and the artifact it must
// produce. Every artifact below is built by the fake wrapper from the real shipped Gradle project.
test('an explicit release/aab request runs bundleRelease and returns the bundle', async () => {
  const root = makeTempDirSync('threenative-android-aab-');
  roots.push(root);
  const runtime = createFakeAndroidRuntime();
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');
  const output = join(root, 'dist', 'fox.aab');

  const artifact = await packageAndroid(bundle, output, undefined, undefined, undefined, {
    runtimeRoot: runtime,
    ensureGradleWrapper: async () => undefined,
    prepareAndroidPrebuilts: async () => undefined,
    mode: 'release',
    format: 'aab',
    ...releaseOptions('/consumer/fox'),
  });

  assert.equal(artifact, output);
  assert.equal(readFileSync(join(runtime, 'android', 'app', 'build', 'last-task.txt'), 'utf8'), 'bundleRelease');
  assert.match(artifactEntry(output, 'AndroidManifest.xml').toString('utf8'), /<manifest\b/u);
});

test('an explicit release/apk request runs assembleRelease and returns the release APK', async () => {
  const root = makeTempDirSync('threenative-android-release-apk-');
  roots.push(root);
  const runtime = createFakeAndroidRuntime();
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');

  const artifact = await packageAndroid(bundle, undefined, undefined, undefined, undefined, {
    runtimeRoot: runtime,
    ensureGradleWrapper: async () => undefined,
    prepareAndroidPrebuilts: async () => undefined,
    mode: 'release',
    format: 'apk',
    ...releaseOptions('/consumer/fox'),
  });

  assert.match(artifact, /app-release\.apk$/u);
  assert.equal(readFileSync(join(runtime, 'android', 'app', 'build', 'last-task.txt'), 'utf8'), 'assembleRelease');
  // The relative keystore from the environment was resolved against the consumer project, and the
  // password sentinels are never written into the artifact.
  assert.equal(
    readFileSync(join(runtime, 'android', 'app', 'build', 'last-keystore.txt'), 'utf8'),
    '/consumer/fox/release/my-release.keystore',
  );
  assert.doesNotMatch(
    artifactEntry(artifact, 'build.gradle.kts').toString('utf8'),
    /store-password-sentinel|key-password-sentinel/u,
  );
});

test('the omitted flags keep the debug APK path', async () => {
  const root = makeTempDirSync('threenative-android-default-');
  roots.push(root);
  const runtime = createFakeAndroidRuntime();
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');

  const artifact = await packageAndroid(bundle, undefined, undefined, undefined, undefined, {
    runtimeRoot: runtime,
    ensureGradleWrapper: async () => undefined,
    prepareAndroidPrebuilts: async () => undefined,
    alignArchive: false,
    artifact16Kb: { runObjdump: () => ALIGNED_LOAD, zipalign: false },
  });

  assert.match(artifact, /app-debug\.apk$/u);
  assert.equal(readFileSync(join(runtime, 'android', 'app', 'build', 'last-task.txt'), 'utf8'), 'assembleDebug');
});

test('a release request never accepts a debug APK returned in its place', async () => {
  const root = makeTempDirSync('threenative-android-wrong-artifact-');
  roots.push(root);
  const runtime = createDebugOnlyAndroidRuntime();
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');

  await assert.rejects(
    packageAndroid(bundle, undefined, undefined, undefined, undefined, {
      runtimeRoot: runtime,
      ensureGradleWrapper: async () => undefined,
      prepareAndroidPrebuilts: async () => undefined,
      mode: 'release',
      format: 'apk',
      ...releaseOptions('/consumer/fox'),
    }),
    /TN_ANDROID_ARTIFACT_MISSING/u,
  );
});

// A wrapper that ignores the signing environment and emits the unsigned release artifact, the shape
// AGP produces when a signing config does not apply. A release must refuse it by name.
function createUnsignedReleaseRuntime() {
  const runtime = createFakeAndroidRuntime();
  const wrapper = join(runtime, 'android', 'gradlew');
  writeFileSync(
    wrapper,
    `#!/bin/sh
set -eu
out="app/build/outputs/apk/release/app-release-unsigned.apk"
mkdir -p "$(dirname "$out")" app/build
jar --create --file "$out" -C app/src/main AndroidManifest.xml
`,
  );
  chmodSync(wrapper, 0o755);
  return runtime;
}

test('release signing inputs are required and named when incomplete', () => {
  const partial = androidReleaseSigning({
    ORG_GRADLE_PROJECT_threenativeKeystore: 'release.keystore',
  });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missing, [
    'ORG_GRADLE_PROJECT_threenativeKeystoreAlias',
    'ORG_GRADLE_PROJECT_threenativeKeystorePassword',
    'ORG_GRADLE_PROJECT_threenativeKeyPassword',
  ]);
});

test('a release request with no signing environment is refused before Gradle', async () => {
  const root = makeTempDirSync('threenative-android-no-signing-');
  roots.push(root);
  const runtime = createFakeAndroidRuntime();
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');

  await assert.rejects(
    packageAndroid(bundle, undefined, undefined, undefined, undefined, {
      runtimeRoot: runtime,
      ensureGradleWrapper: async () => undefined,
      prepareAndroidPrebuilts: async () => undefined,
      mode: 'release',
      format: 'apk',
    }),
    /TN_ANDROID_SIGNING_INCOMPLETE/u,
  );
});

test('an unsigned release artifact is refused, never reported as a release', async () => {
  const root = makeTempDirSync('threenative-android-unsigned-');
  roots.push(root);
  const runtime = createUnsignedReleaseRuntime();
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');

  await assert.rejects(
    packageAndroid(bundle, undefined, undefined, undefined, undefined, {
      runtimeRoot: runtime,
      ensureGradleWrapper: async () => undefined,
      prepareAndroidPrebuilts: async () => undefined,
      mode: 'release',
      format: 'apk',
      ...releaseOptions('/consumer/fox'),
    }),
    /TN_ANDROID_RELEASE_UNSIGNED/u,
  );
});

test('a release whose verifier rejects it is refused and the unsigned path is named', async () => {
  const root = makeTempDirSync('threenative-android-tampered-');
  roots.push(root);
  const runtime = createFakeAndroidRuntime();
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');

  await assert.rejects(
    packageAndroid(bundle, undefined, undefined, undefined, undefined, {
      runtimeRoot: runtime,
      ensureGradleWrapper: async () => undefined,
      prepareAndroidPrebuilts: async () => undefined,
      mode: 'release',
      format: 'apk',
      ...releaseOptions('/consumer/fox', {
        verifyReleaseSignature: () => {
          throw new Error('TN_ANDROID_SIGNATURE_INVALID: tampered');
        },
      }),
    }),
    /TN_ANDROID_SIGNATURE_INVALID/u,
  );
});

test('a missing signature verifier is a blocker, not a silent pass', () => {
  assert.throws(
    () =>
      verifyAndroidReleaseArtifact('/tmp/candidate.apk', androidBuildRequest('release', 'apk'), {
        findBuildTool: () => undefined,
      }),
    /TN_ANDROID_SIGNATURE_TOOL_MISSING/u,
  );
});

test('the unsigned release APK path is the AGP default the packager refuses', () => {
  assert.match(
    androidUnsignedReleaseApk('/runtime'),
    /android\/app\/build\/outputs\/apk\/release\/app-release-unsigned\.apk$/u,
  );
});

test('unsupported mode/format pairs fail before any work', () => {
  assert.throws(() => androidBuildRequest('debug', 'aab'), /TN_ANDROID_BUILD_UNSUPPORTED/u);
  assert.throws(() => androidBuildRequest('staging', 'apk'), /TN_ANDROID_BUILD_MODE_INVALID/u);
  assert.throws(() => androidBuildRequest('release', 'zip'), /TN_ANDROID_BUILD_FORMAT_INVALID/u);
  assert.equal(androidBuildRequest('release', 'aab').task, 'bundleRelease');
  assert.equal(androidBuildRequest('release', 'apk').task, 'assembleRelease');
  assert.deepEqual(
    androidArtifactCandidates('/runtime', androidBuildRequest('debug', 'apk')),
    ['/runtime/android/app/build/outputs/apk/debug/app-debug.apk'],
  );
});

// PRD-212 phase 3: release signing is the developer's, never a debug fallback, and the final
// artifact must prove it is signed and not debuggable.
test('release signing inputs must be complete, and the error names only the missing properties', async () => {
  const root = makeTempDirSync('threenative-android-signing-incomplete-');
  roots.push(root);
  const runtime = createFakeAndroidRuntime();
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');

  await assert.rejects(
    packageAndroid(bundle, undefined, undefined, undefined, undefined, {
      runtimeRoot: runtime,
      ensureGradleWrapper: async () => undefined,
      prepareAndroidPrebuilts: async () => undefined,
      mode: 'release',
      format: 'apk',
      projectRoot: '/consumer/fox',
      environment: { ORG_GRADLE_PROJECT_threenativeKeystore: 'release/my.keystore' },
    }),
    (error) => {
      assert.match(error.message, /TN_ANDROID_SIGNING_INCOMPLETE/u);
      assert.match(error.message, /ORG_GRADLE_PROJECT_threenativeKeystoreAlias/u);
      assert.match(error.message, /ORG_GRADLE_PROJECT_threenativeKeystorePassword/u);
      assert.match(error.message, /ORG_GRADLE_PROJECT_threenativeKeyPassword/u);
      // The one value that was supplied is not echoed back.
      assert.doesNotMatch(error.message, /release\/my\.keystore/u);
      return true;
    },
  );
});

test('a release that Gradle leaves unsigned is refused, never shipped as signed', async () => {
  const root = makeTempDirSync('threenative-android-release-unsigned-');
  roots.push(root);
  const runtime = createFakeAndroidRuntime();
  // A wrapper that ignores the signing environment, which is what a misconfigured Gradle project
  // looks like from the packager's side.
  const wrapper = join(runtime, 'android', 'gradlew');
  writeFileSync(
    wrapper,
    `#!/bin/sh
set -eu
out="app/build/outputs/apk/release/app-release-unsigned.apk"
mkdir -p "$(dirname "$out")" app/build
jar --create --file "$out" -C app/src/main AndroidManifest.xml
`,
  );
  chmodSync(wrapper, 0o755);
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');

  await assert.rejects(
    packageAndroid(bundle, undefined, undefined, undefined, undefined, {
      runtimeRoot: runtime,
      ensureGradleWrapper: async () => undefined,
      prepareAndroidPrebuilts: async () => undefined,
      mode: 'release',
      format: 'apk',
      ...releaseOptions('/consumer/fox'),
    }),
    /TN_ANDROID_RELEASE_UNSIGNED/u,
  );
});

test('a release whose signature verifier rejects is refused', async () => {
  const root = makeTempDirSync('threenative-android-signature-tamper-');
  roots.push(root);
  const runtime = createFakeAndroidRuntime();
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');

  await assert.rejects(
    packageAndroid(bundle, undefined, undefined, undefined, undefined, {
      runtimeRoot: runtime,
      ensureGradleWrapper: async () => undefined,
      prepareAndroidPrebuilts: async () => undefined,
      mode: 'release',
      format: 'apk',
      ...releaseOptions('/consumer/fox', {
        verifyReleaseSignature: () => {
          throw new Error('TN_ANDROID_SIGNATURE_INVALID: apksigner rejected the tampered artifact');
        },
      }),
    }),
    /TN_ANDROID_SIGNATURE_INVALID/u,
  );
});

test('a missing signature verifier is a blocker, not a silent pass', () => {
  assert.throws(
    () =>
      verifyAndroidReleaseArtifact('/tmp/candidate.apk', androidBuildRequest('release', 'apk'), {
        findBuildTool: () => undefined,
        environment: {},
      }),
    /TN_ANDROID_SIGNATURE_TOOL_MISSING/u,
  );
});

test('the signing properties the packager consumes are the four doctor predicts', () => {
  const expected = [
    'threenativeKeystore',
    'threenativeKeystoreAlias',
    'threenativeKeystorePassword',
    'threenativeKeyPassword',
  ];
  assert.deepEqual(Object.values(ANDROID_RELEASE_SIGNING_PROPERTIES).sort(), [...expected].sort());
  const signing = androidReleaseSigning(
    {
      ORG_GRADLE_PROJECT_threenativeKeystore: 'k.jks',
      ORG_GRADLE_PROJECT_threenativeKeystoreAlias: 'a',
    },
    '/consumer',
  );
  assert.equal(signing.complete, false);
  assert.match(signing.missing.join(' '), /ORG_GRADLE_PROJECT_threenativeKeystorePassword/u);
  assert.equal(signing.keystore, '/consumer/k.jks');
});

// The real (non-injected) verification path: the signature tool and aapt are stubbed, but the
// function's own parsing, refusal and fail-closed behaviour is what runs.
function fakeToolRun(responses) {
  return (executable, args) => {
    const key = `${executable} ${args[0]}`;
    const match = Object.keys(responses).find((name) => executable.includes(name));
    if (match === undefined) return { status: 1, stdout: '', stderr: `unexpected tool ${executable}` };
    return { status: 0, stdout: '', stderr: '', ...responses[match] };
  };
}

test('the real signature path rejects an artifact the signer refuses', () => {
  assert.throws(
    () =>
      verifyAndroidReleaseArtifact('/tmp/candidate.apk', androidBuildRequest('release', 'apk'), {
        findBuildTool: (name) => `/sdk/${name}`,
        spawnSync: fakeToolRun({ apksigner: { status: 1, stderr: 'no signature found' } }),
      }),
    /TN_ANDROID_SIGNATURE_INVALID/u,
  );
});

test('AAB verification accepts self-signed certificates but rejects unsigned entries and expired certificates', () => {
  const root = makeTempDirSync('threenative-aab-signature-');
  roots.push(root);
  const archive = join(root, 'candidate.aab');
  const payload = join(root, 'payload.txt');
  const keystore = join(root, 'qualification.p12');
  const env = { ...process.env, TN_TEST_STORE_PASSWORD: 'fixture-password' };
  const run = (tool, args) => execFileSync(tool, args, { env, stdio: 'pipe' });
  const verify = () => verifyAndroidReleaseArtifact(archive, androidBuildRequest('release', 'aab'), {
    findBuildTool: (name) => name,
  });
  writeFileSync(payload, 'signed payload');
  run('jar', ['--create', '--file', archive, '-C', root, 'payload.txt']);
  assert.throws(verify, /TN_ANDROID_SIGNATURE_INVALID/u);
  run('keytool', ['-genkeypair', '-keystore', keystore, '-alias', 'qualification',
    '-storepass:env', 'TN_TEST_STORE_PASSWORD', '-keypass:env', 'TN_TEST_STORE_PASSWORD',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '3650', '-dname', 'CN=Local qualification']);
  run('jarsigner', ['-keystore', keystore, '-storepass:env', 'TN_TEST_STORE_PASSWORD', archive, 'qualification']);
  assert.doesNotThrow(verify);
  writeFileSync(join(root, 'unsigned.txt'), 'unsigned addition');
  run('jar', ['--update', '--file', archive, '-C', root, 'unsigned.txt']);
  assert.throws(verify, /TN_ANDROID_SIGNATURE_INVALID/u);
  run('keytool', ['-genkeypair', '-keystore', keystore, '-alias', 'expired',
    '-storepass:env', 'TN_TEST_STORE_PASSWORD', '-keypass:env', 'TN_TEST_STORE_PASSWORD',
    '-keyalg', 'RSA', '-keysize', '2048', '-startdate', '2000/01/01', '-validity', '1', '-dname', 'CN=Expired qualification']);
  run('jar', ['--create', '--file', archive, '-C', root, 'payload.txt']);
  run('jarsigner', ['-keystore', keystore, '-storepass:env', 'TN_TEST_STORE_PASSWORD', archive, 'expired']);
  assert.throws(verify, /TN_ANDROID_SIGNATURE_INVALID/u);
});

test('the real path needs aapt and fails closed without it', () => {
  assert.throws(
    () =>
      verifyAndroidReleaseArtifact('/tmp/candidate.apk', androidBuildRequest('release', 'apk'), {
        findBuildTool: (name) => (name === 'aapt' ? undefined : `/sdk/${name}`),
        spawnSync: fakeToolRun({ apksigner: { status: 0, stdout: 'Verified' } }),
      }),
    /TN_ANDROID_BADGING_TOOL_MISSING/u,
  );
});

test('the packaged APK targetSdk is checked on the artifact, not the Gradle source', () => {
  const badging = (target) => ({
    status: 0,
    stdout: `package: name='com.x' versionCode='1'\ntargetSdkVersion:'${target}'\n`,
  });
  assert.throws(
    () =>
      verifyAndroidReleaseArtifact('/tmp/candidate.apk', androidBuildRequest('release', 'apk'), {
        findBuildTool: (name) => `/sdk/${name}`,
        spawnSync: (executable, args) =>
          executable.endsWith('apksigner')
            ? { status: 0, stdout: 'Verified' }
            : badging(35),
      }),
    /TN_ANDROID_TARGET_SDK_BELOW_SUBMISSION/u,
  );
  const ok = verifyAndroidReleaseArtifact(
    '/tmp/candidate.apk',
    androidBuildRequest('release', 'apk'),
    {
      findBuildTool: (name) => `/sdk/${name}`,
      spawnSync: (executable) =>
        executable.endsWith('apksigner') ? { status: 0, stdout: 'Verified' } : badging(36),
    },
  );
  assert.equal(ok.targetSdk, 36);
});

test('a debuggable packaged APK is refused', () => {
  assert.throws(
    () =>
      verifyAndroidReleaseArtifact('/tmp/candidate.apk', androidBuildRequest('release', 'apk'), {
        findBuildTool: (name) => `/sdk/${name}`,
        spawnSync: (executable) =>
          executable.endsWith('apksigner')
            ? { status: 0, stdout: 'Verified' }
            : { status: 0, stdout: "targetSdkVersion:'36'\napplication-debuggable\n" },
      }),
    /TN_ANDROID_ARTIFACT_DEBUGGABLE/u,
  );
});

/**
 * PRD-221 phase 2 — the final-artifact 16 KB census.
 *
 * These build archives byte by byte rather than shelling out to `jar` or `zip`, because the number
 * under test is the *data offset of each entry inside the archive*, and no packaging tool lets a
 * caller choose it. The ELF reader is injected; producing genuinely 16 KB-aligned arm64 objects
 * would make the unit lane depend on an NDK toolchain it does not have.
 */
import { crc32, deflateRawSync } from 'node:zlib';

import {
  ANDROID_16KB_ALIGNMENT,
  androidArtifactLibraryCensus,
  assertAndroidArtifact16KbAlignment,
  readZipEntries,
} from '../scripts/check-android-16kb-alignment.mjs';

const ALIGNED_LOAD = [
  '    LOAD off 0x0 vaddr 0x0 paddr 0x0 align 2**14',
  '    LOAD off 0x4000 vaddr 0x4000 paddr 0x4000 align 2**14',
].join('\n');
const FOUR_KB_LOAD = [
  '    LOAD off 0x0 vaddr 0x0 paddr 0x0 align 2**12',
  '    LOAD off 0x1000 vaddr 0x1000 paddr 0x1000 align 2**12',
].join('\n');

/** Minimal ZIP writer with explicit control over storage and entry alignment. */
function writeArchive(path, entries) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data);
    const stored = entry.stored === true;
    const payload = stored ? raw : deflateRawSync(raw);
    let extra = 0;
    if (stored && entry.align) {
      const start = offset + 30 + name.length;
      extra = (entry.align - (start % entry.align)) % entry.align;
    }
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(stored ? 0 : 8, 8);
    header.writeUInt32LE(crc32(raw), 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(extra, 28);
    const block = Buffer.concat([header, name, Buffer.alloc(extra), payload]);
    locals.push(block);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(Buffer.concat([central, name]));
    offset += block.length;
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...locals, centralBytes, end]));
  return path;
}

function archiveRoot() {
  const root = makeTempDirSync('threenative-android-census-');
  roots.push(root);
  return root;
}

/** A complete, compliant artifact: both ABIs, stored and 16 KB aligned inside the archive. */
function compliantEntries() {
  return [
    { data: 'manifest', name: 'AndroidManifest.xml' },
    { align: ANDROID_16KB_ALIGNMENT, data: 'arm64-runtime', name: 'lib/arm64-v8a/libmystral-runtime.so', stored: true },
    { align: ANDROID_16KB_ALIGNMENT, data: 'arm64-v8', name: 'lib/arm64-v8a/libv8android.so', stored: true },
    { align: ANDROID_16KB_ALIGNMENT, data: 'x86-runtime', name: 'lib/x86_64/libmystral-runtime.so', stored: true },
    { align: ANDROID_16KB_ALIGNMENT, data: 'x86-v8', name: 'lib/x86_64/libv8android.so', stored: true },
  ];
}

const alignedOptions = { runObjdump: () => ALIGNED_LOAD, zipalign: false };

test('the artifact census inspects every packaged library on every ABI, not a build directory', () => {
  const apk = writeArchive(join(archiveRoot(), 'app.apk'), compliantEntries());
  const inspected = [];
  const census = assertAndroidArtifact16KbAlignment(apk, {
    runObjdump: (path) => {
      inspected.push(path);
      return ALIGNED_LOAD;
    },
    zipalign: false,
  });
  // Four libraries, four objdump invocations: nothing was credited without being read.
  assert.equal(inspected.length, 4);
  assert.deepEqual(
    census.libraries.map((library) => library.entry).sort(),
    [
      'lib/arm64-v8a/libmystral-runtime.so',
      'lib/arm64-v8a/libv8android.so',
      'lib/x86_64/libmystral-runtime.so',
      'lib/x86_64/libv8android.so',
    ],
  );
  for (const library of census.libraries) {
    assert.equal(library.compression, 'stored');
    assert.equal(library.dataOffset % ANDROID_16KB_ALIGNMENT, 0);
  }
});

test('the artifact census rejects a 4 KB library packaged beside compliant ones', () => {
  const apk = writeArchive(join(archiveRoot(), 'app.apk'), compliantEntries());
  assert.throws(
    () =>
      assertAndroidArtifact16KbAlignment(apk, {
        // One transitive dependency out of four, which is exactly how this ships unnoticed.
        runObjdump: (path) => (path.includes('libv8android') ? FOUR_KB_LOAD : ALIGNED_LOAD),
        zipalign: false,
      }),
    (error) => error.code === 'ANDROID_16KB_MISALIGNED' && /0x1000/u.test(error.message),
  );
});

test('the artifact census rejects an uncompressed library stored at a 4 KB archive offset', () => {
  // The ELF is perfect here. Only the archive offset is wrong, and a 16 KB device still cannot
  // map it — which is why an ELF-only check is not final-app proof.
  const entries = compliantEntries().map((entry) =>
    entry.name === 'lib/x86_64/libv8android.so' ? { ...entry, align: 4096 } : entry,
  );
  const apk = writeArchive(join(archiveRoot(), 'app.apk'), entries);
  const { entries: written } = readZipEntries(apk);
  const offending = written.find((entry) => entry.name === 'lib/x86_64/libv8android.so');
  assert.notEqual(offending.dataOffset % ANDROID_16KB_ALIGNMENT, 0);
  assert.throws(
    () => assertAndroidArtifact16KbAlignment(apk, alignedOptions),
    (error) =>
      error.code === 'ANDROID_16KB_MISALIGNED' &&
      /uncompressed library stored at archive offset/u.test(error.message),
  );
});

test('the artifact census rejects an omitted ABI and an artifact with no libraries at all', () => {
  const omitted = writeArchive(
    join(archiveRoot(), 'omitted.apk'),
    compliantEntries().filter((entry) => !entry.name.startsWith('lib/x86_64/')),
  );
  assert.throws(
    () => assertAndroidArtifact16KbAlignment(omitted, alignedOptions),
    /no native libraries for x86_64/u,
  );

  const empty = writeArchive(join(archiveRoot(), 'empty.apk'), [{ data: 'manifest', name: 'AndroidManifest.xml' }]);
  assert.throws(
    () => assertAndroidArtifact16KbAlignment(empty, alignedOptions),
    /no native libraries for arm64-v8a, x86_64/u,
  );
});

test('the artifact census refuses an undeclared ABI rather than ignoring it', () => {
  const apk = writeArchive(join(archiveRoot(), 'app.apk'), [
    ...compliantEntries(),
    { align: ANDROID_16KB_ALIGNMENT, data: 'armv7', name: 'lib/armeabi-v7a/libv8android.so', stored: true },
  ]);
  assert.throws(
    () => assertAndroidArtifact16KbAlignment(apk, alignedOptions),
    /undeclared ABIs.*armeabi-v7a/u,
  );
});

test('the census is a function of the census input, not of an empty list silently passing', () => {
  assert.throws(
    () => androidArtifactLibraryCensus([], { artifactPath: 'app.apk' }),
    /no native libraries for arm64-v8a, x86_64/u,
  );
  assert.throws(
    () => assertAndroidArtifact16KbAlignment(join(archiveRoot(), 'absent.apk'), alignedOptions),
    /cannot read/u,
  );
});

test('the packager runs the census on the artifact it produced and refuses a misaligned one', async () => {
  const root = archiveRoot();
  const runtime = createFakeAndroidRuntime();
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');
  const apkPath = join(runtime, 'android/app/build/outputs/apk/debug/app-debug.apk');
  const build = (entries) => ({
    ensureGradleWrapper: async () => undefined,
    prepareAndroidPrebuilts: async () => undefined,
    runtimeRoot: runtime,
    spawnSync: () => {
      mkdirSync(dirname(apkPath), { recursive: true });
      writeArchive(apkPath, entries);
      return { status: 0, stdout: '' };
    },
  });

  // No injected alignment options at all: the packager's own default gate has to be the real one.
  // A stored library at a 4 KB offset needs no objdump to reject, so this exercises the shipped
  // path end to end on any host.
  await assert.rejects(
    packageAndroid(bundle, join(root, 'bad.apk'), undefined, undefined, undefined, {
      ...build(compliantEntries().map((entry) =>
        entry.name === 'lib/arm64-v8a/libv8android.so' ? { ...entry, align: 4096 } : entry,
      )),
      alignArchive: false,
    }),
    (error) => error.code === 'ANDROID_16KB_MISALIGNED',
  );

  const output = await packageAndroid(bundle, join(root, 'good.apk'), undefined, undefined, undefined, {
    ...build(compliantEntries()),
    alignArchive: false,
    artifact16Kb: alignedOptions,
  });
  assert.equal(output, join(root, 'good.apk'));
});

test('the packager aligns the finished APK to 16 KB before censusing it, and fails closed', async () => {
  const root = makeTempDirSync('threenative-android-align-');
  roots.push(root);
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');
  const runtime = createFakeAndroidRuntime();
  const apkPath = join(runtime, 'android/app/build/outputs/apk/debug/app-debug.apk');
  const build = (entries) => ({
    runtimeRoot: runtime,
    ensureGradleWrapper: async () => undefined,
    prepareAndroidPrebuilts: async () => undefined,
    spawnSync: () => {
      mkdirSync(dirname(apkPath), { recursive: true });
      writeArchive(apkPath, entries);
      return { status: 0, stdout: '' };
    },
  });

  // AGP 8.2.2 stores shared libraries uncompressed on 4 KB boundaries, so alignment is the
  // packager's job, not the compiler's. The aligner is a real shell-out; here it is injected, and
  // what the test pins is that it runs, that it runs *before* the census, and that its arguments
  // ask for 16 KB.
  const calls = [];
  const spawnAlign = (command, args, options) => {
    calls.push({ args, command, options });
    if (String(command).endsWith('zipalign'))
      writeArchive(`${String(args[args.length - 1])}`, compliantEntries());
    return { status: 0, stdout: '' };
  };
  const keystore = join(root, 'debug.keystore');
  writeFileSync(keystore, 'not a real keystore, only its presence is checked here');
  await packageAndroid(bundle, apkPath, undefined, undefined, undefined, {
    ...build(
      compliantEntries().map((entry) =>
        entry.name === 'lib/arm64-v8a/libv8android.so' ? { ...entry, align: 4096 } : entry,
      ),
    ),
    align: { keystore, keystorePassword: 'store-fixture-secret', keyPassword: 'key-fixture-secret', spawnSync: spawnAlign, zipalign: '/fake/build-tools/zipalign' },
    artifact16Kb: { runObjdump: () => ALIGNED_LOAD, zipalign: false },
  });
  assert.deepEqual(
    calls.map(({ command }) => command),
    ['/fake/build-tools/zipalign', '/fake/build-tools/apksigner'],
  );
  assert.deepEqual(calls[0]?.args.slice(0, 4), ['-P', '16', '-f', '4']);
  assert.ok(calls[1].args.includes('env:TN_ANDROID_KEYSTORE_PASSWORD'));
  assert.ok(calls[1].args.includes('env:TN_ANDROID_KEY_PASSWORD'));
  assert.ok(calls[1].args.every((value) => !String(value).includes('fixture-secret')));
  assert.equal(calls[1].options.env.TN_ANDROID_KEYSTORE_PASSWORD, 'store-fixture-secret');
  assert.equal(calls[1].options.env.TN_ANDROID_KEY_PASSWORD, 'key-fixture-secret');
  // The census passed on an archive Gradle wrote misaligned, which is only possible because the
  // aligner replaced it first.

  // Fail closed: a non-zero zipalign is an error, never a skip that ships a 4 KB archive.
  await assert.rejects(
    packageAndroid(bundle, join(root, 'refused.apk'), undefined, undefined, undefined, {
      ...build(compliantEntries()),
      align: {
        keystore,
        spawnSync: () => ({ status: 1, stdout: '' }),
        zipalign: '/fake/build-tools/zipalign',
      },
      artifact16Kb: { runObjdump: () => ALIGNED_LOAD, zipalign: false },
    }),
    /zipalign exited with code 1/u,
  );
});

// A fresh machine has no ~/.android/debug.keystore: AGP 8 does not always leave one where the
// re-sign step looks. The default debug key is created on demand, exactly as AGP would; a keystore
// the consumer named is never invented.
test('the packager creates the missing default debug keystore before re-signing, and never an explicit one', async () => {
  const root = makeTempDirSync('threenative-android-keystore-');
  roots.push(root);
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');
  const runtime = createFakeAndroidRuntime();
  const apkPath = join(runtime, 'android/app/build/outputs/apk/debug/app-debug.apk');
  const build = {
    runtimeRoot: runtime,
    ensureGradleWrapper: async () => undefined,
    prepareAndroidPrebuilts: async () => undefined,
    spawnSync: () => {
      mkdirSync(dirname(apkPath), { recursive: true });
      writeArchive(apkPath, compliantEntries());
      return { status: 0, stdout: '' };
    },
  };
  const calls = [];
  const spawnAlign = (command, args) => {
    calls.push({ args, command });
    if (String(command).endsWith('zipalign')) writeArchive(String(args[args.length - 1]), compliantEntries());
    if (String(command).endsWith('keytool')) writeFileSync(String(args[args.indexOf('-keystore') + 1]), 'key');
    return { status: 0, stdout: '' };
  };
  const home = join(root, 'home');
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await packageAndroid(bundle, apkPath, undefined, undefined, undefined, {
      ...build,
      align: { spawnSync: spawnAlign, zipalign: '/fake/build-tools/zipalign' },
      artifact16Kb: { runObjdump: () => ALIGNED_LOAD, zipalign: false },
    });
  } finally {
    process.env.HOME = previousHome;
  }
  const keystore = join(home, '.android', 'debug.keystore');
  const keytool = calls.find(({ command }) => String(command).endsWith('keytool'));
  assert.ok(keytool, 'keytool was not run for the missing default debug keystore');
  assert.equal(keytool.args[keytool.args.indexOf('-keystore') + 1], keystore);
  assert.equal(keytool.args[keytool.args.indexOf('-alias') + 1], 'androiddebugkey');
  assert.ok(existsSync(keystore));
  const signer = calls.find(({ command }) => String(command).endsWith('apksigner'));
  assert.equal(signer.args[signer.args.indexOf('--ks') + 1], keystore);

  await assert.rejects(
    packageAndroid(bundle, join(root, 'named.apk'), undefined, undefined, undefined, {
      ...build,
      align: { keystore: join(root, 'absent.jks'), spawnSync: spawnAlign, zipalign: '/fake/build-tools/zipalign' },
      artifact16Kb: { runObjdump: () => ALIGNED_LOAD, zipalign: false },
    }),
    /no keystore at .*absent\.jks/u,
  );
});
