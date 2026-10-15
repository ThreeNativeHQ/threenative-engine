/** Three's struct layout and positional constructor over the shared native struct operations. */
interface IStructNode {
  newStruct(...values: unknown[]): IStructNode;
}
export function defineStruct(make: (...args: string[]) => IStructNode) {
  let serial = 0;
  return (layout: Readonly<Record<string, string>>, name?: string) => {
    if (layout === null || typeof layout !== "object" || Array.isArray(layout))
      throw new TypeError("TN_TSL_STRUCT_LAYOUT: expected named scalar or vector members");
    const members = Object.entries(layout);
    if (members.length === 0 || members.some(([, type]) => typeof type !== "string"))
      throw new TypeError("TN_TSL_STRUCT_LAYOUT: expected named scalar or vector members");
    const schema = make(name ?? `NativeStruct${++serial}`, ...members.flat());
    return (...values: unknown[]) => {
      if (values.length > 0 && values.length !== members.length)
        throw new TypeError("TN_TSL_STRUCT_VALUES: expected one value per member");
      return schema.newStruct(...values);
    };
  };
}
