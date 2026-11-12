/**
 * The version a template ships for one workspace package.
 *
 * A generated game resolves its engine at install time, so a kit pinned to whatever release was
 * current when `create-threenative` was last published handed every new project an engine older
 * than the registry's newest, sometimes by weeks. A template therefore names a floor and no
 * ceiling: `>=0.3.13` installs the newest published engine, forever, without a template repack.
 *
 * The floor is the release the kit's source was last tested against, and it only ever moves in
 * `pnpm release:prepare`. Nothing user-facing depends on it staying current, so a release that
 * forgets to move it costs nothing — which is the point.
 *
 * A game already scaffolded is frozen by its own `pnpm-lock.yaml`, so this floats new projects and
 * never silently upgrades an existing one.
 *
 * `create-threenative` itself stays exact. It is the tool that writes a game's authoring layer, so
 * a floating tool would be choosing its own input.
 */

type ITriple = readonly [number, number, number];

const TRIPLE = /^(\d+)\.(\d+)\.(\d+)/u;
const RANGE = /^>=\s*(\d+\.\d+\.\d+)$/u;

function triple(value: string, what: string): ITriple {
  const match = TRIPLE.exec(value.trim());
  if (match === null)
    throw new Error(`TN_VERSION_RANGE: ${what} '${value}' is not a released version.`);
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (!parts.every(Number.isSafeInteger))
    throw new Error(`TN_VERSION_RANGE: ${what} '${value}' is not a released version.`);
  return parts;
}

function compare(left: ITriple, right: ITriple): number {
  const difference = left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  return Math.sign(difference);
}

/** The specifier a template declares for one workspace package. */
export function templateSpecifier(name: string, version: string): string {
  return name.startsWith("@threenative/") ? rangeForVersion(version) : version;
}

/** `0.3.13` -> `>=0.3.13`: the newest published engine, whatever major it becomes. */
export function rangeForVersion(version: string): string {
  triple(version, "version");
  return `>=${version.trim()}`;
}

/** The published floor of a `>=A` specifier, or `undefined` for anything that is not one. */
export function rangeFloor(specifier: string): string | undefined {
  return RANGE.exec(specifier.trim())?.[1];
}

/** Whether a version satisfies an exact pin or a `>=A` floor. */
export function satisfiesSpecifier(version: string, specifier: string): boolean {
  const floor = rangeFloor(specifier);
  if (floor === undefined) return version.trim() === specifier.trim();
  return compare(triple(version, "version"), triple(floor, "range floor")) >= 0;
}
