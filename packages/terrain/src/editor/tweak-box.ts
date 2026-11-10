/** A range bar over a number. */
export interface ITweakRange {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** The bar's step and the snapshot's rounding. Default: a hundredth of the range. */
  readonly step?: number;
  /** A heading drawn above the first knob that names it. */
  readonly group?: string;
}
/** A picker over an sRGB hex colour. */
export interface ITweakColor {
  readonly color: number;
  readonly group?: string;
}
/** One knob of a tweak box. */
export type TweakKnob = ITweakRange | ITweakColor;

/** The page, the store and the clipboard a tweak box uses. A test passes its own. */
export interface ITweakHost {
  readonly document?: Document;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  readonly copy?: (text: string) => void;
}

export interface ITweakBoxOptions<K extends string> {
  /** The box's heading, and the `tweaks` name written into a snapshot. */
  readonly title: string;
  readonly knobs: Readonly<Record<K, TweakKnob>>;
  /** Called once per knob when the box is made, with the stored or default value, and on each change. */
  readonly onChange: (name: K, value: number, values: Readonly<Record<K, number>>) => void;
  /** Where the values survive a reload (`localStorage`). Absent, nothing is stored. */
  readonly storageKey?: string;
  readonly host?: ITweakHost;
}

export interface ITweakBox<K extends string> {
  /** The live values: a number per knob, a colour as its sRGB hex number. */
  readonly values: Readonly<Record<K, number>>;
  /** Set one knob as its bar would. Throws on a value outside the knob's range. */
  set(name: K, value: number): void;
  /** The values as JSON text: numbers at their step, colours as `#rrggbb`. This is what Copy copies. */
  snapshot(): string;
  /** Put every knob back to the value its spec names, and forget the stored ones. */
  reset(): void;
  dispose(): void;
}

const isColor = (knob: TweakKnob): knob is ITweakColor => "color" in knob;
const hex = (value: number): string => `#${value.toString(16).padStart(6, "0")}`;

function valid(name: string, knob: TweakKnob, value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (isColor(knob)) return Number.isInteger(value) && value >= 0 && value <= 0xffffff;
  if (!(knob.min < knob.max)) throw new RangeError(`Tweak '${name}': min must be below max.`);
  return value >= knob.min && value <= knob.max;
}

/**
 * A box of range bars and colour pickers over the running game, for tuning numbers by eye.
 *
 * The game names its knobs and applies each change itself; the box owns the page elements, the
 * stored values and the Copy button, whose JSON is what gets pasted back and written into the game's
 * own source. With no `document` (a native launch, a test) it draws nothing and still holds the
 * values, so the game code that reads them is the same on every target.
 *
 * @situation tune look numbers by eye with live range bars and colour pickers while the game runs
 * @requires npm i -D @threenative/terrain
 */
export function createTweakBox<K extends string>(options: ITweakBoxOptions<K>): ITweakBox<K> {
  const names = Object.keys(options.knobs) as K[];
  const spec = (name: K): TweakKnob => options.knobs[name];
  const initial = (name: K): number => {
    const knob = spec(name);
    const value = isColor(knob) ? knob.color : knob.value;
    if (!valid(name, knob, value)) throw new RangeError(`Tweak '${name}': default out of range.`);
    return value;
  };
  const host: ITweakHost = options.host ?? {
    document: globalThis.document,
    storage: globalThis.localStorage,
    copy: (text) => void globalThis.navigator?.clipboard?.writeText(text),
  };
  const values = Object.fromEntries(names.map((name) => [name, initial(name)])) as Record<
    K,
    number
  >;
  // A stored value from an older knob list, or outside today's range, is dropped, not applied.
  const key = options.storageKey;
  try {
    const stored: unknown = key ? JSON.parse(host.storage?.getItem(key) ?? "{}") : {};
    for (const name of names) {
      const value = (stored as Record<string, unknown> | null)?.[name];
      if (valid(name, spec(name), value)) values[name] = value;
    }
  } catch {
    // Unreadable stored text is the same as none.
  }
  const inputs = new Map<K, HTMLInputElement>();
  const show = (name: K): void => {
    const input = inputs.get(name);
    if (input) input.value = isColor(spec(name)) ? hex(values[name]) : String(values[name]);
    const label = input?.previousElementSibling;
    if (label)
      label.textContent = `${name} ${isColor(spec(name)) ? hex(values[name]) : Number(values[name].toPrecision(6))}`;
  };
  const set = (name: K, value: number): void => {
    if (!(name in options.knobs))
      throw new RangeError(`Tweak '${name}' is not a knob of this box.`);
    if (!valid(name, spec(name), value))
      throw new RangeError(`Tweak '${name}': ${value} is out of range.`);
    values[name] = value;
    if (key) host.storage?.setItem(key, JSON.stringify(values));
    show(name);
    options.onChange(name, value, values);
  };
  const snapshot = (): string =>
    JSON.stringify(
      {
        tweaks: options.title,
        values: Object.fromEntries(
          names.map((name) => {
            const knob = spec(name);
            if (isColor(knob)) return [name, hex(values[name])];
            const step = knob.step ?? (knob.max - knob.min) / 100;
            return [name, Number((Math.round(values[name] / step) * step).toPrecision(6))];
          }),
        ),
      },
      null,
      1,
    );
  const reset = (): void => {
    if (key) host.storage?.removeItem(key);
    for (const name of names) {
      values[name] = initial(name);
      show(name);
      options.onChange(name, values[name], values);
    }
  };

  const page = host.document;
  const box = page?.createElement("div");
  if (page && box) {
    box.style.cssText =
      "position:fixed;top:8px;right:8px;z-index:9999;width:270px;max-height:94vh;overflow:auto;" +
      "padding:8px 10px;background:#111c;color:#eee;font:11px/1.3 system-ui,sans-serif;border-radius:6px";
    const row = (text: string, bold = false): HTMLElement => {
      const element = page.createElement("div");
      element.textContent = text;
      if (bold) element.style.cssText = "font-weight:700;margin:8px 0 2px";
      return box.appendChild(element);
    };
    row(options.title, true);
    const button = (text: string, act: () => void): void => {
      const element = page.createElement("button");
      element.textContent = text;
      element.style.cssText = "margin:2px 6px 6px 0;padding:4px 10px;cursor:pointer";
      element.addEventListener("click", act);
      box.appendChild(element);
    };
    button("Copy snapshot", () => host.copy?.(snapshot()));
    button("Reset", reset);
    let group: string | undefined;
    for (const name of names) {
      const knob = spec(name);
      if (knob.group && knob.group !== group) row(knob.group, true);
      group = knob.group ?? group;
      row(name);
      const input = page.createElement("input");
      input.type = isColor(knob) ? "color" : "range";
      if (!isColor(knob)) {
        input.min = String(knob.min);
        input.max = String(knob.max);
        input.step = String(knob.step ?? (knob.max - knob.min) / 100);
      }
      input.style.cssText = "width:100%;margin:0 0 4px";
      input.addEventListener("input", () =>
        set(name, isColor(knob) ? Number.parseInt(input.value.slice(1), 16) : Number(input.value)),
      );
      // A key press on a bar must not also drive the game's own input.
      input.addEventListener("keydown", (event) => event.stopPropagation());
      box.appendChild(input);
      inputs.set(name, input);
      show(name);
    }
    page.body.appendChild(box);
  }
  for (const name of names) options.onChange(name, values[name], values);
  return { values, set, snapshot, reset, dispose: () => box?.remove() };
}
