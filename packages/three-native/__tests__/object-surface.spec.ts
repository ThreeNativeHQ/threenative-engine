import { describe, expect, it } from "vitest";
import { Material, defineObjectSurface, defineTypeFlags } from "../src/object-surface.js";

class BufferGeometry {
  readonly stored = new Map<string, unknown>();
  setAttribute(name: string, attribute: unknown) {
    this.stored.set(name, attribute);
    return this;
  }
  deleteAttribute(name: string) {
    this.stored.delete(name);
    return this;
  }
  hasAttribute(name: string) {
    return this.stored.has(name);
  }
  getAttribute(name: string) {
    return this.stored.get(name);
  }
  get __attributeNames() {
    return [...this.stored.keys()].join("\n");
  }
}

describe("defineObjectSurface", () => {
  it("enumerates geometry.attributes, so Object.entries works on an engine geometry", () => {
    class MeshStandardMaterial {}
    defineObjectSurface({
      bufferGeometry: BufferGeometry,
      geometries: [],
      materials: [MeshStandardMaterial],
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", "p");
    geometry.setAttribute("custom", "c");
    const { attributes } = geometry as unknown as { attributes: Record<string, unknown> };
    expect(Object.entries(attributes)).toEqual([
      ["position", "p"],
      ["custom", "c"],
    ]);
    expect(new MeshStandardMaterial()).toBeInstanceOf(Material);
    expect(
      (MeshStandardMaterial.prototype as { isMeshStandardMaterial?: boolean })
        .isMeshStandardMaterial,
    ).toBe(true);
  });

  it("lists the attribute names on every geometry class, not only BufferGeometry", () => {
    // The registry gives each class its own dotted getters (`attributes.position.array`), which
    // read as junk keys unless the view replaces them.
    class BoxGeometry extends BufferGeometry {
      get attributes() {
        return { "position.array": 1 };
      }
    }
    defineObjectSurface({
      bufferGeometry: BufferGeometry,
      geometries: [BoxGeometry],
      materials: [],
    });
    const box = new BoxGeometry();
    box.setAttribute("position", "p");
    expect(Object.keys((box as unknown as { attributes: object }).attributes)).toEqual([
      "position",
    ]);
  });

  it("reads geometry.attributes.position with one engine call", () => {
    class CountedGeometry extends BufferGeometry {
      calls = 0;
      override hasAttribute(name: string) {
        this.calls++;
        return super.hasAttribute(name);
      }
      override getAttribute(name: string) {
        this.calls++;
        return super.getAttribute(name);
      }
    }
    defineObjectSurface({ bufferGeometry: CountedGeometry, geometries: [], materials: [] });
    const geometry = new CountedGeometry().setAttribute("position", "p") as CountedGeometry;
    const { attributes } = geometry as unknown as { attributes: Record<string, unknown> };
    expect(attributes.position).toBe("p");
    expect(attributes.normal).toBeUndefined();
    expect(geometry.calls).toBe(2);
    // Listing asks the engine for every name at once and reads no attribute.
    expect(Object.keys(attributes)).toEqual(["position"]);
    expect(geometry.calls).toBe(2);
  });

  it("keeps a material flag the back end already defined read-only", () => {
    class MeshBasicMaterial {}
    Object.defineProperty(MeshBasicMaterial.prototype, "isMeshBasicMaterial", {
      configurable: true,
      value: true,
    });
    expect(() =>
      defineObjectSurface({
        bufferGeometry: BufferGeometry,
        geometries: [],
        materials: [MeshBasicMaterial],
      }),
    ).not.toThrow();
    expect(new MeshBasicMaterial()).toBeInstanceOf(Material);
  });

  it("replaces morphAttributes whole through the engine's holder, refusing other keys", () => {
    const holder: Record<string, unknown> = { position: ["p"], normal: ["n"] };
    class MorphGeometry extends BufferGeometry {}
    Object.defineProperty(MorphGeometry.prototype, "morphAttributes", {
      configurable: true,
      get: () => holder,
    });
    defineObjectSurface({ bufferGeometry: MorphGeometry, geometries: [], materials: [] });
    const geometry = new MorphGeometry() as unknown as { morphAttributes: Record<string, unknown> };
    geometry.morphAttributes = {};
    expect(holder).toEqual({ position: [], normal: [] });
    expect(() => {
      geometry.morphAttributes = { color: [] };
    }).toThrow("morphAttributes.color");
  });
});

describe("defineTypeFlags", () => {
  it("leaves the flag writable, as three's own `this.isTexture = true` is", () => {
    class Texture {}
    defineTypeFlags({ Texture });
    const texture = new Texture() as { isTexture?: boolean };
    expect(texture.isTexture).toBe(true);
    texture.isTexture = true;
    expect(Object.hasOwn(texture, "isTexture")).toBe(true);
  });
});
