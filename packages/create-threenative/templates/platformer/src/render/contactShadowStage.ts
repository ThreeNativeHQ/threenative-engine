// Generated for you: ordinary Three.js; ThreeNative does not read this file.
//
// The contact shadow under small things. The shadow map cannot resolve the few centimetres where
// a foot meets the ground: its texels are wider than the gap and its bias lifts the shadow off the
// caster, so a fox on a bright grass cap looked unplanted and this game used to hide that with a
// painted blob. This stage replaces the blob with a shadow marched through the depth the scene
// pass already wrote, toward the sun.
//
// The split: `contactShadow()` from the core package owns the compute passes and returns the
// term as a texture node. Everything you see is decided in this file: how far the
// shadow reaches, how thick a surface is assumed to be, how hard the edge is, how dark it gets,
// and that the term multiplies the lit colour after the scene pass, on faces the sun reaches. To
// make it softer, lower `strength` or `contrast` below. To remove it, drop `"contactShadows"` from
// `authoredStageNames` in `postprocessing.ts`; `TN_RENDER_CHAIN` then stops listing it.
import { type IContactShadowOptions, contactShadow } from "@threenative/core";
import { type DirectionalLight, Vector2, Vector3 } from "three";
import { float, getViewPosition, screenUV, sign, smoothstep, uniform, vec2 } from "three/tsl";
import type { Node } from "three/webgpu";
import type { QualityTier } from "./quality.js";
import type { ChainStage, IWorldEnvironmentStageContext } from "./worldEnvironment.js";

/** What one tier asks of the stage. Every number is this game's; the engine has no defaults. */
export interface IContactShadowLook {
  /** Shadow length in screen pixels, and the cost: one depth sample per pixel of length. */
  readonly sampleCount: number;
  /** The first samples cast a hard shadow; the rest are averaged. */
  readonly hardSamples: number;
  /** The last samples fade the shadow out, so its far end does not stop on a line. */
  readonly fadeSamples: number;
  /** How thick a surface is assumed to be, as a fraction of the remaining depth range. */
  readonly surfaceThickness: number;
  /** Depth jump, as a fraction, that counts as an edge instead of a slope. */
  readonly bilinearThreshold: number;
  /** Boost on the lit-to-shadow transition. At least 1. */
  readonly contrast: number;
  /** 0 leaves the frame as it was, 1 applies the whole term. */
  readonly strength: number;
  /** Neighbour distance, in pixel footprints, where a pixel starts to count as a silhouette. */
  readonly silhouetteJump: number;
  /** Surface-to-sun cosine where the term starts, and where it is whole. Faces below it get none. */
  readonly sunFacing: readonly [number, number];
  /**
   * Sun shadow-map texel over screen-pixel footprint, where the term starts and where it is whole.
   * Below it the map already out-resolves the pixel, so the term adds no contact, only edge noise.
   */
  readonly texelsPerPixel: readonly [number, number];
}

/**
 * The `contactShadows` stage. Pass it as `authoredStages` and name `"contactShadows"` in
 * `authoredStageNames`. It refuses by name, with a reason, when the game has no sun to trace
 * toward, and the chain drops it below the `medium` tier.
 */
export function contactShadowStages(
  context: IWorldEnvironmentStageContext,
  sun: DirectionalLight | undefined,
  look: IContactShadowLook,
): readonly ChainStage[] {
  let mask: Node | undefined;
  const towardSun = uniform(new Vector3());
  const texelSize = uniform(new Vector2(1, 1));
  const shadowTexel = uniform(1);
  const from = new Vector3();
  const to = new Vector3();
  return [
    {
      name: "contactShadows",
      minimumTier: "medium",
      available: () => (sun === undefined ? "no-sun-light" : true),
      build: (input) => {
        if (sun === undefined) throw new Error("contactShadows built without a sun light.");
        // The pass's own depth texture: its size follows the drawing buffer, so read it each frame.
        const depth = context.depthNode as unknown as {
          readonly value: { readonly image: { readonly width: number; readonly height: number } };
        };
        const options: IContactShadowOptions = {
          bilinearThreshold: look.bilinearThreshold,
          camera: context.camera,
          contrast: look.contrast,
          depth: {
            node: context.depthNode,
            size: () => ({ height: depth.value.image.height, width: depth.value.image.width }),
          },
          direction: () => {
            sun.getWorldPosition(from);
            sun.target.getWorldPosition(to);
            const world = from.sub(to).normalize();
            texelSize.value.set(1 / depth.value.image.width, 1 / depth.value.image.height);
            const lens = sun.shadow.camera;
            shadowTexel.value = (lens.right - lens.left) / lens.zoom / sun.shadow.mapSize.x;
            towardSun.value.copy(world).transformDirection(context.camera.matrixWorldInverse);
            return world;
          },
          fadeSamples: look.fadeSamples,
          hardSamples: look.hardSamples,
          sampleCount: look.sampleCount,
          surfaceThickness: look.surfaceThickness,
        };
        const node = contactShadow(options) as unknown as Node<"vec4">;
        mask = node;
        const sceneDepth = context.depthNode as unknown as Node;
        const depthAt = (uv: Node): Node<"float"> => sceneDepth.sample(uv).r as Node<"float">;
        // The multiply also reaches faces the sun never touches, which the lighting already
        // darkened. Only surfaces that face the sun take the term: the normal is rebuilt from the
        // neighbour on each axis whose depth is closer, so it holds at silhouettes.
        // The pass camera's inverse, not the post quad's: depth is only meaningful in its own space.
        const projectionInverse = uniform(context.camera.projectionMatrixInverse);
        const viewAt = (uv: Node): Node<"vec3"> =>
          getViewPosition(uv, depthAt(uv), projectionInverse) as Node<"vec3">;
        const step = (x: number, y: number): Node =>
          screenUV.add(vec2(texelSize.x.mul(x), texelSize.y.mul(y)));
        const centre = viewAt(screenUV);
        // Pixel footprint at this depth. A neighbour further than a few footprints is across a
        // silhouette, and there the rebuilt normal is noise: the pixel takes no term.
        const footprint = getViewPosition(step(1, 0), depthAt(screenUV), projectionInverse)
          .sub(centre)
          .length();
        const reachOf = (dx: number, dy: number): Node<"vec3"> =>
          viewAt(step(dx, dy)).sub(centre) as Node<"vec3">;
        const right = reachOf(1, 0);
        const left = reachOf(-1, 0);
        const below = reachOf(0, 1);
        const above = reachOf(0, -1);
        const nearer = (a: Node<"vec3">, b: Node<"vec3">): Node<"vec3"> =>
          a.length().lessThan(b.length()).select(a, b) as Node<"vec3">;
        const acrossRaw = nearer(right, left);
        const upRaw = nearer(above, below);
        const jump = right.length().max(left.length()).max(above.length().max(below.length()));
        const smooth = float(1).sub(
          smoothstep(look.silhouetteJump, look.silhouetteJump * 2, jump.div(footprint)),
        );
        const normal = acrossRaw
          .mul(sign(acrossRaw.x))
          .cross(upRaw.mul(sign(upRaw.y)))
          .normalize();
        const facing = smoothstep(look.sunFacing[0], look.sunFacing[1], normal.dot(towardSun));
        // Where the shadow map's texel is not wider than the pixel, it already resolves the contact.
        const resolvable = smoothstep(
          look.texelsPerPixel[0],
          look.texelsPerPixel[1],
          shadowTexel.div(footprint.max(1e-4)),
        );
        const reach = facing.mul(smooth).mul(resolvable).mul(look.strength);
        // `.r` is 1 where lit and 0 where shadowed; `reach` is how much of that this game wants.
        const term = float(1).sub(float(1).sub(node.r).mul(reach));
        return (input as Node<"vec4">).mul(term);
      },
      dispose: () => {
        mask?.dispose();
        mask = undefined;
      },
    },
  ];
}

/**
 * The contact shadow under small things, per tier. The numbers hold things on the ground rather
 * than draw a dark halo: the reach is 8 px on screen, which is a foot at this camera's distance,
 * the first samples stay hard so the contact is pinned, and the last fade so the far end does not
 * stop on a line. A longer reach grows with distance (a tower 50 m away gets over a metre of it),
 * and where the sun's shadow-map texel is already no wider than a pixel the map resolves the
 * contact itself, so `texelsPerPixel` hands those pixels back to it. `low` does not run the
 * stage: the chain refuses it by name, so its entry only says what it would use. Cost is
 * unmeasured; read `TN_FRAME_BUDGET` after you change a number.
 */
const CONTACT_SHADOW_HIGH: IContactShadowLook = {
  bilinearThreshold: 0.02,
  contrast: 1,
  fadeSamples: 4,
  hardSamples: 1,
  sampleCount: 8,
  strength: 0.75,
  surfaceThickness: 0.005,
  silhouetteJump: 8,
  sunFacing: [0.25, 0.6],
  texelsPerPixel: [1, 1.6],
};
const CONTACT_SHADOW_MEDIUM: IContactShadowLook = {
  ...CONTACT_SHADOW_HIGH,
  fadeSamples: 3,
  hardSamples: 1,
  sampleCount: 6,
};
const CONTACT_SHADOW: Record<QualityTier, IContactShadowLook> = {
  high: CONTACT_SHADOW_HIGH,
  low: CONTACT_SHADOW_MEDIUM,
  medium: CONTACT_SHADOW_MEDIUM,
};

/** The contact-shadow numbers a tier uses. Throws on a name that is not a tier. */
export function contactShadowLook(tier: string): IContactShadowLook {
  const look = CONTACT_SHADOW[tier as QualityTier];
  if (look === undefined) {
    throw new Error(
      `Unknown quality tier ${JSON.stringify(tier)} — expected one of ${Object.keys(CONTACT_SHADOW).join(", ")}.`,
    );
  }
  return look;
}
