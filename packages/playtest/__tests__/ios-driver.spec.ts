import { makeTempDir } from "../../../test-support/temp-dir.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

import { parseLaunchedPid, XcrunIosDriver } from "../src/runner/ios.js";

// The shape `simctl listapps` prints: an old-style plist keyed by bundle identifier, with nested
// dictionaries ahead of `Path`, and `Path` unquoted when it holds only path characters.
const listed = (bundleId: string, path: string) =>
  `{\n    "com.apple.Bridge" =     {\n        ApplicationType = System;\n        Path = "/Applications/Bridge.app";\n    };\n` +
  `    "${bundleId}" =     {\n        ApplicationType = User;\n        CFBundleIdentifier = "${bundleId}";\n` +
  `        GroupContainers =         {\n        };\n        Path = ${path};\n        SBAppTags =         (\n        );\n    };\n}\n`;

// The simulator's app list around one `simctl install`: the previous bundle until the install
// call, then whatever `afterInstall` lists, one entry per poll, repeating the last.
function simulatorApps(bundleId: string, afterInstall: readonly string[] = ["/Bundle/Application/NEW/ThreeNative.app"]) {
  let installed = false;
  let polls = 0;
  return (args: readonly string[]): string | undefined => {
    if (args[1] === "install") installed = true;
    if (args[1] !== "listapps") return undefined;
    if (!installed) return listed(bundleId, "/Bundle/Application/OLD/ThreeNative.app");
    return listed(bundleId, afterInstall[Math.min(polls++, afterInstall.length - 1)]!);
  };
}

test("simctl installs, launches with mailbox environment, and uses the app data container", async () => {
  const root = await makeTempDir("playtest-ios-driver-");
  const appPath = join(root, "ThreeNative.app");
  const container = join(root, "data-container");
  await mkdir(appPath);
  const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  const apps = simulatorApps("dev.threenative.runtime");
  const driver = new XcrunIosDriver({
    appPath,
    bundleId: "dev.threenative.runtime",
    device: "SIM-123",
    transport: "simulator",
  }, async (args, options) => {
    calls.push({ args, env: options?.env });
    const app = apps(args);
    if (app !== undefined) return app;
    if (args[1] === "get_app_container") return `${container}\n`;
    if (args[1] === "launch") return `dev.threenative.runtime: ${process.pid}\n`;
    if (args.includes("log")) return '[info] TN_UI_SAMPLE:{"sequence":321}\n[error] broken user script\n[info] {"failed":0}\n';
    return "";
  });

  await driver.prepare("http://127.0.0.1:41777/playtest");
  await expect(driver.isAlive()).resolves.toBe(true);

  expect(driver.getMailboxRoot()).toBe(join(container, "Documents"));
  expect(calls.map(({ args }) => args.slice(0, 2))).toEqual([
    ["simctl", "bootstatus"],
    ["simctl", "listapps"],
    ["simctl", "install"],
    ["simctl", "listapps"],
    ["simctl", "get_app_container"],
    ["simctl", "terminate"],
    ["simctl", "launch"],
  ]);
  const launch = calls.at(-1);
  expect(launch?.env?.SIMCTL_CHILD_TN_PLAYTEST_ENDPOINT).toBe("http://127.0.0.1:41777/playtest");
  expect(launch?.env?.SIMCTL_CHILD_TN_PLAYTEST_MAILBOX_ROOT).toBe(join(container, "Documents"));
  await expect(driver.captureConsole()).resolves.toEqual([
    { text: '[info] TN_UI_SAMPLE:{"sequence":321}', type: "log" },
    { text: "[error] broken user script", type: "error" },
    { text: '[info] {"failed":0}', type: "log" },
  ]);
  expect(calls.at(-1)?.args).toContain(`processIdentifier == ${process.pid}`);
});

test("a simulator launch waits until the newly installed bundle replaces the dead one", async () => {
  const root = await makeTempDir("playtest-ios-install-");
  const appPath = join(root, "ThreeNative.app");
  await mkdir(appPath);
  const listedAtLaunch: Array<string | undefined> = [];
  let lastListed: string | undefined;
  const apps = simulatorApps("dev.threenative.runtime", [
    "/data/Library/Caches/com.apple.containermanagerd/Dead/temp.X/OLD/ThreeNative.app",
    "/Bundle/Application/OLD/ThreeNative.app",
    "/Bundle/Application/NEW/ThreeNative.app",
  ]);
  const driver = new XcrunIosDriver({
    appPath,
    bundleId: "dev.threenative.runtime",
    device: "SIM-123",
    transport: "simulator",
  }, async (args) => {
    const app = apps(args);
    if (app !== undefined) {
      lastListed = [...app.matchAll(/Path = (\S+);/gu)].at(-1)?.[1];
      return app;
    }
    if (args[1] === "get_app_container") return join(root, "container");
    if (args[1] === "launch") {
      listedAtLaunch.push(lastListed);
      return "dev.threenative.runtime: 22";
    }
    return "";
  });

  await driver.prepare("http://127.0.0.1:41777/playtest");

  expect(listedAtLaunch).toEqual(["/Bundle/Application/NEW/ThreeNative.app"]);
});

test("iOS console classifies Apple-subsystem records as logs and real app errors as errors", async () => {
  const root = await makeTempDir("playtest-ios-severity-");
  const appPath = join(root, "ThreeNative.app");
  const container = join(root, "data-container");
  await mkdir(appPath);

  // The six `[com.apple.*]` records the failed simulator run wrote at launch. The first even
  // stamps `E`, so a rule that trusts the OS severity token fails the run on the OS talking about
  // itself. All six are logs.
  const launchMeasurementError =
    "2026-09-22 15:07:18.566 E  threenative-ios[40455:17aa3] [com.apple.app_launch_measurement:General] Failed to send CA Event for app launch measurements for ca_event_type: 0 event_name: com.apple.app_launch_measurement.FirstFramePresentationMetric";
  const factoryWarning =
    "2026-09-22 15:07:18.500 Df threenative-ios[40455:17a9f] [com.apple.runtime:CFBundle] AddInstanceForFactory: No factory registered for id <CFUUID>";
  const loudnessPlist =
    "2026-09-22 15:07:18.601 Df threenative-ios[40455:17a9f] [com.apple.coreaudio:LoudnessManager] ReadPListFile: could not read the loudness plist";
  const hardwarePlatformKey =
    "2026-09-22 15:07:18.602 Df threenative-ios[40455:17a9f] [com.apple.coreaudio:General] GetHardwarePlatformKey returned an unknown key";
  const hardwareSupportedFirst =
    "2026-09-22 15:07:18.603 Df threenative-ios[40455:17a9f] [com.apple.coreaudio:General] IsHardwareSupported: false";
  const hardwareSupportedSecond =
    "2026-09-22 15:07:18.604 Df threenative-ios[40455:17a9f] [com.apple.coreaudio:General] IsHardwareSupported: true";
  const assetManagerDefault =
    `2026-09-22 15:07:18.517 Df threenative-ios[40455:17a9f] [com.apple.UIKit:AssetManager] Could not load asset catalog from bundle NSBundle </Users/runner/threenative-ios.app> (loaded): Error Domain=NSCocoaErrorDomain Code=260 "couldn't find Assets.car"`;

  // The app's own subsystem, however it is transported: an `E` record with no error keyword, a JS
  // marker on a Default record, and an uncaught exception. Every one is a real console error.
  const appErrorNoKeyword =
    "2026-09-22 15:07:19.100 E  threenative-ios[40455:17a9f] [dev.threenative.runtime:render] bindings frame submission failed";
  const appMarkerInDefault =
    "2026-09-22 15:07:19.200 Df threenative-ios[40455:17a9f] [com.apple.Foundation:general] [error] TN_UI bridge failed";
  const uncaughtException =
    "2026-09-22 15:07:19.300 E  threenative-ios[40455:17a9f] [dev.threenative.runtime:game] Uncaught TypeError: cannot read properties of undefined";
  // A fault is never launch noise: an OS subsystem faulting inside the app's process (Metal,
  // WebKit) is the game breaking, so `F` stays an error even under `com.apple.*`.
  // WebKit stamps slow helper-process launches `F` on a loaded simulator; that is the OS reporting
  // its own timing, not the game failing, so an Apple fault needs a failure word to count.
  const slowWebKitLaunch =
    "2026-09-23 11:39:52.815 F  threenative-ios[85320:32404] [com.apple.WebKit:Process] GPU process (0x1111741e0) took 3.295754 seconds to launch";
  const appleFault =
    "2026-09-22 15:07:19.400 F  threenative-ios[40455:17a9f] [com.apple.Metal:device] Execution of the command buffer was aborted due to an error during execution";
  // The iOS overlay's document-start probe: ready/first-state are plain logs, while a page error
  // carries the `[error]` marker so the run fails with the page's own message.
  const uiPageReady =
    '2026-09-23 14:10:45.300 Df threenative-ios[61943:23880] TN_UI_PAGE:{"type":"tn:ui-diagnostic","event":"ready"}';
  const uiPageFirstState =
    '2026-09-23 14:10:45.301 Df threenative-ios[61943:23880] TN_UI_PAGE:{"type":"tn:ui-diagnostic","event":"first-state"}';
  const apps = simulatorApps("dev.threenative.runtime");
  const uiPageError =
    '2026-09-23 14:10:45.302 Df threenative-ios[61943:23880] TN_UI_PAGE [error]: {"type":"tn:ui-diagnostic","event":"error","kind":"onerror","message":"Uncaught ReferenceError: React is not defined"}';

  const driver = new XcrunIosDriver({
    appPath,
    bundleId: "dev.threenative.runtime",
    device: "SIM-123",
    transport: "simulator",
  }, async (args) => {
    const app = apps(args);
    if (app !== undefined) return app;
    if (args[1] === "get_app_container") return `${container}\n`;
    if (args[1] === "launch") return `dev.threenative.runtime: ${process.pid}\n`;
    if (args.includes("log")) {
      return `${[
        launchMeasurementError,
        factoryWarning,
        loudnessPlist,
        hardwarePlatformKey,
        hardwareSupportedFirst,
        hardwareSupportedSecond,
        assetManagerDefault,
        appErrorNoKeyword,
        appMarkerInDefault,
        uncaughtException,
        appleFault,
        slowWebKitLaunch,
        uiPageReady,
        uiPageFirstState,
        uiPageError,
      ].join("\n")}\n`;
    }
    return "";
  });

  await driver.prepare("http://127.0.0.1:41777/playtest");
  await expect(driver.captureConsole()).resolves.toEqual([
    { text: launchMeasurementError, type: "log" },
    { text: factoryWarning, type: "log" },
    { text: loudnessPlist, type: "log" },
    { text: hardwarePlatformKey, type: "log" },
    { text: hardwareSupportedFirst, type: "log" },
    { text: hardwareSupportedSecond, type: "log" },
    { text: assetManagerDefault, type: "log" },
    { text: appErrorNoKeyword, type: "error" },
    { text: appMarkerInDefault, type: "error" },
    { text: uncaughtException, type: "error" },
    { text: appleFault, type: "error" },
    { text: slowWebKitLaunch, type: "log" },
    { text: uiPageReady, type: "log" },
    { text: uiPageFirstState, type: "log" },
    { text: uiPageError, type: "error" },
  ]);
});

test("simulator mailbox paths are remapped after simctl resolves the container", async () => {
  const root = await makeTempDir("playtest-ios-mailbox-");
  const appPath = join(root, "ThreeNative.app");
  const container = join(root, "container");
  await mkdir(appPath);
  const apps = simulatorApps("dev.example");
  const driver = new XcrunIosDriver({ appPath, bundleId: "dev.example", transport: "simulator" }, async (args) => {
    const app = apps(args);
    if (app !== undefined) return app;
    if (args[1] === "get_app_container") return container;
    if (args[1] === "launch") return "dev.example: 22";
    return "";
  });
  await driver.prepare("http://127.0.0.1:41777/playtest");

  await driver.writeFile("/placeholder/tn-playtest-request.json", "request");
  await writeFile(join(container, "Documents", "tn-playtest-response.json"), "response");

  await expect(driver.readFile("/placeholder/tn-playtest-response.json")).resolves.toBe("response");
  await expect(driver.readFile("/placeholder/tn-playtest-request.json")).resolves.toBe("request");
  await driver.removeFile("/placeholder/tn-playtest-response.json");
  await expect(driver.readFile("/placeholder/tn-playtest-response.json")).resolves.toBeUndefined();
});

test("devicectl mode requires an explicit physical device and uses install plus process launch", async () => {
  const root = await makeTempDir("playtest-ios-device-");
  const appPath = join(root, "ThreeNative.app");
  await mkdir(appPath);
  const calls: readonly string[][] = [];
  const driver = new XcrunIosDriver({
    appPath,
    bundleId: "dev.example",
    device: "PHONE-123",
    transport: "device",
  }, async (args) => {
    (calls as string[][]).push([...args]);
    return args.includes("launch") ? "Launched application with pid 9001" : "";
  });

  await driver.prepare("http://127.0.0.1:41777/playtest");

  expect(calls[0]).toEqual(expect.arrayContaining(["devicectl", "install", "PHONE-123", appPath]));
  expect(calls[1]).toEqual(expect.arrayContaining(["devicectl", "launch", "--terminate-existing", "PHONE-123", "dev.example"]));
});

test("launch parsing and a missing app fail closed", async () => {
  expect(() => parseLaunchedPid("launch succeeded without an id")).toThrow(/process id/u);
  const driver = new XcrunIosDriver({
    appPath: "/missing/ThreeNative.app",
    bundleId: "dev.example",
    transport: "simulator",
  }, async () => "");
  await expect(driver.prepare("http://127.0.0.1:41777/playtest")).rejects.toThrow(/not found/u);
  await expect(driver.captureConsole()).rejects.toThrow(/launched process/u);
});
