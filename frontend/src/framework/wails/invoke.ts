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
  try {
    // Pass the arguments through as they are. The generated binding already serializes to JSON, so
    // stringifying once more here double-encodes the value — measured 2026-08-15: `"core"` arrived as
    // `"\"core\""` and failed the ns rule; the error was at this boundary, not in the store.
    return (await Control.Invoke(cmd, args ?? {})) as T;
  } catch (cause) {
    record(cmd);
    throw cause;
  }
}
