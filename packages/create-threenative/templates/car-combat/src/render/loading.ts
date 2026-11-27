import type { Camera, OrthographicCamera, Scene } from "three";

/** Minimal deliberately opts out; changing this one source value enables a full authored cover. */
export const loading = {
  backgroundImage: undefined as string | undefined,
  enabled: false,
  fillImage: undefined as string | undefined,
  logoImage: undefined as string | undefined,
  progressColor: 0xffd27a,
  trackColor: 0x14516e,
} as const;

interface LoadingHost {
  readonly camera: Camera;
  readonly canvasLayer: {
    readonly camera: OrthographicCamera;
    readonly scene: Scene;
    opaque: boolean;
  };
  readonly viewport?: {
    readonly safeArea: {
      readonly height: number;
      readonly width: number;
      readonly x: number;
      readonly y: number;
    };
  };
}

export function createLoadingScreen(host: LoadingHost) {
  host.canvasLayer.opaque = false;
  return { finish: () => undefined, update: () => undefined };
}
