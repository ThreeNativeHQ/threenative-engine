// The controls card sits in the top-right corner, where the follow camera never puts Wren (she
// stands in the lower middle of the frame). `scenes/Play.ts` checks that against `HINT`.
export function Menu() {
  return (
    <ul className="pointer-events-none absolute right-6 top-6 w-72 space-y-0.5 rounded-2xl border-2 border-line bg-panel/40 px-4 py-3 text-xs font-bold tracking-wide text-text backdrop-blur-sm">
      <li>WASD run · click / J slash · shift shield</li>
      <li>hold Q lock on (again: next target; nothing near: recentre)</li>
      <li>space roll, or hop while locked</li>
      <li>E open, read, unlock</li>
    </ul>
  );
}
