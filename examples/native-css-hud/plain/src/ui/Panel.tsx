import "./plain.css";

export function Panel({ onClose }: { onClose: () => void }) {
  return (
    <section className="panel">
      <h2>Inventory</h2>
      <p>12 items</p>
      <button type="button" className="close" onClick={onClose}>
        Close
      </button>
    </section>
  );
}
