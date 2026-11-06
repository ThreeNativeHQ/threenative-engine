export interface INotOwnedCapability {
  readonly id: string;
  readonly situations: readonly string[];
  readonly guidance: string;
}

/**
 * Measured requests for which the framework deliberately owns no complete system. These rows are
 * guidance, not capabilities: an authoring agent should write the mechanic in the game or add its
 * own dependency instead of selecting an unrelated engine export.
 */
export const NOT_OWNED_CAPABILITIES: readonly INotOwnedCapability[] = [
  {
    guidance:
      "The framework owns no save/load system. Write a save module in your project's src/ using your own plain state shape (for example, ctx.state), and read node_modules/create-threenative/agent-docs/references/gameplay-recipes.md for the template recipe.",
    id: "save-load",
    situations: [
      "persist a player's progress between sessions",
      "save player progress between sessions",
      "load a saved game state",
    ],
  },
  {
    guidance:
      "The framework owns no inventory system. Write inventory state in your project's src/ with plain objects under ctx.state, and read node_modules/create-threenative/agent-docs/references/gameplay-recipes.md for the template recipe.",
    id: "inventory",
    situations: ["inventory system", "manage inventory contents"],
  },
  {
    guidance:
      "The framework owns no dialogue system. Write the conversation data and state in your project's src/; render it with the template UI (starter uses src/ui/), and read node_modules/create-threenative/agent-docs/references/gameplay-recipes.md.",
    id: "dialogue",
    situations: ["NPC dialogue system", "write conversation choices for an NPC"],
  },
  {
    guidance:
      "The framework owns the optional authenticated transport seam at @threenative/core/net. Import connect with an HTTPS endpoint and a game-issued credential; it validates channels, message sizes, and bounded queues, but reliable overflow returns false and native qualification depends on the installed bridge (iOS remains unverified). Write authoritative replication, snapshots, prediction, interpolation, and rejoin policy in your project's src/ and server code.",
    id: "networked-multiplayer",
    situations: ["authoritative replication", "client prediction"],
  },
  {
    guidance:
      "The framework owns no vegetation system. Copy the MIT source in examples/integrations/vegetation/src/ (https://github.com/ThreeNativeHQ/threenative/tree/develop/examples/integrations/vegetation) into your src/ and follow its README: generate seeded, vertex-budgeted EZ Tree variants offline (tree.ts, from the pinned ez-tree source, not the npm 1.1.0 bundle), write them with treeToGlb into assets/, cook them with assets.models.passes.prune: false (prune strips the uv and _WIND weight your materials read), load with ctx.assets.model and re-material by glTF material name. render/wind.ts is editable TSL wind in world metres; call expandBounds(geometry, minWorldScale) per variant geometry. assets.lod bakes bark levels and keeps alpha-masked leaves at LOD0. Worked sample: the grove game in github.com/ThreeNativeHQ/examples.",
    id: "procedural-vegetation",
    situations: [
      "procedural trees",
      "swaying trees",
      "tree foliage wind sway",
      "grow procedural tree meshes",
    ],
  },
  {
    guidance:
      "The framework owns no IK system. Copy the MIT source in examples/integrations/ik/src/ (https://github.com/ThreeNativeHQ/threenative/tree/develop/examples/integrations/ik) into your src/ and follow its README: it needs the closed-chain-ik/core dependency its own package.json pins, three keeps the only rendered pose, and new ConstrainedIK({root, joints: [{bone, axes, min, max}], effectors: [{bone, orientation?}], iterations, positionTolerance, rotationTolerance}) admits direct Bone hierarchies under rigid or positive-uniform-scale parents (shear, reflection, non-uniform or singular scale throws before the pose is touched). Call ik.update(targets) once per frame after AnimationPlayer/mixer and before render, with one world-space metre position per effector in order plus an optional quaternion only where the effector declared orientation: true; it never starts a loop, never moves the root and installs no bone translation or root-motion controller. Joint limits are X/Y/Z offsets relative to the animation pose supplied that call, so reapply the animation pose before solving to avoid accumulation, and the solver only rotates: bone lengths hold to under 1e-15 m. Iterations are 1-128; an unreachable goal returns converged false with finite residuals and never throws, a solver failure restores the original pose, and dispose() at scene teardown. Worked demo: the rifle grip game in examples/constrained-ik/, which plays on web, desktop native and Android.",
    id: "constrained-ik",
    situations: [
      "two-handed grip on a prop",
      "grip shared by two hands",
      "rifle grip follows sway",
      "inverse kinematics for a hand on a target",
      "hand IK pose correction",
      "elbow limits during an aiming pose",
    ],
  },
];
