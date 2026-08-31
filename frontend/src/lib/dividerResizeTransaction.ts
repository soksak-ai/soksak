export interface DividerResizeTransaction<T> {
  submit(value: T): void;
  drain(): Promise<void>;
}

/** Serializes native preparation and retains only the latest pending pointer value. */
export function createDividerResizeTransaction<T>(options: {
  beforeStage?(): Promise<void>;
  stage(value: T): Promise<void>;
  apply(value: T): void;
}): DividerResizeTransaction<T> {
  let pending: T | undefined;
  let running = false;
  let work: Promise<void> = Promise.resolve();

  const start = () => {
    if (running) return;
    running = true;
    work = (async () => {
      try {
        while (pending !== undefined) {
          const value = pending;
          pending = undefined;
          await options.beforeStage?.();
          await options.stage(value);
          options.apply(value);
        }
      } finally {
        running = false;
      }
    })();
  };

  return {
    submit(value) {
      pending = value;
      start();
    },
    drain: () => work,
  };
}
