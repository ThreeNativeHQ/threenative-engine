// Microsecond CPU spans need the isolated browser clock.
const headers = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export default { preview: { headers }, server: { headers } };
