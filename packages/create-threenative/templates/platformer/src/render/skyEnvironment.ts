// Generated for you. This is ordinary Three.js — edit or delete it freely.
import {
  Color,
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  RGBAFormat,
} from "three";
import { gradientColor } from "./sky.js";

// Measured from the photographed sky this kit used to light with, preserving its tuned lighting
// when the background became a stylized gradient; edit these fills to relight.
const UPPER_FILL = new Color(0.355, 0.423, 0.627);
const LOWER_FILL = new Color(0.68, 0.67, 0.633);
export function skyEnvironment(): DataTexture {
  const width = 256;
  const height = 128;
  const data = new Uint16Array(width * height * 4);
  const upperMean = new Color(0, 0, 0);
  let weights = 0;
  for (let row = height / 2; row < height; row += 1) {
    const elevation = (row / (height - 1) - 0.5) * Math.PI;
    const weight = Math.abs(Math.cos(elevation));
    upperMean.add(gradientColor(row, height).multiplyScalar(weight));
    weights += weight;
  }
  upperMean.multiplyScalar(1 / weights);
  const scale = new Color(
    UPPER_FILL.r / upperMean.r,
    UPPER_FILL.g / upperMean.g,
    UPPER_FILL.b / upperMean.b,
  );
  for (let row = 0; row < height; row += 1) {
    const color = row < height / 2 ? LOWER_FILL : gradientColor(row, height).multiply(scale);
    const rgba = [color.r, color.g, color.b, 1].map(DataUtils.toHalfFloat);
    for (let column = 0; column < width; column += 1) {
      data.set(rgba, (row * width + column) * 4);
    }
  }
  const environment = new DataTexture(data, width, height, RGBAFormat, HalfFloatType);
  environment.colorSpace = LinearSRGBColorSpace;
  environment.mapping = EquirectangularReflectionMapping;
  environment.minFilter = LinearFilter;
  environment.magFilter = LinearFilter;
  environment.needsUpdate = true;
  return environment;
}
