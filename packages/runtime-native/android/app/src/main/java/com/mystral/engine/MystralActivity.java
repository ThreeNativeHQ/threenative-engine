package com.threenative.runtime;

import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.Choreographer;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import org.libsdl.app.SDLActivity;

/**
 * MystralActivity - Main entry point for Mystral Native on Android.
 *
 * Extends SDLActivity which handles:
 * - Native library loading
 * - Surface creation (ANativeWindow)
 * - Input events (touch, keyboard, gamepad)
 * - Lifecycle management (pause/resume)
 *
 * The SDL3 Android backend provides the native window to wgpu-native
 * for Vulkan surface creation.
 */
public class MystralActivity extends SDLActivity {

    private static final String LOG_TAG = "MystralRuntime";

    /** The transparent WebView the UI renders into, or null when this game ships no overlay. */
    private TnUiOverlay uiOverlay;

    /**
     * The display-frame signal the native presentation cap aligns to (PRD-399). The native side
     * sleeps to a deadline that has no relation to the display, so a state submitted just after
     * the WebView's frame waits an extra vsync. Each doFrame hands the runtime that display
     * frame's timestamp; the runtime paces to the measured cadence rather than an assumed 60 Hz.
     *
     * The callback is armed on resume and removed on pause, and it re-posts itself only while
     * armed, so it can never outlive the activity that would receive its native call.
     */
    private static native void nativeOnPresentationFrame(long frameTimeNanos);

    private static native void nativeOnPresentationFramesStarted();

    private static native void nativeOnPresentationFramesStopped();

    private boolean presentationFramesArmed = false;

    private final Choreographer.FrameCallback presentationFrame =
        new Choreographer.FrameCallback() {
            @Override
            public void doFrame(long frameTimeNanos) {
                nativeOnPresentationFrame(frameTimeNanos);
                if (presentationFramesArmed) {
                    Choreographer.getInstance().postFrameCallback(this);
                }
            }
        };

    /** Reapply the preference whenever Android replaces the drawable surface. */
    private final SurfaceHolder.Callback frameRateCallback = new SurfaceHolder.Callback() {
        @Override
        public void surfaceCreated(SurfaceHolder holder) {
            requestPreferredFrameRate(holder, applicationMetadata());
        }

        @Override
        public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
            requestPreferredFrameRate(holder, applicationMetadata());
        }

        @Override
        public void surfaceDestroyed(SurfaceHolder holder) {}
    };

    private Bundle applicationMetadata() {
        try {
            ApplicationInfo applicationInfo = getPackageManager().getApplicationInfo(
                getPackageName(), PackageManager.GET_META_DATA);
            return applicationInfo.metaData;
        } catch (PackageManager.NameNotFoundException exception) {
            return null;
        }
    }

    /**
     * Return top, right, bottom and left display cutout/system-bar insets in drawable pixels.
     * Native refreshes this coarse value when SDL reports a resize or system-bar change.
     */
    public int[] getSafeAreaInsets() {
        View decor = getWindow().getDecorView();
        WindowInsets windowInsets = decor.getRootWindowInsets();
        if (windowInsets == null) return new int[] {0, 0, 0, 0};
        Insets insets = windowInsets.getInsets(
            WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
        return new int[] {insets.top, insets.right, insets.bottom, insets.left};
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Bundle metadata = applicationMetadata();
        applyOrientation(metadata);
        if (metadata != null && metadata.getBoolean("TN_KEEP_SCREEN_ON", false)) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
        installPreferredFrameRate(metadata);
        attachUiOverlay(metadata);
    }

    @Override
    protected void onResume() {
        super.onResume();
        armPresentationFrames();
        if (mSurface != null) requestPreferredFrameRate(mSurface.getHolder(), applicationMetadata());
    }

    @Override
    protected void onPause() {
        // Notify the native waiter before removing the callback that would wake it: a render
        // thread inside paceToPresentationCap() must fall back rather than wait out its timeout.
        disarmPresentationFrames();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        // Belt and braces: a callback left registered when the native library unloads would call
        // into freed code. onPause normally precedes this, so the guard makes it a no-op.
        disarmPresentationFrames();
        if (uiOverlay != null) uiOverlay.releaseProducer();
        super.onDestroy();
    }

    /** Arm the display-frame callback once per foreground stretch, never twice. */
    private void armPresentationFrames() {
        if (presentationFramesArmed) return;
        presentationFramesArmed = true;
        nativeOnPresentationFramesStarted();
        Choreographer.getInstance().postFrameCallback(presentationFrame);
    }

    /** Unblock the native waiter, then stop the callback that feeds it. */
    private void disarmPresentationFrames() {
        if (!presentationFramesArmed) return;
        presentationFramesArmed = false;
        nativeOnPresentationFramesStopped();
        Choreographer.getInstance().removeFrameCallback(presentationFrame);
    }

    @Override
    public void onTrimMemory(int level) {
        // SDL's implementation below forwards a level-less SDL_EVENT_LOW_MEMORY. Capture the
        // ComponentCallbacks2 level first so the existing lifecycle watch can answer moderate and
        // critical pressure differently, then preserve SDL's event delivery with super.
        nativeOnTrimMemory(level);
        super.onTrimMemory(level);
    }

    private static native void nativeOnTrimMemory(int level);

    private void installPreferredFrameRate(Bundle metadata) {
        if (mSurface == null) {
            Log.w(LOG_TAG, "TN_DISPLAY_FRAME_RATE_REQUEST:{\"applied\":false,\"reason\":\"surface-missing\"}");
            return;
        }
        SurfaceHolder holder = mSurface.getHolder();
        holder.addCallback(frameRateCallback);
        requestPreferredFrameRate(holder, metadata);
    }

    private void requestPreferredFrameRate(SurfaceHolder holder, Bundle metadata) {
        int maxFps = metadata == null ? 60 : metadata.getInt("TN_MAX_FPS", 60);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            Log.i(LOG_TAG, "TN_DISPLAY_FRAME_RATE_REQUEST:{\"maxFps\":" + maxFps + ",\"applied\":false,\"reason\":\"api<30\"}");
            return;
        }
        Surface surface = holder == null ? null : holder.getSurface();
        if (surface == null || !surface.isValid()) {
            Log.w(LOG_TAG, "TN_DISPLAY_FRAME_RATE_REQUEST:{\"maxFps\":" + maxFps + ",\"applied\":false,\"reason\":\"surface-invalid\"}");
            return;
        }
        try {
            surface.setFrameRate((float) maxFps, Surface.FRAME_RATE_COMPATIBILITY_DEFAULT);
            Log.i(LOG_TAG, "TN_DISPLAY_FRAME_RATE_REQUEST:{\"maxFps\":" + maxFps + ",\"applied\":true}");
        } catch (RuntimeException exception) {
            Log.w(LOG_TAG, "TN_DISPLAY_FRAME_RATE_REQUEST:{\"maxFps\":" + maxFps + ",\"applied\":false,\"reason\":\"" + exception.getClass().getSimpleName() + "\"}");
        }
    }

    /**
     * Attach the UI layer when the game asked for it.
     *
     * `TN_UI_RENDERER` is written by the packager from `ui.renderer` in the game's config, and
     * "native" (the other value) means PRD-216's CanvasLayer renderer with no WebView and no
     * second process — so a game that did not opt in ships no overlay at all.
     *
     * The attach is deliberately not wrapped in a try/catch. A game that asked for this
     * renderer and cannot have it must fail at launch with the reason named; a swallowed
     * exception here presents as a game with no HUD, which sends the reader to the UI code.
     */
    private void attachUiOverlay(Bundle metadata) {
        String renderer = metadata == null ? "native" : metadata.getString("TN_UI_RENDERER", "native");
        if (!"web".equals(renderer)) return;
        uiOverlay = inFrameRequested(metadata)
            ? TnUiOverlay.attachInFrame(this)
            : TnUiOverlay.attach(this);
    }

    /**
     * Whether this run opts into in-frame UI composition (`TN_UI_INFRAME`), default off.
     *
     * The intent extra is the device-run override the verification harness uses; the manifest
     * metadata is the packaged switch the config writes. Both default false, so a game that did
     * not ask for it runs exactly today's child-WebView path.
     */
    private boolean inFrameRequested(Bundle metadata) {
        boolean fromIntent = getIntent().getBooleanExtra("TN_UI_INFRAME", false);
        boolean fromMetadata = metadata != null && metadata.getBoolean("TN_UI_INFRAME", false);
        Log.i(LOG_TAG, "TN_UI_INFRAME_REQUEST:{\"intent\":" + fromIntent
            + ",\"metadata\":" + fromMetadata + "}");
        if (fromIntent) return true;
        return fromMetadata;
    }

    /**
     * Keep the overlay's own hit test authoritative when it composites in-frame.
     *
     * The in-frame WebView is not a sibling view, so the system will not route touches to it. This
     * forwards each gesture to the same WebView first — its published hit regions decide ownership,
     * exactly as before — and only what it does not own reaches SDL and the game.
     */
    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        TnUiOverlay overlay = uiOverlay;
        if (overlay != null && overlay.isInFrame() && overlay.dispatchTouchEvent(event)) return true;
        return super.dispatchTouchEvent(event);
    }

    /**
     * Deliver one bridge frame to the UI layer. Called from the runtime over JNI, on the thread
     * that owns JavaScript, so the post itself is handed to the UI thread that owns the view.
     */
    public void postUiOverlayMessage(final String frame) {
        final TnUiOverlay overlay = uiOverlay;
        if (overlay == null) return;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                overlay.postToPage(frame);
            }
        });
    }

    /**
     * Re-assert the declared orientation from the activity itself.
     *
     * `android:screenOrientation` is already written into the manifest by the packager, and on
     * this device it was not enough: a landscape-declared build still came up in portrait, because
     * the activity declares `configChanges=...|orientation|screenSize`, so the system hands
     * rotation to the app instead of recreating it, and recent Android releases increasingly treat
     * the manifest value as advisory. Calling `setRequestedOrientation` in `onCreate` is the
     * request the window manager honours, and it costs nothing when the manifest already agreed.
     *
     * `sensor` is deliberately the only value that leaves rotation to the user; `landscape` and
     * `portrait` lock, and landscape allows both ways up so the phone can be held either way.
     */
    private void applyOrientation(Bundle metadata) {
        String orientation = metadata == null ? null : metadata.getString("TN_ORIENTATION");
        if (!applyFixedOrientation(orientation)) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
    }

    private boolean applyFixedOrientation(String orientation) {
        if ("landscape".equals(orientation)) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            return true;
        }
        if ("portrait".equals(orientation)) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT);
            return true;
        }
        return false;
    }

    /**
     * SDL3 calls this again when it creates or resizes its window. With no SDL orientation hint a
     * resizable window becomes FULL_USER, overwriting the game metadata applied in onCreate. Keep
     * a fixed game orientation authoritative; sensor games retain SDL's normal policy.
     */
    @Override
    public void setOrientationBis(int width, int height, boolean resizable, String hint) {
        Bundle metadata = applicationMetadata();
        String orientation = metadata == null ? null : metadata.getString("TN_ORIENTATION");
        if (!applyFixedOrientation(orientation)) {
            super.setOrientationBis(width, height, resizable, hint);
        }
    }

    /**
     * Override to specify which native libraries to load.
     * SDL handles loading SDL3, then we load mystral-runtime.
     */
    @Override
    protected String[] getLibraries() {
        return new String[] {
            "SDL3",
            "mystral-runtime"
        };
    }

    /**
     * Override to specify the main function.
     * This is called by SDL after the libraries are loaded.
     */
    @Override
    protected String getMainFunction() {
        return "SDL_main";
    }

    /**
     * Get command line arguments for the main function.
     * Can be used to specify the script path.
     */
    @Override
    protected String[] getArguments() {
        String endpoint = getIntent().getStringExtra("TN_PLAYTEST_ENDPOINT");
        String mailboxRoot = getIntent().getStringExtra("TN_PLAYTEST_MAILBOX_ROOT");
        Bundle metadata = applicationMetadata();
        String title = metadata == null ? "ThreeNative" : metadata.getString("TN_WINDOW_TITLE", "ThreeNative");
        boolean fullscreen = metadata == null || metadata.getBoolean("TN_FULLSCREEN", true);
        // `display.backgroundMode`. The native side parses it and keeps the default for anything it
        // does not recognize, so an unset value and a typo behave the same and both get logged.
        // Default "pause" again as of 2026-08-23: resume now rebuilds the surface against the
        // window Android hands back, so backgrounding no longer trades a battery cost for a black
        // screen. This default must match the native one in `platform/lifecycle.cpp`, or an APK
        // that carries no metadata runs one mode while the host reports the other.
        String backgroundMode = metadata == null ? "pause" : metadata.getString("TN_BACKGROUND_MODE", "pause");
        int maxFps = metadata == null ? 60 : metadata.getInt("TN_MAX_FPS", 60);
        // Ask Android to provision the app-owned external directory before honoring a runner-
        // supplied path beneath it. Creating /sdcard/Android/data/<package> directly is rejected
        // by scoped storage on a clean install, even though a later app-owned child is writable.
        java.io.File externalFiles = getExternalFilesDir(null);
        if (mailboxRoot == null) {
            mailboxRoot = externalFiles == null ? getFilesDir().getAbsolutePath() : externalFiles.getAbsolutePath();
        }
        java.io.File mailboxDirectory = new java.io.File(mailboxRoot);
        if (!mailboxDirectory.isDirectory() && !mailboxDirectory.mkdirs()) {
            throw new IllegalStateException(
                "TN_PLAYTEST_MAILBOX_UNAVAILABLE: cannot create " + mailboxRoot
            );
        }
        String uiRenderer = metadata == null ? "native" : metadata.getString("TN_UI_RENDERER", "native");
        String cssUiRoot = "native-css".equals(uiRenderer) ? extractCssUi() : "";
        // The native-css UI's own test knobs, which the host reads from its environment. An Android
        // app inherits none, so the runner hands them over as intent extras and they arrive as the
        // last two arguments. Empty unless a playtest launch supplied them.
        String fixedStepMs = getIntent().getStringExtra("TN_CSS_UI_FIXED_STEP_MS");
        String stateTrace = getIntent().getStringExtra("TN_CSS_UI_STATE_TRACE");
        return new String[] {
            "asset://scripts/main.js",
            endpoint == null ? "" : endpoint,
            mailboxRoot,
            title,
            Boolean.toString(fullscreen),
            backgroundMode == null ? "pause" : backgroundMode,
            Integer.toString(maxFps),
            cssUiRoot,
            fixedStepMs == null ? "" : fixedStepMs,
            stateTrace == null ? "" : stateTrace
        };
    }

    /**
     * Copy the packaged `assets/ui/**` (stylesheets, fonts, images) to a real directory for the
     * native CSS UI, which reads its `ui/` root from the filesystem and APK assets are not one.
     * Replaced whole on every launch, so an updated APK never paints a previous install's sheets.
     * Not caught: a game that asked for this HUD and cannot have it must fail with the reason named.
     */
    private String extractCssUi() {
        java.io.File root = new java.io.File(getFilesDir(), "tn-ui-css");
        deleteTree(root);
        try {
            copyAssetTree("ui", root);
        } catch (java.io.IOException exception) {
            throw new IllegalStateException("TN_UI_BUNDLE_MISSING: cannot extract assets/ui: " + exception, exception);
        }
        Log.i(LOG_TAG, "TN_CSS_UI_EXTRACTED:{\"root\":\"" + root.getAbsolutePath() + "\"}");
        return root.getAbsolutePath();
    }

    private void copyAssetTree(String asset, java.io.File destination) throws java.io.IOException {
        String[] children = getAssets().list(asset);
        if (children != null && children.length > 0) {
            if (!destination.isDirectory() && !destination.mkdirs()) {
                throw new java.io.IOException("cannot create " + destination);
            }
            for (String child : children) copyAssetTree(asset + "/" + child, new java.io.File(destination, child));
            return;
        }
        try (java.io.InputStream input = getAssets().open(asset);
             java.io.OutputStream output = new java.io.FileOutputStream(destination)) {
            byte[] buffer = new byte[65536];
            int read;
            while ((read = input.read(buffer)) > 0) output.write(buffer, 0, read);
        }
    }

    private static void deleteTree(java.io.File file) {
        java.io.File[] children = file.listFiles();
        if (children != null) for (java.io.File child : children) deleteTree(child);
        file.delete();
    }
}
