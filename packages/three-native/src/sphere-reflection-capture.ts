/** HDR faces in probes::captureFace order (+X,-X,+Y,-Y,+Z,-Z), repacked for the existing PMREM path. */
export function cubemapToEquirectangular(faces: readonly Float32Array[], size: number) {
  if (
    !Number.isInteger(size) ||
    size < 1 ||
    size > 1024 ||
    faces.length !== 6 ||
    faces.some((face) => face.length !== size * size * 3 || !face.every(Number.isFinite))
  )
    throw new Error("TN_REFLECTION_CAPTURE_FACES: six finite RGB faces required");
  const width = size * 4;
  const height = size * 2;
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const theta = ((y + 0.5) * Math.PI) / height;
    for (let x = 0; x < width; x++) {
      // Inverse of three's equirectUV: atan2(z,x)/(2*pi)+0.5, asin(y)/pi+0.5.
      const phi = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const dx = Math.sin(theta) * Math.cos(phi);
      const dy = Math.cos(theta);
      const dz = Math.sin(theta) * Math.sin(phi);
      const ax = Math.abs(dx);
      const ay = Math.abs(dy);
      const az = Math.abs(dz);
      let face: number;
      let col: number;
      let row: number;
      if (ax >= ay && ax >= az) {
        face = dx > 0 ? 0 : 1;
        col = (dx > 0 ? -dz : dz) / ax;
        row = dy / ax;
      } else if (ay >= az) {
        face = dy > 0 ? 2 : 3;
        col = dx / ay;
        row = (dy > 0 ? -dz : dz) / ay;
      } else {
        face = dz > 0 ? 4 : 5;
        col = (dz > 0 ? dx : -dx) / az;
        row = dy / az;
      }
      const px = Math.min(size - 1, Math.max(0, Math.floor(((col + 1) * size) / 2)));
      const py = Math.min(size - 1, Math.max(0, Math.floor(((1 - row) * size) / 2)));
      const source = faces[face] as Float32Array;
      const offset = (py * size + px) * 3;
      const out = (y * width + x) * 4;
      data[out] = source[offset] as number;
      data[out + 1] = source[offset + 1] as number;
      data[out + 2] = source[offset + 2] as number;
      data[out + 3] = 1;
    }
  }
  return { data, width, height };
}

export type CaptureFace = (
  scene: unknown,
  x: number,
  y: number,
  z: number,
  size: number,
  face: number,
) => Promise<Float32Array | null>;
interface IEnvironmentTexture {
  mapping: number;
  colorSpace: string;
  flipY: boolean;
  needsUpdate: boolean;
}

/**
 * A static scene capture from a point. The engine PMREM-filters this HDR texture when used as envMap.
 * @alias reflection probe, cube capture
 */
export function defineSphereReflectionCapture(
  capture: CaptureFace,
  Texture: new (
    data: Float32Array,
    width: number,
    height: number,
    format: number,
    type: number,
  ) => IEnvironmentTexture,
) {
  return async function SphereReflectionCapture(
    scene: unknown,
    position: { x: number; y: number; z: number },
    faceSize = 256,
  ) {
    const { x, y, z } = position;
    if (
      ![x, y, z].every(Number.isFinite) ||
      !Number.isInteger(faceSize) ||
      faceSize < 16 ||
      faceSize > 1024
    )
      throw new Error(
        "TN_REFLECTION_CAPTURE_INPUT: finite position and face size 16..1024 required",
      );
    const faces: Float32Array[] = [];
    const deadline = performance.now() + 120_000;
    for (let face = 0; face < 6; face++) {
      for (;;) {
        if (performance.now() > deadline) throw new Error("TN_REFLECTION_CAPTURE_TIMEOUT");
        const pixels = await capture(scene, x, y, z, faceSize, face);
        if (pixels !== null) {
          faces.push(pixels);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    const { data, width, height } = cubemapToEquirectangular(faces, faceSize);
    const texture = new Texture(data, width, height, 1023, 1015); // RGBAFormat, FloatType
    texture.mapping = 303; // EquirectangularReflectionMapping; existing engine PMREM preparation.
    texture.colorSpace = "srgb-linear";
    texture.flipY = true; // rows above start at the north pole, as HDRLoader's decoded image does.
    texture.needsUpdate = true;
    return texture;
  };
}
