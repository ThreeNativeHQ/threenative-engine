import { describe, expect, it } from "vitest";
import { AnnouncementQueue, editorKeyAction } from "../src/editor/app/keyboard.js";

describe("editor keyboard and announcements", () => {
  it("maps all ten brush shortcuts and selection", () => {
    for (let i = 0; i < 10; i++)
      expect(editorKeyAction({ key: String((i + 1) % 10) })).toBe(`tool:${i}`);
    expect(editorKeyAction({ key: "Q" })).toBe("select");
    expect(editorKeyAction({ key: "v" })).toBe("navigate");
    expect(editorKeyAction({ key: "f" })).toBe("frame");
  });
  it("leaves native controls and modified shortcuts alone", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "SUMMARY"])
      for (const key of ["1", "Enter", " ", "ArrowRight"])
        expect(editorKeyAction({ key }, tag)).toBeUndefined();
    expect(editorKeyAction({ key: "1", ctrlKey: true })).toBeUndefined();
    expect(editorKeyAction({ key: "z", metaKey: true })).toBe("undo");
    expect(editorKeyAction({ key: "z", ctrlKey: true, shiftKey: true })).toBe("redo");
    expect(editorKeyAction({ key: "y", ctrlKey: true })).toBe("redo");
  });
  it("maps viewport arrows and activation without stealing button Enter", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"])
      expect(editorKeyAction({ key }, "DIV", true)).toBe(key.toLowerCase());
    for (const key of ["Enter", " "]) expect(editorKeyAction({ key }, "DIV", true)).toBe("apply");
    expect(editorKeyAction({ key: "Enter" }, "BUTTON")).toBeUndefined();
    expect(editorKeyAction({ key: "Enter" })).toBe("finish");
    // Clicks then Enter finishes a spline in the viewport; Space keeps adding points.
    expect(editorKeyAction({ key: "Enter" }, "DIV", true, true)).toBe("finish");
    expect(editorKeyAction({ key: " " }, "DIV", true, true)).toBe("apply");
  });
  it("cancels even with a text field focused", () => {
    expect(editorKeyAction({ key: "Escape" }, "INPUT")).toBe("cancel");
  });
  it("queues simultaneous and repeated messages without losing blocking severity", () => {
    const queue = new AnnouncementQueue();
    queue.push("  ");
    queue.push("Invalid recipe");
    queue.push("Save failed", true);
    queue.push("Save failed", true);
    expect(queue.shift()).toEqual({ message: "Invalid recipe", blocking: false });
    expect(queue.shift()).toEqual({ message: "Save failed", blocking: true });
    expect(queue.shift()).toEqual({ message: "Save failed", blocking: true });
    expect(queue.shift()).toBeUndefined();
  });
});
