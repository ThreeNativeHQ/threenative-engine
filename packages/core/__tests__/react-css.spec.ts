import { type ReactNode, createElement } from "react";
import { describe, expect, it } from "vitest";
import { CSS_UI_MESSAGE, createCssUiRoot } from "../src/react-css.js";
import type { IUiMessage } from "../src/ui-bridge.js";

interface IOp {
  op: string;
  [key: string]: unknown;
}

interface IFakeScope {
  readonly frames: IUiMessage[];
  readonly scope: Record<string, unknown>;
  send(message: IUiMessage): void;
}

/** The `host` transport with a hand: `__tnUiPost` collects frames, `__tnUiGameReceive` injects them. */
function fakeScope(): IFakeScope {
  const frames: IUiMessage[] = [];
  const scope: Record<string, unknown> = {
    __tnUiPost: (frame: string) => {
      frames.push(JSON.parse(frame) as IUiMessage);
    },
  };
  const inject = (message: IUiMessage): void => {
    // Fail closed on a root that never connected, rather than testing a scope nobody listens to.
    const inbound = scope.__tnUiGameReceive as ((frame: string) => void) | undefined;
    if (inbound === undefined)
      throw new Error("TN_TEST_BRIDGE_MISSING: the game end never connected.");
    inbound(JSON.stringify(message));
  };
  return {
    frames,
    scope,
    send: inject,
  };
}

function opsOf(frame: IUiMessage | undefined): IOp[] {
  expect(frame?.type).toBe(CSS_UI_MESSAGE);
  return (frame?.ops ?? []) as IOp[];
}

function lastFrame(frames: readonly IUiMessage[]): IOp[] {
  return opsOf(frames.at(-1));
}

function classesOf(ops: readonly IOp[]): string[] {
  return ops
    .filter((op) => op.op === "attr" && op.name === "class")
    .map((op) => op.value as string);
}

function idOf(ops: readonly IOp[], tag: string): number {
  const created = ops.find((op) => op.op === "create" && op.tag === tag);
  if (created === undefined) throw new Error(`TN_TEST_TAG_MISSING: no <${tag}> in the frame.`);
  return created.id as number;
}

function lastRootAppend(ops: readonly IOp[]): number {
  let at = -1;
  for (const [index, op] of ops.entries()) if (op.op === "append" && op.parent === 0) at = index;
  return at;
}

/** The inventory panel the brief names, built from the tags and classes a real HUD ships. */
function inventory(onUse: () => void): ReactNode {
  return createElement(
    "section",
    { className: "fixed inset-x-0 top-0 z-10 max-w-[calc(100vw-3rem)]" },
    createElement("h2", { className: "text-sm font-bold uppercase" }, "Inventory"),
    createElement("p", { className: "text-zinc-400" }, "3 / 12 slots"),
    createElement(
      "div",
      { className: "grid grid-cols-2 gap-2" },
      createElement(
        "div",
        { className: "rounded bg-zinc-900/90 p-2" },
        createElement("span", null, "Iron Sword"),
      ),
      createElement(
        "div",
        { className: "rounded bg-zinc-900/90 p-2 hover:bg-brand/80" },
        createElement("span", null, "Health Potion"),
      ),
    ),
    createElement("button", { className: "px-3 py-1", onClick: onUse, type: "button" }, "Use"),
  );
}

describe("createCssUiRoot", () => {
  it("mounts a HUD as one frame that makes every node before it wires them", () => {
    const fake = fakeScope();
    const root = createCssUiRoot({ scope: fake.scope });

    root.render(inventory(() => undefined));

    expect(fake.frames).toHaveLength(1);
    const ops = opsOf(fake.frames[0]);
    // React builds bottom-up, so the frame must be reordered for the engine: every node exists
    // before any parent names it, and the body root's own append is the last op of the batch.
    const lastAppend = lastRootAppend(ops);
    expect(lastAppend).toBe(ops.length - 1);
    for (const [index, op] of ops.entries()) {
      if (op.op !== "create" && op.op !== "text" && op.op !== "attr" && op.op !== "listen")
        continue;
      expect(index).toBeLessThan(lastAppend);
    }
    // Class strings are CSS the engine resolves, so they cross exactly as written. React completes
    // a subtree before its parent, so they arrive in creation order rather than document order.
    expect([...classesOf(ops)].sort()).toEqual(
      [
        "fixed inset-x-0 top-0 z-10 max-w-[calc(100vw-3rem)]",
        "text-sm font-bold uppercase",
        "text-zinc-400",
        "grid grid-cols-2 gap-2",
        "rounded bg-zinc-900/90 p-2",
        "rounded bg-zinc-900/90 p-2 hover:bg-brand/80",
        "px-3 py-1",
      ].sort(),
    );
    expect(ops.filter((op) => op.op === "listen")).toEqual([
      { event: "click", id: idOf(ops, "button"), op: "listen" },
    ]);
    expect(root.postCount).toBe(1);
    root.dispose();
  });

  it("sends one attribute op for a className change and nothing else", () => {
    const fake = fakeScope();
    const root = createCssUiRoot({ scope: fake.scope });
    const panel = (className: string): ReactNode =>
      createElement("section", { className }, createElement("h2", null, "Inventory"));

    root.render(panel("fixed inset-0"));
    const section = idOf(lastFrame(fake.frames), "section");
    root.render(panel("fixed inset-x-0 top-0"));

    expect(fake.frames).toHaveLength(2);
    expect(lastFrame(fake.frames)).toEqual([
      { id: section, name: "class", op: "attr", value: "fixed inset-x-0 top-0" },
    ]);
    root.dispose();
  });

  it("converts a style object to one attribute using React's own rules", () => {
    const fake = fakeScope();
    const root = createCssUiRoot({ scope: fake.scope });

    root.render(
      createElement("p", {
        style: {
          WebkitLineClamp: "2",
          "--ring": 4,
          backgroundColor: "#101010",
          display: null,
          flexGrow: undefined,
          fontSize: 12,
          gridColumnEnd: 3,
          gridColumnStart: 2,
          gridRowEnd: "span 2",
          gridRowStart: 1,
          lineClamp: 2,
          lineHeight: 1.5,
          marginTop: 8,
          opacity: 0.5,
          pointerEvents: true,
          zIndex: 3,
        },
      }),
    );

    // `px` on the lengths, bare on the unitless set, verbatim for the custom property, and the
    // vendor prefix kept. `display`, `flexGrow` and `pointerEvents` are not declarations.
    const style = lastFrame(fake.frames).find((op) => op.op === "attr" && op.name === "style");
    expect(style?.value).toBe(
      "-webkit-line-clamp: 2; --ring: 4; background-color: #101010; font-size: 12px; grid-column-end: 3; grid-column-start: 2; grid-row-end: span 2; grid-row-start: 1; line-clamp: 2; line-height: 1.5; margin-top: 8px; opacity: 0.5; z-index: 3",
    );
    root.dispose();
  });

  it("treats disabled as a boolean attribute, in both directions", () => {
    const fake = fakeScope();
    const root = createCssUiRoot({ scope: fake.scope });
    const button = (disabled: boolean): ReactNode =>
      createElement("button", { disabled, type: "button" }, "Use");

    root.render(button(true));
    const id = idOf(lastFrame(fake.frames), "button");
    expect(lastFrame(fake.frames)).toContainEqual({ id, name: "disabled", op: "attr", value: "" });

    root.render(button(false));
    expect(lastFrame(fake.frames)).toEqual([{ id, name: "disabled", op: "attr", value: null }]);
    root.dispose();
  });

  it("routes an injected event to the handler that asked for it, and to nothing else", () => {
    const fake = fakeScope();
    const root = createCssUiRoot({ scope: fake.scope });
    const seen: { guarded: boolean; id: number; type: string }[] = [];
    const onClick = (event: {
      preventDefault(): void;
      stopPropagation(): void;
      target: { id: number };
      type: string;
    }): void => {
      event.preventDefault();
      event.stopPropagation();
      seen.push({ guarded: true, id: event.target.id, type: event.type });
    };

    root.render(createElement("button", { onClick, type: "button" }, "Use"));
    const button = idOf(lastFrame(fake.frames), "button");

    fake.send({ id: button, type: "click" });
    fake.send({ id: button, type: "pointerdown" });
    fake.send({ id: 9_999, type: "click" });
    fake.send({ type: "click" });
    fake.send({ id: "3", type: "click" });
    fake.send({ id: button, type: "tn:state" });

    expect(seen).toEqual([{ guarded: true, id: button, type: "click" }]);
    root.dispose();
  });

  it.each([false, true])(
    "stops the native ancestor messages from the same click dispatch (%s)",
    (stop) => {
      const fake = fakeScope();
      const root = createCssUiRoot({ scope: fake.scope });
      const seen: string[] = [];
      root.render(
        createElement(
          "div",
          { onClick: () => seen.push("parent") },
          createElement(
            "button",
            {
              type: "button",
              onClick: (event: { stopPropagation(): void }) => {
                seen.push("child");
                if (stop) event.stopPropagation();
              },
            },
            "Use",
          ),
        ),
      );
      const ops = lastFrame(fake.frames);
      const child = idOf(ops, "button");
      const parent = idOf(ops, "div");
      for (const dispatch of ["1", "2"]) {
        fake.send({ dispatch, id: child, type: "click" });
        fake.send({ dispatch, id: parent, type: "click" });
      }
      expect(seen).toEqual(stop ? ["child", "child"] : ["child", "parent", "child", "parent"]);
      root.dispose();
    },
  );

  it("a retained event cannot stop a later native click dispatch", () => {
    const fake = fakeScope();
    const root = createCssUiRoot({ scope: fake.scope });
    const seen: string[] = [];
    let previous: { stopPropagation(): void } | undefined;
    root.render(
      createElement(
        "div",
        { onClick: () => seen.push("parent") },
        createElement(
          "button",
          {
            type: "button",
            onClick: (event: { stopPropagation(): void }) => {
              seen.push("child");
              if (previous === undefined) previous = event;
              else previous.stopPropagation();
            },
          },
          "Use",
        ),
      ),
    );
    const ops = lastFrame(fake.frames);
    const child = idOf(ops, "button");
    const parent = idOf(ops, "div");
    for (const dispatch of ["1", "2"]) {
      fake.send({ dispatch, id: child, type: "click" });
      fake.send({ dispatch, id: parent, type: "click" });
    }
    expect(seen).toEqual(["child", "parent", "child", "parent"]);
    root.dispose();
  });

  it("moves a keyed sibling with insertBefore instead of recreating it", () => {
    const fake = fakeScope();
    const root = createCssUiRoot({ scope: fake.scope });
    const list = (keys: readonly string[]): ReactNode =>
      createElement(
        "ul",
        null,
        ...keys.map((key) => createElement("li", { className: "slot", key }, key)),
      );

    root.render(list(["a", "b", "c"]));
    const mount = opsOf(fake.frames[0]);
    const list_ = idOf(mount, "ul");
    const items = mount.filter((op) => op.op === "create" && op.tag === "li");
    const [a, c] = [items[0]?.id as number, items[2]?.id as number];

    root.render(list(["b", "a", "c"]));

    const ops = lastFrame(fake.frames);
    expect(ops.filter((op) => op.op === "create")).toEqual([]);
    expect(ops).toEqual([{ before: c, child: a, op: "insertBefore", parent: list_ }]);
    root.dispose();
  });

  it("removes a subtree as one op and forgets its handlers", () => {
    const fake = fakeScope();
    const root = createCssUiRoot({ scope: fake.scope });
    let clicks = 0;
    const bump = (): void => {
      clicks += 1;
    };
    const withButton = (): ReactNode =>
      createElement(
        "div",
        { className: "panel" },
        createElement("button", { onClick: bump, type: "button" }, "Go"),
      );

    root.render(withButton());
    const mount = lastFrame(fake.frames);
    const button = idOf(mount, "button");
    fake.send({ id: button, type: "click" });
    expect(clicks).toBe(1);

    root.render(createElement("div", { className: "panel" }));

    expect(lastFrame(fake.frames).filter((op) => op.op === "remove")).toEqual([
      { id: button, op: "remove" },
    ]);
    fake.send({ id: button, type: "click" });
    expect(clicks).toBe(1);
    root.dispose();
  });

  it("refuses an element the native engine cannot build, naming it and the allowed tags", () => {
    const fake = fakeScope();
    const errors: Error[] = [];
    const root = createCssUiRoot({ onError: (error) => errors.push(error), scope: fake.scope });

    root.render(createElement("marquee", null, "scrolling"));

    expect(errors[0]?.message).toContain("TN_CSS_UI_ELEMENT_UNSUPPORTED: <marquee>");
    expect(errors[0]?.message).toContain("div");
    // Named, not dropped: no frame ever claims to have built a <marquee>.
    for (const frame of fake.frames) {
      expect(opsOf(frame).filter((op) => op.op === "create" && op.tag === "marquee")).toEqual([]);
    }
    root.dispose();
  });

  it("refuses dangerouslySetInnerHTML rather than dropping the markup", () => {
    const fake = fakeScope();
    const errors: Error[] = [];
    const root = createCssUiRoot({ onError: (error) => errors.push(error), scope: fake.scope });

    // biome-ignore lint/security/noDangerouslySetInnerHtml: the refusal itself is what is under test.
    root.render(createElement("div", { dangerouslySetInnerHTML: { __html: "<b>hi</b>" } }));

    expect(errors[0]?.message).toContain("TN_CSS_UI_PROP_UNSUPPORTED: dangerouslySetInnerHTML");
    root.dispose();
  });

  it("mounts a thousand nodes in one post", () => {
    const fake = fakeScope();
    const root = createCssUiRoot({ scope: fake.scope });

    root.render(
      createElement(
        "div",
        { className: "grid" },
        ...Array.from({ length: 1_000 }, (_unused, index) =>
          createElement("span", { className: "cell", key: index }, `cell ${index}`),
        ),
      ),
    );

    expect(fake.frames.filter((frame) => frame.type === CSS_UI_MESSAGE)).toHaveLength(1);
    expect(root.postCount).toBe(1);
    // A create, a class, a text node and two appends per cell, plus the wrapper and its own three.
    expect(root.opCount).toBe(1_000 * 5 + 3);
    root.dispose();
  });

  it("posts nothing when a re-render changes no attribute", () => {
    const fake = fakeScope();
    const root = createCssUiRoot({ scope: fake.scope });

    root.render(inventory(() => undefined));
    const posts = root.postCount;
    root.render(inventory(() => undefined));

    expect(root.postCount).toBe(posts);
    expect(fake.frames.filter((frame) => frame.type === CSS_UI_MESSAGE)).toHaveLength(1);
    root.dispose();
  });

  it("publishes the removal on dispose and stops listening", () => {
    const fake = fakeScope();
    const root = createCssUiRoot({ scope: fake.scope });
    let clicks = 0;
    const bump = (): void => {
      clicks += 1;
    };
    root.render(createElement("button", { onClick: bump, type: "button" }, "Go"));
    const button = idOf(lastFrame(fake.frames), "button");
    // The host's own reference to the inbound entry point, which it still holds after a close.
    const hostReceive = fake.scope.__tnUiGameReceive as (frame: string) => void;

    root.dispose();

    expect(lastFrame(fake.frames).filter((op) => op.op === "remove")).toEqual([
      { id: button, op: "remove" },
    ]);
    hostReceive(JSON.stringify({ id: button, type: "click" }));
    expect(clicks).toBe(0);
  });
});
