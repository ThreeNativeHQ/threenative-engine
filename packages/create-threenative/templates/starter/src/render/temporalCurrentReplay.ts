// Owned private passes: matched sample visibility, centre replay and four-depth packet export.
import { Color, FloatType, type Material, NearestFilter, type Scene } from "three";
import { context, int, ivec2, pass, texture, uv, vec4 } from "three/tsl";
import {
  MeshBasicNodeMaterial,
  type Node,
  type NodeFrame,
  type PassNode,
  QuadMesh,
  RenderTarget,
  type Renderer,
  RendererUtils,
} from "three/webgpu";
import type { IRawPass } from "./temporalCurrentSelection.js";
import { currentVisibilityMaterial } from "./temporalCurrentVisibility.js";
export function createTemporalCurrentReplay(beauty: PassNode) {
  const scene = beauty.scene as Scene;
  const visibility = pass(beauty.scene, beauty.camera, { samples: 4 }) as IRawPass;
  const centre = pass(beauty.scene, beauty.camera, { samples: 0 });
  visibility.contextNode = context({ invariantPosition: true, sampleInterpolation: true });
  centre.contextNode = context({ invariantPosition: true });
  // The beauty wrapper schedules both private traversals, once after its frozen input draw.
  // Their borrowed texture dependencies must not trigger independent traversals later in a quad.
  const drawVisibility = visibility.updateBefore.bind(visibility);
  const drawCentre = centre.updateBefore.bind(centre);
  visibility.updateBefore = () => {};
  centre.updateBefore = () => {};
  const rawMotion = visibility.getRawTextureNode();
  const rawDepth = visibility.getRawTextureNode("depth");
  const centreDepth = texture(centre.getTexture("depth"));
  const centreMotion = texture(centre.getTexture("output"));
  const centreDepthOwner = centreDepth.value;
  const centreMotionOwner = centreMotion.value;
  centreDepth.value = beauty.getTextureNode("depth").value;
  centreMotion.value = beauty.getTextureNode("velocity").value;
  const previous = new RenderTarget(1, 1, {
    type: FloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
  });
  previous.texture.name = "Temporal previous four-site depth";
  const packetMaterial = new MeshBasicNodeMaterial();
  const packetUV = ivec2(uv().mul(rawDepth.size(int(0)) as Node<"uvec2">));
  // This is a depth packet, not opaque colour: preserve channel3 instead of forcing alpha=1.
  packetMaterial.fragmentNode = vec4(
    ...([0, 1, 2, 3].map((sample) => rawDepth.load(packetUV).level(int(sample)).r) as [
      Node<"float">,
      Node<"float">,
      Node<"float">,
      Node<"float">,
    ]),
  );
  packetMaterial.fog = false;
  const packetQuad = new QuadMesh(packetMaterial);
  const materials = new Map<
    Material,
    {
      material: ReturnType<typeof currentVisibilityMaterial>;
      version: number;
      motion: Node<"vec2">;
    }
  >();
  function release() {
    visibility.renderTarget.dispose();
    centre.renderTarget.dispose();
    previous.dispose();
    for (const entry of materials.values()) entry.material.dispose();
    materials.clear();
    // Material disposal releases compiled draw bindings/pipelines and permits later reuse.
    packetMaterial.dispose();
  }
  return {
    depth: centreDepth,
    motion: centreMotion,
    inputs: { motion: rawMotion, depth: rawDepth, previousDepth: texture(previous.texture) },
    setActive: (next: boolean) => {
      centreDepth.value = next ? centreDepthOwner : beauty.getTextureNode("depth").value;
      centreMotion.value = next ? centreMotionOwner : beauty.getTextureNode("velocity").value;
    },
    draw: (
      frame: NodeFrame,
      width: number,
      height: number,
      scale: number,
      sourceMotion: Node<"vec2">,
    ) => {
      if (frame.renderer === null) throw new Error("Replay requires a renderer.");
      const renderer = frame.renderer;
      visibility.setResolutionScale(scale);
      centre.setResolutionScale(scale);
      const layers = beauty.getLayers();
      visibility.setLayers(layers);
      centre.setLayers(layers);
      visibility.opaque = centre.opaque = beauty.opaque;
      visibility.transparent = centre.transparent = beauty.transparent;
      // Original list sorting uses original material IDs/order. Only the draw's material changes.
      renderer.setRenderObjectFunction(
        (object, drawScene, camera, geometry, source, group, lights, clipping, passId) => {
          let entry = materials.get(source);
          if (
            entry === undefined ||
            entry.version !== source.version ||
            entry.motion !== sourceMotion
          ) {
            entry?.material.dispose();
            entry = {
              material: currentVisibilityMaterial(renderer, source, sourceMotion as Node<"vec2">),
              version: source.version,
              motion: sourceMotion as Node<"vec2">,
            };
            materials.set(source, entry);
          } else {
            // NodeLibrary performs this same material transfer. Numeric edits need not bump version.
            for (const key in source)
              if (!/^(?:id|uuid|version|type|_)|^(?:is[A-Z])/.test(key))
                Reflect.set(entry.material, key, Reflect.get(source, key));
            entry.material.alphaTest = source.alphaTest;
            entry.material.fog = false;
          }
          renderer.renderObject(
            object,
            drawScene,
            camera,
            geometry,
            entry.material,
            group,
            lights,
            clipping,
            passId,
          );
        },
      );
      scene.background = null;
      renderer.setClearColor(new Color(0), 1);
      drawVisibility(frame);
      drawCentre(frame);
      previous.setSize(width, height);
      renderer.initRenderTarget(previous);
    },
    publishDepth: (renderer: Renderer) => {
      const saved = RendererUtils.saveRendererState(renderer);
      try {
        renderer.setRenderTarget(previous);
        packetQuad.render(renderer);
      } finally {
        RendererUtils.restoreRendererState(renderer, saved);
      }
    },
    release,
    dispose: () => {
      visibility.dispose();
      centre.dispose();
      previous.dispose();
      packetMaterial.dispose();
      for (const entry of materials.values()) entry.material.dispose();
      materials.clear();
    },
  };
}
