import assert from "node:assert/strict";

/** Keep failure diagnosis useful without publishing arbitrary browser/host messages. */
export function fluidConsumerFailureDiagnostics(
  diagnostics: readonly { code: string; message?: string }[] | undefined,
) {
  const known = new Set([
    "TN_PLAYTEST_OPERATION_TIMEOUT",
    "TN_PLAYTEST_SOFTWARE_DEVICE_LOST",
    "TN_PLAYTEST_RESOURCE_ASSERTION_FAILED",
    "TN_PLAYTEST_CONSOLE_ERROR",
    "TN_PLAYTEST_BRIDGE_MISSING",
    "TN_CAPTURE_BLANK",
    "TN_PLAYTEST_ASSERTION_NOT_EVALUATED",
  ]);
  return (
    diagnostics?.slice(0, 16).map(({ code, message }) => {
      const safeCode = known.has(code) ? code : "UNRECOGNIZED_DIAGNOSTIC";
      const match =
        code === "TN_PLAYTEST_OPERATION_TIMEOUT" &&
        message?.match(
          /^Bridge operation '(advance|sample|ready|describe|setup|drainEvents)' exceeded ([1-9][0-9]{0,8})ms\.$/u,
        );
      return match
        ? { code: safeCode, operation: match[1], timeoutMs: Number(match[2]) }
        : { code: safeCode };
    }) ?? null
  );
}

/** Bounded technical failure evidence; full raw console remains in the local artifact directory. */
export function fluidConsumerFailureEvidence(
  report:
    | {
        capture?: { rendererKind?: string; adapter?: object };
        observations?: { console?: readonly { source?: string; type: string; text: string }[] };
        assertionResults?: readonly { id?: string; pass: boolean }[];
      }
    | undefined,
  error: unknown,
) {
  const console = report?.observations?.console;
  const lossConsole =
    console?.filter(({ text }) =>
      /TN_DEVICE_LOST|WebGPU Device Lost|A valid external Instance reference no longer exists|Instance dropped in popErrorScope/iu.test(
        text,
      ),
    ) ?? [];
  return {
    reportReturned: report !== undefined,
    consoleAvailable: console !== undefined,
    lossConsoleTruncated: lossConsole.length > 16,
    lossConsole: lossConsole.slice(0, 16).map(({ source, type, text }) => ({
      source:
        source === "browser-console" || source === "page-error" ? source : "unrecognized-source",
      type: ["error", "assert", "pageerror", "warning"].includes(type) ? type : "unrecognized-type",
      text: sanitizeFluidFailureText(text, 1024),
    })),
    rendererKind: report?.capture?.rendererKind ?? null,
    adapter:
      report?.capture?.adapter === undefined
        ? null
        : Object.fromEntries(
            Object.entries(report.capture.adapter)
              .filter(
                ([key, value]) =>
                  ["vendor", "architecture", "device", "description"].includes(key) &&
                  typeof value === "string",
              )
              .map(([key, value]) => [key, sanitizeFluidFailureText(String(value), 256)]),
          ),
    assertions:
      report?.assertionResults?.slice(0, 32).map(({ id, pass }) => ({ id, pass })) ?? null,
    thrownError:
      error === undefined
        ? null
        : {
            name: error instanceof Error ? sanitizeFluidFailureText(error.name, 128) : "NonError",
            message: sanitizeFluidFailureText(
              error instanceof Error ? error.message : String(error),
              2048,
            ),
            stack:
              error instanceof Error && error.stack !== undefined
                ? sanitizeFluidFailureText(error.stack, 4096)
                : null,
          },
  };
}

function sanitizeFluidFailureText(value: string, limit: number): string {
  return value
    .replace(/authorization\s*[=:][^\r\n]*/giu, "authorization: <redacted>")
    .replace(
      /((?:token|password|secret|api[_-]?key)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
      "$1<redacted>",
    )
    .replace(/(?:https?:|file:)\/\/[^\s"'<>]+/giu, "<redacted-url>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "<redacted-email>")
    .replace(/[A-Z]:[\\/][^\s"'<>]+|(?:\.{1,2}\/|\/)[^\s"'<>]+/giu, "<redacted-path>")
    .slice(0, limit);
}

/** Software rendering can prove the solver result, never the hardware frame-time criterion. */
export function assertFluidOutcome(
  report: {
    readonly pass: boolean;
    readonly diagnostics: readonly { readonly code: string }[];
    readonly assertionResults?: readonly { readonly id?: string; readonly pass: boolean }[];
    readonly capture?: {
      readonly rendererKind?: string;
      readonly adapter?: object;
    };
  },
  expectedFailure?: string,
): void {
  const unexpected = report.diagnostics.filter(
    ({ code }) => expectedFailure === undefined || code !== "TN_PLAYTEST_RESOURCE_ASSERTION_FAILED",
  );
  assert.equal(
    unexpected.length,
    0,
    `fluid collision diagnostics: ${report.diagnostics.map(({ code }) => code).join(", ")}`,
  );
  assert.equal(
    report.pass,
    expectedFailure === undefined,
    "fluid collision run failed its expected outcome",
  );
  assert.ok(
    report.assertionResults !== undefined && report.assertionResults.length > 0,
    "fluid collision assertions must exist",
  );
  assert.deepEqual(
    report.assertionResults.filter(({ pass }) => !pass).map(({ id }) => id),
    expectedFailure === undefined ? [] : [expectedFailure],
    "fluid collision assertions must match the exact expected failures",
  );
  assert.equal(
    report.diagnostics.length,
    expectedFailure === undefined ? 0 : 1,
    "fluid collision requires the exact expected diagnostic count",
  );
}

export function assertFluidCapture(
  report: Parameters<typeof assertFluidOutcome>[0],
  expectedFailure?: string,
): void {
  assertFluidOutcome(report, expectedFailure);
  assert.equal(report.capture?.rendererKind, "webgpu", "fluid collision requires actual WebGPU");
  assert.ok(
    Object.values(report.capture?.adapter ?? {}).some(
      (value) => typeof value === "string" && value.trim().length > 0,
    ),
    "fluid collision requires an identified adapter",
  );
}
