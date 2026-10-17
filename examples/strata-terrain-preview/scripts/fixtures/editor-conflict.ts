/** Refuse two sculpt intents and their automatic retries with real server 409s. */
export function installStaleWrites(): void {
  const fetch_ = globalThis.fetch.bind(globalThis);
  const writes: Record<string, number> = {};
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (
      new URL(url, location.href).pathname === "/terrain-editor/api/document" &&
      init?.method === "POST"
    ) {
      const transaction = JSON.parse(String(init.body));
      const stroke = transaction.commands?.find(
        (command: { layer?: { name?: string; id?: string } }) =>
          command.layer?.name === "Sculpt stroke",
      )?.layer;
      if (!stroke || transaction.commands.length !== 1)
        throw new Error("Conflict fixture expected one sculpt intent");
      // Distinct brush positions identify intents even when discard lets a layer ID be reused.
      const intent = JSON.stringify(stroke);
      writes[intent] = (writes[intent] ?? 0) + 1;
      document.body.dataset.commitWrites = JSON.stringify(writes);
      // Refuse the first two intents twice; the explicit retry and later sibling may save.
      const refuse = Object.keys(writes).indexOf(intent) < 2 && writes[intent] <= 2;
      const response = await fetch_(input, {
        ...init,
        body: JSON.stringify(
          refuse ? { ...transaction, baseRevision: "stale-durability-fixture" } : transaction,
        ),
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
