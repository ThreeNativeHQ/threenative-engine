/** Required recovered controls fail by ID rather than silently dropping an edit. */
export function $<T extends HTMLElement = HTMLInputElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing editor control: ${id}`);
  return element as T;
}
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}
export function field(label: string, input: HTMLElement) {
  return element("label", { class: "field-label" }, label, input);
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
