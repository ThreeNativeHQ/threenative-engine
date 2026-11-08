import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../src/runtime.cpp", import.meta.url)),
  "utf8",
);
const constructorScript = readFileSync(
  fileURLToPath(new URL("../src/runtime-scripts/event-constructors-setup.js", import.meta.url)),
  "utf8",
);

function constructorSource(runtime, script) {
  assert.match(
    runtime,
    /evalRuntimeScript\(\*jsEngine_, runtime_scripts::Script::event_constructors_setup/u,
    "runtime must load executable event constructors",
  );
  for (const name of ["Event", "PointerEvent", "TouchEvent", "KeyboardEvent", "ErrorEvent"]) {
    assert.match(script, new RegExp(`globalThis\\.${name} = ${name};`, "u"));
  }
  return script;
}

function assertDispatchContract(candidate) {
  for (const target of ["canvas", "document", "window"]) {
    assert.match(
      candidate,
      new RegExp(`dispatchConstructedEvent\\("${target}", ${target}, args\\)`, "u"),
    );
  }
  assert.match(candidate, /eventListeners_\.find\(target\)/u);
  assert.match(candidate, /jsEngine_->call\(listener\.callback, targetObject, \{event\}\)/u);
  assert.match(candidate, /_immediatePropagationStopped/u);
  assert.match(candidate, /!jsEngine_->toBoolean\(defaultPrevented\)/u);
}

test("native Event constructors expose the fields used by runtime event scenes", () => {
  const context = vm.createContext({});
  vm.runInContext(constructorSource(source, constructorScript), context);

  const result = vm.runInContext(
    `(() => {
      const uncancelable = new Event("resize");
      uncancelable.preventDefault();
      const cancelable = new Event("submit", { cancelable: true, bubbles: true });
      cancelable.preventDefault();
      cancelable.stopPropagation();
      const pointer = new PointerEvent("pointerdown", {
        pointerId: 7, pointerType: "touch", clientX: 12, buttons: 1, isPrimary: true
      });
      const touches = [{ identifier: 4 }];
      const touch = new TouchEvent("touchstart", { touches, changedTouches: touches });
      const keyboard = new KeyboardEvent("keydown", { key: "a", code: "KeyA", repeat: true });
      return {
        uncancelable: uncancelable.defaultPrevented,
        cancelable: cancelable.defaultPrevented,
        bubbles: cancelable.bubbles,
        stopped: cancelable.cancelBubble,
        pointer: [pointer.pointerId, pointer.pointerType, pointer.clientX, pointer.buttons, pointer.isPrimary],
        touch: [touch.touches.length, touch.changedTouches[0].identifier],
        keyboard: [keyboard.key, keyboard.code, keyboard.repeat],
      };
    })()`,
    context,
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    uncancelable: false,
    cancelable: true,
    bubbles: true,
    stopped: true,
    pointer: [7, "touch", 12, 1, true],
    touch: [1, 4],
    keyboard: ["a", "KeyA", true],
  });
  assert.throws(() => vm.runInContext("new Event()", context), /requires a type/u);
});

test("canvas, document, and window dispatch through native listener storage", () => {
  assert.doesNotThrow(() => assertDispatchContract(source));
});

test("event plumbing contract fails closed when a constructor or target route disappears", () => {
  assert.throws(() =>
    constructorSource(
      source.replace("evalRuntimeScript(*jsEngine_, runtime_scripts::Script::event_constructors_setup", "removed"),
      constructorScript,
    ),
  );
  assert.throws(() =>
    assertDispatchContract(
      source.replace('dispatchConstructedEvent("window", window, args)', "dispatch removed"),
    ),
  );
});
