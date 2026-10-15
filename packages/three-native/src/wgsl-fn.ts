/** FunctionNode's typed WGSL call surface; the engine links its source into the emitted stage. */
interface IWgslFunction {
  invoke(...args: unknown[]): unknown;
}
const scalar: Readonly<Record<string, string>> = {
  f32: "float",
  i32: "int",
  u32: "uint",
  bool: "bool",
};
function nodeType(source: string): string {
  const name = source.replace(/\s/gu, "");
  if (scalar[name]) return scalar[name];
  const vector = /^vec([234])(?:<f32>|f)$/u.exec(name);
  if (vector) return `vec${vector[1]}`;
  const matrix = /^mat([234])x\1(?:<f32>|f)$/u.exec(name);
  if (matrix) return `mat${matrix[1]}`;
  throw new TypeError(`TN_TSL_WGSL_TYPE: unsupported parameter type ${source}`);
}
export function defineWgslFn(make: (...args: string[]) => IWgslFunction) {
  return (source: string, includes: readonly unknown[] = []) => {
    if (includes.length)
      throw new TypeError("TN_TSL_WGSL_INCLUDES: function dependencies are not bound");
    const declaration = /^\s*fn\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*->\s*([^{}]+)\s*\{/u.exec(source);
    if (!declaration)
      throw new TypeError("TN_TSL_WGSL_DECLARATION: expected a typed WGSL function");
    const [, name = "", signature = "", result = ""] = declaration;
    const inputs = signature.trim()
      ? signature.split(",").map((input) => {
          const member = /^\s*([a-zA-Z_]\w*)\s*:\s*(.+?)\s*$/u.exec(input);
          if (!member)
            throw new TypeError("TN_TSL_WGSL_DECLARATION: expected named typed arguments");
          return { name: member[1] ?? "", type: nodeType(member[2] ?? "") };
        })
      : [];
    if (inputs.length > 4 || new Set(inputs.map(({ name }) => name)).size !== inputs.length)
      throw new TypeError("TN_TSL_WGSL_ARGUMENTS: expected up to four distinct arguments");
    const functionNode = make(source, name, nodeType(result), ...inputs.map(({ type }) => type));
    return (...values: unknown[]) => {
      let args = values;
      if (
        args.length === 1 &&
        typeof args[0] === "object" &&
        args[0] !== null &&
        inputs.every(({ name }) => Object.hasOwn(args[0] as object, name))
      ) {
        const named = args[0] as Record<string, unknown>;
        args = inputs.map(({ name }) => named[name]);
      }
      if (args.length !== inputs.length)
        throw new TypeError("TN_TSL_WGSL_ARGUMENTS: arguments must match the declaration");
      return functionNode.invoke(...args);
    };
  };
}
