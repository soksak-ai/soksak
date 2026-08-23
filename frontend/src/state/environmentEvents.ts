export interface EnvironmentChange { previousRevision: number; revision: number }
export interface EnvironmentEventHandler { (change: EnvironmentChange): Promise<void>; revision(): number }

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
