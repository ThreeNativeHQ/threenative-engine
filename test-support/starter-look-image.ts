import type { PNG } from "pngjs";

export type PixelBounds = { bottom: number; left: number; right: number; top: number };

/**
 * The 3D view of the 1280x720 starter frame, clear of the HUD. The controls bar starts at y 644, so
 * a stage reaching 660 counted its pixels as world: an unpainted SwiftShader frame (cover and HUD
 * over one flat colour) then read 96.1% flat instead of 98.5% and was judged as a look failure
 * (PR #595 run 41275660116, `contact-shadow coverage 0.0000`).
 */
export const STARTER_LOOK_STAGE: PixelBounds = { bottom: 640, left: 220, right: 1060, top: 160 };

type ColorComponent = { bounds: PixelBounds; count: number };
type ColorObject = { bounds?: PixelBounds; count: number };

export function dominantColorCoverage(image: PNG, stage: PixelBounds): number {
  const buckets = new Map<string, number>();
  let pixels = 0;
  for (let y = stage.top; y < stage.bottom; y += 1) {
    for (let x = stage.left; x < stage.right; x += 1) {
      const [red, green, blue] = readPixel(image, x, y);
      const key = `${red >> 5},${green >> 5},${blue >> 5}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
      pixels += 1;
    }
  }
  return Math.max(0, ...buckets.values()) / Math.max(1, pixels);
}

export function findLargestColorObject(
  image: PNG,
  stage: PixelBounds,
  matches: (red: number, green: number, blue: number) => boolean,
): ColorObject {
  const visited = new Uint8Array(image.width * image.height);
  const components: ColorComponent[] = [];
  for (let y = stage.top; y < stage.bottom; y += 1) {
    for (let x = stage.left; x < stage.right; x += 1) {
      const index = y * image.width + x;
      if (visited[index] === 1 || !matches(...readPixel(image, x, y))) continue;
      components.push(collectComponent(image, stage, matches, visited, x, y));
    }
  }
  components.sort((first, second) => second.count - first.count);
  const largest = components.shift();
  if (largest === undefined) return { count: 0 };

  let merged = true;
  while (merged) {
    merged = false;
    for (let index = components.length - 1; index >= 0; index -= 1) {
      const component = components[index];
      if (component === undefined || !withinGap(largest.bounds, component.bounds, 8)) continue;
      largest.bounds = mergeBounds(largest.bounds, component.bounds);
      largest.count += component.count;
      components.splice(index, 1);
      merged = true;
    }
  }
  return largest;
}

export function contactShadowCoverage(image: PNG, bounds: PixelBounds): number {
  const luminances: number[] = [];
  for (let y = bounds.bottom + 1; y <= Math.min(image.height - 1, bounds.bottom + 36); y += 1) {
    for (
      let x = Math.max(0, bounds.left - 30);
      x <= Math.min(image.width - 1, bounds.right + 30);
      x += 1
    ) {
      luminances.push(pixelLuminance(...readPixel(image, x, y)));
    }
  }
  if (luminances.length === 0) return 0;
  luminances.sort((first, second) => first - second);
  const baseline = luminances[Math.floor((luminances.length - 1) * 0.75)] ?? 0;
  const shadowThreshold = baseline - Math.max(0.04, baseline * 0.2);
  return luminances.filter((luminance) => luminance < shadowThreshold).length / luminances.length;
}

function collectComponent(
  image: PNG,
  stage: PixelBounds,
  matches: (red: number, green: number, blue: number) => boolean,
  visited: Uint8Array,
  startX: number,
  startY: number,
): ColorComponent {
  const queue: [number, number][] = [[startX, startY]];
  const bounds = { bottom: startY, left: startX, right: startX, top: startY };
  visited[startY * image.width + startX] = 1;
  let count = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const [x, y] = queue[cursor] as [number, number];
    count += 1;
    bounds.bottom = Math.max(bounds.bottom, y);
    bounds.left = Math.min(bounds.left, x);
    bounds.right = Math.max(bounds.right, x);
    bounds.top = Math.min(bounds.top, y);
    const neighbors: readonly [number, number][] = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nextX, nextY] of neighbors) {
      if (nextX < stage.left || nextX >= stage.right || nextY < stage.top || nextY >= stage.bottom)
        continue;
      const index = nextY * image.width + nextX;
      if (visited[index] === 1 || !matches(...readPixel(image, nextX, nextY))) continue;
      visited[index] = 1;
      queue.push([nextX, nextY]);
    }
  }
  return { bounds, count };
}

function withinGap(first: PixelBounds, second: PixelBounds, gap: number): boolean {
  return !(
    first.right + gap < second.left ||
    second.right + gap < first.left ||
    first.bottom + gap < second.top ||
    second.bottom + gap < first.top
  );
}

function mergeBounds(first: PixelBounds, second: PixelBounds): PixelBounds {
  return {
    bottom: Math.max(first.bottom, second.bottom),
    left: Math.min(first.left, second.left),
    right: Math.max(first.right, second.right),
    top: Math.min(first.top, second.top),
  };
}

function readPixel(image: PNG, x: number, y: number): [number, number, number] {
  const index = (y * image.width + x) * 4;
  return [image.data[index] ?? 0, image.data[index + 1] ?? 0, image.data[index + 2] ?? 0];
}

function pixelLuminance(red: number, green: number, blue: number): number {
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
}
