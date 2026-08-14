// PTY observation parser — parses shell integration OSC sequences straight from raw PTY output
// (no dependency on the xterm Terminal).
//
// [PRINCIPLE] Observation (cwd, command start/finish) is terminal-protocol level = a general
// substrate, not a terminal-feature view. So anyone streaming PTY bytes (a terminal plugin, for
// example) gets the same observations by feeding output into this parser. The OSC parsing
// semantics (OSC 7 / 133 / 633) that depended on xterm's parser.registerOscHandler were moved into
// a byte-stream parser.
//
// Parsed:
//   - OSC 7  : file URI → cwd
//   - OSC 133: A prompt start / D;exit command finish (standard semantic prompt)
//   - OSC 633: A/D identical, cwd via P;Cwd=, command line via E;<percent-encoded>
// Terminators: BEL(0x07) or ST(ESC '\\').

export interface PtyObservationCallbacks {
  /** Notified only when cwd actually changes (OSC 7 / 633;P). */
  onCwd?: (cwd: string) => void;
  /** Command start (OSC 633;E — the command line reported by shell preexec). */
  onCommandStart?: (commandLine: string) => void;
  /** Command finish (OSC 133/633 D). exitCode = the exit code from D;<code> (undefined when absent or non-numeric). */
  onCommandFinished?: (exitCode?: number) => void;
}

export interface PtyObservationParser {
  /** Feeds a PTY output chunk (string or raw bytes). OSC accumulates across chunk boundaries. */
  write: (chunk: string | Uint8Array) => void;
  /** Current cwd snapshot (undefined when unconfirmed). */
  getCwd: () => string | undefined;
}

const BEL = 0x07;
const ESC = 0x1b;

// OSC payload accumulation state machine. Enter on ESC ], collect the body until BEL or ESC \.
// Non-OSC ESC sequences (CSI and such) pass through — only OSC is observed.
type State = "text" | "esc" | "osc" | "osc-esc";

export function createPtyObservationParser(
  cb: PtyObservationCallbacks,
): PtyObservationParser {
  const decoder = new TextDecoder("utf-8");
  let state: State = "text";
  let osc = "";
  let cwd: string | undefined;

  const setCwd = (next: string) => {
    if (!next || next === cwd) return;
    cwd = next;
    cb.onCwd?.(next);
  };

  const setCwdFromUri = (uri: string) => {
    // file://host/path → path
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(uri);
    if (!m) return;
    let path: string;
    try {
      path = decodeURIComponent(m[1]);
    } catch {
      path = m[1];
    }
    setCwd(path);
  };

  // Handles the accumulated OSC body (number excluded) — same semantics as the shellIntegration.ts handler.
  const handleOsc = (data: string) => {
    const numEnd = data.indexOf(";");
    const num = numEnd === -1 ? data : data.slice(0, numEnd);
    const body = numEnd === -1 ? "" : data.slice(numEnd + 1);

    if (num === "7") {
      setCwdFromUri(body);
      return;
    }
    if (num === "133" || num === "633") {
      const semi = body.indexOf(";");
      const cmd = semi === -1 ? body : body.slice(0, semi);
      const rest = semi === -1 ? "" : body.slice(semi + 1);
      if (cmd === "D") {
        // D;<exitcode> — parse the exit code (undefined when absent or non-numeric). The exitCode of the R2 block.
        const code = rest === "" ? undefined : Number.parseInt(rest, 10);
        cb.onCommandFinished?.(Number.isNaN(code as number) ? undefined : code);
      } else if (num === "633" && cmd === "P") {
        const m = /Cwd=([^;]*)/.exec(rest);
        if (m) setCwd(m[1]);
      } else if (num === "633" && cmd === "E") {
        let line: string;
        try {
          line = decodeURIComponent(rest);
        } catch {
          line = rest;
        }
        if (line) cb.onCommandStart?.(line);
      }
      // cmd === "A" (prompt start) and the rest are not observed — ignore.
    }
  };

  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      switch (state) {
        case "text":
          if (c === ESC) state = "esc";
          break;
        case "esc":
          // ESC ] = enter OSC. For the rest (CSI '[' and such) returning to text after one
          // character is fine — not OSC, so not observed, and the following bytes go through the
          // normal flow.
          if (c === 0x5d /* ] */) {
            state = "osc";
            osc = "";
          } else {
            state = "text";
          }
          break;
        case "osc":
          if (c === BEL) {
            handleOsc(osc);
            osc = "";
            state = "text";
          } else if (c === ESC) {
            // ST candidate (ESC \) — terminate when the next character is '\'.
            state = "osc-esc";
          } else {
            osc += s[i];
          }
          break;
        case "osc-esc":
          if (c === 0x5c /* \\ */) {
            handleOsc(osc);
            osc = "";
            state = "text";
          } else {
            // The ESC was not ST — absorb ESC and the current character into the body and continue
            // the OSC. (A lone ESC inside an OSC body is rare in practice; handled safely anyway.)
            osc += "\x1b" + s[i];
            state = "osc";
          }
          break;
      }
    }
  };

  return {
    write: (chunk) => {
      const s =
        typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      feed(s);
    },
    getCwd: () => cwd,
  };
}
