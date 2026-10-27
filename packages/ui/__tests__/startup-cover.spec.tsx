import { UI_STARTUP_MESSAGE, connectUiBridge, publishUiState } from "@threenative/core/ui-layer";
import { createElement } from "react";
import { type ReactTestRenderer, act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiLayer, useUiState, useUiStateDuringStartup } from "../src/UiLayer.js";

async function flush(times = 4): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) await Promise.resolve();
  });
}

function setup() {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      querySelectorAll: () => [],
    },
  });
  const game = connectUiBridge({ end: "game" });
  const publisher = publishUiState<{ hull: number }>(game, {
    getState: () => ({ hull: 100 }),
    subscribe: () => () => undefined,
  });
  return { game, publisher };
}

const readout = (renderer: ReactTestRenderer): unknown =>
  renderer.root.findByType("span").props.children;

describe("page UI stays hidden behind the loading cover", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
    vi.restoreAllMocks();
  });

  it("useUiState reads undefined while the cover is up and the state after it lifts", async () => {
    const { game, publisher } = setup();
    function Hud() {
      const hull = useUiState<{ hull: number }, number>((state) => state.hull);
      return createElement("span", null, String(hull));
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(UiLayer, null, createElement(Hud)));
      await flush();
    });
    game.post({ type: UI_STARTUP_MESSAGE, phase: "covered" });
    publisher.publish();
    await flush();
    expect(readout(renderer)).toBe("undefined");

    game.post({ type: UI_STARTUP_MESSAGE, phase: "ready" });
    await flush();
    expect(readout(renderer)).toBe("100");
    renderer.unmount();
    game.close();
  });

  it("a game that never announces a startup phase keeps reading state at once", async () => {
    const { game, publisher } = setup();
    function Hud() {
      return createElement("span", null, String(useUiState<{ hull: number }>()?.hull));
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(UiLayer, null, createElement(Hud)));
      await flush();
    });
    publisher.publish();
    await flush();
    expect(readout(renderer)).toBe("100");
    renderer.unmount();
    game.close();
  });

  it("the named override reads state behind the cover and reports its reason once", async () => {
    const { game, publisher } = setup();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    function Loading() {
      const hull = useUiStateDuringStartup<{ hull: number }, number>(
        { reason: "draws its own staged loading screen" },
        (state) => state.hull,
      );
      return createElement("span", null, String(hull));
    }
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(UiLayer, null, createElement(Loading)));
      await flush();
    });
    game.post({ type: UI_STARTUP_MESSAGE, phase: "covered" });
    publisher.publish();
    await flush();
    expect(readout(renderer)).toBe("100");
    expect(info).toHaveBeenCalledWith("TN_UI_STARTUP_OVERRIDE draws its own staged loading screen");
    expect(info).toHaveBeenCalledTimes(1);
    renderer.unmount();
    game.close();
  });

  it("the override without a reason throws", async () => {
    setup();
    function Loading() {
      useUiStateDuringStartup({ reason: "" });
      return null;
    }
    await expect(
      act(async () => {
        create(createElement(UiLayer, null, createElement(Loading)));
        await flush();
      }),
    ).rejects.toThrow("TN_UI_STARTUP_OVERRIDE_REASON");
  });
});
