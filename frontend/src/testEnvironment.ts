export {};

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

if (typeof window !== "undefined") {
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
