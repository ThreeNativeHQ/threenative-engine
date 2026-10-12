/** Make the first save and its automatic retry genuinely stale; the real server answers 409. */
export function installStaleWrites(): void {
  const fetch_ = globalThis.fetch.bind(globalThis);
  let remaining = 2;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (
      remaining &&
      new URL(url, location.href).pathname === "/terrain-editor/api/document" &&
      init?.method === "POST"
    ) {
      remaining--;
      const transaction = JSON.parse(String(init.body));
      const response = await fetch_(input, {
        ...init,
        body: JSON.stringify({ ...transaction, baseRevision: "stale-durability-fixture" }),
      });
      if (response.status === 409)
        document.body.dataset.staleWriteConflicts = String(
          Number(document.body.dataset.staleWriteConflicts ?? 0) + 1,
        );
      return response;
    }
    return fetch_(input, init);
  };
}
