interface ITraceSearchCase {
  readonly id: string;
  readonly situation: string;
  readonly scope?: "request";
  readonly expected?: { readonly symbol: string; readonly rank: number };
  readonly excluded?: readonly string[];
}

export const november25CapabilityTraces: readonly ITraceSearchCase[] = [
  {
    id: "street does not match trees",
    situation: "night city street racing with neon signs on wet reflective asphalt",
    excluded: ["bakeVegetation"],
  },
  {
    id: "leaves in a scene does not match leaveScene",
    situation: "lush tropical leaves in a canyon scene",
    scope: "request",
    excluded: ["leaveScene"],
  },
  {
    id: "closed spline does not match the app exit hook",
    situation: "closed spline",
    excluded: ["ctx.quit"],
  },
  {
    id: "verbatim Heightfield in a long query",
    situation:
      "procedural canyon terrain cliffs ledges stone and wet copper materials Heightfield runtime generator and terrain bake",
    expected: { symbol: "Heightfield", rank: 3 },
  },
  {
    id: "race countdown ranks Scheduler",
    situation: "countdown before race start, begin on GO",
    expected: { symbol: "Scheduler", rank: 3 },
  },
  {
    id: "countdown that unlocks controls ranks Scheduler",
    situation: "countdown before the race starts, its numbers ticking then controls unlock at GO",
    expected: { symbol: "Scheduler", rank: 3 },
  },
  {
    id: "night lighting ranks WorldEnvironment",
    situation:
      "night scene lighting, exposure and fog with emissive neon signage and wet reflective asphalt",
    expected: { symbol: "WorldEnvironment", rank: 5 },
  },
  {
    id: "racing request keeps unrelated exit hooks out",
    situation:
      "Build a small 3D racing game that looks like the reference picture: a night city street circuit with neon signs, wet reflective asphalt and a sports car seen from behind. One car on a closed track, a countdown, three laps, a lap timer, and a finish screen that says your best lap. Arrow keys or WASD steer and accelerate, and the car must bump the walls instead of passing through them. The HUD shows the lap, the lap time, the best lap and the speed.",
    scope: "request",
    excluded: ["bakeVegetation", "onLaunchFailure", "ctx.quit", "leaveScene"],
  },
];
