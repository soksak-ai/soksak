// pty.session.* commands — headless PTY sessions as a registry surface.
// Fills substrate gap D1 (ARCHITECTURE §5) on the command axis: any consumer (CLI, MCP,
// native-runtime plugin) can own a daemon-backed PTY session that has no view. The core
// owns the byte consumer: it drains output, acks flow control (the daemon pauses at the
// unacked high watermark otherwise), and keeps a bounded raw tail ring. The core never
// interprets the bytes — readers strip/parse on their side.

import { Channel, invoke } from "@tauri-apps/api/core";
import { register } from "./registry";
import { currentWindowLabel } from "../lib/webviewLabels";

const RING_CAP_BYTES = 256 * 1024;
const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;

interface SessionState {
  id: number;
  ring: string[];
  ringBytes: number;
  bytesSeen: number;
  decoder: TextDecoder;
  spawnedAt: number;
}

// window-scoped: each workspace window registers its own catalog, and daemon sessions are
// keyed by (window label, pane id) — the module map mirrors that scope naturally.
const sessions = new Map<string, SessionState>();

function invalid(message: string) {
  return { ok: false as const, code: "INVALID_PARAMS" as const, message };
}

function paneOf(p: Record<string, unknown>): string | null {
  return typeof p.pane === "string" && p.pane ? p.pane : null;
}

export function registerPtySessionCatalog(): void {
  register("pty.session.spawn", {
    description:
      "Spawn (or warm-reattach) a headless daemon-backed PTY session under a caller-chosen pane id. No view is created; the core drains and acks output into a bounded raw tail readable via pty.session.read. Respawning the same pane id reattaches to the still-running shell; pass replayFromSeq to skip ring replay up to a sequence already consumed.",
    triggers: { ko: "헤드리스 터미널 세션 생성 재부착" },
    params: {
      pane: { type: "string", required: true, description: "Caller-owned session pane id" },
      cwd: { type: "string", required: false, description: "Working directory" },
      shell: { type: "string", required: false, description: "Shell binary (default: user shell)" },
      cols: { type: "number", required: false, description: "Columns (default 200)" },
      rows: { type: "number", required: false, description: "Rows (default 50)" },
      replayFromSeq: {
        type: "number",
        required: false,
        description: "Warm-reattach: attach the daemon ring from this sequence",
      },
    },
    danger: "inject",
    returns: "{ pane, attached }",
    message: (d) => `headless session ${d.pane} ${d.attached ? "attached" : "spawned"}`,
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['pty.session.spawn \'{"pane":"agent-k3f9a2-1","cwd":"/tmp"}\''],
    handler: async (p) => {
      const pane = paneOf(p);
      if (!pane) return invalid("pane 필요");
      if (sessions.has(pane)) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: `already attached: ${pane}` };
      }
      const st: SessionState = {
        id: 0,
        ring: [],
        ringBytes: 0,
        bytesSeen: 0,
        decoder: new TextDecoder(),
        spawnedAt: Date.now(),
      };
      const onOutput = new Channel<ArrayBuffer>();
      onOutput.onmessage = (m) => {
        const bytes = new Uint8Array(m);
        const text = st.decoder.decode(bytes, { stream: true });
        st.bytesSeen += bytes.byteLength;
        if (text) {
          st.ring.push(text);
          st.ringBytes += text.length;
          while (st.ringBytes > RING_CAP_BYTES && st.ring.length > 1) {
            st.ringBytes -= st.ring.shift()!.length;
          }
        }
        // Core-owned flow control: ack exactly what was drained so the daemon reader
        // never pauses at the high watermark for a session nobody renders.
        void invoke("ack_terminal", { id: st.id, bytes: bytes.byteLength }).catch(() => {});
      };
      const replayFromSeq = typeof p.replayFromSeq === "number" ? p.replayFromSeq : null;
      const res = (await invoke("spawn_terminal", {
        cols: typeof p.cols === "number" ? p.cols : DEFAULT_COLS,
        rows: typeof p.rows === "number" ? p.rows : DEFAULT_ROWS,
        cwd: typeof p.cwd === "string" ? p.cwd : null,
        shell: typeof p.shell === "string" ? p.shell : null,
        paneId: pane,
        windowLabel: currentWindowLabel() || null,
        replay: replayFromSeq == null ? "none" : { fromSeq: replayFromSeq },
        onOutput,
      })) as { id: number };
      st.id = res.id;
      sessions.set(pane, st);
      return { pane, attached: replayFromSeq != null };
    },
  });

  register("pty.session.write", {
    description:
      "Write raw bytes (text) to a headless PTY session created by pty.session.spawn.",
    triggers: { ko: "헤드리스 세션 입력 쓰기" },
    params: {
      pane: { type: "string", required: true, description: "Session pane id" },
      data: { type: "string", required: true, description: "Raw text to write" },
    },
    danger: "inject",
    returns: "{ pane, bytes }",
    message: (d) => `wrote ${d.bytes} byte(s) to ${d.pane}`,
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND"],
    examples: ['pty.session.write \'{"pane":"agent-k3f9a2-1","data":"ls\\r"}\''],
    handler: async (p) => {
      const pane = paneOf(p);
      const data = typeof p.data === "string" ? p.data : null;
      if (!pane || data == null) return invalid("pane, data 필요");
      const st = sessions.get(pane);
      if (!st) {
        return { ok: false as const, code: "TARGET_NOT_FOUND" as const, message: `no session: ${pane}` };
      }
      await invoke("write_terminal", { id: st.id, data });
      return { pane, bytes: data.length };
    },
  });

  register("pty.session.read", {
    description:
      "Read the raw output tail of a headless PTY session (bounded ring, ANSI included — the reader interprets). Returns the tail joined and the total bytes seen as a resume cursor.",
    triggers: { ko: "헤드리스 세션 출력 읽기" },
    params: {
      pane: { type: "string", required: true, description: "Session pane id" },
      lines: { type: "number", required: false, description: "Trailing lines to keep (default all buffered)" },
    },
    returns: "{ pane, tail, bytesSeen }",
    message: (d) => `read tail of ${d.pane}`,
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND"],
    examples: ['pty.session.read \'{"pane":"agent-k3f9a2-1","lines":200}\''],
    handler: async (p) => {
      const pane = paneOf(p);
      if (!pane) return invalid("pane 필요");
      const st = sessions.get(pane);
      if (!st) {
        return { ok: false as const, code: "TARGET_NOT_FOUND" as const, message: `no session: ${pane}` };
      }
      let tail = st.ring.join("");
      if (typeof p.lines === "number" && p.lines > 0) {
        tail = tail.split("\n").slice(-p.lines).join("\n");
      }
      return { pane, tail, bytesSeen: st.bytesSeen };
    },
  });

  register("pty.session.alive", {
    description:
      "Report whether the PTY daemon still holds a live shell for this pane id — true even across an app restart before anything reattaches. Distinct from being attached in this window (see pty.session.list).",
    triggers: { ko: "헤드리스 세션 생존 확인" },
    params: { pane: { type: "string", required: true, description: "Session pane id" } },
    returns: "{ pane, alive, attached }",
    message: (d) => `${d.pane}: ${d.alive ? "alive" : "gone"}`,
    errors: ["INVALID_PARAMS"],
    examples: ['pty.session.alive \'{"pane":"agent-k3f9a2-1"}\''],
    handler: async (p) => {
      const pane = paneOf(p);
      if (!pane) return invalid("pane 필요");
      const alive = (await invoke("pty_pane_alive", { paneId: pane })) as boolean;
      return { pane, alive, attached: sessions.has(pane) };
    },
  });

  register("pty.session.kill", {
    description: "Close a headless PTY session and its daemon shell.",
    triggers: { ko: "헤드리스 세션 종료" },
    params: { pane: { type: "string", required: true, description: "Session pane id" } },
    danger: "destructive",
    returns: "{ pane }",
    message: (d) => `session ${d.pane} closed`,
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND"],
    examples: ['pty.session.kill \'{"pane":"agent-k3f9a2-1"}\''],
    handler: async (p) => {
      const pane = paneOf(p);
      if (!pane) return invalid("pane 필요");
      const st = sessions.get(pane);
      if (!st) {
        return { ok: false as const, code: "TARGET_NOT_FOUND" as const, message: `no session: ${pane}` };
      }
      sessions.delete(pane);
      await invoke("close_terminal", { id: st.id });
      return { pane };
    },
  });

  register("pty.session.list", {
    description: "List headless PTY sessions attached in this window.",
    triggers: { ko: "헤드리스 세션 목록" },
    params: {},
    returns: "{ sessions: [{pane, bytesSeen, spawnedAt}] }",
    message: (d) => `${(d.sessions as unknown[]).length} headless session(s)`,
    errors: [],
    examples: ["pty.session.list"],
    handler: async () => ({
      sessions: [...sessions.entries()].map(([pane, st]) => ({
        pane,
        bytesSeen: st.bytesSeen,
        spawnedAt: st.spawnedAt,
      })),
    }),
  });
}
