export type PlaytestCapability =
  | "browser.canvas"
  | "browser.console"
  | "browser.dom"
  | "browser.input"
  | "browser.network"
  | "browser.screenshot"
  | "browser.trace"
  | "camera.observe"
  | "device.metrics"
  | "entity.bounds"
  | "entity.observe"
  | "entity.setup"
  | "runtime.animation"
  | "runtime.audio"
  | "runtime.components"
  | "runtime.contacts"
  | "runtime.diagnostics"
  | "runtime.events"
  | "runtime.fixedStep"
  | "runtime.geometry"
  | "runtime.physics"
  | "runtime.network"
  | "runtime.performance"
  | "runtime.pipelineCensus"
  | "runtime.renderChain"
  | "runtime.renderOnly"
  | "runtime.resources"
  | "runtime.startup"
  | "runtime.state"
  | "runtime.tags"
  | "runtime.transitions"
  | "runtime.ui"
  | "runtime.world"
  | "scene.nodes"
  | "scene.observe";

export interface IPlaytestCapabilityDescriptor {
  description: string;
  name: PlaytestCapability;
  protocolVersion: 1;
}

export const PLAYTEST_CAPABILITY_REGISTRY: readonly IPlaytestCapabilityDescriptor[] = [
  capability("browser.canvas", "Samples canvas pixels and health."),
  capability("browser.console", "Captures browser console and page errors."),
  capability("browser.dom", "Reads bounded DOM observations."),
  capability("browser.input", "Delivers keyboard and pointer input."),
  capability("browser.network", "Captures failed browser requests."),
  capability("browser.screenshot", "Captures viewport screenshots."),
  capability("browser.trace", "Captures a bounded Playwright trace."),
  capability("camera.observe", "Samples the active camera transform and projection."),
  capability("device.metrics", "Measures device thermal, power and battery state around a run."),
  capability("entity.bounds", "Projects registered entity bounds into the viewport."),
  capability("entity.observe", "Samples registered entity transforms and visibility."),
  capability("entity.setup", "Applies bounded transforms to registered entities."),
  capability("runtime.animation", "Samples application-owned animation state."),
  capability("runtime.audio", "Samples application-owned audio runtime state."),
  capability("runtime.components", "Samples registered JSON-safe component state."),
  capability("runtime.contacts", "Samples bounded collision and trigger contacts."),
  capability("runtime.diagnostics", "Captures application runtime errors."),
  capability("runtime.events", "Drains bounded application event observations."),
  capability("runtime.fixedStep", "Advances an application-owned deterministic tick."),
  capability("runtime.geometry", "Answers one armed per-object geometry capture for the frame it was requested on."),
  capability("runtime.physics", "Samples bounded application-owned physics observations."),
  capability("runtime.network", "Captures native fetch requests and failures through the host mailbox."),
  capability("runtime.performance", "Samples bounded per-render frame cost and renderer counts."),
  capability("runtime.pipelineCensus", "Samples bounded shader and pipeline creation observations."),
  capability("runtime.renderChain", "Reports the render stages, quality tier, and velocity route actually applied."),
  capability("runtime.renderOnly", "Draws the current world once without advancing the simulation, for a capture while the loop is driven."),
  capability("runtime.resources", "Reads and writes registered JSON-safe application state."),
  capability("runtime.startup", "Reports whether first-use startup work has finished and the world is safe to observe."),
  capability("runtime.state", "Samples application-owned state-machine state."),
  capability("runtime.transitions", "Samples tick-stamped changes to published entity states and game-state fields."),
  capability("runtime.tags", "Samples bounded application-owned entity tags."),
  capability("runtime.ui", "Samples registered JSON-safe UI and HUD state."),
  capability("runtime.world", "Samples bounded runtime world metadata."),
  capability("scene.nodes", "Reports scene-graph nodes selected by name, path or type, with world transform, bounds, frustum membership, geometry, materials and texture load state."),
  capability("scene.observe", "Counts the lights, materials, fog, background and camera framing mounted in the scene."),
];

const KNOWN_CAPABILITIES = new Set<string>(PLAYTEST_CAPABILITY_REGISTRY.map(({ name }) => name));

export function unknownPlaytestCapabilities(capabilities: readonly string[]): string[] {
  return capabilities.filter((name) => !KNOWN_CAPABILITIES.has(name));
}

export function missingPlaytestCapabilities(required: readonly string[], available: readonly string[]): string[] {
  const availableSet = new Set(available);
  return [...new Set(required)].filter((name) => !availableSet.has(name)).sort();
}

function capability(name: PlaytestCapability, description: string): IPlaytestCapabilityDescriptor {
  return { description, name, protocolVersion: 1 };
}
