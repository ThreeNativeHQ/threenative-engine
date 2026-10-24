// three r185: src/renderers/common/RendererUtils.js, for state the Wasm facade exposes.
interface IRendererStateSurface {
  toneMapping: unknown;
  toneMappingExposure: unknown;
  outputColorSpace: unknown;
  autoClear: boolean;
  getRenderTarget(): unknown;
  setRenderTarget(target: unknown, face?: number, mip?: number): void;
  getActiveCubeFace(): number;
  getActiveMipmapLevel(): number;
  getPixelRatio(): number;
  setPixelRatio(value: number): void;
  getClearColor(target: object): object;
  getClearAlpha(): number;
  setClearColor(color: unknown, alpha: number): void;
}
interface IRendererState {
  toneMapping?: unknown;
  toneMappingExposure?: unknown;
  outputColorSpace?: unknown;
  autoClear?: boolean;
  renderTarget?: unknown;
  activeCubeFace?: number;
  activeMipmapLevel?: number;
  pixelRatio?: number;
  clearColor?: object;
  clearAlpha?: number;
}
export function defineRendererUtils(Color: new () => object) {
  const saveRendererState = (renderer: IRendererStateSurface, state: IRendererState = {}) => {
    for (const key of [
      "toneMapping",
      "toneMappingExposure",
      "outputColorSpace",
      "autoClear",
    ] as const)
      Object.assign(state, { [key]: renderer[key] });
    state.renderTarget = renderer.getRenderTarget();
    state.activeCubeFace = renderer.getActiveCubeFace();
    state.activeMipmapLevel = renderer.getActiveMipmapLevel();
    state.pixelRatio = renderer.getPixelRatio();
    state.clearColor = renderer.getClearColor(state.clearColor ?? new Color());
    state.clearAlpha = renderer.getClearAlpha();
    return state;
  };
  return {
    saveRendererState,
    resetRendererState(renderer: IRendererStateSurface, state?: IRendererState) {
      const saved = saveRendererState(renderer, state);
      renderer.setClearColor(0, 1);
      renderer.autoClear = true;
      return saved;
    },
    restoreRendererState(renderer: IRendererStateSurface, state: IRendererState) {
      renderer.toneMapping = state.toneMapping;
      renderer.toneMappingExposure = state.toneMappingExposure;
      renderer.outputColorSpace = state.outputColorSpace;
      renderer.autoClear = state.autoClear as boolean;
      renderer.setRenderTarget(state.renderTarget, state.activeCubeFace, state.activeMipmapLevel);
      if (renderer.getPixelRatio() !== state.pixelRatio)
        renderer.setPixelRatio(state.pixelRatio as number);
      renderer.setClearColor(state.clearColor, state.clearAlpha as number);
    },
  };
}
