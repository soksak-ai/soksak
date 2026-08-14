import { Events } from "@wailsio/runtime";
import type { NativeSurfaceCommit } from "@soksak/wails-service-native-compositor";
import type { TerminalBinding, TerminalEvents, TerminalOutput } from "@soksak/soksak-plugin-terminal-xterm";

import * as CompositorService from "../bindings/github.com/soksak/wails-service-native-compositor/service";
import { Snapshot } from "../bindings/github.com/soksak/wails-service-native-compositor/models";
import * as TerminalService from "../bindings/github.com/soksak/soksak-plugin-terminal-xterm/service";
import { InputTrace } from "../bindings/github.com/soksak/soksak-plugin-terminal-xterm/models";

export const commitNativeSurfaceSnapshot: NativeSurfaceCommit = async (snapshot) => {
  const receipt = await CompositorService.Commit(Snapshot.createFrom(snapshot));
  document.documentElement.dataset.nativeSnapshotSequence = String(receipt.sequence);
  document.documentElement.dataset.nativeSnapshotAccepted = String(receipt.accepted);
  document.documentElement.dataset.nativeSnapshotCount = String(receipt.surfaces.length);
  return receipt;
};

export const terminalBinding: TerminalBinding = {
  open: (id, cols, rows) => TerminalService.Open(id, cols, rows),
  write: (handle, data) => TerminalService.Write(handle, data),
  resize: (handle, cols, rows) => TerminalService.Resize(handle, cols, rows),
  close: (handle) => TerminalService.Close(handle),
  traceInput: (handle, event) => TerminalService.TraceInput(handle, InputTrace.createFrom(event)),
};

export const terminalEvents: TerminalEvents = {
  onOutput(callback) {
    return Events.On("terminal:output", (event) => callback(event.data as TerminalOutput));
  },
};
