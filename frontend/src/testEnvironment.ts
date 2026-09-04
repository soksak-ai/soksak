import { afterEach, beforeEach } from "vitest";
import { setPlaneBox } from "./state/planeBox";
import { FIXTURE_BOX } from "./test/planes";

export {};

// Every test lays panes out in one plane box. The host measures it in the app; here nothing does,
// and a plane of 0×0 refuses every split at the floor.
beforeEach(() => setPlaneBox(FIXTURE_BOX));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

if (typeof window !== "undefined") {
  const intervals = new Set<number>();
  const setInterval = window.setInterval.bind(window);
  const clearInterval = window.clearInterval.bind(window);
  window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const id = setInterval(handler, timeout, ...args);
    intervals.add(id);
    return id;
  }) as typeof window.setInterval;
  window.clearInterval = ((id?: number) => {
    if (id !== undefined) intervals.delete(id);
    clearInterval(id);
  }) as typeof window.clearInterval;
  afterEach(() => {
    for (const id of intervals) clearInterval(id);
    intervals.clear();
  });

  Object.defineProperty(window, "chrome", {
    configurable: true,
    writable: true,
    value: { webview: { postMessage: () => {} } },
  });
  Object.defineProperty(window, "_wails", {
    configurable: true,
    writable: true,
    value: { environment: { OS: "darwin", Arch: "arm64" } },
  });
}
