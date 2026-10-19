import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugOverlay, type DebugSnapshot } from "../src/DebugOverlay.js";

type Listener = (event: KeyboardEvent) => void;

type GeometryMock = ((request?: unknown) => Promise<unknown>) | undefined;

function installDevWindow(snapshot: () => DebugSnapshot, geometry?: GeometryMock) {
  const listeners = new Set<Listener>();
  const windowLike = {
    __THREENATIVE__: geometry === undefined ? { snapshot } : { geometry, snapshot },
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as Listener);
    },
    clearInterval,
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as Listener);
    },
    setInterval,
  } as unknown as Window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowLike });
  return {
    toggle: () => {
      for (const listener of listeners) listener({ key: "`" } as KeyboardEvent);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "window");
});

describe("DebugOverlay", () => {
  it("renders one row per registered entity field", () => {
    vi.useFakeTimers();
    const controls = installDevWindow(() => ({
      player: { hull: 100, position: [0, 1, 2] },
      pickup: { active: true, value: 1 },
    }));
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<DebugOverlay />);
    });
    act(() => {
      controls.toggle();
      vi.advanceTimersByTime(100);
    });

    expect(renderer.root.findAllByType("tbody")[0]?.findAllByType("tr")).toHaveLength(4);
    const overlay = renderer.root.findByProps({ "data-threenative-debug-overlay": "true" });
    expect(overlay.props.style).toBeUndefined();
    expect(overlay.findByType("table").props.style).toBeUndefined();
    act(() => renderer.unmount());
  });

  it("polls at most 11 times per second", () => {
    vi.useFakeTimers();
    const snapshot = vi.fn(() => ({ player: { hull: 100 } }));
    const controls = installDevWindow(snapshot);
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<DebugOverlay />);
    });
    act(() => {
      controls.toggle();
      vi.advanceTimersByTime(1_000);
    });

    expect(snapshot.mock.calls.length).toBeLessThanOrEqual(11);
    act(() => renderer.unmount());
  });

  it("requests a geometry capture only when the button is pressed, once per press", async () => {
    const geometry = vi.fn(async () => capturedReport());
    const controls = installDevWindow(() => ({}), geometry);
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<DebugOverlay />);
    });
    act(() => controls.toggle());
    act(() => clickText(renderer, "Geometry"));

    // The capture must never ride the entity poll: opening the tab asks for nothing.
    expect(geometry).not.toHaveBeenCalled();
    await act(async () => {
      clickText(renderer, "Capture");
    });
    expect(geometry).toHaveBeenCalledTimes(1);
    await act(async () => {
      clickText(renderer, "Refresh");
    });
    expect(geometry).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it("renders one row per captured object and an em dash for an unknown number", async () => {
    const renderer = await openGeometry(capturedReport());
    const names = objectRowNames(renderer);
    expect(names).toEqual(["tree", "hull", "mystery"]);
    const mystery = rowCells(renderer, "mystery");
    expect(mystery[1]).toBe("—");
    expect(mystery[3]).toBe("—");
    act(() => renderer.unmount());
  });

  it("renders an unavailable capture's reason and no rows", async () => {
    const renderer = await openGeometry({
      reason: "TN_GEOMETRY_CAPTURE_NO_FRAME: no world frame was presented within 2000 ms.",
      status: "unavailable",
    });
    expect(texts(renderer).some((text) => text.includes("TN_GEOMETRY_CAPTURE_NO_FRAME"))).toBe(
      true,
    );
    expect(objectRowNames(renderer)).toEqual([]);
    act(() => renderer.unmount());
  });

  it("excludes an object with no measured bounds from the small-on-screen filter", async () => {
    const renderer = await openGeometry(capturedReport());
    act(() => {
      renderer.root
        .findAllByType("input")
        .find((node) => node.props.type === "checkbox")
        ?.props.onChange({ target: { checked: true } });
    });
    // "mystery" has no projectedPixels: unknown bounds are not grounds for calling it small.
    expect(objectRowNames(renderer)).toEqual(["tree"]);
    act(() => renderer.unmount());
  });

  it("expands an object into its component meshes", async () => {
    const renderer = await openGeometry(capturedReport());
    expect(texts(renderer)).not.toContain("canopy");
    act(() => {
      renderer.root
        .findAllByProps({ className: "tn-debug-expand" })
        .find((node) => node.type === "button")
        ?.props.onClick();
    });
    expect(texts(renderer)).toContain("canopy");
    act(() => renderer.unmount());
  });

  it("draws no outline for a selected row whose bounds are unavailable", async () => {
    const renderer = await openGeometry(capturedReport());
    act(() => {
      renderer.root
        .findAllByProps({ className: "tn-debug-select" })
        .filter((node) => node.type === "button")
        .find((node) => node.children.includes("mystery"))
        ?.props.onClick();
    });
    expect(renderer.root.findAllByProps({ className: "tn-debug-outline" })).toHaveLength(0);
    expect(texts(renderer)).toContain("bounds unavailable");
    act(() => renderer.unmount());
  });

  it("re-sorts the captured rows without asking for another capture", async () => {
    const geometry = vi.fn(async () => capturedReport());
    const controls = installDevWindow(() => ({}), geometry);
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<DebugOverlay />);
    });
    act(() => controls.toggle());
    act(() => clickText(renderer, "Geometry"));
    await act(async () => {
      clickText(renderer, "Capture");
    });
    expect(objectRowNames(renderer)).toEqual(["tree", "hull", "mystery"]);

    act(() => {
      renderer.root.findByType("select").props.onChange({ target: { value: "draws" } });
    });
    expect(objectRowNames(renderer)).toEqual(["hull", "tree", "mystery"]);
    expect(geometry).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it("stays empty while the devtools snapshot is replaced", () => {
    vi.useFakeTimers();
    const controls = installDevWindow(() => ({ player: { hull: 100 } }));
    (globalThis.window as unknown as { __THREENATIVE__?: unknown }).__THREENATIVE__ = {};
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(<DebugOverlay />);
    });
    act(() => {
      controls.toggle();
      vi.advanceTimersByTime(100);
    });

    expect(renderer.root.findAllByType("tbody")[0]?.findAllByType("tr")).toHaveLength(0);
    act(() => renderer.unmount());
  });
});

function clickText(renderer: ReturnType<typeof create>, label: string): void {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => node.children.includes(label));
  if (button === undefined) throw new Error(`No button labelled '${label}'.`);
  button.props.onClick();
}

/** Opens the Geometry tab on one captured report and returns the rendered tree. */
async function openGeometry(report: unknown): Promise<ReturnType<typeof create>> {
  const controls = installDevWindow(
    () => ({}),
    async () => report,
  );
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<DebugOverlay />);
  });
  act(() => controls.toggle());
  act(() => clickText(renderer, "Geometry"));
  await act(async () => {
    clickText(renderer, "Capture");
  });
  return renderer;
}

function texts(renderer: ReturnType<typeof create>): string[] {
  const found: string[] = [];
  const walk = (children: readonly unknown[]): void => {
    for (const child of children) {
      if (typeof child === "string") found.push(child);
      else if (child !== null && typeof child === "object" && "children" in child) {
        walk((child as { children: readonly unknown[] }).children);
      }
    }
  };
  walk(renderer.root.children);
  return found;
}

function objectRowNames(renderer: ReturnType<typeof create>): string[] {
  return renderer.root
    .findAllByProps({ className: "tn-debug-select" })
    .filter((node) => node.type === "button")
    .flatMap((node) => node.children.filter((child): child is string => typeof child === "string"));
}

function rowCells(renderer: ReturnType<typeof create>, name: string): string[] {
  const row = renderer.root
    .findAllByType("tr")
    .find((node) =>
      node
        .findAllByProps({ className: "tn-debug-select" })
        .some((button) => button.children.includes(name)),
    );
  if (row === undefined) throw new Error(`No object row named '${name}'.`);
  return row
    .findAllByType("td")
    .map((cell) =>
      cell.children.filter((child): child is string => typeof child === "string").join(""),
    );
}

/**
 * One report shaped exactly as the collector answers: "tree" is the biggest by triangles, "hull"
 * is the biggest by draws, and "mystery" has no measured cost or bounds at all.
 */
function capturedReport() {
  return {
    assets: [{ asset: "models/tree.glb", draws: 1, objects: 1, submittedTriangles: 900 }],
    backend: "WebGPUBackend",
    camera: { position: [0, 0, 10] as const, type: "perspective" as const },
    durationMs: 3.5,
    generation: 1,
    inspectedNodes: 3,
    inspectionComplete: true,
    limit: 50,
    matched: 3,
    objects: [
      {
        asset: "models/tree.glb",
        copies: 1,
        draws: 1,
        generation: 1,
        id: "1:0",
        materials: 1,
        meshes: [
          {
            draws: 1,
            id: "1:0:0",
            materials: 1,
            name: "canopy",
            path: "/tree/canopy",
            submissions: { main: { draws: 1, triangles: 900 } },
            submittedTriangles: 900,
            type: "Mesh",
            visible: true,
          },
        ],
        name: "tree",
        path: "/tree",
        projectedCenter: [200, 100] as const,
        projectedPixels: 12,
        submissions: { main: { draws: 1, triangles: 900 } },
        submittedTriangles: 900,
        type: "Group",
        visibility: "submitted" as const,
      },
      {
        copies: 1,
        draws: 40,
        generation: 1,
        id: "1:1",
        materials: 4,
        meshes: [],
        name: "hull",
        path: "/hull",
        projectedCenter: [640, 360] as const,
        projectedPixels: 400,
        submissions: { main: { draws: 40, triangles: 500 } },
        submittedTriangles: 500,
        type: "Group",
        visibility: "submitted" as const,
      },
      {
        copies: 1,
        draws: 1,
        generation: 1,
        id: "1:2",
        materials: 1,
        meshes: [],
        name: "mystery",
        path: "/mystery",
        submissions: { main: { draws: 1, triangles: 0 } },
        type: "Mesh",
        unavailable: ["TN_GEOMETRY_NO_POSITION_COUNT"],
        visibility: "submitted" as const,
      },
    ],
    partialRanking: false,
    passes: [
      {
        attributedDraws: 42,
        attributedTriangles: 1_400,
        draws: 44,
        kind: "main" as const,
        triangles: 1_600,
        unattributedDraws: 2,
        unattributedTriangles: 200,
      },
    ],
    returned: 3,
    rowsTruncated: false,
    sort: "triangles" as const,
    status: "captured" as const,
    tick: 120,
    viewport: { height: 720, width: 1280 },
  };
}

describe("DebugOverlay DEV gate", () => {
  it("places the dev gate before hooks so the view is unreachable in production", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const overlayPath = fileURLToPath(new URL("../src/DebugOverlay.tsx", import.meta.url));
    const source = await readFile(overlayPath, "utf8");

    // The gate must be in DebugOverlay before calling DebugOverlayView or running hooks
    const match = source.match(/export function DebugOverlay\(\)[^{]*\{([\s\S]*?)\}/);
    expect(match).not.toBeNull();
    const body = match?.[1] ?? "";
    expect(body).toContain("if (!isDev) return null;");
    expect(body).toContain("<DebugOverlayView />");
    expect(body).not.toContain("useState");
    expect(body).not.toContain("useEffect");
  });
});
