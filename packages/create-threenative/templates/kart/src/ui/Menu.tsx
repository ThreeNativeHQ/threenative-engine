export function Menu() {
  return (
    <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded-2xl border-2 border-line bg-panel/40 px-4 py-3 text-xs font-bold tracking-wide text-text backdrop-blur-sm animate-hint-fade">
      W / ↑ accelerate · S / ↓ brake · A D steer · space hop, hold through a turn to drift, wiggle
      against it for sparks, let go for a boost · E use item
    </div>
  );
}
