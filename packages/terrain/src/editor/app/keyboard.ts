/** Native controls own their keys; only the viewport turns activation into a terrain edit. */
export function editorKeyAction(
  event: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  },
  tag = "",
  viewport = false,
  splinePending = false,
): string | undefined {
  const key = event.key.toLowerCase();
  if (key === "escape") return "cancel";
  if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "SUMMARY"].includes(tag)) return;
  if (event.ctrlKey || event.metaKey) {
    if (key === "z") return event.shiftKey ? "redo" : "undo";
    if (key === "y") return "redo";
    return;
  }
  if (/^[0-9]$/.test(key)) return `tool:${(Number(key) + 9) % 10}`;
  if (key === "q") return "select";
  if (key === "v") return "navigate";
  if (key === "f") return "frame";
  if (viewport && ["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) return key;
  // Clicks then Enter is how the recovered GUI finishes a spline; Space still adds a point.
  if (viewport && key === "enter" && splinePending) return "finish";
  if (viewport && (key === "enter" || key === " ")) return "apply";
  if (key === "enter") return "finish";
}

/** FIFO delivery keeps simultaneous errors and repeated messages observable. */
export class AnnouncementQueue {
  private readonly messages: { message: string; blocking: boolean }[] = [];
  push(message: string, blocking = false): void {
    if (message.trim()) this.messages.push({ message, blocking });
  }
  shift(): { message: string; blocking: boolean } | undefined {
    return this.messages.shift();
  }
}
