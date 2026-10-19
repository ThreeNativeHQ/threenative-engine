import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameUi } from "../templates/rain/src/ui/GameUi.js";

const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => unknown>,
  refs: [] as Array<{ current: unknown }>,
  index: 0,
  state: {
    quality: "performance",
    softwareRendering: true,
    qualityExplicit: false,
    loading: { ready: false, progress: 0 },
  },
  send: vi.fn(),
}));
vi.mock("@threenative/ui", () => ({
  UiLayer: "div",
  useUiState: () => hooks.state,
  useUiIntent: () => hooks.send,
}));
vi.mock("react/jsx-runtime", () => ({
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
}));
vi.mock("react/jsx-dev-runtime", () => ({
  jsxDEV: (type: unknown, props: unknown) => ({ type, props }),
}));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => unknown) => hooks.effects.push(effect),
  useRef: (value: unknown) => {
    const index = hooks.index++;
    hooks.refs[index] ??= { current: value };
    return hooks.refs[index];
  },
  useState: (value: unknown) => [value, vi.fn()],
}));

function publishSnapshot(): void {
  hooks.index = 0;
  hooks.effects = [];
  const element = GameUi();
  element.props.children.type();
  for (const effect of hooks.effects) effect();
}

describe("Rain initial quality ownership", () => {
  beforeEach(() => {
    hooks.refs = [];
    hooks.send.mockClear();
    hooks.state = {
      quality: "performance",
      softwareRendering: true,
      qualityExplicit: false,
      loading: { ready: false, progress: 0 },
    };
    vi.stubGlobal("window", {
      innerWidth: 1440,
      location: { search: "" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the scene's software study tier instead of raising it for a wide UI", () => {
    publishSnapshot();
    expect(hooks.send.mock.calls.filter(([name]) => name === "setQuality")).toEqual([]);
  });

  it("honours an explicit URL tier even on the software default", () => {
    window.location.search = "?quality=ultra";
    publishSnapshot();
    expect(hooks.send).toHaveBeenCalledWith("setQuality", "ultra");
  });

  it("keeps a later player choice when another snapshot arrives", () => {
    publishSnapshot();
    hooks.send.mockClear();
    hooks.state.quality = "balanced";
    publishSnapshot();
    expect(hooks.send.mock.calls.filter(([name]) => name === "setQuality")).toEqual([]);
  });

  it.each([
    [699, "performance"],
    [700, "high"],
    [1440, "high"],
  ])("keeps the hardware width default at %s pixels", (width, quality) => {
    hooks.state.softwareRendering = false;
    window.innerWidth = Number(width);
    publishSnapshot();
    expect(hooks.send).toHaveBeenCalledWith("setQuality", quality);
    hooks.send.mockClear();
    window.innerWidth = 400;
    publishSnapshot();
    expect(hooks.send.mock.calls.filter(([name]) => name === "setQuality")).toEqual([]);
  });

  it("keeps an explicit hardware choice made before the first UI snapshot", () => {
    hooks.state.softwareRendering = false;
    hooks.state.qualityExplicit = true;
    hooks.state.quality = "balanced";
    publishSnapshot();
    expect(hooks.send.mock.calls.filter(([name]) => name === "setQuality")).toEqual([]);
  });
  it("keeps a runner's raw quality setup on software after scene loading", () => {
    hooks.state.quality = "balanced";
    publishSnapshot();
    expect(hooks.send.mock.calls.filter(([name]) => name === "setQuality")).toEqual([]);
  });
  it("waits for adapter classification without consuming its one-time hardware choice", () => {
    Reflect.deleteProperty(hooks.state, "softwareRendering");
    publishSnapshot();
    expect(hooks.send.mock.calls.filter(([name]) => name === "setQuality")).toEqual([]);
    hooks.state.softwareRendering = false;
    publishSnapshot();
    expect(hooks.send).toHaveBeenCalledWith("setQuality", "high");
  });
});
