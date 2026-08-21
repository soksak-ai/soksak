export interface CompositionChange {
  previousGeneration: number;
  generation: number;
}

export interface PluginCompositionEventHandler {
  (change: CompositionChange): Promise<void>;
  generation(): number;
}

export function createPluginCompositionEventHandler(
  reload: () => Promise<void>,
  initialGeneration: number,
): PluginCompositionEventHandler {
  let applied = initialGeneration;
  let pending = initialGeneration;
  let running: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    while (pending > applied) {
      const target = pending;
      await reload();
      applied = target;
    }
  };

  const handler = (async (change: CompositionChange): Promise<void> => {
    if (!Number.isSafeInteger(change.generation) || change.generation <= applied) return;
    pending = Math.max(pending, change.generation);
    if (running === null) {
      running = drain().finally(() => { running = null; });
    }
    await running;
  }) as PluginCompositionEventHandler;
  handler.generation = () => applied;
  return handler;
}
