import { type RenderTarget, type Texture, Vector2 } from "three";

export interface IResolutionTextureView {
  readonly viewFraction: Vector2;
  readonly halfTexel: Vector2;
}
export interface IResolutionSubrectNode {
  setSize(width: number, height: number): void;
}
interface IRetainedTarget {
  readonly target: RenderTarget;
  readonly view: IResolutionTextureView;
  readonly original: RenderTarget["setSize"];
  readonly wrapped: RenderTarget["setSize"];
  width: number;
  height: number;
  viewWidth: number;
  viewHeight: number;
}
interface IRetainedNode {
  readonly node: IResolutionSubrectNode;
  readonly original: IResolutionSubrectNode["setSize"];
  readonly wrapped: IResolutionSubrectNode["setSize"];
  readonly targets: readonly IRetainedTarget[];
  width: number;
  height: number;
}

const quantize = (size: number): number => Math.max(8, Math.ceil(size / 8) * 8);
const validateSize = (width: number, height: number): void => {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0))
    throw new Error("TN_RESOLUTION_SUBRECT: invalid target extent");
};

const validateScale = (scale: number): void => {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1)
    throw new Error("TN_RESOLUTION_SUBRECT: invalid scale");
};

/** Owns capacity and viewport lifetime; generated render source owns sampling. */
export interface IResolutionSubrect {
  readonly active?: boolean;
  readonly view?: IResolutionTextureView;
  textureView(texture: Texture): IResolutionTextureView | undefined;
  activate?(scale: number): void;
  deactivate?(): void;
  setScale?(scale: number): void;
  setSize?(width: number, height: number): void;
  retain(node: IResolutionSubrectNode, targets: readonly RenderTarget[]): void;
  release(node: IResolutionSubrectNode): void;
  dispose(): void;
}

export class ResolutionSubrect implements IResolutionSubrect {
  readonly viewSize = new Vector2();
  readonly #fullSize = new Vector2();
  readonly #nodes = new Map<IResolutionSubrectNode, IRetainedNode>();
  readonly #targets = new Map<RenderTarget, IRetainedTarget>();
  #active = false;
  #disposed = false;
  #reserving = false;
  #scale = 1;

  get active(): boolean {
    return this.#active;
  }
  get scale(): number {
    return this.#scale;
  }

  get view(): IResolutionTextureView | undefined {
    for (const binding of this.#targets.values()) return binding.view;
    return undefined;
  }

  activate(scale: number): void {
    if (this.#disposed) throw new Error("TN_RESOLUTION_SUBRECT: disposed controller");
    validateScale(scale);
    this.#active = true;
    this.setScale(scale);
  }

  deactivate(): void {
    if (!this.#active) return;
    this.#active = false;
    for (const binding of this.#nodes.values()) {
      if (binding.width <= 0 || binding.height <= 0) continue;
      binding.original.call(
        binding.node,
        Math.max(1, Math.round(binding.width * this.#scale)),
        Math.max(1, Math.round(binding.height * this.#scale)),
      );
    }
    for (const binding of this.#targets.values()) {
      const width = Math.max(1, binding.target.width);
      const height = Math.max(1, binding.target.height);
      binding.target.viewport.set(0, 0, width, height);
      binding.target.scissor.copy(binding.target.viewport);
      binding.target.scissorTest = false;
      binding.view.viewFraction.set(1, 1);
      binding.view.halfTexel.set(0.5 / width, 0.5 / height);
    }
  }

  setScale(scale: number): void {
    if (this.#disposed) throw new Error("TN_RESOLUTION_SUBRECT: disposed controller");
    validateScale(scale);
    this.#scale = scale;
    if (this.#fullSize.x > 0)
      this.viewSize.set(quantize(this.#fullSize.x * scale), quantize(this.#fullSize.y * scale));
    for (const binding of this.#nodes.values()) {
      if (binding.width > 0) binding.node.setSize(binding.width, binding.height);
    }
  }

  setSize(width: number, height: number): void {
    if (this.#disposed) throw new Error("TN_RESOLUTION_SUBRECT: disposed controller");
    validateSize(width, height);
    if (this.#active && this.#fullSize.x === width && this.#fullSize.y === height) return;
    this.#fullSize.set(width, height);
    this.viewSize.set(quantize(width * this.#scale), quantize(height * this.#scale));
    for (const binding of this.#nodes.values()) binding.node.setSize(width, height);
  }

  retain(node: IResolutionSubrectNode, targets: readonly RenderTarget[]): void {
    if (this.#disposed) throw new Error("TN_RESOLUTION_SUBRECT: disposed controller");
    if (this.#nodes.has(node)) return;
    if (
      targets.length === 0 ||
      new Set(targets).size !== targets.length ||
      targets.some((target) => this.#targets.has(target))
    )
      throw new Error("TN_RESOLUTION_SUBRECT: missing or multiply owned target");
    const retained = targets.map((target) => {
      const view = { viewFraction: new Vector2(1, 1), halfTexel: new Vector2() };
      const original = target.setSize;
      const binding: IRetainedTarget = {
        target,
        view,
        original,
        width: 0,
        height: 0,
        viewWidth: 0,
        viewHeight: 0,
        wrapped: (width, height, depth = target.depth) => {
          validateSize(width, height);
          if (!this.#active) {
            original.call(target, width, height, depth);
            view.viewFraction.set(1, 1);
            view.halfTexel.set(0.5 / width, 0.5 / height);
            return;
          }
          let capacityChanged = false;
          if (this.#reserving) {
            const widthCapacity = Math.max(binding.width, quantize(width));
            const heightCapacity = Math.max(binding.height, quantize(height));
            capacityChanged = widthCapacity !== binding.width || heightCapacity !== binding.height;
            binding.width = widthCapacity;
            binding.height = heightCapacity;
          } else {
            if (binding.width === 0 || binding.height === 0)
              throw new Error("TN_RESOLUTION_SUBRECT: target capacity not reserved");
            if (Math.round(width) > binding.width || Math.round(height) > binding.height)
              throw new Error("TN_RESOLUTION_SUBRECT: viewport exceeds retained capacity");
            binding.viewWidth = Math.max(1, Math.round(width));
            binding.viewHeight = Math.max(1, Math.round(height));
          }
          if (capacityChanged || target.width !== binding.width || target.height !== binding.height)
            original.call(target, binding.width, binding.height, depth);
          if (!this.#reserving) this.#applyViewport(binding);
        },
      };
      target.setSize = binding.wrapped;
      this.#targets.set(target, binding);
      return binding;
    });
    const original = node.setSize;
    const binding: IRetainedNode = {
      node,
      original,
      targets: retained,
      width: 0,
      height: 0,
      wrapped: (width, height) => {
        validateSize(width, height);
        binding.width = width;
        binding.height = height;
        if (!this.#active) {
          original.call(node, width, height);
          return;
        }
        this.#reserving = true;
        try {
          original.call(node, quantize(width), quantize(height));
        } finally {
          this.#reserving = false;
        }
        original.call(node, quantize(width * this.#scale), quantize(height * this.#scale));
        // PassNode copies its own viewport/scissor after target.setSize().
        for (const target of retained) this.#applyViewport(target);
      },
    };
    node.setSize = binding.wrapped;
    this.#nodes.set(node, binding);
    if (this.#active && this.#fullSize.x > 0) node.setSize(this.#fullSize.x, this.#fullSize.y);
  }

  textureView(texture: Texture): IResolutionTextureView | undefined {
    for (const { target, view } of this.#targets.values()) {
      if (target.textures.includes(texture) || target.depthTexture === texture) {
        return view;
      }
    }
    return undefined;
  }

  release(node: IResolutionSubrectNode): void {
    const binding = this.#nodes.get(node);
    if (!binding) return;
    if (node.setSize === binding.wrapped) node.setSize = binding.original;
    for (const { target, original, wrapped } of binding.targets) {
      if (target.setSize === wrapped) target.setSize = original;
      this.#targets.delete(target);
    }
    this.#nodes.delete(node);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.deactivate();
    this.#disposed = true;
    for (const { node, original, wrapped } of this.#nodes.values()) {
      if (node.setSize === wrapped) node.setSize = original;
    }
    for (const { target, original, wrapped } of this.#targets.values()) {
      if (target.setSize === wrapped) target.setSize = original;
    }
    this.#nodes.clear();
    this.#targets.clear();
  }

  #applyViewport({ target, view, width, height, viewWidth, viewHeight }: IRetainedTarget): void {
    if (viewWidth > width || viewHeight > height || viewWidth <= 0 || viewHeight <= 0)
      throw new Error("TN_RESOLUTION_SUBRECT: viewport exceeds retained capacity");
    target.viewport.set(0, 0, viewWidth, viewHeight);
    target.scissor.copy(target.viewport);
    target.scissorTest = true;
    view.viewFraction.set(viewWidth / width, viewHeight / height);
    view.halfTexel.set(0.5 / width, 0.5 / height);
  }
}
