import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InputMap } from "@threenative/core";
import tsParser from "@typescript-eslint/parser";
import { Linter } from "eslint";
import { MathUtils } from "three";
import { describe, expect, it } from "vitest";
import { threenativePlugin } from "../src/quality/plugin.js";
import { REINVENTIONS, reinventionConfigs, reinventionRules } from "../src/quality/reinventions.js";

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

describe("threenative/hot-callback-scene-work beyond update and render", () => {
  // core's AutoBatch fingerprint before 90856171d, written where a game would write it: 41% of the worker.
  const fingerprint =
    "let hash = this.scene.children.length; for (const child of this.scene.children) hash = (hash * 31 + child.children.length + 1) | 0;";

  it("flags a hand walk over children in update, and in a callback an array iterator runs", () => {
    expect(fired(scene(`update() { ${fingerprint} }`))).toEqual([
      "threenative/hot-callback-scene-work",
    ]);
    expect(
      fired(scene("update() { this.group.children.forEach((c) => c.updateMatrix()); }")),
    ).toEqual(["threenative/hot-callback-scene-work"]);
    expect(
      fired(
        scene(
          "update() { this.enemies.forEach((enemy) => enemy.root.traverse(() => undefined)); }",
        ),
      ),
    ).toEqual(["threenative/hot-callback-scene-work"]);
  });

  it("flags a walk in a TSL node's per-render callback, the backlight uniforms' hook", () => {
    expect(
      fired(
        "const rimGain = uniform(controls.rimGain).onRenderUpdate(() => { controls.scene.traverse(() => undefined); return controls.rimGain; });",
      ),
    ).toEqual(["threenative/hot-callback-scene-work"]);
    expect(
      fired(
        "renderer.setAnimationLoop(() => { box.setFromObject(world); renderer.render(world, camera); });",
      ),
    ).toEqual(["threenative/hot-callback-scene-work"]);
  });

  it("passes the same walk in enter, a deferred callback, and a uniform that only returns its value", () => {
    expect(fired(scene(`enter() { ${fingerprint} }`))).toEqual([]);
    expect(
      fired(scene("update() { setTimeout(() => this.world.traverse(() => undefined), 0); }")),
    ).toEqual([]);
    expect(
      fired("const rimGain = uniform(controls.rimGain).onRenderUpdate(() => controls.rimGain);"),
    ).toEqual([]);
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

describe("threenative/hot-callback-* in an entity update method", () => {
  const entity = (body: string): string => `import * as THREE from "three";
export class Enemies {\n${body}\n}\n`;

  it("treats a non-static update, fixedUpdate, tick or step as per-frame", () => {
    for (const name of ["update", "fixedUpdate", "tick", "step"]) {
      expect(fired(entity(`${name}() { const v = new THREE.Vector2(); return v; }`))).toEqual([
        "threenative/hot-callback-allocation",
      ]);
    }
    expect(fired(entity("update() { this.world.traverse(() => undefined); }"))).toEqual([
      "threenative/hot-callback-scene-work",
    ]);
  });

  it("passes construction in load, a static update, and a method that is not a frame name", () => {
    expect(fired(entity("load() { const v = new THREE.Vector2(); return v; }"))).toEqual([]);
    expect(fired(entity("static update() { const v = new THREE.Vector2(); return v; }"))).toEqual(
      [],
    );
    expect(fired(entity("refresh() { const v = new THREE.Vector2(); return v; }"))).toEqual([]);
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

describe("the reinvention rows", () => {
  /** One hand-written form and the call that replaces it, per row. */
  const CASES: readonly {
    readonly capability: string;
    readonly bad: string;
    readonly good: string;
  }[] = [
    {
      capability: "createRandom",
      bad: "const r = Math.random();\n",
      good: "const random = createRandom(7)();\n",
    },
    {
      capability: "createRandom",
      bad: "let s = 7;\ns = (Math.imul(s, 1664525) + 1013904223) | 0;\n",
      good: "const random = createRandom(7)();\n",
    },
    {
      capability: "createRandom",
      bad: "let a = 7;\na = (a + 0x6d2b79f5) | 0;\n",
      good: "const random = createRandom(7)();\n",
    },
    {
      capability: "MathUtils.damp",
      bad: "const k = 1 - Math.exp(-dt * 4);\n",
      good: "const k = MathUtils.damp(a, b, 4, dt);\n",
    },
    {
      capability: "debugFlag",
      bad: 'const asked = new URLSearchParams(location.search).get("quality");\n',
      good: 'const asked = debugValue("quality");\n',
    },
    {
      capability: "renderer.matrixWorld",
      bad: "scene.matrixWorldAutoUpdate = false;\n",
      good: "const config = { renderer: { matrixWorld: true } };\n",
    },
    {
      capability: "InputMap.axis",
      bad: 'const x = (keys.has("KeyA") ? 1 : 0) - (keys.has("KeyD") ? 1 : 0);\n',
      good: 'const x = ctx.input.axis("moveX");\n',
    },
    {
      capability: "MathUtils.smoothstep",
      bad: "const t = u * u * (3 - 2 * u);\n",
      good: "const t = MathUtils.smoothstep(u, 0, 1);\n",
    },
  ];

  /** Lint one file with only `rows` on, at error. */
  function reinvented(
    rows: Parameters<typeof reinventionRules>[0],
    source: string,
    filename = "src/game.ts",
  ): string[] {
    return new Linter()
      .verify(
        source,
        [
          {
            files: ["src/**/*.ts"],
            languageOptions: { parser: tsParser as Linter.Parser },
            rules: reinventionRules(rows),
          },
        ],
        filename,
      )
      .map((message) => message.ruleId ?? `parse:${message.message}`);
  }

  const row = (capability: string) => {
    const found = REINVENTIONS.find((candidate) => candidate.capability === capability);
    if (found === undefined) throw new Error(`no reinvention row names ${capability}`);
    return found;
  };

  it("fails each hand-written form and passes the call it names", () => {
    for (const test of CASES) {
      expect(reinvented([row(test.capability)], test.bad), test.bad).not.toEqual([]);
      expect(reinvented([row(test.capability)], test.good), test.good).toEqual([]);
    }
  });

  it("names only a symbol that still exists", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../core/capabilities.json", import.meta.url), "utf8"),
    ) as { entries: readonly Record<string, unknown>[] };
    const entries = new Map(
      manifest.entries.map((entry) => [String(entry.symbol), JSON.stringify(entry)]),
    );
    for (const reinvention of REINVENTIONS) {
      const [owner, member] = reinvention.capability.split(".");
      if (reinvention.source === "three") {
        expect(owner, reinvention.capability).toBe("MathUtils");
        const members = MathUtils as unknown as Record<string, unknown>;
        expect(typeof members[member ?? ""], reinvention.capability).toBe("function");
        continue;
      }
      if (entries.has(reinvention.capability)) continue;
      const ownerRow = owner === undefined ? undefined : entries.get(owner);
      expect(ownerRow, reinvention.capability).toBeDefined();
      expect(ownerRow?.includes(member ?? ""), reinvention.capability).toBe(true);
    }
    // The messages also name these, and a message that names nothing is the bug the spec exists for.
    expect(entries.has("debugValue"), "debugValue").toBe(true);
    expect(typeof (InputMap.prototype as unknown as Record<string, unknown>).axis).toBe("function");
  });

  it("should pass every kit's own source under the hot rules and the rows", () => {
    const templatesRoot = fileURLToPath(new URL("../templates", import.meta.url));
    const sourceFiles = (directory: string): string[] =>
      readdirSync(directory).flatMap((entry) => {
        const file = path.join(directory, entry);
        if (statSync(file).isDirectory()) return sourceFiles(file);
        return /\.tsx?$/u.test(entry) ? [file] : [];
      });
    const files = readdirSync(templatesRoot).flatMap((kit) => {
      const source = path.join(templatesRoot, kit, "src");
      if (!existsSync(source)) return [];
      return sourceFiles(source).map((file) => ({ file, kit }));
    });
    // Fail closed: a discovery bug must not report a green zero.
    expect(files.length).toBeGreaterThan(300);

    const found: string[] = [];
    for (const { file, kit } of files) {
      const relative = path.relative(path.join(templatesRoot, kit), file);
      const messages = new Linter().verify(
        readFileSync(file, "utf8"),
        [
          {
            files: ["src/**/*.ts", "src/**/*.tsx"],
            languageOptions: { parser: tsParser as Linter.Parser },
            plugins: { threenative: threenativePlugin },
            rules: {
              "threenative/hot-callback-allocation": "error",
              "threenative/hot-callback-resource-creation": "error",
              "threenative/hot-callback-scene-work": "error",
            },
          },
          ...reinventionConfigs(["src/**/*.ts", "src/**/*.tsx"]),
        ],
        relative,
      );
      for (const message of messages)
        found.push(`${kit}/${relative}:${message.line} ${message.message}`);
    }
    expect(found).toEqual([]);
  });

  it("keeps a path's excluded rows out and leaves the others on", () => {
    const configs = reinventionConfigs(["src/**/*.ts"]);
    const lint = (source: string, filename: string): string[] =>
      new Linter()
        .verify(source, configs, filename)
        .map((message) => message.ruleId ?? `parse:${message.message}`);
    const ui = "const r = Math.random();\nconst t = u * u * (3 - 2 * u);\n";
    // The UI keeps the platform RNG and still gets the smoothstep row.
    expect(lint(ui, "src/ui/hud.ts").length).toBe(1);
    // The same two lines in a scene are both reinventions.
    expect(lint(ui, "src/scenes/Play.ts").length).toBe(2);
  });
});
