import { execute } from "../commands/registry";
import { listenThisWindow } from "./windowEvents";

export interface NativeCloseRequest {
  window: string;
  sequence: number;
  atUnixMs: number;
}

export async function handleNativeCloseRequest(
  request: NativeCloseRequest,
  run: typeof execute = execute,
): Promise<void> {
  if (!request || typeof request.window !== "string" || request.window === "" ||
      !Number.isSafeInteger(request.sequence) || request.sequence < 1 ||
      !Number.isFinite(request.atUnixMs)) {
    throw new Error("native close request is invalid");
  }
  const outcome = await run("window.close", {}, {});
  if (!outcome.ok) {
    throw new Error(`native close request failed: ${outcome.code}`);
  }
}

export async function initNativeCloseRequests(): Promise<() => void> {
  const subscription = listenThisWindow<NativeCloseRequest>(windowNativeCloseEvent, (event) => {
    void handleNativeCloseRequest(event.payload).catch((error) => {
      console.error("native close request failed:", error);
    });
  });
  await subscription.ready;
  return subscription;
}

export const windowNativeCloseEvent = "window.native-close-requested";
