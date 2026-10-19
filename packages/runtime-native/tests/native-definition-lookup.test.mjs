import { describe, expect, it } from "vitest";

import {
  nativeBindingDefinition,
  nativeDefinition,
} from "../../../test-support/native-definition.js";

// Phase 5's whole point: an assertion must survive the file moving and still red on the behaviour.
// Locating a definition by symbol instead of by path is what makes both controls possible.
describe("native definition lookup", () => {
  it("finds a definition wherever the file lives", () => {
    const found = nativeDefinition("replayPackedFrameOpStream");
    expect(found.text).toMatch(/replayPackedFrameOpStream/u);
    expect(found.path).toMatch(/\.(?:cpp|h)$/u);
  });

  // Fail closed. The old path-coupled assertion sliced from indexOf() === -1, produced an empty
  // string, and passed vacuously - it slept through exactly the split PRD-230 performs.
  it("throws instead of returning nothing when the symbol is gone", () => {
    expect(() => nativeDefinition("tnSymbolThatDoesNotExistAnywhere")).toThrow(
      /no definition found/iu,
    );
  });

  it("throws when a symbol is defined in more than one place", () => {
    expect(() =>
      nativeDefinition("replayPackedFrameOpStream", {
        readFiles: () => [
          { path: "a.cpp", text: "bool replayPackedFrameOpStream(int) { return true; }" },
          { path: "b.cpp", text: "bool replayPackedFrameOpStream(int) { return false; }" },
        ],
      }),
    ).toThrow(/more than one/iu);
  });

  it("does not mistake a multiline call followed by a block for a definition", () => {
    const found = nativeDefinition("readCanvasDimension", {
      readFiles: () => [
        {
          path: "call-site.cpp",
          text: `if (!readCanvasDimension(
            state, canvas, "width", width)) {
              return false;
            }`,
        },
        {
          path: "qualified-call-site.cpp",
          text: `if (copyDimension(
            namespace_name::readCanvasDimension(
              state, canvas, "width", value),
            output)) { return true; }`,
        },
        {
          path: "moved-definition.cpp",
          text: "bool readCanvasDimension(State*, Value, const char*, unsigned&) { return true; }",
        },
      ],
    });

    expect(found.path).toBe("moved-definition.cpp");
  });

  it("follows nested registration rows to the current handler definition", () => {
    const files = [
      {
        path: "install.cpp",
        text: `bool installWebGPUBindingTables() {
          bindingTable({{"GPU", "requestAdapter", 0, nullptr, &requestAdapter}});
          return true;
        }`,
      },
      {
        path: "adapter.cpp",
        text: `Value requestAdapter() {
          bindingTable({{"GPUAdapter", "requestDevice", 0, nullptr, &requestDevice}});
          return {};
        }`,
      },
      {
        path: "device.cpp",
        text: `Value requestDevice() {
          bindingTable({{"GPUDevice", "createBindGroup", 0, nullptr, &createBindGroup}});
          return {};
        }
        Value createBindGroup() { return failClosed(); }`,
      },
    ];

    let corpusReads = 0;
    const found = nativeBindingDefinition("GPUDevice", "createBindGroup", {
      readFiles: () => {
        corpusReads += 1;
        return files;
      },
    });

    expect(found.path).toBe("device.cpp");
    expect(found.text).toMatch(/failClosed/u);
    expect(corpusReads).toBe(1);
  });
});
