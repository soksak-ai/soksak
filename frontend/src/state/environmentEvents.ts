export interface EnvironmentChange { previousRevision: number; revision: number }
export interface EnvironmentEventHandler { (change: EnvironmentChange): Promise<void>; revision(): number }

let activeHandler: EnvironmentEventHandler | null = null;

export function setEnvironmentEventHandler(handler: EnvironmentEventHandler): () => void {
  const previous = activeHandler;
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = previous;
  };
}

export function reconcileEnvironmentRevision(revision: number): Promise<void> {
  if (activeHandler === null) return Promise.reject(new Error("environment revision coordinator is not ready"));
  return activeHandler({ previousRevision: activeHandler.revision(), revision });
}

export function createEnvironmentEventHandler(reload: () => Promise<void>, initialRevision: number): EnvironmentEventHandler {
  let applied = initialRevision;
  let pending = initialRevision;
  let running: Promise<void> | null = null;
  const drain = async (): Promise<void> => { while (pending > applied) { const target = pending; await reload(); applied = target; } };
  const handler = (async (change: EnvironmentChange): Promise<void> => {
    if (!Number.isSafeInteger(change.revision) || change.revision <= applied) return;
    pending = Math.max(pending, change.revision);
    if (running === null) running = drain().finally(() => { running = null; });
    await running;
  }) as EnvironmentEventHandler;
  handler.revision = () => applied;
  return handler;
}
