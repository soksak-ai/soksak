// Backend command invocation.
//
// The Go-side registry is not up yet. Record what was called in the document and reject — this list
// is what the backend must serve next. Order is preserved not because of frequency but because the order picks what is
// blocking boot. A silent undefined makes the caller believe the command ran.

const requested: string[] = [];

export function requestedCommands(): string[] {
  return [...requested];
}

export async function invokeCommand<T>(cmd: string, _args?: Record<string, unknown>): Promise<T> {
  throw new Error(`command ${cmd} is not served: the wails backend registry is not up yet`);
}
