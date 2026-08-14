// Backend command invocation.
//
// One name, one registry. Frontend calls and socket calls resolve through the same table, so neither can
// take a path that answers differently from the other.

import * as Control from "../../../bindings/github.com/soksak/soksak-core/frameworks/wails/controlservice";

/** Commands refused in this boot — in order, preserving the time of the first call. */
const refused: string[] = [];

export function refusedCommands(): string[] {
  return [...refused];
}

function record(cmd: string): void {
  if (refused.includes(cmd)) return;
  refused.push(cmd);
  // When boot dies during module evaluation the exported function is unreachable. The document attribute remains.
  if (typeof document !== "undefined") {
    document.documentElement.dataset.wailsUnservedCommands = refused.join(" ");
  }
}

export async function invokeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const encoded: Record<string, string> = {};
  for (const [name, value] of Object.entries(args ?? {})) {
    // The registry types each command, so this boundary passes only the envelope.
    encoded[name] = JSON.stringify(value ?? null);
  }
  try {
    return (await Control.Invoke(cmd, encoded)) as T;
  } catch (cause) {
    record(cmd);
    throw cause;
  }
}
