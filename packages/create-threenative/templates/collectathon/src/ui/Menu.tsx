export function Menu() {
  return (
    <div className="pointer-events-none absolute bottom-6 left-6 rounded-2xl border-2 border-line bg-panel/40 px-4 py-3 text-xs font-bold tracking-wide text-text backdrop-blur-sm">
      WASD run · space jump (land and jump again: double, triple) · shift crouch, then space: back
      flip or long jump · in the air, shift pounds · X dives
    </div>
  );
}
