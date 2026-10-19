export type PlaytestDiagnosticCode =
  | "TN_PLAYTEST_ANDROID_LIFECYCLE_NOT_APPLIED"
  | "TN_PLAYTEST_ANDROID_LIFECYCLE_PHYSICS_UNOBSERVED"
  | "TN_PLAYTEST_ANDROID_LIFECYCLE_SESSION_CHANGED"
  | "TN_PLAYTEST_ANDROID_LIFECYCLE_UNOBSERVED"
  | "TN_PLAYTEST_BRIDGE_INCOMPATIBLE"
  | "TN_PLAYTEST_BRIDGE_CAPABILITY_UNKNOWN"
  | "TN_PLAYTEST_BRIDGE_MISSING"
  | "TN_PLAYTEST_BRIDGE_NOT_READY"
  | "TN_PLAYTEST_CAPTURE_PROVENANCE_MISSING"
  | "TN_PLAYTEST_CAPABILITY_MISSING"
  | "TN_PLAYTEST_DEVICE_FAILED"
  | "TN_PLAYTEST_HOST_EXITED"
  | "TN_PLAYTEST_MAILBOX_POLL_STALLED"
  | "TN_PLAYTEST_OBSERVATION_UNAVAILABLE"
  | "TN_PLAYTEST_OPERATION_TIMEOUT"
  | "TN_PLAYTEST_PAGE_CLOSED"
  | "TN_PLAYTEST_PAGE_CRASHED"
  | "TN_PLAYTEST_PAGE_NAVIGATED"
  | "TN_PLAYTEST_PAYLOAD_TOO_LARGE"
  | "TN_PLAYTEST_SERVER_FAILED"
  | "TN_PLAYTEST_SETUP_UNAPPLIED"
  | "TN_PLAYTEST_START_TICK_INVALID"
  | "TN_PLAYTEST_STARTUP_ABORTED"
  | "TN_PLAYTEST_STARTUP_HOST_EXITED"
  | "TN_PLAYTEST_STARTUP_NOT_READY"
  | "TN_PLAYTEST_UNSUPPORTED_ON_TARGET";

export interface IPlaytestProtocolDiagnostic {
  capability?: string;
  code: PlaytestDiagnosticCode;
  fix: {
    instruction: string;
    nextCommand?: string;
  };
  message: string;
  path?: string;
  severity: "error";
}

export function playtestDiagnostic(
  code: PlaytestDiagnosticCode,
  message: string,
  instruction: string,
  details: Pick<IPlaytestProtocolDiagnostic, "capability" | "path"> & { nextCommand?: string } = {},
): IPlaytestProtocolDiagnostic {
  return {
    ...(details.capability === undefined ? {} : { capability: details.capability }),
    code,
    fix: {
      instruction,
      ...(details.nextCommand === undefined ? {} : { nextCommand: details.nextCommand }),
    },
    message,
    ...(details.path === undefined ? {} : { path: details.path }),
    severity: "error",
  };
}
