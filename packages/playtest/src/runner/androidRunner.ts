import { AdbAndroidDriver, type IAndroidDriver } from "./android.js";
import type { IStandalonePlaytestConfig } from "./config.js";
import { runDevicePlaytest } from "./deviceRunner.js";
import { withTargetAbortSignal } from "./deviceSignal.js";
import { androidMailboxPaths, type IDevicePlaytestTransport } from "./deviceTransport.js";
import type { IStandalonePlaytestReport } from "./shared.js";

/** The Android lane: an adb-backed driver handed to the shared device flow in `deviceRunner.ts`. */
export interface IAndroidPlaytestDependencies {
  abortSignal?: AbortSignal;
  driver?: IAndroidDriver;
  transport?: IDevicePlaytestTransport;
}

export async function runAndroidPlaytest(
  config: IStandalonePlaytestConfig,
  dependencies: IAndroidPlaytestDependencies = {},
): Promise<IStandalonePlaytestReport> {
  const android = config.android ?? {
    activity: ".MystralActivity",
    packageName: "com.mystral.engine",
  };
  const driver = dependencies.driver ?? new AdbAndroidDriver({
    ...android,
    ...(config.adbPath === undefined ? {} : { adbPath: config.adbPath }),
    ...(config.touchRotation === undefined ? {} : { touchRotation: config.touchRotation }),
    ...(config.device === undefined ? {} : { serial: config.device }),
  });
  const mailboxRoot = config.mailboxRoot ?? `/sdcard/Android/data/${android.packageName}/files`;
  return withTargetAbortSignal("android", (abortSignal) => runDevicePlaytest({ ...config, mailboxRoot }, {
    abortSignal: abortSignal,
    driver,
    mailboxPaths: androidMailboxPaths(android.packageName, mailboxRoot),
    name: "android",
    processName: android.packageName,
    ...(dependencies.transport === undefined ? {} : { transport: dependencies.transport }),
  }), dependencies.abortSignal);
}
