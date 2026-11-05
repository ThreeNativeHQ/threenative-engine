import { afterEach, describe, expect, it, vi } from "vitest";

import { installCameras } from "../src/editor/app/cameras.js";
import type { EditorSession } from "../src/editor/app/session.js";
import type { IViewerPose } from "../src/editor/index.js";

/** The two controls the save button reads back, plus the panel's own container lookups. */
class StubElement {
  readonly attributes = new Map<string, string>();
  children: (StubElement | string)[] = [];
  className = "";
  id = "";
  onclick: (() => void) | null = null;
  textContent = "";
  value = "";
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    if (name === "id") {
      this.id = value;
      byId.set(value, this);
    } else if (name === "class") this.className = value;
    else if (name === "value") this.value = value;
    else this.attributes.set(name, value);
  }
  append(...nodes: (StubElement | string)[]): void {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: (StubElement | string)[]): void {
    this.children = nodes;
  }
  querySelector(): StubElement | null {
    return null;
  }
  insertBefore(node: StubElement): void {
    this.children.push(node);
  }
}

let byId = new Map<string, StubElement>();
const sidebar = new StubElement("aside");
afterEach(() => {
  byId = new Map();
  vi.unstubAllGlobals();
});

function stubDocument(): unknown {
  return {
    head: new StubElement("head"),
    createElement: (tag: string) => new StubElement(tag),
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelector: (selector: string) => (selector === ".right-sidebar" ? sidebar : null),
  };
}

function pose(overrides: Partial<IViewerPose>): IViewerPose {
  return {
    position: [0, 100, 0],
    target: [0, 0, 0],
    up: [0, 1, 0],
    projection: "perspective",
    fov: 60,
    extent: null,
    zoom: null,
    near: 0.5,
    far: 900,
    aspect: 1.5,
    activeCamera: null,
    ...overrides,
  };
}

/** Clicking Save current must save the live eye exactly as the view reports it. */
function saveCurrent(live: IViewerPose): Record<string, number | string> {
  const written: Record<string, number | string>[] = [];
  const session = {
    view: { cameras: () => ({ read: () => live }) },
    attemptCamera: (operation: { camera: Record<string, number | string> }) => {
      written.push(operation.camera);
      return undefined;
    },
  } as unknown as EditorSession;
  installCameras(session);
  const projection = byId.get("camera-projection");
  const save = byId.get("camera-save");
  if (!projection || !save?.onclick) throw new Error("The panel did not build its Save control");
  projection.value = "orthographic";
  save.onclick();
  const camera = written[0];
  if (!camera) throw new Error("Save current wrote no camera");
  return camera;
}

describe("editor observation camera panel", () => {
  it("measures an orthographic extent against the target on every axis", () => {
    vi.stubGlobal("document", stubDocument());
    const camera = saveCurrent(pose({ position: [0, 100, 0], target: [50, 0, 50] }));
    expect(camera.projection).toBe("orthographic");
    expect(camera.extent).toBeCloseTo(Math.hypot(0 - 50, 100 - 0, 0 - 50), 6);
  });
});
