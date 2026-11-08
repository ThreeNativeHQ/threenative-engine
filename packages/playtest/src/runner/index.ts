/**
 * Connect a Playwright page to a playtest bridge.
 * @situation run a browser scenario against a game
 * @situation inspect bridge diagnostics from a runner
 * @constraint the bridge must answer the handshake or the run fails
 * @example const bridge = await connectPlaytestBridge(page, scenario);
 */
export * from "./bridgeClient.js";
// `WEBGPU_BROWSER_ARGS` lives here. Without it an external consumer cannot reproduce the browser
// arguments this repository's own gates depend on — and a WebGPU run that reaches SwiftShader
// instead of the Vulkan driver reports healthy-looking numbers from a CPU rasteriser.
export { PERFORMANCE_BROWSER_ARGS, WEBGPU_BROWSER_ARGS } from "./browser.js";
export type { IBrowserPointerChange } from "./browser.js";
/**
 * Copy the selected Chromium arguments without silently enabling a rendering recipe.
 * @situation run a browser playtest with Vulkan WebGPU
 * @constraint pass WEBGPU_BROWSER_ARGS explicitly; undefined selects no additional arguments
 * @constraint inspect the observed adapter before claiming hardware GPU evidence
 * @example import { resolveBrowserArguments, WEBGPU_BROWSER_ARGS } from "@threenative/playtest/runner";
 * const args = resolveBrowserArguments(WEBGPU_BROWSER_ARGS);
 */
export { resolveBrowserArguments } from "./browser.js";
/**
 * Identify a software renderer in the fields reported by adapter.info.
 * @situation reject a SwiftShader adapter as evidence
 * @constraint undefined means no software name was found, not proof of a hardware adapter
 * @example import { softwareAdapterName } from "@threenative/playtest/runner";
 * const software = softwareAdapterName({ architecture: "swiftshader" });
 */
export { softwareAdapterName } from "./browser.js";
/**
 * The host-load reading and the rule that decides whether absolute milliseconds are trustworthy:
 * absolutes are invalid once the one-minute load passes half the cores.
 *
 * @situation mark a benchmark run invalid because the machine was busy
 * @constraint an unreadable load is a refusal, not a silence: an unmeasured machine cannot vouch
 * @example import { absolutesVerdict, readHostLoad } from "@threenative/playtest/runner";
 * const load = readHostLoad();
 * if (absolutesVerdict(load) === "invalid-absolute") ignoreAbsoluteMilliseconds();
 */
export {
  type IPerfHostLoad,
  type IPerfHostLoadReading,
  type IPerfHostLoadSource,
  absolutesVerdict,
  readHostLoad,
} from "./perf.js";
/**
 * Decide which display a pixel-producing run paints on, the same decision the runner makes.
 * @situation judge whether a measured frame rate came from a display that can carry one
 * @constraint a private Xvfb is software, so a rate read there measures the X server
 * @example import { decideDisplayStrategy } from "@threenative/playtest/runner";
 * const lane = decideDisplayStrategy({ env: process.env, platform: "linux" });
 * if (lane.kind === "private-xvfb") throw new Error("refuse to judge this frame rate");
 */
export { decideDisplayStrategy } from "./captureEnvironment.js";
export type { IDisplayStrategy } from "./captureEnvironment.js";
/**
 * Compare pointer snapshots and produce down, move, and up transitions.
 * @situation reconcile pointer contacts into down move and up events
 * @constraint returns changes only; the caller dispatches them and retains the next snapshot
 * @example import { reconcileBrowserPointers } from "@threenative/playtest/runner";
 * const changes = reconcileBrowserPointers(new Map(), [{ id: 1, x: 20, y: 30 }]);
 */
export { reconcileBrowserPointers } from "./browser.js";
/**
 * Drive and inspect Android playtest transport.
 * @situation run a scenario on an Android emulator or device
 * @situation parse Android console diagnostics
 * @constraint Android evidence must name its target and transport
 * @example const adb = discoverAdb(process.env);
 */
export * from "./android.js";
/**
 * Run a playtest on Android through the configured device transport.
 * @situation execute a scenario on an Android target
 * @situation collect Android playtest artifacts
 * @constraint the app bundle and device transport must be prepared
 * @example await runAndroidPlaytest(options);
 */
export * from "./androidRunner.js";
/**
 * Run a playtest on any device lane (Android, desktop or iOS) through its driver and transport.
 * @situation execute a scenario on a device target with a custom driver
 * @constraint the driver must prepare the app bundle and the transport must answer the handshake
 * @example await runDevicePlaytest(config, { name: "android", driver, transport, processName, mailboxPaths });
 */
export { runDevicePlaytest } from "./deviceRunner.js";
export type { IDevicePlaytestDriver, IDevicePlaytestTarget } from "./deviceRunner.js";
/**
 * Parse standalone playtest runner configuration.
 * @situation invoke the playtest CLI from a scaffold
 * @situation validate runner flags before launching a browser
 * @constraint invalid flags throw a named usage error
 * @example const config = parseStandalonePlaytestArgs(argv);
 */
export * from "./config.js";
/**
 * Drive a local desktop playtest mailbox.
 * @situation run a desktop target through the playtest protocol
 * @situation exchange observations with a native desktop host
 * @constraint the mailbox lifecycle must be disposed after the run
 * @example const driver = new DesktopPlaytestDriver(options);
 */
export * from "./desktop.js";
/**
 * Run a desktop playtest and collect its report.
 * @situation execute a scenario against the desktop host
 * @situation verify native desktop behavior from the same scenario
 * @constraint the desktop host must be built before launching
 * @example await runDesktopPlaytest(options);
 */
export * from "./desktopRunner.js";
/**
 * Initialize the standalone playtest files for a project.
 * @situation add the runner contract to a new game
 * @situation create a starter scenario fixture
 * @constraint generated scenarios must contain real assertions
 * @example await initStandalonePlaytest(projectPath);
 */
export * from "./init.js";
/**
 * Drive and inspect iOS simulator playtest transport.
 * @situation run a scenario on the iOS simulator
 * @situation parse the launched native process identifier
 * @constraint simulator evidence does not claim physical-device proof
 * @example const driver = new XcrunIosDriver(options);
 */
export * from "./ios.js";
/**
 * Run a playtest on the iOS simulator or device transport.
 * @situation execute a scenario on an iOS target
 * @situation collect iOS playtest artifacts
 * @constraint identify simulator versus physical transport in evidence
 * @example await runIosPlaytest(options);
 */
export * from "./iosRunner.js";
/**
 * Convert captured runner observations into a replay scenario.
 * @situation preserve a failing playtest as a replay fixture
 * @situation require assertions before recording a scenario
 * @constraint an empty assertion set is a failure
 * @example const scenario = recordToScenario(recording);
 */
export * from "./recording.js";
/**
 * Execute scenario steps, assertions, and evidence capture.
 * @situation run a complete browser or device playtest
 * @situation capture diagnostics and screenshots from a managed server
 * @constraint missing observations and malformed assertions fail closed
 * @example const report = await runStandalonePlaytest(options);
 */
export * from "./runner.js";
/**
 * Parse and explain bounded shader-compilation captures.
 * @situation diagnose a slow shader-heavy launch from one browser or native capture
 * @situation reconcile pipeline creation counts and compile timing
 * @constraint incomplete or malformed captures never become a successful empty report
 * @example summarizePipelineCapture(parsePipelineCapture(captureText));
 */
export * from "./pipeline-summary.js";
/**
 * Resolve a native device transport and its mailbox paths.
 * @situation connect a native host to the playtest runner
 * @situation validate an Android or iOS device endpoint
 * @constraint paths stay inside the managed artifact directory
 * @example const paths = deviceMailboxPaths(projectRoot);
 */
export * from "./deviceTransport.js";

/**
 * Capture a ready ThreeNative game with the runner's display, lock, server and browser ownership.
 * @situation write a custom browser capture without owning Xvfb or Chromium cleanup
 * @constraint browser only; requires a scenario and runtime.startup; does not execute scenario steps or assertions
 * @constraint cancellation is checked between resource acquisitions; lock waiting retains its own bounded queue policy
 * @constraint use session.screenshot for nonblank PNGs; private-display captures are not FPS evidence
 * @constraint use threenative-playtest trace --url <url> for slow-frame attribution instead of creating another profiler
 * @example import { parseStandalonePlaytestArgs, withBrowserCapture } from "@threenative/playtest/runner";
 * const config = parseStandalonePlaytestArgs(["--scenario", "playtests/smoke.playtest.json", "--url", "http://127.0.0.1:5173"]);
 * await withBrowserCapture(config, async (session) => session.screenshot("ready"));
 */
export { withBrowserCapture } from "./captureSession.js";
export type { IBrowserCaptureSession } from "./captureSession.js";
