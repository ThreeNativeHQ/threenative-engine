/** Cube LUT loading shared by the native player and the Wasm engine. */
interface ITexture {
  image: { data: Uint8Array | Float32Array; width: number; height: number; depth: number };
  type: number;
  minFilter: number;
  magFilter: number;
  wrapS: number;
  wrapT: number;
  wrapR: number;
  generateMipmaps: boolean;
  needsUpdate: boolean;
}
interface IVector {
  x: number;
  y: number;
  z: number;
}
interface IManager {
  itemStart?(url: string): void;
  itemEnd?(url: string): void;
  itemError?(url: string): void;
}
interface ICubeClasses {
  textureClass: new (
    data: Uint8Array | Float32Array,
    width: number,
    height: number,
    depth: number,
  ) => ITexture;
  vectorClass: new (x: number, y: number, z: number) => IVector;
}

interface ICubeData {
  title: string | null;
  size: number;
  min: number[];
  max: number[];
  samples: number[];
}

function cubeSize(words: string[], previous: number): number {
  if (previous || words.length !== 2) throw new Error("TN_LUT_SIZE: expected one LUT_3D_SIZE");
  const size = Number(words[1]);
  if (!Number.isInteger(size) || size < 2 || size > 256)
    throw new Error("TN_LUT_SIZE: expected 2 through 256");
  return size;
}

function cubeRow(line: string, cube: ICubeData): void {
  if (!line || line.startsWith("#")) return;
  const heading = /^TITLE\s+"([^"]*)"\s*(?:#.*)?$/u.exec(line);
  if (heading) {
    cube.title = heading[1] ?? "";
    return;
  }
  const words = line.split("#")[0]?.trim().split(/\s+/u) ?? [];
  const key = words[0];
  if (key === "LUT_3D_SIZE") {
    cube.size = cubeSize(words, cube.size);
    return;
  }
  const target = key === "DOMAIN_MIN" ? cube.min : key === "DOMAIN_MAX" ? cube.max : undefined;
  const values = (target ? words.slice(1) : words).map(Number);
  if (values.length !== 3 || !values.every(Number.isFinite)) throw new Error(`TN_LUT_ROW: ${line}`);
  if (target) {
    target.splice(0, 3, ...values);
    return;
  }
  if (!cube.size || cube.samples.length >= cube.size ** 3 * 4)
    throw new Error("TN_LUT_DATA: missing size or excess samples");
  cube.samples.push(...values, 1);
}

function parseCube(input: string): ICubeData {
  const cube: ICubeData = { title: null, size: 0, min: [0, 0, 0], max: [1, 1, 1], samples: [] };
  for (const raw of input.split(/\r?\n/u)) cubeRow(raw.trim(), cube);
  if (!cube.size || cube.samples.length !== cube.size ** 3 * 4)
    throw new Error("TN_LUT_DATA: expected size cubed RGB samples");
  if (cube.min.some((value, index) => value > (cube.max[index] ?? 0)))
    throw new Error("TN_LUT_DOMAIN: minimum exceeds maximum");
  return cube;
}

export function defineLUTCubeLoader(classes: ICubeClasses, read: (url: string) => Promise<string>) {
  return class LUTCubeLoader {
    type = 1009;
    path = "";
    constructor(readonly manager?: IManager) {}
    setType(type: number): this {
      if (type !== 1009 && type !== 1015)
        throw new Error("TN_LUT_TYPE: expected UnsignedByteType or FloatType");
      this.type = type;
      return this;
    }
    setPath(path: string): this {
      this.path = path;
      return this;
    }
    load(
      url: string,
      onLoad?: (result: ReturnType<LUTCubeLoader["parse"]>) => void,
      _onProgress?: unknown,
      onError?: (error: unknown) => void,
    ): void {
      this.loadAsync(url).then(onLoad, (error) => {
        if (onError === undefined) throw error;
        onError(error);
      });
    }
    async loadAsync(url: string) {
      const resolved = this.path + url;
      this.manager?.itemStart?.(resolved);
      try {
        return this.parse(await read(resolved));
      } catch (error) {
        this.manager?.itemError?.(resolved);
        throw error;
      } finally {
        this.manager?.itemEnd?.(resolved);
      }
    }
    parse(input: string) {
      this.setType(this.type);
      const { title, size, min, max, samples } = parseCube(input);
      const data =
        this.type === 1009
          ? Uint8Array.from(samples, (value) => value * 255)
          : Float32Array.from(samples);
      const texture3D = new classes.textureClass(data, size, size, size);
      Object.assign(texture3D, {
        type: this.type,
        magFilter: 1006,
        minFilter: 1006,
        wrapS: 1001,
        wrapT: 1001,
        wrapR: 1001,
        generateMipmaps: false,
        needsUpdate: true,
      });
      return {
        title,
        size,
        domainMin: new classes.vectorClass(min[0] ?? 0, min[1] ?? 0, min[2] ?? 0),
        domainMax: new classes.vectorClass(max[0] ?? 1, max[1] ?? 1, max[2] ?? 1),
        texture3D,
      };
    }
  };
}
