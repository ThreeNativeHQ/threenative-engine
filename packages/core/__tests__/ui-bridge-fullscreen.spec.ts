import { describe, expect, it } from "vitest";
import { FULLSCREEN_MESSAGE, connectUiBridge } from "../src/ui-bridge.js";

/**
 * A native host's UI page: the web view is the game window's HUD, so the page's Fullscreen API must
 * switch the game window through the host (the frame stops there), not fill the web view.
 *
 * The mutations that redden this file: remove `installHostFullscreen` from `connectUiBridge`, its
 * loopback guard, or the resize listener's removal on `close()`.
 */
function page(innerWidth: number, innerHeight: number) {
  const sent: string[] = [];
  const events: string[] = [];
  const resize: Array<() => void> = [];
  const root = { tagName: "HTML" };
  const document = {
    documentElement: root,
    dispatchEvent: (event: { type: string }) => events.push(event.type),
  };
  const scope: Record<string, unknown> = {
    ipc: { postMessage: (frame: string) => sent.push(frame) },
    document,
    screen: { width: 1920, height: 1080 },
    innerWidth,
    innerHeight,
    Event: class {
      constructor(readonly type: string) {}
    },
    addEventListener: (type: string, listener: () => void) =>
      type === "resize" && resize.push(listener),
    removeEventListener: (type: string, listener: () => void) =>
      type === "resize" && resize.splice(resize.indexOf(listener), 1),
  };
  return { scope, sent, events, root, document: document as Record<string, unknown>, resize };
}

describe("ui bridge fullscreen on a native host", () => {
  it("asks the host to switch the game window and reports the window's state", async () => {
    const { scope, sent, events, root, document, resize } = page(1024, 700);
    connectUiBridge({ end: "ui", scope });

    expect(document.fullscreenElement).toBeNull();
    await (root as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen();
    expect(sent.map((frame) => JSON.parse(frame))).toContainEqual({
      type: FULLSCREEN_MESSAGE,
      on: true,
    });

    // The host switched the window: the page now fills the screen.
    scope.innerWidth = 1920;
    scope.innerHeight = 1080;
    for (const listener of resize) listener();
    expect(document.fullscreenElement).toBe(root);
    expect(events).toEqual(["fullscreenchange"]);

    await (document.exitFullscreen as () => Promise<void>)();
    expect(JSON.parse(sent.at(-1) ?? "{}")).toEqual({ type: FULLSCREEN_MESSAGE, on: false });
  });

  it("leaves the browser's own Fullscreen API alone on the web", () => {
    const { scope, root } = page(1024, 700);
    scope.ipc = undefined;
    connectUiBridge({ end: "ui", scope });
    expect((root as Record<string, unknown>).requestFullscreen).toBeUndefined();
  });

  it("leaves the browser's Fullscreen API alone under the web loopback", () => {
    const { scope, root } = page(1024, 700);
    scope.ipc = undefined;
    scope.location = { search: "?tnUiLoopback=1" };
    const bridge = connectUiBridge({ end: "ui", scope });
    expect(bridge.transport).toBe("host");
    expect((root as Record<string, unknown>).requestFullscreen).toBeUndefined();
    bridge.close();
    (scope.__tnUiLoopback as { close: () => void }).close();
  });

  it("stops watching the window when the bridge closes", () => {
    const { scope, resize } = page(1024, 700);
    const bridge = connectUiBridge({ end: "ui", scope });
    expect(resize).toHaveLength(1);
    bridge.close();
    expect(resize).toHaveLength(0);
  });
});
