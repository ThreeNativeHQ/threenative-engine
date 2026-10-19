import type { IPlaytestSceneNodeObservation, IPlaytestSceneNodesObservation } from "../protocol.js";
import type { IPlaytestSceneNodesAssertion } from "../scenario/schema-base.js";
import type { IEvaluationContext } from "./context.js";

/**
 * Bounds on named nodes of the scene graph.
 *
 * `emitScene` bounds the room: is anything lit, does the fog clear the world. This bounds one
 * object, which is what an agent otherwise takes a screenshot to find out — where the crate is,
 * whether it is inside the camera's frustum, whether its texture ever loaded, whether the mesh
 * is visible once every ancestor's flag is counted. Each of those kills a frame while every
 * count above it stays healthy, and a screenshot can show the damage without naming the cause.
 *
 * Every branch fails closed. A run whose bridge reported no scene nodes has not reported a
 * visible crate; it has reported nothing.
 */
export function emitSceneNodes(ctx: IEvaluationContext): void {
  const assertions = ctx.scenarioAssertions.sceneNodes;
  if (assertions === undefined || assertions.length === 0) return;
  const observed = ctx.input.report.observations?.sceneNodes;
  if (observed === undefined) {
    ctx.assertions.push({ details: { expected: assertions.length, observed: undefined }, id: "sceneNodes.observed", pass: false });
    ctx.diagnostics.push({
      code: "TN_PLAYTEST_SCENE_NODES_UNOBSERVED",
      message:
        "A sceneNodes assertion was evaluated against a run whose bridge reported no scene-node observation.",
      observedRuntimePath: "observations.json/sceneNodes",
      severity: "error",
      suggestion:
        "Install the playtest bridge (core's playtest() plugin, or installThreePlaytestBridge for a plain Three.js project) so the run advertises 'scene.nodes', or narrow the scenario. Never delete the assertion to get green.",
    });
    return;
  }
  assertions.forEach((assertion, index) => {
    emitOne(ctx, assertion, index, observed[index]);
  });
}

function describeSelector(assertion: IPlaytestSceneNodesAssertion): string {
  const { limit: _limit, ...filters } = assertion.select;
  return Object.entries(filters)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

function emitOne(
  ctx: IEvaluationContext,
  assertion: IPlaytestSceneNodesAssertion,
  index: number,
  observation: IPlaytestSceneNodesObservation | undefined,
): void {
  const id = `sceneNodes[${index}]`;
  const selector = describeSelector(assertion);
  if (observation === undefined) {
    ctx.assertions.push({ details: { selector }, id: `${id}.observed`, pass: false });
    ctx.diagnostics.push({
      code: "TN_PLAYTEST_SCENE_NODES_UNOBSERVED",
      message: `The run reported no scene-node observation for selector ${selector}.`,
      observedRuntimePath: `observations.json/sceneNodes/${index}`,
      severity: "error",
      suggestion:
        "The runner requests one observation per assertion in order; a missing one means the bridge answered a different request. Re-run against a build that advertises 'scene.nodes'.",
    });
    return;
  }

  const minCount = assertion.minCount ?? (assertion.maxCount === 0 ? 0 : 1);
  const countPass = observation.matched >= minCount && (assertion.maxCount === undefined || observation.matched <= assertion.maxCount);
  ctx.assertions.push({
    details: { matched: observation.matched, maxCount: assertion.maxCount, minCount, selector },
    id: `${id}.count`,
    pass: countPass,
  });
  if (!countPass)
    ctx.diagnostics.push({
      code: "TN_PLAYTEST_SCENE_NODES_COUNT",
      message: `Selector ${selector} matched ${observation.matched} node(s); the scenario bounds it to ${minCount}..${assertion.maxCount ?? "∞"}.`,
      observedRuntimePath: `observations.json/sceneNodes/${index}/matched`,
      severity: "error",
      suggestion:
        observation.matched === 0
          ? "Check the node's name against the scene graph — the walk reports Object3D.name, which is empty unless the game sets it. Nothing was matched, so no other bound in this assertion was measured."
          : "Narrow the selector, or fix the scene so it carries the number of nodes the scenario expects.",
    });

  // Every remaining bound is measured against the nodes that were reported. A selector whose
  // matches exceeded the report limit is measured against a sample and says so, rather than
  // being read as a statement about the whole set.
  if (observation.nodes.length === 0) return;
  const sampled = observation.truncated;

  if (assertion.visible !== undefined)
    emitPerNode(ctx, id, index, "visible", observation, sampled, assertion.visible, (node) => node.visibleInTree, {
      code: "TN_PLAYTEST_SCENE_NODE_INVISIBLE",
      failure: (names) =>
        assertion.visible === true
          ? `${names} is not visible to the renderer once every ancestor's flag is counted.`
          : `${names} is visible to the renderer, and the scenario asserts it is not.`,
      suggestion:
        "Object3D.visible is checked up the whole parent chain — a visible mesh under a hidden group draws nothing. Check the ancestors, not just the node.",
    });

  if (assertion.inFrustum !== undefined)
    emitPerNode(ctx, id, index, "inFrustum", observation, sampled, assertion.inFrustum, (node) => node.inFrustum, {
      code: "TN_PLAYTEST_SCENE_NODE_OFF_SCREEN",
      failure: (names) =>
        assertion.inFrustum === true
          ? `${names} is outside the active camera's frustum, so nothing the scenario asserts about it reaches the screen.`
          : `${names} is inside the active camera's frustum, and the scenario asserts it is not.`,
      suggestion:
        "Compare the node's world bounds against the camera position, forward and clip planes in the same observation. A node with no bounds is not tested and reports no frustum membership at all.",
    });

  if (assertion.texturesLoaded === true)
    emitPerNode(
      ctx,
      id,
      index,
      "texturesLoaded",
      observation,
      sampled,
      true,
      (node) => (node.materials?.length ?? 0) > 0 && (node.materials ?? []).every((material) => material.mapsUnloaded.length === 0),
      {
        code: "TN_PLAYTEST_SCENE_NODE_TEXTURE_UNLOADED",
        failure: (names, nodes) => {
          const slots = nodes
            .flatMap((node) => (node.materials ?? []).flatMap((material) => material.mapsUnloaded))
            .join(", ");
          return `${names} has bound texture slot(s) carrying no image: ${slots}. Those slots sample black while every material and light count stays healthy.`;
        },
        suggestion:
          "The texture was bound before it loaded, or its load failed. Check the network observations for the image request and await the loader before assigning the map.",
      },
    );

  if (assertion.animated !== undefined)
    emitPerNode(ctx, id, index, "animated", observation, sampled, assertion.animated, (node) => (node.animation?.clips.length ?? 0) > 0, {
      code: "TN_PLAYTEST_SCENE_NODE_NOT_ANIMATED",
      failure: (names) =>
        assertion.animated === true
          ? `${names} carries no animation clips, so nothing it is asked to play exists on it.`
          : `${names} carries animation clips, and the scenario asserts it carries none.`,
      suggestion:
        "This reports the clips mounted on the object, not the actions running on the game's mixer. A game that drives its own mixer publishes what is playing through gameplay.animation and bounds it with assert.animation.",
    });

  if (assertion.minTriangles !== undefined) {
    const triangles = observation.nodes.reduce((total, node) => total + (node.geometry?.triangles ?? 0), 0);
    const pass = triangles >= assertion.minTriangles;
    ctx.assertions.push({
      details: { expected: assertion.minTriangles, observed: triangles, sampled, selector },
      id: `${id}.minTriangles`,
      pass,
    });
    if (!pass)
      ctx.diagnostics.push({
        code: "TN_PLAYTEST_SCENE_NODE_GEOMETRY",
        message: `Selector ${selector} reported ${triangles} triangle(s) across ${observation.nodes.length} node(s), below the asserted floor of ${assertion.minTriangles}.`,
        observedRuntimePath: `observations.json/sceneNodes/${index}/nodes`,
        severity: "error",
        suggestion:
          sampled
            ? "The reported nodes are a sample cut by the selector's limit, so the sum is a floor. Raise the limit before reading this as the scene's total."
            : "The mesh loaded with less geometry than expected, or a placeholder is standing in for an asset that never arrived.",
      });
  }
}

interface IPerNodeMessages {
  code: string;
  failure: (names: string, nodes: IPlaytestSceneNodeObservation[]) => string;
  suggestion: string;
}

/**
 * Every matched node must agree with the bound. `undefined` from the reader is unobserved, and
 * unobserved fails — a node whose frustum membership was never tested has not been shown to be
 * on screen.
 */
function emitPerNode(
  ctx: IEvaluationContext,
  id: string,
  index: number,
  bound: string,
  observation: IPlaytestSceneNodesObservation,
  sampled: boolean,
  expected: boolean,
  read: (node: IPlaytestSceneNodeObservation) => boolean | undefined,
  messages: IPerNodeMessages,
): void {
  const failing = observation.nodes.filter((node) => read(node) !== expected);
  const pass = failing.length === 0;
  ctx.assertions.push({
    details: {
      expected,
      failing: failing.map((node) => node.path).slice(0, 10),
      observed: observation.nodes.length - failing.length,
      of: observation.nodes.length,
      sampled,
    },
    id: `${id}.${bound}`,
    pass,
  });
  if (pass) return;
  const names = failing.length === 1 ? `'${failing[0]!.path}'` : `${failing.length} node(s), including '${failing[0]!.path}',`;
  ctx.diagnostics.push({
    code: messages.code,
    message: messages.failure(names, failing),
    observedRuntimePath: `observations.json/sceneNodes/${index}/nodes`,
    severity: "error",
    suggestion: messages.suggestion,
  });
}
