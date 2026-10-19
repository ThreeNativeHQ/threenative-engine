/** Minimal test-facing declaration for Three's private attribute uploader. */
declare module "three/src/renderers/common/Bindings.js" {
  export default class Bindings {
    constructor(
      backend: object,
      nodes: object,
      textures: object,
      attributes: object,
      pipelines: object,
      info: object,
    );
    getForCompute(node: object): object[];
    updateForCompute(node: object): void;
    getForRender(renderObject: object): object[];
    updateForRender(renderObject: object): void;
    _createBindings(bindings: object[]): void;
    _updateBindings(bindings: object[], settled?: boolean): void;
    _update(bindGroup: object, bindings: object[], settled?: boolean): void;
  }
}

declare module "three/src/renderers/common/StorageBuffer.js" {
  export default class StorageBuffer {
    constructor(name: string, attribute: object);
  }
}

declare module "three/src/renderers/common/Attributes.js" {
  export default class Attributes {
    constructor(backend: object, info: object);
    get(attribute: object): { version?: number };
    update(attribute: object, type: number): void;
  }
}

declare module "three/src/renderers/common/Geometries.js" {
  export default class Geometries {
    constructor(attributes: object, info: object);
    updateAttribute(attribute: object, type: number): void;
    updateAttributes(renderObject: unknown): void;
    updateForRender(renderObject: unknown): void;
    attributesChanged(renderObject: unknown): boolean;
    getIndex(renderObject: unknown): unknown;
  }
}
