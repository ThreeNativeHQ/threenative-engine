import { editWorldPlacements } from "../../../../terrain/src/core/placement-edits.ts";
import { assertCondition } from "./scene-support.js";
import {
  createWorldCellsProxyData,
  startScene as startProxyStream,
} from "./world-cells-proxy-stream.js";

export function assertWorldCellsEditedProxyProof(observations, validationError) {
  assertCondition(observations?.length === 3, "edited stream requires A, B, then captured A");
  for (const [index, stats] of observations.entries()) {
    const editedCell = index !== 1;
    assertCondition(
      stats.residentKeys?.includes(editedCell ? "0:0" : "2:0"),
      "edited stream cell missing",
    );
    assertCondition(
      stats.loadedCells > 0 && stats.instances > 0,
      "edited cell source not admitted",
    );
    assertCondition(stats.failures === 0 && stats.hlod?.failures === 0, "edited streaming failed");
    if (editedCell) {
      assertCondition(stats.hlod.active === 0, "cell A retained its stale cell proxy");
      assertCondition(
        stats.positions?.length === 1,
        "cell A must render exactly one detail record",
      );
      assertCondition(
        stats.positions[0].every((value, axis) => value === [10, 3, 8][axis]),
        "cell A did not render the moved record at its authored position",
      );
    } else {
      assertCondition(
        stats.hlod.compiled > 0 && stats.hlod.observed > 0 && stats.hlod.active > 0,
        "untouched cell B must compile, submit and swap to its proxy",
      );
      assertCondition(stats.evictions > 0, "edited cell A did not evict");
      assertCondition(
        stats.positions?.length === 1 &&
          stats.positions[0].every((value, axis) => value === [72, 1, 8][axis]),
        "untouched cell B did not restore its original detail record",
      );
    }
  }
  assertCondition(validationError === null, "GPU validation observation missing or failed");
}

export async function startScene(canvas, dimensions) {
  const source = createWorldCellsProxyData();
  source.manifest.placementIds = "placement-ids.json";
  source.ids = ["cell-a:box", "cell-b:box"];
  const edited = editWorldPlacements(
    source,
    {
      overrides: {
        "cell-a:box": {
          position: [10, 3, 8],
          quaternion: [0, 0, 0, 1],
          scale: [1, 1, 1],
          grounding: false,
        },
      },
    },
    () => {
      throw new Error("grounding:false must preserve authored Y");
    },
  );
  assertCondition(edited.unmatched.length === 0, "fixture placement ID was not matched");
  assertCondition(
    edited.ids?.join(",") === source.ids.join(","),
    "fixture IDs lost binary record order",
  );
  assertCondition(edited.manifest.cells[0]?.proxy === undefined, "editor retained cell A proxy");
  const cellB = edited.manifest.cells[1];
  const originalB = source.manifest.cells[1];
  assertCondition(
    cellB?.x === originalB.x &&
      cellB.z === originalB.z &&
      cellB.proxy === originalB.proxy &&
      cellB.runs.length === 1 &&
      cellB.runs[0].asset === "box" &&
      cellB.runs[0].offset === 1 &&
      cellB.runs[0].count === 1,
    "editor changed untouched cell B",
  );
  assertCondition(
    new Float32Array(edited.placements)
      .slice(8)
      .every((value, index) => value === new Float32Array(source.placements)[index + 8]),
    "editor changed untouched cell B placement bytes",
  );
  const result = await startProxyStream(canvas, dimensions, edited);
  assertWorldCellsEditedProxyProof(result.observations, result.validationError);
  globalThis.__TN_CONFORMANCE = {
    ok: true,
    type: "world-cells-edited-proxy-stream",
    detail: {
      movedPosition: [10, 3, 8],
      cellAProxy: false,
      proxySwaps: 1,
      nearRestores: 1,
      validationErrors: 0,
    },
  };
  return result;
}
