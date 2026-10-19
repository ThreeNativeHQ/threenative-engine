import { BoxGeometry, Mesh, PerspectiveCamera, Scene } from "three";
import { describe, expect, it, vi } from "vitest";
import { observeAnimalSubmissions } from "../../../examples/procedural-animals/src/observe-submissions.js";

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Missing fixture");
  return value;
}
function setup(count = 1) {
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const shadowCamera = new PerspectiveCamera();
  const surfaces = Array.from({ length: count }, () => new Mesh(new BoxGeometry()));
  const collector = { wolves: count, beginWorld: vi.fn(), endWorld: vi.fn(), submitted: vi.fn() };
  const priorUpdate = vi.fn(function (
    this: unknown,
    _object: unknown,
    _count: number,
    _instances: number,
  ) {
    return this;
  });
  const renderer: {
    info: { frame: number; update(object: unknown, count: number, instances: number): void };
  } = { info: { frame: 72, update: priorUpdate } };
  let armed = false;
  const dispose = observeAnimalSubmissions(
    scene,
    camera,
    surfaces,
    collector as never,
    () => armed,
  );
  return {
    scene,
    camera,
    shadowCamera,
    surfaces,
    collector,
    renderer,
    priorUpdate,
    dispose,
    arm: () => {
      armed = true;
    },
  };
}
function begin(s: ReturnType<typeof setup>) {
  s.arm();
  s.scene.onBeforeRender(
    s.renderer as never,
    s.scene,
    s.camera,
    null as never,
    undefined as never,
    undefined as never,
  );
}
function draw(s: ReturnType<typeof setup>, camera = s.camera, count = 36, instances = 1) {
  const mesh = first(s.surfaces);
  mesh.onBeforeRender(
    s.renderer as never,
    s.scene,
    camera,
    mesh.geometry,
    mesh.material as never,
    null as never,
  );
  s.renderer.info.update(mesh, count, instances);
  mesh.onAfterRender(
    s.renderer as never,
    s.scene,
    camera,
    mesh.geometry,
    mesh.material as never,
    null as never,
  );
}
describe("backend-confirmed public Three submission attribution staging", () => {
  it("does not count a callback when the backend submitted no draw", () => {
    const s = setup();
    begin(s);
    const mesh = first(s.surfaces);
    mesh.onBeforeRender(
      s.renderer as never,
      s.scene,
      s.camera,
      mesh.geometry,
      mesh.material as never,
      null as never,
    );
    mesh.onAfterRender(
      s.renderer as never,
      s.scene,
      s.camera,
      mesh.geometry,
      mesh.material as never,
      null as never,
    );
    expect(s.collector.submitted).not.toHaveBeenCalled();
    s.dispose();
  });
  it("records world IDs and confirms nested shadow/main backend draws", () => {
    const s = setup();
    begin(s);
    const mesh = first(s.surfaces);
    s.scene.onBeforeRender(
      s.renderer as never,
      s.scene,
      s.shadowCamera,
      null as never,
      undefined as never,
      undefined as never,
    );
    mesh.onBeforeShadow(
      s.renderer as never,
      mesh as never,
      s.camera,
      s.shadowCamera,
      mesh.geometry,
      mesh.material as never,
      null as never,
    );
    draw(s, s.shadowCamera);
    mesh.onAfterShadow(
      s.renderer as never,
      mesh as never,
      s.camera,
      s.shadowCamera,
      mesh.geometry,
      mesh.material as never,
      null as never,
    );
    s.scene.onAfterRender(
      s.renderer as never,
      s.scene,
      s.shadowCamera,
      null as never,
      undefined as never,
      undefined as never,
    );
    draw(s);
    s.scene.onAfterRender(
      s.renderer as never,
      s.scene,
      s.camera,
      null as never,
      undefined as never,
      undefined as never,
    );
    expect(s.collector.beginWorld.mock.calls).toEqual([[72]]);
    expect(s.collector.endWorld.mock.calls).toEqual([[72]]);
    expect(s.collector.submitted.mock.calls).toEqual([
      [72, 0, "shadow"],
      [72, 0, "main"],
    ]);
    expect(s.priorUpdate).toHaveBeenCalledTimes(2);
    s.dispose();
  });
  it("keeps an outer main camera across a reentrant shadow draw of the same mesh", () => {
    const s = setup();
    begin(s);
    const mesh = first(s.surfaces);
    mesh.onBeforeRender(
      s.renderer as never,
      s.scene,
      s.camera,
      mesh.geometry,
      mesh.material as never,
      null as never,
    );
    mesh.onBeforeShadow(
      s.renderer as never,
      mesh as never,
      s.camera,
      s.shadowCamera,
      mesh.geometry,
      mesh.material as never,
      null as never,
    );
    draw(s, s.shadowCamera);
    mesh.onAfterShadow(
      s.renderer as never,
      mesh as never,
      s.camera,
      s.shadowCamera,
      mesh.geometry,
      mesh.material as never,
      null as never,
    );
    s.renderer.info.update(mesh, 36, 1);
    mesh.onAfterRender(
      s.renderer as never,
      s.scene,
      s.camera,
      mesh.geometry,
      mesh.material as never,
      null as never,
    );
    expect(s.collector.submitted.mock.calls).toEqual([
      [72, 0, "shadow"],
      [72, 0, "main"],
    ]);
    s.dispose();
  });
  it("supports baseline world IDs with zero wolf surfaces", () => {
    const s = setup(0);
    begin(s);
    s.renderer.info.update(new Mesh(), 12, 1);
    s.scene.onAfterRender(
      s.renderer as never,
      s.scene,
      s.camera,
      null as never,
      undefined as never,
      undefined as never,
    );
    expect(s.collector.beginWorld).toHaveBeenCalledWith(72);
    expect(s.collector.endWorld).toHaveBeenCalledWith(72);
    expect(s.collector.submitted).not.toHaveBeenCalled();
    s.dispose();
  });
  it("ignores unarmed compile/startup callbacks", () => {
    const s = setup();
    s.scene.onBeforeRender(
      s.renderer as never,
      s.scene,
      s.camera,
      null as never,
      undefined as never,
      undefined as never,
    );
    draw(s);
    expect(s.collector.beginWorld).not.toHaveBeenCalled();
    expect(s.collector.submitted).not.toHaveBeenCalled();
    s.dispose();
  });
  it.each([0, 3, 35, Number.NaN])("rejects incomplete backend geometry count %s", (count) => {
    const s = setup();
    begin(s);
    expect(() => draw(s, s.camera, count)).toThrow(/DRAW_INCOMPLETE/);
    s.dispose();
  });
  it("rejects changed backend world ID or instance count", () => {
    const s = setup();
    begin(s);
    expect(() => draw(s, s.camera, 36, 0)).toThrow(/DRAW_INCOMPLETE/);
    s.renderer.info.frame = 73;
    expect(() => draw(s)).toThrow(/DRAW_INCOMPLETE/);
    s.dispose();
  });
  it("rejects missing draw pass and invalid source geometry", () => {
    const s = setup();
    begin(s);
    expect(() => s.renderer.info.update(first(s.surfaces), 36, 1)).toThrow(/DRAW_PASS_UNAVAILABLE/);
    s.dispose();
    expect(() =>
      observeAnimalSubmissions(
        new Scene(),
        new PerspectiveCamera(),
        [new Mesh()],
        { wolves: 1 } as never,
        () => true,
      ),
    ).toThrow(/SURFACE_GEOMETRY/);
  });
  it("preserves prior callback/update arguments and this; restores exact functions", () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const mesh = new Mesh(new BoxGeometry());
    const prior = vi.fn(function (this: Mesh, ..._args: unknown[]) {
      return this;
    });
    mesh.onAfterRender = prior;
    const before = scene.onBeforeRender;
    const shadow = mesh.onBeforeShadow;
    const collector = { wolves: 1, beginWorld: vi.fn(), endWorld: vi.fn(), submitted: vi.fn() };
    const priorUpdate = vi.fn(function (
      this: unknown,
      _object: unknown,
      _count: number,
      _instances: number,
    ) {
      return this;
    });
    const renderer = { info: { frame: 5, update: priorUpdate } };
    const dispose = observeAnimalSubmissions(scene, camera, [mesh], collector as never, () => true);
    scene.onBeforeRender(
      renderer as never,
      scene,
      camera,
      null as never,
      undefined as never,
      undefined as never,
    );
    mesh.onBeforeRender(
      renderer as never,
      scene,
      camera,
      mesh.geometry,
      mesh.material as never,
      null as never,
    );
    renderer.info.update(mesh, 36, 1);
    mesh.onAfterRender(
      renderer as never,
      scene,
      camera,
      mesh.geometry,
      mesh.material as never,
      null as never,
    );
    expect(first(prior.mock.results).value).toBe(mesh);
    expect(first(prior.mock.calls)[0]).toBe(renderer);
    expect(first(priorUpdate.mock.results).value).toBe(renderer.info);
    expect(first(priorUpdate.mock.calls)).toEqual([mesh, 36, 1]);
    dispose();
    dispose();
    expect(mesh.onAfterRender).toBe(prior);
    expect(mesh.onBeforeShadow).toBe(shadow);
    expect(scene.onBeforeRender).toBe(before);
    expect(renderer.info.update).toBe(priorUpdate);
  });
  it("restores each still-owned callback when one mesh and scene hook changed", () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera();
    const mesh = new Mesh(new BoxGeometry());
    const sceneBefore = scene.onBeforeRender;
    const meshBefore = mesh.onBeforeRender;
    const shadowBefore = mesh.onBeforeShadow;
    const shadowAfter = mesh.onAfterShadow;
    const collector = { wolves: 1, beginWorld: vi.fn(), endWorld: vi.fn(), submitted: vi.fn() };
    const dispose = observeAnimalSubmissions(scene, camera, [mesh], collector as never, () => true);
    const replacedMesh = () => {};
    const replacedScene = () => {};
    mesh.onAfterRender = replacedMesh;
    scene.onAfterRender = replacedScene;
    expect(() => dispose()).toThrow(/HOOK_RESTORE/);
    expect(mesh.onAfterRender).toBe(replacedMesh);
    expect(scene.onAfterRender).toBe(replacedScene);
    expect(mesh.onBeforeRender).toBe(meshBefore);
    expect(mesh.onBeforeShadow).toBe(shadowBefore);
    expect(mesh.onAfterShadow).toBe(shadowAfter);
    expect(scene.onBeforeRender).toBe(sceneBefore);
  });
  it("rejects unavailable actual IDs and changed hook ownership", () => {
    const s = setup();
    s.arm();
    expect(() =>
      s.scene.onBeforeRender(
        { info: { frame: undefined } } as never,
        s.scene,
        s.camera,
        null as never,
        undefined as never,
        undefined as never,
      ),
    ).toThrow(/RENDER_INFO_UNAVAILABLE/);
    begin(s);
    const replacement = () => {};
    s.renderer.info.update = replacement;
    expect(() => s.dispose()).toThrow(/HOOK_RESTORE/);
    expect(s.renderer.info.update).toBe(replacement);
    expect(s.scene.onBeforeRender.name).not.toBe("beforeObserved");
  });
});
