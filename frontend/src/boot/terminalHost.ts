// The terminal plugin owns PTY bytes and declares the shape it needs; this file
// is the only place that knows those calls arrive as generated bindings.
import { Events } from "@wailsio/runtime";
import type { TerminalBinding, TerminalEvents, TerminalOutput } from "@soksak/soksak-plugin-terminal-xterm";

import * as TerminalService from "../../bindings/github.com/soksak/soksak-plugin-terminal-xterm/service";
import { InputTrace } from "../../bindings/github.com/soksak/soksak-plugin-terminal-xterm/models";

export const terminalHost: { binding: TerminalBinding; events: TerminalEvents; status: () => Promise<unknown> } = {
  binding: {
    open: (id, cols, rows) => TerminalService.Open(id, cols, rows),
    write: (handle, data) => TerminalService.Write(handle, data),
    resize: (handle, cols, rows) => TerminalService.Resize(handle, cols, rows),
    close: (handle) => TerminalService.Close(handle),
    traceInput: (handle, event) => TerminalService.TraceInput(handle, InputTrace.createFrom(event)),
  },
  events: {
    onOutput(callback) {
      return Events.On("terminal:output", (event) => callback(event.data as TerminalOutput));
    },
  },
  status: () => TerminalService.Status(),
};
