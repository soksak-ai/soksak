// Backend command invocation.
//
// One name, one registry. Frontend calls and socket calls resolve through the same table, so neither can
// take a path that answers differently from the other.

const requested: string[] = [];

export function requestedCommands(): string[] {
  return [...requested];
}

function record(cmd: string): void {
  if (refused.includes(cmd)) return;
  refused.push(cmd);
  // When boot dies during module evaluation the exported function is unreachable. The document attribute remains.
  if (typeof document !== "undefined") {
    document.documentElement.dataset.wailsUnservedCommands = refused.join(" ");
  }
  throw new Error(`command ${cmd} is not served: the wails backend registry is not up yet`);
}
