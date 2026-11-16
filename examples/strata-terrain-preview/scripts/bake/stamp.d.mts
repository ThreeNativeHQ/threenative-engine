/** The bake inputs' digest the stamp file records. */
export const stamp: string;
/** Whether the files in `outputDir` are already baked from these inputs. */
export function isFresh(outputDir: URL): Promise<boolean>;
