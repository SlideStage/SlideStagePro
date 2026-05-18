const deckMutationChains = new Map<string, Promise<void>>();

export async function acquireDeckMutationLock(deckId: string): Promise<() => void> {
  const previous = deckMutationChains.get(deckId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  deckMutationChains.set(deckId, current);

  await previous.catch(() => undefined);

  return () => {
    release();
    if (deckMutationChains.get(deckId) === current) {
      deckMutationChains.delete(deckId);
    }
  };
}
