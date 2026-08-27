export interface CapturePresentation {
  ordered: boolean;
}

interface CapturePrepareDetail {
  waitUntil(promise: Promise<void>): void;
}

const CAPTURE_PREPARE_LIMIT_MS = 5_000;

async function prepareRenderers(root: Window): Promise<void> {
  const pending: Promise<void>[] = [];
  const detail: CapturePrepareDetail = {
    waitUntil(promise) { pending.push(Promise.resolve(promise)); },
  };
  root.dispatchEvent(new CustomEvent("soksak:capture-prepare", { detail }));
  if (pending.length === 0) return;
  let expiry = 0;
  try {
    await Promise.race([
      Promise.all(pending),
      new Promise<never>((_, reject) => {
        expiry = root.setTimeout(
          () => reject(new Error(`capture renderers did not settle within ${CAPTURE_PREPARE_LIMIT_MS}ms`)),
          CAPTURE_PREPARE_LIMIT_MS,
        );
      }),
    ]);
  } finally {
    root.clearTimeout(expiry);
  }
}

export async function captureAfterPresentation<T>(
  root: Window,
  present: () => Promise<CapturePresentation>,
  capture: () => Promise<T>,
  restore: (presentation: CapturePresentation) => Promise<void>,
): Promise<T> {
  const presentation = await present();
  try {
    await prepareRenderers(root);
    return await capture();
  } finally {
    await restore(presentation);
  }
}
