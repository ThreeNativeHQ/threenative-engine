interface IOwnedRunResource {
  release(): Promise<void>;
}
/** Release only the handles acquired by this run, after any in-flight acquisition settles. */
export function createOwnedRunResourceRelease(
  display: () => Promise<IOwnedRunResource> | undefined,
  lease: () => Promise<IOwnedRunResource> | undefined,
): () => Promise<void> {
  let releasePromise: Promise<void> | undefined;
  return () => {
    releasePromise ??= (async () => {
      // Match normal teardown order; a display failure must not strand the capture lease.
      await display()?.then((resource) => resource.release()).catch(() => undefined);
      await lease()?.then((resource) => resource.release()).catch(() => undefined);
    })();
    return releasePromise;
  };
}
