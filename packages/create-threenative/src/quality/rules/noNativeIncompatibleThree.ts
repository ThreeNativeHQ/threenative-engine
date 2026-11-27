import type { Rule } from "eslint";
import type * as ESTree from "estree";

const NON_TSL_FOG = new Set(["Fog", "FogExp2"]);
const UNCATALOGUED_TSL = new Set(["rangeFogFactor"]);

function className(callee: ESTree.Expression | ESTree.Super): string | undefined {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return undefined;
}

function isNullLiteral(node: ESTree.Node | undefined | null): boolean {
  return node?.type === "Literal" && node.value === null;
}

function memberPropertyName(node: ESTree.Pattern | ESTree.Expression): string | undefined {
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return undefined;
}

function nonTslFogLabel(rhs: ESTree.Expression): string | undefined {
  if (rhs.type === "NewExpression") {
    const name = className(rhs.callee);
    return name !== undefined && NON_TSL_FOG.has(name) ? `new ${name}(...)` : undefined;
  }
  // `scene.fogNode = null` legitimately clears a previously installed fog node (e.g. volumetricFog).
  if (rhs.type === "Literal" && rhs.value !== null) return String(rhs.value);
  return undefined;
}

/** Errors on Three.js APIs and TSL shortcuts that break ThreeNative's native/WebGPU parity:
 * `CubeTexture`, `CubeReflectionMapping`, non-TSL `scene.fogNode`, `null` `DataTexture` / `.mapping`
 * (`TN_ABI_6`), and uncatalogued `three/tsl` exports (`rangeFogFactor`). */
export const noNativeIncompatibleThree: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      cubeTexture:
        "`CubeTexture` breaks native environment/background parity (`TN_NATIVE_ENVIRONMENT_UNSUPPORTED`). Use `render/sky.ts` or an equirectangular RGBA texture (`>= 64px`).",
      cubeReflectionMapping:
        "`CubeReflectionMapping` is unsupported natively (`TN_NATIVE_ENVIRONMENT_UNSUPPORTED`). Use `EquirectangularReflectionMapping` or `WorldEnvironment`.",
      fogNode:
        "`fogNode` requires a TSL node (`three/tsl`), not `{{what}}` (`TN_BROWSER_SHADER_NODE`). Use a TSL `fog(...)` node or omit `fogNode`.",
      nullTextureAbi:
        "Do not pass `null` to `DataTexture` `format`/`type` or assign `texture.mapping = null` (`TN_ABI_6`). Omit the argument or pass a Three.js constant.",
      uncataloguedTsl:
        "`{{name}}` from `three/tsl` is not exported on the native runtime (`TN_NATIVE_UNCATALOGUED_*`). Build fog via `three/tsl` `fog(...)` or catalogued helpers.",
    },
  },
  create(context) {
    const visitor: Rule.RuleListener = {};
    visitor.ImportDeclaration = (node) => {
      if (node.source.value !== "three/tsl") return;
      for (const spec of node.specifiers) {
        if (
          spec.type === "ImportSpecifier" &&
          spec.imported.type === "Identifier" &&
          UNCATALOGUED_TSL.has(spec.imported.name)
        ) {
          context.report({
            node: spec,
            messageId: "uncataloguedTsl",
            data: { name: spec.imported.name },
          });
        }
      }
    };
    visitor.NewExpression = (node) => {
      const name = className(node.callee);
      if (name === "CubeTexture") context.report({ node, messageId: "cubeTexture" });
      if (
        name === "DataTexture" &&
        (isNullLiteral(node.arguments[3]) || isNullLiteral(node.arguments[4]))
      ) {
        context.report({ node, messageId: "nullTextureAbi" });
      }
    };
    visitor.MemberExpression = (node) => {
      if (
        !node.computed &&
        node.property.type === "Identifier" &&
        node.property.name === "CubeReflectionMapping"
      ) {
        context.report({ node, messageId: "cubeReflectionMapping" });
      }
    };
    visitor.Identifier = (node) => {
      if (node.name !== "CubeReflectionMapping") return;
      const parent = (node as ESTree.Identifier & { parent?: ESTree.Node }).parent;
      if (
        parent?.type === "MemberExpression" ||
        parent?.type === "ImportSpecifier" ||
        (parent?.type === "Property" && parent.key === node && !parent.shorthand)
      ) {
        return;
      }
      context.report({ node, messageId: "cubeReflectionMapping" });
    };
    visitor.AssignmentExpression = (node) => {
      const prop = memberPropertyName(node.left);
      if (prop === "mapping" && isNullLiteral(node.right)) {
        context.report({ node, messageId: "nullTextureAbi" });
      } else if (prop === "fogNode") {
        const what = nonTslFogLabel(node.right);
        if (what !== undefined) context.report({ node, messageId: "fogNode", data: { what } });
      }
    };
    return visitor;
  },
};
