export type TerminalHostFacts = {
  isConnected: boolean;
  clientWidth: number;
  clientHeight: number;
};

type RequestFrame = (callback: FrameRequestCallback) => number;

export function isRenderableTerminalHost(host: TerminalHostFacts): boolean {
  return host.isConnected && host.clientWidth > 0 && host.clientHeight > 0;
}

export function createTerminalMountScheduler(requestFrame: RequestFrame) {
  let disposed = false;
  return {
    afterPaint(task: () => void) {
      requestFrame(() => {
        if (!disposed) task();
      });
    },
    dispose() {
      disposed = true;
    },
  };
}
