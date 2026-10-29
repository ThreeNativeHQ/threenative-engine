import { type ILaunchFailure, onLaunchFailure } from "@threenative/core";

const RETRIED = "strata-device-retry";

interface IFailureElement {
  textContent: string | null;
  readonly style: { cssText: string };
  setAttribute(name: string, value: string): void;
}

export interface ILaunchFailurePage {
  readonly document: {
    createElement(tag: "pre"): IFailureElement;
    readonly body: { append(element: IFailureElement): void };
  };
  readonly location: { reload(): void };
  readonly navigator: { readonly webdriver?: boolean };
  readonly sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

/**
 * Says why the launch stopped, on the page. The loading screen is drawn with WebGPU, so a lost
 * device cannot draw its own error and the player saw a blank screen forever. A lost device
 * reloads once for a fresh GPU process; under automation it never does, so a playtest still fails.
 */
export function showLaunchFailures(
  page: ILaunchFailurePage = globalThis as unknown as ILaunchFailurePage,
  subscribe: (listener: (failure: ILaunchFailure) => void) => () => void = onLaunchFailure,
): { ready(): void } {
  let box: IFailureElement | undefined;
  const storage = (use: (store: ILaunchFailurePage["sessionStorage"]) => unknown) => {
    try {
      return use(page.sessionStorage);
    } catch {
      return undefined;
    }
  };
  subscribe((failure) => {
    if (
      failure.kind === "device-lost" &&
      page.navigator.webdriver !== true &&
      storage((store) => store.getItem(RETRIED)) === null
    ) {
      storage((store) => store.setItem(RETRIED, "1"));
      page.location.reload();
      return;
    }
    if (box === undefined) {
      box = page.document.createElement("pre");
      box.setAttribute("role", "alert");
      box.style.cssText =
        "position:fixed;inset:auto 16px 16px;margin:0;padding:12px;white-space:pre-wrap;" +
        "font:14px/1.4 monospace;color:#fff;background:#000c;border-radius:6px;z-index:10";
      page.document.body.append(box);
    }
    box.textContent = failure.message;
  });
  return { ready: () => storage((store) => store.removeItem(RETRIED)) };
}
