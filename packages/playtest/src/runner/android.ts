import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface IAndroidDriverOptions {
  activity: string;
  adbPath?: string;
  packageName: string;
  serial?: string;
  /** Android user id to target; when omitted, the device's current foreground user is detected. */
  user?: string;
  /**
   * The rotation between the touchscreen's raw axes and the frame the app draws in, when the
   * device cannot be asked.
   *
   * Normally this is read from the window — `dumpsys window`'s `mRotation`, inverted, and then
   * `dumpsys input`'s `SurfaceOrientation` and the `user_rotation` setting behind it. Those two
   * older sources are why this option exists: an orientation-locked game on a device whose
   * display never rotated reads 0 from both while its window is turned 90° from the panel, so an
   * injected touch lands somewhere else entirely and every input assertion fails for a reason
   * that has nothing to do with the game.
   *
   * Set explicitly to make such a run reproducible, and say so in the evidence. Fails closed on
   * anything but 0, 1, 2 or 3.
   */
  touchRotation?: number;
}

export interface IAndroidDriver {
  /** Send the app behind HOME and wait until the device reports it unfocused. */
  background?(): Promise<void>;
  captureConsole(): Promise<Array<{ text: string; type: string }>>;
  /** The device this driver is bound to, when it knows; reported next to its metric samples. */
  deviceSerial?(): string | undefined;
  /** Bring the launched app back to the foreground without force-stopping it. */
  foreground?(): Promise<void>;
  isAlive(): Promise<boolean>;
  /** What the device says about the app right now; the lifecycle phases are read from this. */
  lifecycleState?(): Promise<IAndroidAppState>;
  prepare(
    endpoint: string,
    mailboxRoot?: string,
    viewport?: { height: number; width: number },
  ): Promise<void>;
  readFile?(path: string): Promise<string | undefined>;
  removeFile?(path: string): Promise<void>;
  /** Lock the display to one rotation and wait until the device's own window reports it. */
  rotate?(rotation: number): Promise<void>;
  /** Raw adb passthrough, so the host can measure the device itself. Read-only probes only. */
  runAdb?(args: readonly string[]): Promise<string>;
  screenshot(path: string): Promise<void>;
  setPointers?(pointers: readonly IAndroidPointer[]): Promise<IAndroidPointerInjection>;
  startScreenRecording?(): Promise<void>;
  /** One OS tap in viewport pixels. Works on emulators and physical devices alike. */
  tap?(x: number, y: number): Promise<void>;
  /** Put the soft keyboard away, and report whether one was up. */
  hideKeyboard?(): Promise<boolean>;
  stop(): Promise<void>;
  stopScreenRecording?(path: string): Promise<void>;
  writeFile?(path: string, contents: string): Promise<void>;
}

/** The device operations a scenario's `lifecycle` step can name. */
export type IAndroidLifecycleOperation = "background" | "foreground" | "rotate";

/**
 * One reading of the app, taken off the device and never off the game.
 *
 * `frames` is the platform's own count of frames drawn for this process (`dumpsys gfxinfo`), which
 * is what makes "the surface stopped while backgrounded and started again after resume" a
 * measurement rather than a claim. It is absent when the device declined to report one, and the
 * runner treats that absence as a failure — a zero here would be indistinguishable from a game
 * that genuinely drew nothing.
 */
export interface IAndroidAppState {
  focused: boolean;
  frames?: number;
  pid?: number;
  /** `mRotation` for the app's window: how far its content is turned from the panel's frame. */
  windowRotation?: number;
}

/** One device-observed lifecycle phase, in the order the scenario drove them. */
export interface IPlaytestDeviceLifecyclePhase {
  at: number;
  focused: boolean;
  frames: number;
  /** Only on a `background` phase: the platform's frame count stopped before this reading. */
  framesPaused?: boolean;
  phase: IAndroidLifecycleOperation;
  pid: number;
  requestedRotation?: number;
  windowRotation?: number;
}

/**
 * The simulation-step count at each read around a driven lifecycle.
 *
 * A read the scenario never reached is `null` rather than a count this run did not take.
 */
export interface IPlaytestDeviceLifecycleSteps {
  afterAdvance: number | null;
  afterForeground: number | null;
  beforeBackground: number | null;
}

/**
 * The simulation-step count read around a driven lifecycle, and what it says about continuity.
 *
 * The counter is runtime-owned, not device-observed: the platform counts drawn frames, and
 * `dumpsys gfxinfo` has no physics counter, so only the plugin that performed the step can say
 * whether the simulation moved. Neither the device nor a game-authored `GameState` can restate it.
 */
export type IPlaytestDeviceLifecyclePhysics =
  | { available: false; reason: string }
  | {
      available: true;
      /** Read immediately before the app went away, on its return before the advance, and after. */
      steps: IPlaytestDeviceLifecycleSteps;
      /** The count moved across the runner's advance after the app came back, or `null`. */
      stepsAdvanced: boolean | null;
      /** The count stood still while the app was away, or `null` for a scenario that never left. */
      stepsPaused: boolean | null;
    };

/**
 * The runner's own account of a driven lifecycle, for a collector to bind to a scenario and an
 * installed artifact. Nothing here was authored by the game.
 */
export interface IPlaytestDeviceLifecycleObservation {
  phases: readonly IPlaytestDeviceLifecyclePhase[];
  /** Absent rather than zero on a build that installs no physics plugin, and a failed run rather
   * than a value when the plugin advertised one and reported nothing readable. */
  physics: IPlaytestDeviceLifecyclePhysics;
  render: {
    /** Frames advanced after the background phase, or `null` when there was nothing to compare. */
    framesAdvanced: boolean | null;
    /** Whether the device's own frame count stopped while the app was unfocused, or `null`. */
    framesPaused: boolean | null;
  };
  /** The process every phase reported; a different pid anywhere is a failed run, not a row. */
  session: { pid: number };
}

export interface IAndroidPointer {
  buttons?: number;
  id: number;
  x: number;
  y: number;
}

export interface IAndroidPointerInjection {
  activeIds: number[];
  injection: "adb-emu-event-protocol-b";
  rotation: number;
  trackingIds: number[];
}

/**
 * The `am start` extras that carry the native-css UI's own test knobs, or none.
 *
 * An Android app inherits no environment, so the host cannot read these from `getenv` the way it
 * does on desktop; the activity forwards them to `setenv` from intent extras. Read from this
 * runner's own environment rather than a new flag: the desktop lane already configures its host
 * from the environment, so one variable name means the same thing on both device lanes.
 */
function hostCssUiExtras(): string[] {
  const extras: string[] = [];
  for (const name of ["TN_CSS_UI_FIXED_STEP_MS", "TN_CSS_UI_STATE_TRACE"]) {
    const value = process.env[name];
    if (value !== undefined && value !== "") extras.push("--es", name, value);
  }
  return extras;
}

export interface IAndroidTouchViewport {
  device: { height: number; width: number };
  logical: { bottom: number; left: number; right: number; top: number };
  orientation: number | undefined;
  physical: { bottom: number; left: number; right: number; top: number };
}

export class AdbAndroidDriver implements IAndroidDriver {
  private static readonly COVERAGE_VIDEO_PATH = "/sdcard/tn-playtest-framebuffer-coverage.mp4";
  /** Bounded polls for a lifecycle operation to become visible to the device's own readings. */
  private static readonly LIFECYCLE_ATTEMPTS = 50;
  private readonly adbPath: string;
  private screenrecord?: ChildProcess;
  private screenrecordError?: Error;
  private readonly touchSlots = new Map<number, {
    slot: number;
    trackingId: number;
    x: number;
    y: number;
  }>();
  private nextTrackingId = 100;
  private rotation?: number;
  private touchViewport?: IAndroidTouchViewport;
  private readonly user?: string;
  private activeUser?: string;
  private readonly consolePids = new Set<string>();
  /** Set by a lifecycle `rotate`, whose display lock `stop()` has to free on its own account. */
  private lifecycleRotationLocked = false;
  private viewportPresented = false;

  constructor(private readonly options: IAndroidDriverOptions) {
    this.adbPath = options.adbPath ?? discoverAdb();
    this.user = options.user === undefined ? undefined : validateAndroidUser(options.user);
    if (options.touchRotation !== undefined) {
      if (![0, 1, 2, 3].includes(options.touchRotation)) {
        throw new Error(
          `TN_PLAYTEST_ANDROID_ROTATION_INVALID: touch rotation must be 0, 1, 2 or 3, got '${String(options.touchRotation)}'.`,
        );
      }
      this.rotation = options.touchRotation;
    }
  }

  async prepare(
    endpoint: string,
    mailboxRoot?: string,
    viewport?: { height: number; width: number },
  ): Promise<void> {
    const url = new URL(endpoint);
    const port = url.port;
    const user = await this.resolveUser();
    this.activeUser = user;
    await this.adb(["reverse", `tcp:${port}`, `tcp:${port}`]);
    await this.adb(["shell", "am", "force-stop", "--user", user, this.options.packageName]);
    if (viewport !== undefined) await this.presentViewport(viewport);
    // Stopping the old app can log a broken input channel. Capture only the new launch.
    await this.adb(["logcat", "-c"]);
    this.consolePids.clear();
    await this.adb([
      "shell",
      "am",
      "start",
      "--user",
      user,
      "-W",
      "-n",
      `${this.options.packageName}/${this.options.activity}`,
      "--es",
      "TN_PLAYTEST_ENDPOINT",
      endpoint,
      ...(mailboxRoot === undefined ? [] : ["--es", "TN_PLAYTEST_MAILBOX_ROOT", mailboxRoot]),
      // The native-css UI's own test knobs, forwarded from this runner's environment because `am
      // start` passes the app none: its fixed animation clock and its focus/scroll state trace. The
      // desktop driver needs no equivalent because it spawns the host and inherits them there, so
      // the same two variables in the environment mean the same thing on both device lanes.
      ...hostCssUiExtras(),
    ]);
    await this.rememberConsolePids();
  }

  private async rememberConsolePids(): Promise<void> {
    const output = await this.adb(["shell", "pidof", this.options.packageName]).catch(() => "");
    for (const pid of output.trim().split(/\s+/u))
      if (/^[1-9]\d*$/u.test(pid)) this.consolePids.add(pid);
  }

  private async resolveUser(): Promise<string> {
    if (this.user !== undefined) return this.user;
    const user = (await this.adb(["shell", "am", "get-current-user"])).trim();
    if (!/^\d+$/u.test(user)) {
      throw new Error(
        `TN_PLAYTEST_ANDROID_USER_UNKNOWN: am get-current-user returned '${user || "empty output"}'. Pass --user with a numeric Android user id.`,
      );
    }
    return user;
  }

  /**
   * Put the device into the scenario's viewport, and fail closed if it did not take.
   *
   * A silent failure here is the expensive one: the run continues, the touches arrive, the
   * assertions go red, and the report blames the game for a device that was never showing the
   * viewport the scenario asked for.
   */
  private async presentViewport(viewport: { height: number; width: number }): Promise<void> {
    const physical = parsePhysicalSize(await this.adb(["shell", "wm", "size"]));
    if (physical === undefined) {
      throw new Error("TN_PLAYTEST_ANDROID_VIEWPORT_UNKNOWN: `wm size` did not report a physical size, so the scenario viewport cannot be presented.");
    }
    for (const command of viewportPresentationCommands(viewport, physical)) await this.adb(command);
    this.viewportPresented = true;
    // The touch rotation is a property of the window, and the window has just been resized.
    this.rotation = this.options.touchRotation;
    this.touchViewport = undefined;
    const override = parseOverrideSize(await this.adb(["shell", "wm", "size"]));
    const expected = viewportPresentationCommands(viewport, physical)[0]?.[3];
    if (!viewportPresentationObserved(override, expected, physical)) {
      throw new Error(
        `TN_PLAYTEST_ANDROID_VIEWPORT_NOT_PRESENTED: asked for ${String(expected)} and the device reports ${String(override)}.`,
      );
    }
  }

  async tap(x: number, y: number): Promise<void> {
    await this.adb(tapCommand(x, y));
  }

  /**
   * The three device operations a `lifecycle` step names, each waiting for the device to *report*
   * the effect rather than for the command to return.
   *
   * `input keyevent 3` and `am start` both answer `OK` whether or not anything moved, and `wm
   * user-rotation lock` answers the same way on a device whose rotation is pinned. A step that
   * recorded a phase on the strength of the exit code alone would certify a device that never went
   * away — which is the exact value the gate exists to read off the phone, so each op polls the
   * reading it is about to claim and throws when the claim is false.
   */
  async background(): Promise<void> {
    await this.adb(["shell", "input", "keyevent", "3"]);
    await this.waitForFocus(false);
  }

  async foreground(): Promise<void> {
    const user = this.activeUser ?? await this.resolveUser();
    await this.adb([
      "shell",
      "am",
      "start",
      "--user",
      user,
      "-n",
      `${this.options.packageName}/${this.options.activity}`,
    ]);
    await this.waitForFocus(true);
  }

  async rotate(rotation: number): Promise<void> {
    if (![0, 1, 2, 3].includes(rotation)) {
      throw new Error(
        `TN_PLAYTEST_ANDROID_ROTATION_INVALID: rotation must be 0, 1, 2 or 3, got '${String(rotation)}'.`,
      );
    }
    await this.adb(["shell", "wm", "user-rotation", "lock", String(rotation)]);
    // Set before the poll, not after it: the lock is taken whether or not the window ever turns, so
    // a device that refused the rotation is exactly the device `stop()` must put back.
    this.lifecycleRotationLocked = true;
    let observed: number | undefined;
    for (let attempt = 0; attempt < AdbAndroidDriver.LIFECYCLE_ATTEMPTS; attempt += 1) {
      observed = windowRotationFromDump(await this.adb(["shell", "dumpsys", "window"]));
      if (observed === rotation) return;
      await delay(100);
    }
    throw new Error(
      `TN_PLAYTEST_ANDROID_LIFECYCLE_NOT_APPLIED: asked the device for rotation ${rotation} and dumpsys window still reports ${String(observed)}.`,
    );
  }

  async lifecycleState(): Promise<IAndroidAppState> {
    const [pids, window, frames] = await Promise.all([
      this.adb(["shell", "pidof", this.options.packageName]),
      this.adb(["shell", "dumpsys", "window"]),
      this.adb(["shell", "dumpsys", "gfxinfo", this.options.packageName]),
    ]);
    const pid = parseAndroidAppPid(pids);
    const appFrames = parseAndroidAppFrames(frames);
    const windowRotation = windowRotationFromDump(window);
    return {
      focused: windowHasFocus(window, this.options.packageName),
      ...(appFrames === undefined ? {} : { frames: appFrames }),
      ...(pid === undefined ? {} : { pid }),
      ...(windowRotation === undefined ? {} : { windowRotation }),
    };
  }

  private async waitForFocus(expected: boolean): Promise<void> {
    for (let attempt = 0; attempt < AdbAndroidDriver.LIFECYCLE_ATTEMPTS; attempt += 1) {
      const focused = windowHasFocus(
        await this.adb(["shell", "dumpsys", "window"]),
        this.options.packageName,
      );
      if (focused === expected) return;
      await delay(100);
    }
    throw new Error(
      `TN_PLAYTEST_ANDROID_LIFECYCLE_NOT_APPLIED: the device still reports '${this.options.packageName}' as ${expected ? "not focused" : "focused"} after the operation.`,
    );
  }

  /**
   * Dismiss the soft keyboard and wait for it to actually be gone.
   *
   * Measured on the physical Pixel 8: focusing a text field opens the IME, the WebView reflows
   * into the space left above it, and the page's centred menu rides up — so a coordinate computed
   * against the scenario's viewport now points at the keyboard. A tap there does not merely miss
   * the control; it types a character into the field it meant to submit.
   *
   * BACK is the dismissal the platform guarantees. The wait is the point: the reflow happens on
   * the next layout pass, and a click sent into the middle of it lands wherever the menu was
   * halfway through moving.
   */
  async hideKeyboard(): Promise<boolean> {
    if (!keyboardIsShown(await this.adb(["shell", "dumpsys", "input_method"]))) return false;
    await this.adb(["shell", "input", "keyevent", "4"]);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!keyboardIsShown(await this.adb(["shell", "dumpsys", "input_method"]))) return true;
    }
    throw new Error(
      "TN_PLAYTEST_ANDROID_KEYBOARD_STUCK: the soft keyboard did not close, so a click step would land on it instead of the UI.",
    );
  }

  /**
   * The device's own diagnostics, read once and parsed once.
   *
   * The read is the only step here that can fail for a reason the game did not cause: a hosted
   * SwiftShader emulator drops the adb transport mid-dump, and `adb logcat -d` exits non-zero after
   * printing part of the buffer — a run whose assertions all passed died on a truncated line (CI
   * `clean-consumer`, 5th of 6 sequential runs). The native harnesses already answer that with one
   * re-read after `wait-for-device` (#310, b12becde6); this mirrors it, including the named refusal
   * exemption: a `KO:` reply is the device rejecting the command, and retrying it would hide that.
   */
  async captureConsole(): Promise<Array<{ text: string; type: string }>> {
    const args = ["logcat", "-d", "-v", "brief"];
    let output: string | undefined;
    let lastError = "";
    for (let attempt = 1; output === undefined && attempt <= LOGCAT_ATTEMPTS; attempt += 1) {
      try {
        output = await this.adb(args);
      } catch (error) {
        lastError = (error as Error).message;
        if (isAdbRefusal(lastError) || attempt === LOGCAT_ATTEMPTS) break;
        await this.adb(["wait-for-device"]).catch(() => undefined);
      }
    }
    if (output === undefined) throw failedLogcat(args.join(" "), lastError);
    await this.rememberConsolePids();
    // A launch may crash before pidof sees it; the cleared log retains its process identity.
    for (const line of output.split(/\r?\n/u)) {
      const launch = /\bStart proc ([1-9]\d*):([^\s/]+)/u.exec(line);
      const java = /\bProcess:\s*([^,\s]+),\s*PID:\s*([1-9]\d*)\b/u.exec(line);
      const native = /\bpid:\s*([1-9]\d*),.*>>>\s*([^<\s]+)\s*<<</u.exec(line);
      const name = launch?.[2] ?? java?.[1] ?? native?.[2];
      const pid = launch?.[1] ?? java?.[2] ?? native?.[1];
      if (
        pid !== undefined &&
        (name === this.options.packageName || name?.startsWith(`${this.options.packageName}:`))
      )
        this.consolePids.add(pid);
    }
    if (this.consolePids.size === 0) {
      const excerpt =
        output.length > LOGCAT_ERROR_LIMIT ? `…${output.slice(-LOGCAT_ERROR_LIMIT)}` : output;
      throw new Error(
        `TN_PLAYTEST_ANDROID_CONSOLE_UNATTRIBUTED: no process identity for '${this.options.packageName}'; console tail:\n${excerpt}`,
      );
    }
    return parseAndroidConsoleEntries(output, {
      packageName: this.options.packageName,
      pids: this.consolePids,
    });
  }

  async screenshot(path: string): Promise<void> {
    const { stdout } = await execFileAsync(this.adbPath, [
      ...this.serialArgs(),
      "exec-out",
      "screencap",
      "-p",
    ], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
    await writeFile(path, stdout);
  }

  async startScreenRecording(): Promise<void> {
    if (this.screenrecord !== undefined) {
      throw new Error("TN_PLAYTEST_FRAMEBUFFER_COVERAGE_RECORDING_ACTIVE");
    }
    if ((await this.adb(["shell", "pidof", "screenrecord"]).catch(() => "")).trim().length > 0) {
      throw new Error("TN_PLAYTEST_FRAMEBUFFER_COVERAGE_OTHER_RECORDING_ACTIVE");
    }
    try {
      await this.adb(["shell", "rm", "-f", AdbAndroidDriver.COVERAGE_VIDEO_PATH]);
      this.screenrecordError = undefined;
      this.screenrecord = spawn(this.adbPath, [
        ...this.serialArgs(),
        "shell",
        "screenrecord",
        "--time-limit",
        "180",
        "--bit-rate",
        "20000000",
        AdbAndroidDriver.COVERAGE_VIDEO_PATH,
      ], { stdio: "ignore" });
      this.screenrecord.once("error", (error) => {
        this.screenrecordError = error;
      });
      await this.waitForScreenRecorder();
    } catch (error) {
      await this.abortScreenRecording();
      throw error;
    }
  }

  async stopScreenRecording(path: string): Promise<void> {
    const recorder = this.screenrecord;
    if (recorder === undefined) {
      throw new Error("TN_PLAYTEST_FRAMEBUFFER_COVERAGE_RECORDING_NOT_ACTIVE");
    }
    this.screenrecord = undefined;
    this.screenrecordError = undefined;
    try {
      const pids = (await this.adb(["shell", "pidof", "screenrecord"]).catch(() => ""))
        .trim()
        .split(/\s+/u)
        .filter((pid) => /^\d+$/u.test(pid));
      for (const pid of pids) await this.adb(["shell", "kill", "-2", pid]);
      await waitForProcessExit(recorder, 5_000);
      await this.adb(["pull", AdbAndroidDriver.COVERAGE_VIDEO_PATH, path]);
      if ((await stat(path)).size === 0) {
        throw new Error("TN_PLAYTEST_FRAMEBUFFER_COVERAGE_RECORDING_EMPTY");
      }
    } finally {
      recorder.kill();
      await this.adb(["shell", "rm", "-f", AdbAndroidDriver.COVERAGE_VIDEO_PATH]).catch(() => undefined);
    }
  }

  async isAlive(): Promise<boolean> {
    return (await this.adb(["shell", "pidof", this.options.packageName])).trim().length > 0;
  }

  async setPointers(pointers: readonly IAndroidPointer[]): Promise<IAndroidPointerInjection> {
    const serial = (await this.adb(["get-serialno"])).trim();
    if (!serial.startsWith("emulator-")) {
      throw new Error("TN_PLAYTEST_ANDROID_MULTITOUCH_EMULATOR_REQUIRED: multi-pointer injection uses rootless adb emu event send.");
    }
    if (new Set(pointers.map(({ id }) => id)).size !== pointers.length) {
      throw new Error("Android complete held-pointer sets require unique pointer ids.");
    }
    if (pointers.some(({ buttons }) => buttons !== undefined && buttons !== 1)) {
      throw new Error("Android touch injection supports buttons=1 only.");
    }
    this.rotation ??= await this.readRotation();
    if (this.viewportPresented && this.touchViewport === undefined) {
      this.touchViewport = parseAndroidTouchViewport(await this.adb(["shell", "dumpsys", "input"]));
    }
    const next = new Map(pointers.map((pointer) => [pointer.id, pointer]));
    const identity: string[] = [];
    const positions: string[] = [];
    const append = (batch: string[], type: string, code: string, value: number) => {
      batch.push(`${type}:${code}:${value}`);
    };
    for (const [id, held] of [...this.touchSlots]) {
      if (next.has(id)) continue;
      append(identity, "EV_ABS", "ABS_MT_SLOT", held.slot);
      append(identity, "EV_ABS", "ABS_MT_TRACKING_ID", -1);
      this.touchSlots.delete(id);
    }
    for (const pointer of pointers) {
      const [x, y] = this.touchViewport === undefined
        ? rotatedTouchPosition(pointer.x, pointer.y, this.rotation)
        : touchPositionForViewport(pointer.x, pointer.y, this.touchViewport, this.options.touchRotation);
      let held = this.touchSlots.get(pointer.id);
      if (held === undefined) {
        const usedSlots = new Set([...this.touchSlots.values()].map(({ slot }) => slot));
        let slot = 0;
        while (usedSlots.has(slot)) slot += 1;
        held = { slot, trackingId: this.nextTrackingId++, x, y };
        this.touchSlots.set(pointer.id, held);
        append(identity, "EV_ABS", "ABS_MT_SLOT", slot);
        append(identity, "EV_ABS", "ABS_MT_TRACKING_ID", held.trackingId);
        append(positions, "EV_ABS", "ABS_MT_SLOT", slot);
        append(positions, "EV_ABS", "ABS_MT_POSITION_X", x);
        append(positions, "EV_ABS", "ABS_MT_POSITION_Y", y);
        // The emulator's virtio touchscreen advertises pressure and touch-major axes.
        append(positions, "EV_ABS", "ABS_MT_TOUCH_MAJOR", 1);
        append(positions, "EV_ABS", "ABS_MT_PRESSURE", 512);
      } else if (held.x !== x || held.y !== y) {
        append(positions, "EV_ABS", "ABS_MT_SLOT", held.slot);
        append(positions, "EV_ABS", "ABS_MT_POSITION_X", x);
        append(positions, "EV_ABS", "ABS_MT_POSITION_Y", y);
        held.x = x;
        held.y = y;
      }
    }
    // Coordinates first, identity second, and the order is the whole point.
    //
    // A tracking id and a coordinate cannot share one emulator batch — the emulator answers OK
    // and drops the coordinate — so they are two batches, and which one goes first decides where
    // Android thinks the finger landed. Sending the tracking id first activates the slot at
    // whatever position it still held from the previous gesture, so every press was reported at
    // the *previous* step's coordinates and then moved: a tap on a HUD button arrived as a press
    // somewhere else followed by a drag onto the button. Positioning the inactive slot first and
    // activating it second reports the press where the scenario asked for it.
    for (const batch of androidTouchBatches(positions, identity)) {
      await this.adb(["emu", "event", "send", ...batch]);
    }
    return {
      activeIds: [...this.touchSlots.keys()],
      injection: "adb-emu-event-protocol-b",
      rotation: this.rotation,
      trackingIds: [...this.touchSlots.values()].map(({ trackingId }) => trackingId),
    };
  }

  async readFile(path: string): Promise<string | undefined> {
    try {
      const contents = await this.adb(["exec-out", "cat", path]);
      return isMissingRemoteFileOutput(contents) ? undefined : contents;
    } catch (error) {
      if (isMissingRemoteFile(error)) return undefined;
      throw error;
    }
  }

  async removeFile(path: string): Promise<void> {
    await this.adb(["shell", "rm", "-f", path]);
  }

  async stop(): Promise<void> {
    await this.abortScreenRecording();
    await this.setPointers([]).catch(() => undefined);
    if (this.lifecycleRotationLocked) {
      // A lifecycle rotation is its own display override, so it is freed on its own account. The
      // viewport restore below frees the display too, but it also resets size and density, which a
      // rotation-only run never asked to change — and a device left pinned is a device whose next
      // measurement is silently against the wrong orientation.
      this.lifecycleRotationLocked = false;
      await this.adb(["shell", "wm", "user-rotation", "free"]).catch(() => undefined);
    }
    if (this.viewportPresented) {
      this.viewportPresented = false;
      this.touchViewport = undefined;
      // Before the force-stop below, and unconditional: a device left at a test viewport is a
      // device whose next measurement is silently against the wrong screen.
      for (const command of viewportRestoreCommands()) {
        await this.adb(command).catch(() => undefined);
      }
    }
    await this.adb([
      "shell",
      "am",
      "force-stop",
      ...(this.activeUser === undefined ? [] : ["--user", this.activeUser]),
      this.options.packageName,
    ]).catch(() => undefined);
    await this.adb(["reverse", "--remove-all"]).catch(() => undefined);
  }

  private async readRotation(): Promise<number> {
    // The window first, and the two older sources only behind it. See
    // touchRotationFromWindowDump: an orientation-locked game reads 0 from user_rotation while
    // its window is turned 90 degrees off the panel, and dumpsys input prints no
    // SurfaceOrientation at all on the emulator — so both agreed on a value that was wrong, and
    // every injected touch landed transposed.
    const window = touchRotationFromWindowDump(await this.adb(["shell", "dumpsys", "window"]));
    if (window !== undefined) return window;
    const input = await this.adb(["shell", "dumpsys", "input"]);
    const surface = /SurfaceOrientation:\s*([0-3])/u.exec(input)?.[1];
    if (surface !== undefined) return Number(surface);
    const setting = (await this.adb(["shell", "settings", "get", "system", "user_rotation"])).trim();
    if (/^[0-3]$/u.test(setting)) return Number(setting);
    throw new Error("TN_PLAYTEST_ANDROID_ROTATION_UNKNOWN: dumpsys window, dumpsys input and user_rotation did not report 0 through 3.");
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "threenative-adb-mailbox-"));
    const localPath = join(directory, "payload.json");
    const remotePath = `${path}.incoming-${process.pid}-${Date.now()}`;
    try {
      await writeFile(localPath, contents, "utf8");
      await this.adb(["push", localPath, remotePath]);
      await this.adb(["shell", "mv", remotePath, path]);
    } finally {
      await rm(directory, { force: true, recursive: true });
      await this.adb(["shell", "rm", "-f", remotePath]).catch(() => undefined);
    }
  }

  deviceSerial(): string | undefined {
    return this.options.serial;
  }

  /**
   * The device-metrics probes read `dumpsys`, `logcat` and sysfs through here. Deliberately a
   * thin passthrough rather than a metrics API: the parsing belongs to deviceMetrics.ts, which
   * is unit-tested against real captured device output.
   */
  async runAdb(args: readonly string[]): Promise<string> {
    return this.adb(args);
  }

  private async adb(args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        this.adbPath,
        [...this.serialArgs(), ...args],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      );
      if (/^KO:/mu.test(stdout)) {
        throw new Error(`adb ${args.join(" ")} failed: ${stdout.trim()}`);
      }
      return stdout;
    } catch (error) {
      const detail = error as Error & { stderr?: string; stdout?: string };
      throw new Error(
        `adb ${args.join(" ")} failed: ${detail.stderr || detail.stdout || detail.message}`,
      );
    }
  }

  private async waitForScreenRecorder(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (this.screenrecordError !== undefined) {
        throw new Error(`TN_PLAYTEST_FRAMEBUFFER_COVERAGE_RECORDING_FAILED:${this.screenrecordError.message}`);
      }
      if (this.screenrecord?.exitCode !== null) {
        throw new Error("TN_PLAYTEST_FRAMEBUFFER_COVERAGE_RECORDING_EXITED");
      }
      const pid = await this.adb(["shell", "pidof", "screenrecord"]).catch(() => "");
      if (pid.trim().length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("TN_PLAYTEST_FRAMEBUFFER_COVERAGE_RECORDING_NOT_READY");
  }

  private async abortScreenRecording(): Promise<void> {
    const recorder = this.screenrecord;
    this.screenrecord = undefined;
    this.screenrecordError = undefined;
    if (recorder !== undefined) {
      const pids = (await this.adb(["shell", "pidof", "screenrecord"]).catch(() => ""))
        .trim()
        .split(/\s+/u)
        .filter((pid) => /^\d+$/u.test(pid));
      for (const pid of pids) await this.adb(["shell", "kill", "-2", pid]).catch(() => undefined);
      await waitForProcessExit(recorder, 5_000).catch(() => recorder.kill());
      await this.adb(["shell", "rm", "-f", AdbAndroidDriver.COVERAGE_VIDEO_PATH]).catch(() => undefined);
    }
  }

  private serialArgs(): string[] {
    return this.options.serial === undefined ? [] : ["-s", this.options.serial];
  }
}

async function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("TN_PLAYTEST_FRAMEBUFFER_COVERAGE_RECORDING_STOP_TIMEOUT"));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
    if (child.exitCode !== null) onExit();
  });
}

/**
 * A refusal is the device answering, not the transport dropping.
 *
 * `adb` reports a command it will not run as `KO:` on stdout — an unknown subcommand, a locked
 * transport, a disabled daemon. Nothing about a retry changes that answer, and retrying it would
 * turn a named refusal into a slower version of the same failure. Every other `adb ... failed:` is
 * an exit status, which is the one shape a dropped transport produces.
 */
function isAdbRefusal(message: string): boolean {
  return /\bKO:/u.test(message);
}

/**
 * The tail of a failed dump, never the whole buffer.
 *
 * The truncation *is* the evidence — it lands mid-line — so the end is kept. The head is 82 KB of
 * Android noise that buries the one line a reader needs, and a CI log viewer truncates it anyway.
 */
function failedLogcat(command: string, message: string): Error {
  const prefix = `adb ${command} failed: `;
  const detail = message.startsWith(prefix) ? message.slice(prefix.length) : message;
  const excerpt = detail.length > LOGCAT_ERROR_LIMIT
    ? `…${detail.slice(-LOGCAT_ERROR_LIMIT)}`
    : detail;
  return new Error(`${prefix}${excerpt}`);
}

export function parseAndroidConsole(output: string): Array<{ text: string; type: string }> {
  return parseAndroidConsoleEntries(output);
}

function parseAndroidConsoleEntries(
  output: string,
  app?: { packageName: string; pids: ReadonlySet<string> },
): Array<{ text: string; type: string }> {
  const packageRecord =
    app === undefined
      ? undefined
      : new RegExp(
          `(?:^|[^\\w.])${app.packageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=[:/\\s,})]|$)`,
          "u",
        );
  return (
    output
      .split(/\r?\n/u)
      // system_server and the compositor name the activity while reporting on themselves.
      .filter((line) => !/^[VDIWEF]\/(?:SurfaceSyncGroup|TransitionController)\(/u.test(line))
      .filter((line) => {
        if (app === undefined) return /Mystral|THREENATIVE|chromium/u.test(line);
        if (app.pids.size === 0) return line.trim().length > 0;
        const pid = /^[VDIWEF]\/[^\n(]+\(\s*(\d+)\)/u.exec(line)?.[1];
        return (
          (pid !== undefined &&
            app.pids.has(pid) &&
            (/Mystral|THREENATIVE|chromium/u.test(line) ||
              /^[EF]\/(?:AndroidRuntime|libc|DEBUG)\s*\(/u.test(line))) ||
          (/^[EF]\//u.test(line) && packageRecord!.test(line))
        );
      })
      .map((text) => ({
        text,
        type: isPlatformWebViewNoise(text)
          ? "log"
          : /^(?:E|F)\//u.test(text) || /\b(?:Error|FATAL|FAILED)\b/u.test(text)
            ? "error"
            : "log",
      }))
  );
}

/**
 * A `chromium` line the WebView wrote about itself, rather than the page's console.
 *
 * The tag carries both. The page's `console.error` arrives as `[ERROR:CONSOLE(line)]`; the
 * WebView's own C++ diagnostics name their source file — `variations_seed_loader.cc`,
 * `simple_index_file.cc` — and describe the platform, not the game. A first launch after
 * `adb install -r` writes five of them because the HTTP cache directory does not exist yet, and
 * counting those as the game's console errors makes `noConsoleErrors` mean something different
 * on Android than it means in a browser, which is the one thing a cross-target assertion may
 * never do.
 *
 * The line is kept either way. Only its severity is decided here.
 */
function isPlatformWebViewNoise(text: string): boolean {
  if (!/\bchromium\(/u.test(text)) return false;
  // The page's console, or anything carrying the framework's own marker, is the game talking
  // whatever tag it arrived under.
  return !/:CONSOLE\(|Mystral|THREENATIVE/u.test(text);
}

const TOUCH_AXIS_MAX = 32767;
/** A dropped adb transport is re-read once; a device that never returns fails the run. */
const LOGCAT_ATTEMPTS = 2;
/** Bytes of a failed dump kept in the error, so an 82 KB logcat never becomes the report. */
const LOGCAT_ERROR_LIMIT = 2_000;

export function parseAndroidTouchViewport(output: string): IAndroidTouchViewport {
  const match = /Viewport\s+INTERNAL:\s*displayId=0,[\s\S]*?(?:orientation=(\d+),\s*)?logicalFrame=\[\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\s*\],\s*physicalFrame=\[\s*(-?\d+),\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\s*\],\s*deviceSize=\[\s*(\d+),\s*(\d+)\s*\]/u.exec(output);
  if (match === null) {
    throw new Error(
      "TN_PLAYTEST_ANDROID_TOUCH_VIEWPORT_MISSING: dumpsys input did not report an INTERNAL viewport for display 0.",
    );
  }
  const orientation = match[1] === undefined ? undefined : Number(match[1]);
  const [
    logicalLeft,
    logicalTop,
    logicalRight,
    logicalBottom,
    physicalLeft,
    physicalTop,
    physicalRight,
    physicalBottom,
    deviceWidth,
    deviceHeight,
  ] = match.slice(2).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (orientation !== undefined && ![0, 1, 2, 3].includes(orientation)) {
    throw new Error(`TN_PLAYTEST_ANDROID_TOUCH_ORIENTATION_INVALID: display 0 reported orientation ${orientation}.`);
  }
  if (logicalRight <= logicalLeft || logicalBottom <= logicalTop
    || physicalRight <= physicalLeft || physicalBottom <= physicalTop
    || deviceWidth <= 0 || deviceHeight <= 0) {
    throw new Error(
      `TN_PLAYTEST_ANDROID_TOUCH_VIEWPORT_EMPTY: display 0 reported logical [${logicalLeft}, ${logicalTop}, ${logicalRight}, ${logicalBottom}], physical [${physicalLeft}, ${physicalTop}, ${physicalRight}, ${physicalBottom}], device ${deviceWidth}x${deviceHeight}.`,
    );
  }
  return {
    device: { height: deviceHeight, width: deviceWidth },
    logical: { bottom: logicalBottom, left: logicalLeft, right: logicalRight, top: logicalTop },
    orientation,
    physical: { bottom: physicalBottom, left: physicalLeft, right: physicalRight, top: physicalTop },
  };
}

/** Map a normalized logical-display point to the raw touchscreen axes. */
export function touchPositionForViewport(
  x: number,
  y: number,
  viewport: IAndroidTouchViewport,
  rotationOverride?: number,
): [number, number] {
  const logicalX = viewport.logical.left + clampUnit(x) * (viewport.logical.right - viewport.logical.left);
  const logicalY = viewport.logical.top + clampUnit(y) * (viewport.logical.bottom - viewport.logical.top);
  const physicalX = viewport.physical.left
    + (logicalX - viewport.logical.left) * (viewport.physical.right - viewport.physical.left)
      / (viewport.logical.right - viewport.logical.left);
  const physicalY = viewport.physical.top
    + (logicalY - viewport.logical.top) * (viewport.physical.bottom - viewport.physical.top)
      / (viewport.logical.bottom - viewport.logical.top);
  if (rotationOverride !== undefined && ![0, 1, 2, 3].includes(rotationOverride)) {
    throw new Error(`TN_PLAYTEST_ANDROID_TOUCH_ORIENTATION_INVALID: touch rotation ${rotationOverride}.`);
  }
  // `rotationOverride` follows rotatedTouchPosition's content-to-panel convention. The dumpsys
  // viewport orientation uses the inverse panel-to-content convention, so invert the override
  // before applying the physical-frame transform.
  const orientation = rotationOverride === undefined
    ? viewport.orientation
    : (4 - rotationOverride) % 4;
  if (orientation === undefined) {
    throw new Error(
      "TN_PLAYTEST_ANDROID_TOUCH_ORIENTATION_UNKNOWN: pass touchRotation when dumpsys input omits the viewport orientation.",
    );
  }
  if (![0, 1, 2, 3].includes(orientation)) {
    throw new Error(`TN_PLAYTEST_ANDROID_TOUCH_ORIENTATION_INVALID: display 0 reported orientation ${orientation}.`);
  }
  const [rawX, rawY, rawWidth, rawHeight] = orientation === 0
    ? [physicalX, physicalY, viewport.device.width, viewport.device.height]
    : orientation === 1
      ? [viewport.device.height - physicalY, physicalX, viewport.device.height, viewport.device.width]
      : orientation === 2
        ? [viewport.device.width - physicalX, viewport.device.height - physicalY, viewport.device.width, viewport.device.height]
        : [physicalY, viewport.device.width - physicalX, viewport.device.height, viewport.device.width];
  return [
    Math.round(clampUnit(rawX / rawWidth) * TOUCH_AXIS_MAX),
    Math.round(clampUnit(rawY / rawHeight) * TOUCH_AXIS_MAX),
  ];
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) throw new Error(`Android touch coordinate must be finite, got ${String(value)}.`);
  return Math.max(0, Math.min(1, value));
}

/**
 * Splits slot identity from coordinates into separate synced `adb emu event send` batches.
 *
 * The emulator console drops ABS_MT_POSITION_X/Y from any batch that also carries an
 * ABS_MT_TRACKING_ID: the command reports `OK` and the coordinates never reach the device, so
 * every contact lands at (0, 0) and a two-finger gesture reads as two touches in the same
 * screen half — the exact failure that made the simultaneous-touch proof unprovable.
 * Confirmed against `getevent -lt /dev/input/event2` on emulator 36.6.11 with the android-35
 * google_apis image. Identity goes first so a slot exists before it is positioned.
 */
export function androidTouchBatches(
  identity: readonly string[],
  positions: readonly string[],
): string[][] {
  const batches: string[][] = [];
  for (const batch of [identity, positions]) {
    if (batch.length === 0) continue;
    if (
      batch.some((event) => event.includes("ABS_MT_TRACKING_ID")) &&
      batch.some((event) => event.includes("ABS_MT_POSITION_"))
    ) {
      throw new Error(
        "TN_PLAYTEST_ANDROID_TOUCH_BATCH_MIXED: a tracking id and a coordinate cannot share one emulator event batch; the emulator silently drops the coordinate.",
      );
    }
    // The emulator console has no symbolic EV_SYN code aliases. Linux SYN_REPORT is 0.
    batches.push([...batch, "EV_SYN:0:0"]);
  }
  return batches;
}

/** `wm size`'s physical line: the panel's own frame, which the override is written in. */
function parsePhysicalSize(output: string): { height: number; width: number } | undefined {
  const size = /Physical size:\s*(\d+)x(\d+)/u.exec(output);
  return size == null ? undefined : { height: Number(size[2]), width: Number(size[1]) };
}

/** `wm size`'s override line, as written — absent until something overrides it. */
function parseOverrideSize(output: string): string | undefined {
  return /Override size:\s*(\d+x\d+)/u.exec(output)?.[1];
}

/**
 * Confirm that Android reported the requested viewport, including the physical-size omission.
 *
 * @situation verify that an Android device presented the requested viewport
 * @situation accept the physical panel size when `wm size` omits its override line
 * @example viewportPresentationObserved(undefined, "1080x2400", { width: 1080, height: 2400 });
 */
export function viewportPresentationObserved(
  override: string | undefined,
  expected: string | undefined,
  physical: { height: number; width: number },
): boolean {
  return (
    expected !== undefined
    && (override === expected || (override === undefined && expected === `${physical.width}x${physical.height}`))
  );
}

/**
 * The touch rotation for the window `dumpsys window` just described, or `undefined`.
 *
 * `mRotation` says how far the window's content is turned from the panel's natural frame.
 * {@link rotatedTouchPosition} converts the other way — a point in that content back to the
 * panel's raw axes — so the value it needs is the inverse, and handing it `mRotation` directly
 * is a 180-degree error on either odd rotation.
 *
 * This is the source of truth because it describes the *window*. `dumpsys input`'s
 * `SurfaceOrientation` is absent on the emulator, and `user_rotation` is the user's preference:
 * an orientation-locked game on a device the user never turned reads 0 there while its window
 * is turned 90 degrees off the panel, so every injected touch lands somewhere else.
 */
export function touchRotationFromWindowDump(dump: string): number | undefined {
  const rotation = windowRotationFromDump(dump);
  return rotation === undefined ? undefined : (4 - rotation) % 4;
}

/**
 * The window's own `mRotation`, as the device states it rather than as touch needs it. `undefined`
 * means the dump carried no `mRotation`, never rotation 0.
 */
function windowRotationFromDump(dump: string): number | undefined {
  const rotation = /\bmRotation=([0-3])\b/u.exec(dump)?.[1];
  return rotation === undefined ? undefined : Number(rotation);
}

/** Whether `dumpsys window` shows this package holding input focus. */
function windowHasFocus(dump: string, packageName: string): boolean {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`mCurrentFocus=.*\\s${escaped}/`, "u").test(dump);
}

/** The pid `pidof` reported for the package, or `undefined` when nothing carries that name. */
function parseAndroidAppPid(output: string): number | undefined {
  const pid = output.trim().split(/\s+/u)[0];
  return pid !== undefined && /^\d+$/u.test(pid) ? Number(pid) : undefined;
}

/**
 * The frames the platform has drawn for this process, from `dumpsys gfxinfo <package>`.
 *
 * `undefined` when the device declined the query or reported no counter, which is not the same as
 * a process that drew nothing: a device with the per-app frame statistics turned off prints
 * neither line, and reading that as `0` would certify a paused surface from a device that never
 * answered.
 */
function parseAndroidAppFrames(dump: string): number | undefined {
  const frames = /Total frames rendered:\s*(\d+)/u.exec(dump)?.[1];
  return frames === undefined ? undefined : Number(frames);
}

/**
 * Make the device present a scenario's declared viewport, one device pixel per CSS pixel.
 *
 * A scenario's `viewport` is a declared test condition, and the browser target honours it by
 * sizing the window. Without the same courtesy here, a UI page lays out at whatever CSS viewport
 * the device's density happens to give — 914x411 on a 2400x1080 panel at 420dpi — and a step
 * that names a point in viewport pixels lands on whatever the device's own layout put there.
 * Nothing about that failure looks like a coordinate problem: the touch arrives, the host
 * hit-tests it honestly, and the control simply is not where the scenario said.
 *
 * Density 160 is the whole mechanism: it makes `devicePixelRatio` 1, so a viewport pixel, a CSS
 * pixel and a device pixel are the same pixel and the page lays out exactly as it does on web.
 * The size is written in the panel's natural frame, which is why it is transposed for the
 * portrait-natural devices every phone and emulator here happens to be.
 */
export function viewportPresentationCommands(
  viewport: { height: number; width: number },
  physical: { height: number; width: number },
): string[][] {
  if (!(viewport.width > 0) || !(viewport.height > 0)) {
    throw new Error(
      `TN_PLAYTEST_ANDROID_VIEWPORT_INVALID: a scenario viewport of ${viewport.width}x${viewport.height} cannot be presented on a device.`,
    );
  }
  const short = Math.min(viewport.width, viewport.height);
  const long = Math.max(viewport.width, viewport.height);
  const naturallyPortrait = physical.height >= physical.width;
  const natural = naturallyPortrait ? `${short}x${long}` : `${long}x${short}`;
  // Orientation is the other half of presenting a viewport. The runtime's activity declares no
  // `screenOrientation`, so it takes whatever the device gives: the emulator gave landscape and
  // the Pixel 8, lying flat, gave portrait — the same build and the same size override, but a
  // 720x405 letterbox inside a portrait window. A 1280x720 viewport is a landscape viewport, and
  // a device showing it portrait is not presenting it.
  const quarterTurn = naturallyPortrait === viewport.width > viewport.height;
  return [
    ["shell", "wm", "size", natural],
    ["shell", "wm", "density", "160"],
    ["shell", "wm", "user-rotation", "lock", quarterTurn ? "1" : "0"],
  ];
}

/**
 * One OS-level tap, in the display's current orientation.
 *
 * With the viewport presented, that orientation *is* the scenario's viewport and the coordinate
 * needs no rotation — which is the second reason to prefer this over the emulator's pointer
 * protocol. The first is that `adb emu event send` exists only on emulators, and a click step
 * that only works on an emulator is a click step that does not work.
 */
export function tapCommand(x: number, y: number): string[] {
  return ["shell", "input", "tap", String(Math.round(x)), String(Math.round(y))];
}

/** Whether an input method window is on screen, from `dumpsys input_method`. */
export function keyboardIsShown(dump: string): boolean {
  return /\bmInputShown=true\b/u.test(dump);
}

/**
 * Undo the presentation.
 *
 * `reset` and never the numbers read beforehand: a run that crashed between reading and writing
 * would restore a size it had already replaced, and leave the device quietly wrong for whoever
 * measures on it next.
 */
export function viewportRestoreCommands(): string[][] {
  return [
    // Orientation first: freeing it while the display is still the test size lets the window
    // manager settle once, rather than once per reset.
    ["shell", "wm", "user-rotation", "free"],
    ["shell", "wm", "size", "reset"],
    ["shell", "wm", "density", "reset"],
  ];
}

export function rotatedTouchPosition(x: number, y: number, rotation: number): [number, number] {
  const normalized = rotation === 0
    ? [x, y]
    : rotation === 1
      ? [y, 1 - x]
      : rotation === 2
        ? [1 - x, 1 - y]
        : rotation === 3
          ? [1 - y, x]
          : undefined;
  if (normalized === undefined) throw new Error(`Android display rotation ${rotation} is invalid.`);
  return normalized.map((value) => Math.round(value * TOUCH_AXIS_MAX)) as [number, number];
}

function isMissingRemoteFile(error: unknown): boolean {
  const detail = error as Error & { stderr?: string; stdout?: string };
  return isMissingRemoteFileOutput(`${detail.stderr ?? ""}\n${detail.stdout ?? ""}`);
}

function isMissingRemoteFileOutput(output: string): boolean {
  return /No such file|not found/u.test(output);
}

function validateAndroidUser(user: string): string {
  const trimmed = user.trim();
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`TN_PLAYTEST_ANDROID_USER_INVALID: Android user must be numeric, got '${user}'.`);
  }
  return trimmed;
}

export function discoverAdb(environment: NodeJS.ProcessEnv = process.env): string {
  const executable = process.platform === "win32" ? "adb.exe" : "adb";
  const candidates = [
    environment.THREENATIVE_ADB,
    environment.ANDROID_SDK_ROOT === undefined
      ? undefined
      : join(environment.ANDROID_SDK_ROOT, "platform-tools", executable),
    environment.ANDROID_HOME === undefined
      ? undefined
      : join(environment.ANDROID_HOME, "platform-tools", executable),
    join(homedir(), "Android", "Sdk", "platform-tools", executable),
    join(homedir(), "Library", "Android", "sdk", "platform-tools", executable),
  ];
  const found = candidates.find((candidate): candidate is string =>
    candidate !== undefined && existsSync(candidate));
  if (found !== undefined) return found;
  if (environment.PATH?.split(process.platform === "win32" ? ";" : ":").some((directory) =>
    existsSync(join(directory, executable))) === true) return executable;
  throw new Error(
    "adb was not found. Install Android SDK Platform Tools, set ANDROID_HOME, or pass --adb /absolute/path/to/adb.",
  );
}

/** A bounded pause between device polls. Scenario steps are ticks; this is the OS settling. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
