import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { errorMessage } from "../src/editor/app/dom.js";

const editorRoot = fileURLToPath(new URL("../src/editor/", import.meta.url));
const sources = readdirSync(editorRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => `${entry.parentPath}/${entry.name}`);

describe("typed terrain editor source", () => {
  it("preserves validation and transport error messages", () => {
    expect(errorMessage(new Error("invalid layer"))).toBe("invalid layer");
    expect(errorMessage("disconnected")).toBe("disconnected");
  });
  it("contains no JavaScript source", () => {
    expect(sources.filter((path) => /\.(?:[cm]?js|jsx)$/.test(path))).toEqual([]);
  });

  it("constructs the DOM without HTML sinks", () => {
    const sinks = /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/;
    expect(
      sources.filter((path) => path.endsWith(".ts") && sinks.test(readFileSync(path, "utf8"))),
    ).toEqual([]);
  });
});
