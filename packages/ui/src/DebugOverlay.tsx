import type {
  GeometryCaptureSort,
  IGeometryCaptureReport,
  IGeometryCaptureRow,
} from "@threenative/core";
import { useCallback, useEffect, useMemo, useState } from "react";

export type DebugSnapshot = Record<string, Record<string, unknown>>;

type GeometryRequest = { limit?: number; sort?: GeometryCaptureSort };

type DevWindow = Window &
  Partial<
    Record<
      "__THREENATIVE__",
      {
        snapshot?: () => DebugSnapshot;
        geometry?: (request?: GeometryRequest) => Promise<IGeometryCaptureReport>;
      }
    >
  >;

const isDev =
  (import.meta as ImportMeta & { env?: Record<"DEV", boolean | undefined> }).env?.DEV === true;

/** Rows the capture asks for. Enough to find the offender without shipping the scene. */
const ROW_LIMIT = 50;

/** The projected diameter under which the filter calls an object small. Editable in the panel. */
const DEFAULT_SMALL_PIXELS = 32;

const SORTS: readonly GeometryCaptureSort[] = ["triangles", "draws", "projected"];

function devTools(): NonNullable<DevWindow["__THREENATIVE__"]> | undefined {
  return (globalThis.window as DevWindow | undefined)?.__THREENATIVE__;
}

function readSnapshot(): DebugSnapshot {
  const snapshot = devTools()?.snapshot;
  return typeof snapshot === "function" ? snapshot() : {};
}

function displayValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

/** An unknown number is an em dash. A zero is a measurement and reads as one. */
function count(value: number | undefined): string {
  return value === undefined ? "—" : Math.round(value).toLocaleString("en-US");
}

function sortKey(row: IGeometryCaptureRow, sort: GeometryCaptureSort): number | undefined {
  if (sort === "draws") return row.draws;
  if (sort === "projected") return row.projectedPixels;
  return row.submittedTriangles;
}

/** Descending, with unknowns last: an unknown cost is not a small cost. */
function rank(
  rows: readonly IGeometryCaptureRow[],
  sort: GeometryCaptureSort,
): IGeometryCaptureRow[] {
  return [...rows].sort((left, right) => {
    const a = sortKey(left, sort);
    const b = sortKey(right, sort);
    if (a === undefined && b === undefined) return left.path.localeCompare(right.path);
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    return b - a;
  });
}

/**
 * The dev-only gate, and the reason the view below is a separate component.
 *
 * `isDev` folds to `false` in a production build, so this returns null before any hook runs and
 * `DebugOverlayView` becomes unreachable — the bundler then drops the whole view, and with it every
 * reference to the devtools global. A guard placed after the hooks keeps those references alive
 * instead, which `scripts/check-core-boundary.ts` rejects: the overlay must not ship in a game.
 */
export function DebugOverlay() {
  if (!isDev) return null;
  return <DebugOverlayView />;
}

function DebugOverlayView() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"entities" | "geometry">("entities");
  const [snapshot, setSnapshot] = useState<DebugSnapshot>({});
  const [report, setReport] = useState<IGeometryCaptureReport | undefined>(undefined);
  const [capturing, setCapturing] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [group, setGroup] = useState<"objects" | "assets">("objects");
  const [sort, setSort] = useState<GeometryCaptureSort>("triangles");
  const [smallOnly, setSmallOnly] = useState(false);
  const [smallPixels, setSmallPixels] = useState(DEFAULT_SMALL_PIXELS);
  const [expanded, setExpanded] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const hostWindow = window;
    const toggle = (event: KeyboardEvent) => {
      if (event.key === "`") setOpen((visible) => !visible);
    };
    // A capture is a snapshot of one frame; a moved camera or a resized drawing buffer makes its
    // outline a lie, so the selection goes rather than pointing somewhere plausible and wrong.
    const clearOutline = () => setSelected(undefined);
    hostWindow.addEventListener("keydown", toggle);
    hostWindow.addEventListener("resize", clearOutline);
    return () => {
      hostWindow.removeEventListener("keydown", toggle);
      hostWindow.removeEventListener("resize", clearOutline);
    };
  }, []);

  // A snapshot calls every entity's `debug()`, which a game may make as costly as it likes, so the
  // panel reads it only while it is open: polling a closed panel cost the shooter most of its frame.
  useEffect(() => {
    if (!open || typeof window === "undefined") return undefined;
    const hostWindow = window;
    setSnapshot(readSnapshot());
    const timer = hostWindow.setInterval(() => setSnapshot(readSnapshot()), 100);
    return () => hostWindow.clearInterval(timer);
  }, [open]);

  const capture = useCallback(() => {
    const geometry = devTools()?.geometry;
    if (typeof geometry !== "function" || capturing) return;
    setCapturing(true);
    setSelected(undefined);
    setCopied(undefined);
    setFailure(undefined);
    geometry({ limit: ROW_LIMIT, sort })
      .then((next) => setReport(next))
      .catch((error: unknown) => {
        setReport(undefined);
        setFailure(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setCapturing(false));
  }, [capturing, sort]);

  const rows = useMemo(() => rank(report?.objects ?? [], sort), [report, sort]);
  const visibleRows = useMemo(
    () =>
      smallOnly
        ? rows.filter(
            (row) => row.projectedPixels !== undefined && row.projectedPixels < smallPixels,
          )
        : rows,
    [rows, smallOnly, smallPixels],
  );
  const selectedRow = rows.find((row) => row.id === selected);

  if (!open) return null;
  const entityRows = Object.entries(snapshot).flatMap(([entity, fields]) =>
    Object.entries(fields).map(([key, value]) => ({ entity, key, value })),
  );
  const captureAvailable = typeof devTools()?.geometry === "function";

  return (
    <aside
      aria-label="ThreeNative entity debug overlay"
      data-threenative-debug-overlay="true"
      data-tn-debug-tab={tab}
    >
      <div className="tn-debug-tabs" role="tablist" aria-label="Debug views">
        <button
          aria-controls="tn-debug-entities"
          aria-selected={tab === "entities"}
          className="tn-debug-tab"
          id="tn-debug-entities-tab"
          onClick={() => setTab("entities")}
          role="tab"
          type="button"
        >
          Entities
        </button>
        <button
          aria-controls="tn-debug-geometry"
          aria-selected={tab === "geometry"}
          className="tn-debug-tab"
          id="tn-debug-geometry-tab"
          onClick={() => setTab("geometry")}
          role="tab"
          type="button"
        >
          Geometry
        </button>
      </div>

      {tab === "entities" ? (
        <div aria-labelledby="tn-debug-entities-tab" id="tn-debug-entities" role="tabpanel">
          <table>
            <thead>
              <tr>
                <th>entity</th>
                <th>key</th>
                <th>value</th>
              </tr>
            </thead>
            <tbody>
              {entityRows.map(({ entity, key, value }) => (
                <tr key={`${entity}.${key}`}>
                  <td>{entity}</td>
                  <td>{key}</td>
                  <td>{displayValue(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div aria-labelledby="tn-debug-geometry-tab" id="tn-debug-geometry" role="tabpanel">
          <div className="tn-debug-controls">
            <button
              className="tn-debug-action"
              disabled={capturing || !captureAvailable}
              onClick={capture}
              type="button"
            >
              {capturing ? "Capturing…" : report === undefined ? "Capture" : "Refresh"}
            </button>
            {report === undefined ? null : (
              <button
                className="tn-debug-action"
                onClick={() => {
                  const json = JSON.stringify(report, null, 2);
                  const clipboard = (globalThis.navigator as Navigator | undefined)?.clipboard;
                  if (clipboard === undefined) {
                    setCopied(json);
                    return;
                  }
                  clipboard.writeText(json).catch(() => setCopied(json));
                }}
                type="button"
              >
                Copy JSON
              </button>
            )}
          </div>

          {captureAvailable ? null : (
            <p className="tn-debug-note">
              The running game exposes no geometry capture. Mount a development build to use this
              view.
            </p>
          )}
          {failure === undefined ? null : <p className="tn-debug-note">{failure}</p>}

          {report === undefined || report.status === "unavailable" ? (
            report?.reason === undefined ? null : (
              <p className="tn-debug-note">{report.reason}</p>
            )
          ) : (
            <>
              <p className="tn-debug-note">
                tick {count(report.tick)} · {report.backend ?? "backend unknown"} ·{" "}
                {count(report.viewport?.width)}×{count(report.viewport?.height)} ·{" "}
                {report.camera?.type ?? "camera unknown"} · {(report.durationMs ?? 0).toFixed(1)} ms
                · {count(report.returned)} of {count(report.matched)} rows
              </p>
              {report.partialRanking === true ? (
                <p className="tn-debug-warn">Ranking is partial — not a global claim.</p>
              ) : null}
              {report.rowsTruncated === true ? (
                <p className="tn-debug-warn">Rows were cut by the limit ({count(report.limit)}).</p>
              ) : null}
              {report.inspectionComplete === false ? (
                <p className="tn-debug-warn">
                  Inspection stopped at the walk cap ({count(report.inspectedNodes)} nodes).
                </p>
              ) : null}
              {sort === report.sort ? null : (
                <p className="tn-debug-note">
                  These rows were ranked by {report.sort}; this table is re-sorted locally.
                </p>
              )}

              <table className="tn-debug-passes">
                <thead>
                  <tr>
                    <th>pass</th>
                    <th>draws</th>
                    <th>triangles</th>
                    <th>rows</th>
                    <th>unattributed (measured − rows)</th>
                  </tr>
                </thead>
                <tbody>
                  {(report.passes ?? []).map((pass) => (
                    <tr key={pass.kind}>
                      <td>{pass.kind}</td>
                      <td>{count(pass.draws)}</td>
                      <td>{count(pass.triangles)}</td>
                      <td>{count(pass.attributedTriangles)}</td>
                      <td>{count(pass.unattributedTriangles)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <fieldset className="tn-debug-controls">
                <legend>Group</legend>
                <label>
                  <input
                    checked={group === "objects"}
                    name="tn-debug-group"
                    onChange={() => setGroup("objects")}
                    type="radio"
                  />
                  Objects
                </label>
                <label>
                  <input
                    checked={group === "assets"}
                    name="tn-debug-group"
                    onChange={() => setGroup("assets")}
                    type="radio"
                  />
                  Assets
                </label>
              </fieldset>

              <div className="tn-debug-controls">
                <label>
                  Sort
                  <select
                    onChange={(event) => setSort(event.target.value as GeometryCaptureSort)}
                    value={sort}
                  >
                    {SORTS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <input
                    checked={smallOnly}
                    onChange={(event) => setSmallOnly(event.target.checked)}
                    type="checkbox"
                  />
                  Small on screen (&lt; {count(smallPixels)} px)
                </label>
                <label>
                  Threshold
                  <input
                    min={1}
                    onChange={(event) =>
                      setSmallPixels(Math.max(1, Number(event.target.value) || 1))
                    }
                    type="number"
                    value={smallPixels}
                  />
                </label>
              </div>
              <p className="tn-debug-note">
                A diagnostic filter, not a recommendation: whether an object matters is an authoring
                decision, and an object with no measured bounds is excluded rather than called
                small.
              </p>

              {group === "assets" ? (
                <table className="tn-debug-assets">
                  <thead>
                    <tr>
                      <th>asset</th>
                      <th>objects</th>
                      <th>triangles</th>
                      <th>unique</th>
                      <th>draws</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.assets ?? []).map((asset) => (
                      <tr key={asset.asset}>
                        <td>{asset.asset}</td>
                        <td>{count(asset.objects)}</td>
                        <td>{count(asset.submittedTriangles)}</td>
                        <td>{count(asset.uniqueTriangles)}</td>
                        <td>{count(asset.draws)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="tn-debug-objects">
                  <thead>
                    <tr>
                      <th>object</th>
                      <th>triangles</th>
                      <th>draws</th>
                      <th>projected px</th>
                      <th>copies</th>
                      <th>asset</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.flatMap((row) => {
                      const isExpanded = expanded.includes(row.id);
                      const head = (
                        <tr key={row.id} title={(row.unavailable ?? []).join(" ")}>
                          <td>
                            <button
                              aria-expanded={isExpanded}
                              className="tn-debug-expand"
                              onClick={() =>
                                setExpanded((current) =>
                                  current.includes(row.id)
                                    ? current.filter((id) => id !== row.id)
                                    : [...current, row.id],
                                )
                              }
                              type="button"
                            >
                              {isExpanded ? "−" : "+"}
                            </button>
                            <button
                              aria-pressed={selected === row.id}
                              className="tn-debug-select"
                              onClick={() =>
                                setSelected((current) => (current === row.id ? undefined : row.id))
                              }
                              type="button"
                            >
                              {row.name}
                            </button>
                            {(row.unavailable ?? []).length === 0 ? null : (
                              <small className="tn-debug-unavailable">
                                {(row.unavailable ?? []).join(" ")}
                              </small>
                            )}
                          </td>
                          <td>
                            {count(row.submittedTriangles)}
                            {row.trianglesSource === "batchMembers" ? " (derived)" : ""}
                          </td>
                          <td>{count(row.draws)}</td>
                          <td>{count(row.projectedPixels)}</td>
                          <td>{count(row.copies)}</td>
                          <td>{row.asset ?? "—"}</td>
                        </tr>
                      );
                      if (!isExpanded) return [head];
                      return [
                        head,
                        ...row.meshes.map((mesh) => (
                          <tr className="tn-debug-mesh" key={mesh.id}>
                            <td>{mesh.name}</td>
                            <td>{count(mesh.submittedTriangles)}</td>
                            <td>{count(mesh.draws)}</td>
                            <td>{count(mesh.materials)}</td>
                            <td>{count(mesh.instances)}</td>
                            <td>{mesh.batchOwner ?? "—"}</td>
                          </tr>
                        )),
                      ];
                    })}
                  </tbody>
                </table>
              )}

              {selectedRow === undefined ? null : selectedRow.projectedCenter === undefined ||
                selectedRow.projectedPixels === undefined ||
                report.viewport === undefined ? (
                <p className="tn-debug-note">bounds unavailable</p>
              ) : (
                // Percentages of the captured drawing buffer, which is the canvas the overlay sits
                // over. The box is the capture's ESTIMATED bounds, not a silhouette or a pixel mask.
                <div className="tn-debug-outline-layer">
                  <div
                    className="tn-debug-outline"
                    style={{
                      height: `${String((selectedRow.projectedPixels / report.viewport.height) * 100)}%`,
                      left: `${String(((selectedRow.projectedCenter[0] - selectedRow.projectedPixels / 2) / report.viewport.width) * 100)}%`,
                      top: `${String(((selectedRow.projectedCenter[1] - selectedRow.projectedPixels / 2) / report.viewport.height) * 100)}%`,
                      width: `${String((selectedRow.projectedPixels / report.viewport.width) * 100)}%`,
                    }}
                  />
                </div>
              )}

              {copied === undefined ? null : (
                <textarea className="tn-debug-json" readOnly rows={8} value={copied} />
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
