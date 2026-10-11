import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Matrix4, Quaternion, Vector3 } from "three";
import { buildGlb } from "../../../packages/terrain/__tests__/fixtures/glb.mjs";
import { solidPng } from "../../../packages/terrain/__tests__/fixtures/png.mjs";

const FEET = 3.28084;
const close = (actual, expected, tolerance) =>
  actual.length === expected.length &&
  actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance);

/**
 * AC-7: an imported-and-edited world exports as one portable GLB. A custom model (authored in feet,
 * with its own camera and light), a PBR image mapped onto the bark, and one individually scaled
 * instance go in; an ordinary GLTFLoader game comes out with the final transforms, the model's own
 * materials, the image's pixels embedded, and no camera, light or external request.
 */
export async function verifyImportedExport({
  context,
  editorUrl,
  controller,
  consumerUrl,
  isolated,
  temporary,
}) {
  const folder = mkdtempSync(join(temporary, "imports-"));
  const editor = await context.newPage();
  const viewer = await context.newPage();
  const errors = [];
  const rejected = [];
  for (const page of [editor, viewer]) {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
  }
  await viewer.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("blob:") || url.startsWith("data:") || url.startsWith(consumerUrl))
      await route.continue();
    else {
      rejected.push(url);
      await route.abort();
    }
  });
  try {
    await editor.goto(editorUrl);
    await editor.waitForFunction(
      () => window.strata?.state && !window.strata.busy,
      {},
      { timeout: 60000 },
    );
    const revision = async () => (await controller.snapshot()).revision;
    const rendered = (value) =>
      editor.waitForFunction(
        (target) =>
          window.strata.renderedRevision === target &&
          window.strata.view.inspect().renderedRevision === target &&
          !window.strata.busy,
        value,
        { timeout: 60000 },
      );

    // Import: a model in feet from a local path, adjusted to metres, and an image mapped onto the bark.
    writeFileSync(join(folder, "oak.glb"), buildGlb({ unit: FEET }));
    writeFileSync(join(folder, "magenta.png"), solidPng(16, 16, [255, 0, 255, 255]));
    await controller.asset(
      { op: "register", id: "feet-tree", path: join(folder, "oak.glb") },
      await revision(),
    );
    await controller.asset(
      { op: "adjust", id: "feet-tree", adjust: { scale: 1 / FEET, pivot: "base" } },
      await revision(),
    );
    await controller.asset(
      { op: "register", id: "magenta-bark", path: join(folder, "magenta.png") },
      await revision(),
    );
    await controller.asset(
      { op: "map", input: "bark.albedo", asset: "magenta-bark" },
      await revision(),
    );
    const placed = await controller.commit({
      baseRevision: await revision(),
      commands: [
        {
          op: "upsert",
          layer: {
            id: "feet-grove",
            type: "scatter",
            params: { asset: "feet-tree", count: 6, avoidWater: false },
          },
        },
      ],
    });
    await rendered(placed.revision);
    await editor.waitForFunction(
      () =>
        window.strata.view
          .inspectSurfaces()
          .some((r) => r.input === "bark.albedo" && r.source === "magenta-bark"),
      {},
      { timeout: 20000 },
    );

    // Edit: one imported instance gets its own scale, the way the individual gizmo saves it.
    const trees = (await editor.evaluate(() => window.strata.view.inspectProps())).filter((p) =>
      p.id.startsWith("feet-grove:"),
    );
    assert(trees.length >= 1, "The imported model must be placed before it can be exported");
    const chosen = trees[0];
    const snapshot = await controller.snapshot();
    const edited = await controller.commit({
      baseRevision: snapshot.revision,
      document: {
        ...snapshot.document,
        placementOverrides: {
          ...snapshot.document.placementOverrides,
          [chosen.id]: { ...chosen.transform, scale: [2, 2, 2], grounding: true },
        },
      },
    });
    await rendered(edited.revision);
    const live = (await editor.evaluate(() => window.strata.view.inspectProps())).filter((p) =>
      p.id.startsWith("feet-grove:"),
    );
    assert.equal(live.length, trees.length);

    // Export the committed revision and read the file itself.
    const result = await editor.evaluate(async () => {
      const output = await window.strata.view.exportCurrentWorld();
      return {
        report: output.report,
        base64: await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.readAsDataURL(new Blob([output.bytes]));
        }),
      };
    });
    assert.equal(
      result.report.revision,
      edited.revision,
      "The export names the committed revision",
    );
    const bytes = Buffer.from(result.base64, "base64");
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
    const importedNodes = json.nodes.filter((node) =>
      node.extras?.placementId?.startsWith("feet-grove:"),
    );
    assert.equal(
      importedNodes.length,
      trees.length,
      "Every imported placement is a node in the GLB",
    );
    assert(
      json.materials.some((m) =>
        close(m.pbrMetallicRoughness?.baseColorFactor ?? [], [0.35, 0.2, 0.1, 1], 1e-3),
      ) &&
        json.materials.some((m) =>
          close(m.pbrMetallicRoughness?.baseColorFactor ?? [], [0.1, 0.5, 0.15, 1], 1e-3),
        ),
      "The imported model keeps the materials its file was authored with, not the starter's",
    );
    assert(
      !json.nodes.some((node) => /imported-(camera|light)/.test(node.name ?? "")) &&
        !json.cameras &&
        !JSON.stringify(json.extensionsUsed ?? []).includes("lights_punctual") &&
        !json.extensions?.KHR_lights_punctual,
      "The model's own camera and light never reach the world file",
    );
    assert(
      json.images.length >= 1 && json.images.every((i) => i.bufferView !== undefined && !i.uri),
    );
    assert(json.buffers.every((b) => !b.uri));
    assert(
      result.report.receivingGameSupplies.includes("lighting") &&
        result.report.receivingGameSupplies.includes("sky/environment") &&
        result.report.waterIds.includes("river"),
      "The export names what the receiving game supplies and the static water it carries",
    );
    writeFileSync(join(isolated, "public/world.glb"), bytes);

    // Render it in an ordinary game with a plain GLTFLoader and no authoring code.
    await viewer.goto(`${consumerUrl}?imported`);
    await viewer.waitForFunction(
      () => window.exportConsumerReady && window.portableWorld.frames >= 5,
    );
    const loaded = await viewer.evaluate(() => window.portableWorld);
    for (const tree of live) {
      const node = loaded.placements.find((entry) => entry.id === tree.id);
      assert(node, `Placement ${tree.id} reaches the receiving game`);
      const matrix = new Matrix4().compose(
        new Vector3().fromArray(tree.transform.position),
        new Quaternion().fromArray(tree.transform.quaternion),
        new Vector3().fromArray(tree.transform.scale),
      );
      matrix.elements.forEach((value, index) =>
        assert(Math.abs(node.matrix[index] - value) < 1e-4),
      );
    }
    const scaled = loaded.placements.find((entry) => entry.id === chosen.id);
    const column = new Vector3().fromArray(scaled.matrix, 0).length();
    assert(
      Math.abs(column - 2) < 1e-4,
      `The individually scaled instance arrives scaled (${column})`,
    );
    assert(
      loaded.mapPixels.includes("255,0,255"),
      `The mapped image's pixels are embedded: ${loaded.mapPixels}`,
    );
    assert.equal(loaded.lights, 0);
    assert.equal(loaded.cameras, 0);
    assert.deepEqual(rejected, [], "The receiving game makes no external request");
    assert.deepEqual(errors, []);
    return {
      importedPlacements: importedNodes.length,
      bytes: bytes.length,
      mapPixels: loaded.mapPixels.length,
    };
  } finally {
    await editor.close();
    await viewer.close();
  }
}
