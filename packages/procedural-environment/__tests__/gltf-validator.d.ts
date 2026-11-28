declare module "gltf-validator" {
  export function validateBytes(data: Uint8Array): Promise<{
    issues: { messages: { code: string }[] };
  }>;
  const validator: { validateBytes: typeof validateBytes };
  export default validator;
}
