export interface SettingsChange { previousRevision: number; revision: number }
export interface SettingsEventHandler { (change: SettingsChange): Promise<void>; revision(): number }

export function createSettingsEventHandler(reload: () => Promise<void>, initialRevision: number): SettingsEventHandler {
  let applied = initialRevision;
  let pending = initialRevision;
  let running: Promise<void> | null = null;
  const drain = async (): Promise<void> => { while (pending > applied) { const target = pending; await reload(); applied = target; } };
  const handler = (async (change: SettingsChange): Promise<void> => {
    if (!Number.isSafeInteger(change.revision) || change.revision <= applied) return;
    pending = Math.max(pending, change.revision);
    if (running === null) running = drain().finally(() => { running = null; });
    await running;
  }) as SettingsEventHandler;
  handler.revision = () => applied;
  return handler;
}
