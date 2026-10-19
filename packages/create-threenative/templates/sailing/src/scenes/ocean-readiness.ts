import type { ICtx, SpectralOcean } from "@threenative/core";

// Match the existing startup hold deadline; the contract test guards this against core drift.
const HEIGHT_READBACK_BUDGET_MS = 45_000;
let nextHold = 0;

/** Keep the initial loading curtain up until the sea has an authoritative CPU height. */
export function holdOceanHeight(
  ctx: Pick<ICtx, "beforeRender" | "startup">,
  ocean: Pick<SpectralOcean, "process" | "sampleHeight">,
): () => void {
  // Startup is a one-time gate. A later scene restart uses the ordinary compute lifecycle.
  if (ctx.startup.phase === "ready") return () => undefined;
  let active = true;
  let dispatched = false;
  let removeObserver: () => void = () => undefined;
  let finishWork: () => void = () => undefined;
  const work = new Promise<void>((resolve) => {
    finishWork = resolve;
  });
  const stop = (): void => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    removeObserver();
    finishWork();
  };
  const fail = (reason: unknown): void => {
    if (!active) return;
    console.error(
      "TN_SAILING_HEIGHT_READBACK_FAILED",
      reason instanceof Error ? reason.message : String(reason),
    );
    stop();
  };
  // Register this timer before hold(): a failed sample must be reported before the gate fails open.
  const timer = setTimeout(
    () => fail("No finite ocean height sample arrived within the startup budget."),
    HEIGHT_READBACK_BUDGET_MS,
  );
  removeObserver = ctx.beforeRender(() => {
    if (!active || !dispatched) return;
    try {
      const sample = ocean.sampleHeight(0, 0);
      if (sample !== undefined && Number.isFinite(sample.height)) stop();
    } catch (error) {
      fail(error);
    }
  });
  try {
    ctx.startup.hold(`sailing-ocean-height-${++nextHold}`, work);
  } catch (error) {
    stop();
    throw error;
  }
  // Waiting on whenReady() here would make the hold wait on itself. Compilation and the frame
  // window finish independently; one dispatch then primes the copy without advancing game time.
  void ctx.startup.whenFrameworkReady().then(() => {
    if (!active) return;
    try {
      dispatched = true;
      ocean.process();
    } catch (error) {
      fail(error);
    }
  }, fail);
  return stop;
}
