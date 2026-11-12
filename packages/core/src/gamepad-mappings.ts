import type { IInputGamepad } from "./input.js";

/**
 * The web half of the one interface a game reads a controller through: the W3C "standard"
 * mapping. A pad the browser already maps needs nothing; a pad it reports unmapped
 * (`mapping: ""`, which is the browser saying "I do not know this device") is turned into the
 * standard layout by one table row per measured device, never by a class per model.
 *
 * The rows are SDL_GameControllerDB entries, copied verbatim and stamped with the line they came
 * from (`third_party/sdl3/SDL3-3.2.30/src/joystick/SDL_gamepad_db.h`). The database carries several
 * GUID forms per device — a USB hidraw entry, a Bluetooth one, and one per host driver — and which
 * of them a browser reports is the device read still open on this PRD. What the rows do here is name
 * the slots, and for every form of these devices the sticks and the face/shoulder/start/back/stick
 * buttons are the same; the triggers are axes in the forms below and buttons in the
 * `SDL_JOYSTICK_DINPUT` (Windows) form at `:72`, which no browser reports.
 *
 * The d-pad is deliberately not mapped: every row expresses it as a hat (`h0.1`), which arrives in a
 * browser as two extra axes in a device-specific order. No kit here binds the d-pad, so a row ships
 * the sticks, the triggers and the face/shoulder/start/back/stick-click buttons only.
 */

/** Which normalizer read a pad — the word a `TN_GAMEPAD` line reports. */
export type GamepadNormalizer = "standard" | "table" | "unmapped";

/** The W3C standard's 16 buttons; 6 and 7 are the analog triggers, read from axes. */
export const STANDARD_BUTTON_COUNT = 16;

/** The standard's 4 stick axes: left x/y, then right x/y. */
export const STANDARD_AXIS_COUNT = 4;

/**
 * A mutable standard pad: the buffer a normalizer fills and `InputMap` publishes. One is allocated
 * per pad the reader has to normalize, then mutated every tick — normalizing must not allocate in
 * the frame loop.
 */
export interface IStandardPad {
  readonly axes: number[];
  readonly buttons: { pressed: boolean }[];
}

export function createStandardPad(): IStandardPad {
  const buttons: { pressed: boolean }[] = [];
  for (let index = 0; index < STANDARD_BUTTON_COUNT; index += 1) buttons.push({ pressed: false });
  return { axes: [0, 0, 0, 0], buttons };
}

/** One device the browser cannot map, keyed by the vendor:product its `id` carries. */
interface IPadRow {
  /** The SDL_GameControllerDB mapping string, verbatim. */
  readonly map: string;
  readonly product: number;
  readonly vendor: number;
}

const PAD_ROWS: readonly IPadRow[] = [
  {
    // 8BitDo Ultimate C 2.4G Wireless Controller, **measured on the owner's device** (2026-11-11):
    // the kernel reports `2dc8:3016` and Chromium reports `mapping: ""` for it, so this row is the
    // only thing that makes the pad work on the web. SDL 3.2.30 has no row for `3016` under any name
    // (its 8BitDo entries are `301b`, `3013`, `3011`, `3012`), so nothing could be copied.
    // Linux sorts an unmapped pad's buttons and axes by evdev code, and the measured device exposes
    // KEY 304..318 and ABS 0,1,2,5,9,10,16,17 — so the raw indices are that order: b0..b14 are
    // A, B, C, X, Y, Z, LB, RB, LT, RT, Select, Start, Home, L3, R3, and a0..a7 are ABS_X, ABS_Y,
    // ABS_Z, ABS_RZ, ABS_GAS, ABS_BRAKE, HAT0X, HAT0Y. Hence X and Y sit on b3/b4 (not b2/b3), the
    // right stick is a2/a3, and the triggers are a5 (left) and a4 (right), travelling -1..1.
    // What was measured in Chromium, by pressing the pad: A, B, X, Y, LB, RB, Select and Start at raw
    // 0, 1, 3, 4, 6, 7, 10, 11, the left stick on a0/a1 and the right stick on a2/a3. The trigger sides
    // are derived from the kernel instead, which is the closest measurement available without a
    // per-frame logger in the page: pressing LT swept `ABS_BRAKE` (10) 0..255 and pressing RT swept
    // `ABS_GAS` (9) 0..255, and axes are reported in ascending ABS order — the rule the two sticks
    // confirm, ABS_X/ABS_Y on a0/a1 and ABS_Z/ABS_RZ on a2/a3 — which puts the left trigger on a5 and
    // the right on a4, as SDL's 8BitDo rows also have them.
    // Two caveats, measured on this unit on Linux: a press on either `leftstick`/`rightstick` reaches
    // the kernel as `BTN_TL2`, the left trigger's digital button (twice, once per stick, 1.26 s
    // apart), so no browser there reports them as separate buttons and b13/b14 are inert; and the
    // extra C/Z buttons at b2/b5 have no standard slot, so they are left unbound.
    product: 0x3016,
    vendor: 0x2dc8,
    map: "a:b0,b:b1,x:b3,y:b4,back:b10,start:b11,leftshoulder:b6,rightshoulder:b7,leftstick:b13,rightstick:b14,lefttrigger:a5,righttrigger:a4,leftx:a0,lefty:a1,rightx:a2,righty:a3,",
  },
  {
    // 8BitDo Ultimate 2C Wireless, SDL_GameControllerDB:367 (`0300…1b30000001000000`), whose
    // triggers are axes 5 and 4 — the form a browser reports, where the `SDL_JOYSTICK_DINPUT`
    // entry (:72) has them as buttons 8 and 9 and nothing on the web would ever see those.
    product: 0x301b,
    vendor: 0x2dc8,
    map: "a:b0,b:b1,back:b10,dpdown:h0.4,dpleft:h0.8,dpright:h0.2,dpup:h0.1,guide:b12,leftshoulder:b6,leftstick:b13,lefttrigger:a5,leftx:a0,lefty:a1,paddle1:b2,paddle2:b5,rightshoulder:b7,rightstick:b14,righttrigger:a4,rightx:a2,righty:a3,start:b11,x:b3,y:b4,",
  },
  {
    // 8BitDo Ultimate Wireless Controller, SDL_GameControllerDB:369 (`0300…1330000000020000`).
    product: 0x3013,
    vendor: 0x2dc8,
    map: "a:b0,b:b1,back:b10,dpdown:h0.4,dpleft:h0.8,dpright:h0.2,dpup:h0.1,guide:b12,leftshoulder:b6,leftstick:b13,lefttrigger:a5,leftx:a0,lefty:a1,misc1:b26,paddle1:b23,paddle2:b19,rightshoulder:b7,rightstick:b14,righttrigger:a4,rightx:a2,righty:a3,start:b11,x:b3,y:b4,",
  },
  {
    // Steam Deck Controller, SDL_GameControllerDB:756 (`0300…0512000000016800`). Steam Input's virtual
    // pad is a different SDL entry (:757) with the face buttons on b3..b6, and its d-pad as buttons;
    // that one is not covered here.
    product: 0x1205,
    vendor: 0x28de,
    map: "a:b0,b:b1,back:b4,dpdown:h0.4,dpleft:h0.8,dpright:h0.2,dpup:h0.1,guide:b5,leftshoulder:b9,leftstick:b7,lefttrigger:a4,leftx:a0,lefty:a1,misc1:b11,paddle1:b12,paddle2:b13,paddle3:b14,paddle4:b15,rightshoulder:b10,rightstick:b8,righttrigger:a5,rightx:a2,righty:a3,start:b6,x:b2,y:b3,",
  },
];

/** SDL's names for the standard slots, so a copied row needs no renumbering to be read. */
const BUTTON_NAMES: Readonly<Record<string, number>> = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  leftshoulder: 4,
  rightshoulder: 5,
  back: 8,
  start: 9,
  leftstick: 10,
  rightstick: 11,
};

const AXIS_NAMES: Readonly<Record<string, number>> = {
  leftx: 0,
  lefty: 1,
  rightx: 2,
  righty: 3,
};

const TRIGGER_SLOTS: Readonly<Record<string, number>> = {
  lefttrigger: 6,
  righttrigger: 7,
};

/** Where one row sends a standard slot: an index into the pad's buttons or its axes. */
type PadSlot =
  | { readonly index: number; readonly kind: "button" }
  | { readonly index: number; readonly invert: boolean; readonly kind: "axis" };

interface IParsedRow {
  /** Standard axis index -> where the pad keeps it. */
  readonly axes: readonly (PadSlot | undefined)[];
  /** Standard button index -> where the pad keeps it. */
  readonly buttons: readonly (PadSlot | undefined)[];
}

function parseSlot(value: string): PadSlot | undefined {
  const invert = value.startsWith("-");
  const token = invert || value.startsWith("+") ? value.slice(1) : value;
  const index = Number.parseInt(token.slice(1), 10);
  if (!Number.isInteger(index) || index < 0) return undefined;
  if (token.startsWith("b")) return { index, kind: "button" };
  if (token.startsWith("a")) return { index, invert, kind: "axis" };
  return undefined;
}

function parseRow(row: IPadRow): IParsedRow {
  const axes: (PadSlot | undefined)[] = [];
  const buttons: (PadSlot | undefined)[] = [];
  for (const token of row.map.split(",")) {
    const colon = token.indexOf(":");
    if (colon < 1) continue;
    const slot = parseSlot(token.slice(colon + 1));
    if (slot === undefined) continue; // a hat, a paddle or the guide button: no standard slot
    const name = token.slice(0, colon);
    const axis = AXIS_NAMES[name];
    if (axis !== undefined) axes[axis] = slot;
    const button = BUTTON_NAMES[name] ?? TRIGGER_SLOTS[name];
    if (button !== undefined) buttons[button] = slot;
  }
  return { axes, buttons };
}

/** Parsed once per row: parsing the same string every tick is work the frame loop must not do. */
const PARSED_ROWS = new Map<IPadRow, IParsedRow>(PAD_ROWS.map((row) => [row, parseRow(row)]));

/**
 * Row per browser `id`. A pad keeps its id while it is connected, so this answer never changes for a
 * connected device — and `RegExp.exec` allocates a match array, which the frame loop must not do.
 */
const ROW_BY_ID = new Map<string, IPadRow | null>();

const CHROMIUM_VENDOR_PRODUCT = /vendor:\s*([0-9a-f]{1,4})\s+product:\s*([0-9a-f]{1,4})/i;
const FIREFOX_VENDOR_PRODUCT = /^([0-9a-f]{4})-([0-9a-f]{4})-/i;

/**
 * The vendor:product a browser `id` carries. Chromium writes `… Vendor: 045e Product: 028e` inside
 * the parentheses, Firefox writes `045e-028e-<name>`. Anything else answers `undefined`, which is
 * what makes such a pad unmapped rather than guessed at.
 */
export function padVendorProduct(
  id: string | undefined,
): { readonly product: number; readonly vendor: number } | undefined {
  if (id === undefined) return undefined;
  const match = CHROMIUM_VENDOR_PRODUCT.exec(id) ?? FIREFOX_VENDOR_PRODUCT.exec(id);
  if (match === null) return undefined;
  const vendor = Number.parseInt(match[1] as string, 16);
  const product = Number.parseInt(match[2] as string, 16);
  if (!Number.isInteger(vendor) || !Number.isInteger(product)) return undefined;
  return { product, vendor };
}

function readSlot(pad: IInputGamepad, slot: PadSlot): number {
  if (slot.kind === "button") return pad.buttons[slot.index]?.pressed === true ? 1 : 0;
  const value = pad.axes[slot.index];
  if (value === undefined || !Number.isFinite(value)) return 0;
  return slot.invert ? -value : value;
}

/**
 * Fills `out` with `pad` in the W3C standard layout and says which normalizer read it.
 *
 * A pad that reports `mapping: "standard"` — or no `mapping` field at all, which is what the owned
 * native host and a test fixture report — passes through. A pad reporting the empty string is
 * looked up by vendor:product; `unmapped` means the caller must ignore it, because reading raw
 * indices fires whatever action the device happened to number 0.
 */
export function toStandardPad(pad: IInputGamepad, out: IStandardPad): GamepadNormalizer {
  const mapping = pad.mapping;
  const parsed =
    mapping === undefined || mapping === "standard"
      ? undefined
      : PARSED_ROWS.get(rowFor(pad.id) as IPadRow);
  if (mapping === undefined || mapping === "standard") {
    copyPad(pad, out);
    return "standard";
  }
  if (parsed === undefined) {
    clearPad(out);
    return "unmapped";
  }
  for (let index = 0; index < STANDARD_AXIS_COUNT; index += 1) {
    const slot = parsed.axes[index];
    out.axes[index] = slot === undefined ? 0 : readSlot(pad, slot);
  }
  for (let index = 0; index < STANDARD_BUTTON_COUNT; index += 1) {
    const slot = parsed.buttons[index];
    // A trigger is an axis on these devices; the standard's button 6/7 is down past halfway.
    const value = slot === undefined ? 0 : readSlot(pad, slot);
    (out.buttons[index] as { pressed: boolean }).pressed = value > 0.5;
  }
  return "table";
}

function rowFor(id: string | undefined): IPadRow | undefined {
  if (id === undefined) return undefined;
  const cached = ROW_BY_ID.get(id);
  if (cached !== undefined) return cached ?? undefined;
  const key = padVendorProduct(id);
  let found: IPadRow | undefined;
  if (key !== undefined)
    for (const row of PAD_ROWS)
      if (row.vendor === key.vendor && row.product === key.product) found = row;
  ROW_BY_ID.set(id, found ?? null);
  return found;
}

function clearPad(out: IStandardPad): void {
  for (let index = 0; index < STANDARD_AXIS_COUNT; index += 1) out.axes[index] = 0;
  for (let index = 0; index < STANDARD_BUTTON_COUNT; index += 1)
    (out.buttons[index] as { pressed: boolean }).pressed = false;
}

function copyPad(pad: IInputGamepad, out: IStandardPad): void {
  const axes = pad.axes;
  for (let index = 0; index < STANDARD_AXIS_COUNT; index += 1) {
    const value = axes[index];
    out.axes[index] = value !== undefined && Number.isFinite(value) ? value : 0;
  }
  for (let index = 0; index < STANDARD_BUTTON_COUNT; index += 1)
    (out.buttons[index] as { pressed: boolean }).pressed = pad.buttons[index]?.pressed === true;
}
