/**
 * A material's field names and values, found with `for...in`. three keeps them as own fields. The engine's
 * web materials keep them as enumerable accessors on the prototype, which `Object.keys` and
 * `Object.values` do not list, so every walk over a material's fields goes through here.
 */
export function materialFieldNames(material: object): string[] {
  const names: string[] = [];
  for (const name in material) names.push(name);
  return names;
}

export function materialFieldValues(material: object): unknown[] {
  const values: unknown[] = [];
  for (const name in material) values.push((material as Record<string, unknown>)[name]);
  return values;
}
