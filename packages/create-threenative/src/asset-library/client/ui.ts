// Element and request helpers the Dashboard panels share (PRD-918, PRD-923).
export { getJson, mb } from "./viewers.js";

type Child = Node | string | false | null | undefined;

/** `h("div", "card p-4", "text")` or `h("div", "grid", [child, child])`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  content: Child | readonly Child[] = null,
  attributes: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  for (const child of Array.isArray(content) ? content : [content])
    if (child !== false && child !== null && child !== undefined) node.append(child);
  return node;
}

/** A JSON write to the Dashboard API; the server refuses anything else (same-origin JSON only). */
export async function sendJson<T>(
  url: string,
  method: "PATCH" | "POST",
  body: unknown = {},
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({ error: response.statusText }))) as T & {
    error?: string;
    fields?: Record<string, string>;
  };
  if (!response.ok)
    throw Object.assign(new Error(parsed.error ?? `${response.status}`), { fields: parsed.fields });
  return parsed;
}

/** A Studio-style on/off switch. */
export function toggle(
  label: string,
  checked: boolean,
  onChange: (next: boolean) => void,
): HTMLButtonElement {
  const button = h("button", "switch", null, {
    type: "button",
    role: "switch",
    "aria-label": label,
  });
  const set = (on: boolean) => button.setAttribute("aria-checked", String(on));
  set(checked);
  button.onclick = () => {
    const next = button.getAttribute("aria-checked") !== "true";
    set(next);
    onChange(next);
  };
  return button;
}

/** A small rounded status chip. */
export function chip(
  text: string,
  tone: "ok" | "warn" | "bad" | "muted" | "accent" = "muted",
): HTMLSpanElement {
  const tones = {
    ok: "border-live/40 text-live",
    warn: "border-warn/40 text-warn",
    bad: "border-danger/40 text-danger",
    muted: "border-line text-muted",
    accent: "border-accent/40 text-accent",
  };
  return h(
    "span",
    `inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`,
    text,
  );
}

/** The panel heading every section shares. */
export function header(title: string, subtitle: string, actions: Child[] = []): HTMLElement {
  return h("header", "flex flex-wrap items-end gap-3 border-b border-line px-8 pt-7 pb-5", [
    h("div", "min-w-0 flex-1", [
      h("h1", "text-[20px] leading-tight font-semibold tracking-tight text-ink", title),
      h("p", "mt-1 text-muted", subtitle),
    ]),
    ...actions,
  ]);
}
