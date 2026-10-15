/** RTTNode's mutable target state over the engine's scheduled fullscreen pass. */
interface IRttNode {
  __effect(name: string, value?: number): number;
}
function validateOptions(options: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(options)) {
    if (key === "type" && value === 1016) continue;
    if (key === "depthBuffer" && value === false) continue;
    if ((key === "minFilter" || key === "magFilter") && (value === 1003 || value === 1006))
      continue;
    throw new TypeError(`TN_TSL_RTT_OPTION: unsupported ${key}=${value}`);
  }
}
export function defineRtt(make: (...args: unknown[]) => IRttNode) {
  return (
    source: unknown,
    width: number | null = null,
    height: number | null = null,
    options: Record<string, unknown> = { type: 1016 },
  ) => {
    validateOptions(options);
    const node = make(
      source,
      width ?? 0,
      height ?? 0,
      options.minFilter ?? 1006,
      options.magFilter ?? 1006,
    );
    const parameter = (name: string) => ({
      configurable: true,
      get: () => node.__effect(name),
      set: (value: number) => {
        node.__effect(name, value);
      },
    });
    const extent = {
      width: { get: () => node.__effect("actualWidth") },
      height: { get: () => node.__effect("actualHeight") },
    };
    const texture = Object.defineProperties(
      { type: 1016, isTexture: true, image: Object.defineProperties({}, extent) },
      {
        ...extent,
        minFilter: parameter("minFilter"),
        magFilter: parameter("magFilter"),
      },
    );
    const renderTarget = Object.defineProperties(
      {
        texture,
        setSize(w: number, h: number) {
          node.__effect("width", w);
          node.__effect("height", h);
        },
        dispose() {
          node.__effect("dispose", 1);
        },
      },
      {
        width: { get: () => node.__effect("actualWidth") },
        height: { get: () => node.__effect("actualHeight") },
      },
    );
    return Object.defineProperties(node, {
      isRTTNode: { value: true },
      autoResize: { get: () => node.__effect("width") === 0 },
      renderTarget: { value: renderTarget },
      value: { value: texture },
      width: parameter("width"),
      height: parameter("height"),
      autoUpdate: {
        get: () => !!node.__effect("autoUpdate"),
        set: (v: boolean) => node.__effect("autoUpdate", Number(v)),
      },
      textureNeedsUpdate: {
        get: () => !!node.__effect("textureNeedsUpdate"),
        set: (v: boolean) => node.__effect("textureNeedsUpdate", Number(v)),
      },
      setResolutionScale: {
        value: (scale: number) => {
          node.__effect("resolutionScale", scale);
          return node;
        },
      },
      getResolutionScale: { value: () => node.__effect("resolutionScale") },
      setSize: { value: (w: number, h: number) => renderTarget.setSize(w, h) },
    });
  };
}
