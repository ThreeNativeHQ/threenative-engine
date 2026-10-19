import {
  type IUiStatePublisher,
  UI_DEV_METRICS_MESSAGE,
  connectUiBridge,
  onUiIntent,
  publishUiState,
} from "@threenative/core/ui-layer";
import { createElement } from "react";
import { type ReactTestRenderer, act, create } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vitest";
import { UiLayer, useUiIntent, useUiState } from "../src/UiLayer.js";

function installDocument(): () => void {
  const documentLike = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelectorAll: () => [],
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentLike });
  return () => Reflect.deleteProperty(globalThis, "document");
}

async function flush(times = 4): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) await Promise.resolve();
  });
}

describe("UiLayer", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
  });

  it("throws TN_UI_LAYER_MISSING when a hook renders outside the provider", () => {
    function StateProbe() {
      useUiState();
      return null;
    }
    expect(() =>
      act(() => {
        create(createElement(StateProbe));
      }),
    ).toThrow("TN_UI_LAYER_MISSING");

    function IntentProbe() {
      useUiIntent();
      return null;
    }
    expect(() =>
      act(() => {
        create(createElement(IntentProbe));
      }),
    ).toThrow("TN_UI_LAYER_MISSING");
  });

  it("mirrors published state through the real bridge and announces ready with the region count", async () => {
    const restore = installDocument();
    const gameBridge = connectUiBridge({ end: "game" });
    const intents: { intent: string; payload: unknown }[] = [];
    onUiIntent(gameBridge, (intent, payload) => intents.push({ intent, payload }));

    let hull = 100;
    const publisher: IUiStatePublisher = publishUiState<{ hull: number }>(gameBridge, {
      getState: () => ({ hull }),
      subscribe: () => () => undefined,
    });

    function Hud() {
      const value = useUiState<{ hull: number }>((state) => state.hull);
      return createElement("span", null, `hull:${String(value)}`);
    }

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(UiLayer, null, createElement(Hud)));
      await flush();
    });

    const ready = intents.find((entry) => entry.intent === "tn:ready");
    expect(ready).toBeDefined();
    expect(ready?.payload).toBe(0);

    publisher.publish();
    await flush();
    expect(renderer.root.findByType("span").props.children).toBe("hull:100");

    hull = 42;
    publisher.publish();
    await flush();

    expect(renderer.root.findByType("span").props.children).toBe("hull:42");

    publisher.stop();
    gameBridge.close();
    renderer.unmount();
    restore();
  });

  it("shows the scene verdict and no frame rate, so a screenshot cannot be misread", async () => {
    const restore = installDocument();
    const gameBridge = connectUiBridge({ end: "game" });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(UiLayer, null, createElement("span")));
      await flush();
    });
    expect(renderer.root.findAllByType("output")).toHaveLength(0);

    await act(async () => {
      // An `fps` field the current game no longer sends, so the check survives an older core: the
      // rate is the loop's throttled rAF rate and must never reach the screen.
      gameBridge.post({
        type: UI_DEV_METRICS_MESSAGE,
        fps: 42,
        sceneWarning: "the last window was CPU-bound on scene shape",
      });
      await flush();
    });

    const chip = renderer.root.findByType("output");
    expect(chip.props.className).toBe("tn-dev-scene-warning");
    expect(chip.props.children).toBe("the last window was CPU-bound on scene shape");
    expect(chip.props.style.pointerEvents).toBe("none");

    gameBridge.close();
    renderer.unmount();
    restore();
  });

  it("announces ready again on a remount, so the first bridge's teardown was real", async () => {
    const restore = installDocument();
    const gameBridge = connectUiBridge({ end: "game" });
    let readyCount = 0;
    onUiIntent(gameBridge, (intent) => {
      if (intent === "tn:ready") readyCount += 1;
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(UiLayer, null, createElement("span")));
      await flush();
    });
    expect(readyCount).toBe(1);

    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      renderer = create(createElement(UiLayer, null, createElement("span")));
      await flush();
    });
    expect(readyCount).toBe(2);

    gameBridge.close();
    restore();
  });
});

it("stops the hit region registry on an open bridge during unmount", async () => {
  const restore = installDocument();
  const gameBridge = connectUiBridge({ end: "game" });
  const emptyPublished: unknown[] = [];
  gameBridge.onMessage((message) => {
    const hitMessage = message as { regions?: unknown[] };
    if (
      message.type === "tn:hit-regions" &&
      Array.isArray(hitMessage.regions) &&
      hitMessage.regions.length === 0
    ) {
      emptyPublished.push(message);
    }
  });

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(
        UiLayer,
        null,
        createElement("button", { "data-tn-interactive": "true", type: "button" }, "click"),
      ),
    );
    await flush();
  });

  await act(async () => {
    renderer.unmount();
    await flush();
  });

  expect(emptyPublished.length).toBeGreaterThan(0);

  gameBridge.close();
  restore();
});
