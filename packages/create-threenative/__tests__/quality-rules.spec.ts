import tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import { threenativePlugin } from "../src/quality/plugin.js";

const RULES = [
  "hot-callback-allocation",
  "hot-callback-resource-creation",
  "hot-callback-scene-work",
  "startup-override-reason",
  "ui-state-selector",
] as const;

/** Lint `source` with every threenative rule on at `error`; return the ids that fired. */
function fired(source: string): string[] {
  const rules = Object.fromEntries(RULES.map((name) => [`threenative/${name}`, "error" as const]));
  const messages = new Linter().verify(
    source,
    [
      {
        files: ["**/*.tsx"],
        languageOptions: { parser: tsParser as Linter.Parser },
        plugins: { threenative: threenativePlugin },
        rules,
      },
    ],
    "a.tsx",
  );
  return messages.map((message) => message.ruleId ?? `parse:${message.message}`);
}

const scene = (body: string): string =>
  `import { Scene } from "@threenative/core";\nimport * as THREE from "three";\nexport class Play extends Scene {\n${body}\n}\n`;

describe("threenative/hot-callback-scene-work", () => {
  it("flags a whole-tree walk inside update, render, beforeRender and afterPhysics", () => {
    for (const call of [
      "new THREE.Box3().setFromObject(this.track)",
      "box.expandByObject(this.track)",
      "this.world.traverse(() => undefined)",
      "this.world.traverseVisible(() => undefined)",
      "ray.intersectObjects(this.world.children, true)",
      "physics.raycastAll(origin, direction)",
    ]) {
      expect(fired(scene(`update() { ${call}; }`))).toContain(
        "threenative/hot-callback-scene-work",
      );
    }
    expect(
      fired(scene("enter(ctx) { ctx.beforeRender(() => { box.setFromObject(this.a); }); }")),
    ).toEqual(["threenative/hot-callback-scene-work"]);
    expect(
      fired(scene("enter(ctx) { ctx.afterPhysics(() => { this.a.traverse(() => undefined); }); }")),
    ).toEqual(["threenative/hot-callback-scene-work"]);
  });

  it("passes the same walk in enter or load, and the engine's accelerated query", () => {
    expect(fired(scene("enter() { new THREE.Box3().setFromObject(this.track); }"))).toEqual([]);
    expect(fired(scene("async load() { this.world.traverse(() => undefined); }"))).toEqual([]);
    expect(fired(scene("update(ctx) { ctx.raycast(origin, direction); }"))).toEqual([]);
    expect(fired("export function boot(root) { root.traverse(() => undefined); }")).toEqual([]);
  });
});

describe("threenative/hot-callback-resource-creation", () => {
  it("flags a new material, geometry or texture inside a frame callback", () => {
    for (const make of [
      "new THREE.MeshStandardMaterial()",
      "new BoxGeometry(1, 1, 1)",
      "new CanvasTexture(canvas)",
    ]) {
      expect(fired(scene(`update() { this.mesh.material = ${make}; }`))).toEqual([
        "threenative/hot-callback-resource-creation",
      ]);
    }
  });

  it("passes creation in enter and a mutation in the frame", () => {
    expect(
      fired(
        scene(
          "enter() { this.mat = new THREE.MeshStandardMaterial(); }\nupdate() { this.mat.opacity = 0.5; }",
        ),
      ),
    ).toEqual([]);
  });
});

describe("threenative/ui-state-selector", () => {
  const hud = (call: string): string =>
    `import { useUiState } from "@threenative/ui";\nexport function Hud() { const s = ${call}; return s; }\n`;

  it("flags useUiState() without a selector", () => {
    expect(fired(hud("useUiState<GameState>()"))).toEqual(["threenative/ui-state-selector"]);
  });

  it("passes a selector", () => {
    expect(fired(hud("useUiState<GameState, number>((state) => state.score)"))).toEqual([]);
  });
});

describe("threenative/startup-override-reason", () => {
  const ui = (call: string): string =>
    `import { useUiStateDuringStartup } from "@threenative/ui";\nexport function Loading() { return ${call}; }\n`;

  it("flags the override without a reason, with an empty one or with a computed one", () => {
    for (const call of [
      "useUiStateDuringStartup<GameState>()",
      "useUiStateDuringStartup<GameState>({})",
      'useUiStateDuringStartup<GameState>({ reason: "  " })',
      "useUiStateDuringStartup<GameState>({ reason: why })",
      "useUiStateDuringStartup<GameState>(options)",
    ]) {
      expect(fired(ui(call))).toContain("threenative/startup-override-reason");
    }
  });

  it("passes the override with a literal reason", () => {
    expect(
      fired(ui('useUiStateDuringStartup<GameState>({ reason: "draws its own loading overlay" })')),
    ).toEqual([]);
  });
});

describe("threenative/hot-callback-allocation after the shared tracker", () => {
  it("still flags a Vector3 in update and passes it in enter", () => {
    expect(fired(scene("update() { const v = new THREE.Vector3(); return v; }"))).toEqual([
      "threenative/hot-callback-allocation",
    ]);
    expect(fired(scene("enter() { this.v = new THREE.Vector3(); }"))).toEqual([]);
  });
});
