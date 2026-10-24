export function Menu() {
  return (
    <div className="pointer-events-none absolute bottom-6 left-6 rounded-2xl border-2 border-line bg-panel/40 px-4 py-3 text-xs font-bold tracking-wide text-text backdrop-blur-sm">
      WASD run · J slash · shift shield · hold Q lock on (again: next target; nothing near:
      recentre) · space roll, or hop while locked · E open, read, unlock
    </div>
  );
}
