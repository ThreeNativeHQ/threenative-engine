import "./hud.css";

export function Inventory({ onClose }: { onClose: () => void }) {
  return (
    <section className="inventory fixed bottom-6 left-6 w-80 max-w-[calc(100vw-3rem)] rounded-2xl border border-zinc-700 bg-zinc-900/90 p-6 text-white shadow-xl">
      <h2 className="text-2xl font-bold">Inventory</h2>
      <p className="mt-1 text-sm text-zinc-400">12 items</p>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="rounded-lg bg-zinc-800 p-3">Medkit</div>
        <div className="rounded-lg bg-zinc-800 p-3">Battery</div>
      </div>
      <button
        type="button"
        className="mt-4 rounded-lg bg-brand px-4 py-2 transition-colors hover:bg-brand/80 focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50"
        onClick={onClose}
      >
        Close
      </button>
    </section>
  );
}
