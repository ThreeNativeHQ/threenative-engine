declare function js_tnp_layout(field: number): number;
declare function js_tnp_alloc(bytes: number): number;
declare function js_tnp_free(pointer: number): void;
declare function js_tnp_memory(kind: number, pointer: number, value: number): number;
declare function js_tnp_call(
  op: number,
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
  g: number,
): number;
declare function js_tnp_bind(invoke: unknown, release: unknown): number;
declare function js_tnp_read_string(pointer: number, bytes: number): string;
declare function js_tnp_string_bytes(text: string): number;
declare function js_tnp_write_string(text: string, pointer: number, capacity: number): number;

export function layout(field: number): number {
  return js_tnp_layout(field);
}
export function alloc(bytes: number): number {
  return js_tnp_alloc(bytes);
}
export function free(pointer: number): void {
  js_tnp_free(pointer);
}
export function memory(kind: number, pointer: number, value = 0): number {
  return js_tnp_memory(kind, pointer, value);
}
export function call(op: number, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0): number {
  return js_tnp_call(op, a, b, c, d, e, f, g);
}
export function bind(invoke: unknown, release: unknown): number {
  return js_tnp_bind(invoke, release);
}
export function readString(pointer: number, bytes = -1): string {
  return js_tnp_read_string(pointer, bytes);
}
export function stringBytes(text: string): number {
  return js_tnp_string_bytes(text);
}
export function writeString(text: string, pointer: number, capacity: number): number {
  return js_tnp_write_string(text, pointer, capacity);
}

declare function js_tnp_render(
  scene: number,
  camera: number,
  width: number,
  height: number,
  tone: number,
  exposure: number,
  srgb: number,
  clear: number,
): number;
export function render(
  scene: number,
  camera: number,
  width: number,
  height: number,
  tone: number,
  exposure: number,
  srgb: number,
  clear: number,
): number {
  return js_tnp_render(scene, camera, width, height, tone, exposure, srgb, clear);
}

declare function js_tnp_player_bind(update: unknown, frame: unknown, observe: unknown): number;
declare function js_tnp_player_open(): number;
declare function js_tnp_player_step(): number;
declare function js_tnp_player_close(): void;
declare function js_tnp_player_running(): number;
declare function js_tnp_player_runner(): number;
declare function js_tnp_player_codes(): number;
declare function js_tnp_player_capture(on: number): number;
export function playerBind(update: unknown, frame: unknown, observe: unknown): number {
  return js_tnp_player_bind(update, frame, observe);
}
export function playerOpen(): number {
  return js_tnp_player_open();
}
export function playerStep(): number {
  return js_tnp_player_step();
}
export function playerClose(): void {
  js_tnp_player_close();
}
export function playerRunning(): number {
  return js_tnp_player_running();
}
export function playerRunner(): number {
  return js_tnp_player_runner();
}
export function playerCodes(): string {
  return readString(js_tnp_player_codes());
}
export function playerCapture(on: boolean): number {
  return js_tnp_player_capture(on ? 1 : 0);
}
