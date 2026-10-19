// Turns native `_setValue`-bearing objects into Web Audio AudioParams, and gives the nodes that
// carry them their Web Audio property names. The engine has no accessor support, so `value` has to
// be defined here rather than in the binding.
//
// `bundle.params` are the raw param objects, already carrying the native setters. `bundle.type` is
// a biquad whose filter type must be settable and refused rather than accepted and ignored, and
// `bundle.reduction` is a compressor whose `reduction` is a native readout.
((bundle) => {
  for (const param of bundle.params) {
    let value = Number(param._default);
    Object.defineProperty(param, 'value', {
      get: () => value,
      set: (next) => { value = Number(next); param._setValue(value); },
      configurable: true,
    });
    param.setValueAtTime = (next, time) => {
      value = Number(next); param._setValueAtTime(value, time); return param;
    };
    param.linearRampToValueAtTime = (next, time) => {
      value = Number(next); param._linearRampToValueAtTime(value, time); return param;
    };
    param.setTargetAtTime = (next, time, constant) => {
      value = Number(next); param._setTargetAtTime(value, time, constant); return param;
    };
  }

  if (bundle.type) {
    const node = bundle.type;
    Object.defineProperty(node, 'type', {
      // Only `lowpass` is implemented. Accepting the other five names and passing the signal
      // through unfiltered is the silent failure this node exists to remove.
      get: () => 'lowpass',
      set: (next) => {
        if (!node._setType(next)) {
          throw new RangeError(`BiquadFilterNode.type: only "lowpass" is implemented on this runtime, not ${next}.`);
        }
      },
      configurable: true,
    });
  }

  if (bundle.reduction) {
    const node = bundle.reduction;
    const read = node._getReduction;
    Object.defineProperty(node, 'reduction', { get: () => read(), configurable: true });
  }
})(globalThis.__tnAudioParamBundle);