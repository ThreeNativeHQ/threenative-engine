// The bounded browser-side driver for a full-world export.
//
// It carries no materials of its own: the terrain surface, the props and the water all come from the
// live editor view, because an export that supplied its own textures would prove the container and
// not the world.
export async function exportFixtureWorld() {
  const started = performance.now();
  const output = await window.strata.view.exportCurrentWorld();
  window.exportedWorld = output;
  return {
    report: output.report,
    bytes: output.bytes.byteLength,
    exportMs: performance.now() - started,
  };
}
