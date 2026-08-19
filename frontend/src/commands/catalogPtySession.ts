// pty.session.* commands — headless PTY sessions as a registry surface.
// Fills substrate gap D1 (ARCHITECTURE §5) on the command axis: any consumer (CLI, MCP,
// native-runtime plugin) can own a daemon-backed PTY session that has no view. The core
// owns the byte consumer: it drains output, acks flow control (the daemon pauses at the
// unacked high watermark otherwise), and keeps a bounded raw tail ring. The core never
// interprets the bytes — readers strip/parse on their side.

import { moduleState } from "../lib/moduleState";
import { createStream, invoke } from "../framework";
import { register, type CommandBrokerSpec, type CommandMachineObjectSchema } from "./registry";
import { currentWindowLabel } from "../lib/webviewLabels";
import { tmsg, key} from "../i18n";
import { BoundedTextTail } from "./ptyOutputTail";

// broker = the plugin call permission contract (pluginCallable). This surface exists for native
// runtime plugins (view-less session owners), so every command opens a broker. danger pairs with
// the required permission.
const brokerOf = (
  permissions: CommandBrokerSpec["permissions"],
  result: CommandMachineObjectSchema,
): CommandBrokerSpec => ({
  permissions,
  contracts: { requires: [], provides: [] },
  authority: [],
  result,
});

const RING_CAP_BYTES = 256 * 1024;
const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;

interface SessionState {
  id: number;
  tail: BoundedTextTail;
  bytesSeen: number;
  decoder: TextDecoder;
  spawnedAt: number;
}

// window-scoped: each workspace window registers its own catalog, and daemon sessions are
// keyed by (window label, session id) — the module map mirrors that scope naturally.
// Outside the hot-swap boundary — a replaced map would stay empty: the filling side has already
// recorded the fill and does not fill again.
const sessions = moduleState("commands/catalogPtySession#sessions", () => new Map<string, SessionState>());
function invalid(message: string) {
  return { ok: false as const, code: "INVALID_PARAMS" as const, message };
}

function sessionOf(p: Record<string, unknown>): string | null {
  return typeof p.session === "string" && p.session ? p.session : null;
}

export function registerPtySessionCatalog(): void {
  register("pty.session.spawn", {
    description: key("cmd.pty.session.spawn.desc"),
    triggers: { ko: "헤드리스 터미널 세션 생성 재부착" },
    params: {
      session: { type: "string", required: true, description: key("cmd.pty.session.spawn.param.session") },
      cwd: { type: "string", required: false, description: key("cmd.pty.session.spawn.param.cwd") },
      shell: { type: "string", required: false, description: key("cmd.pty.session.spawn.param.shell") },
      cols: { type: "number", required: false, description: key("cmd.pty.session.spawn.param.cols") },
      rows: { type: "number", required: false, description: key("cmd.pty.session.spawn.param.rows") },
      replayFromSeq: {
        type: "number",
        required: false,
        description: key("cmd.pty.session.spawn.param.replayFromSeq"),
      },
    },
    danger: "inject",
    broker: brokerOf(["commands", "commands:inject"], {
      type: "object",
      properties: { session: { type: "string" }, attached: { type: "boolean" } },
      required: ["session", "attached"],
      additionalProperties: false,
    }),
    returns: "{ session, attached }",
    message: () => tmsg("msg.pty.session.spawn"),
    errors: ["INVALID_PARAMS", "INTERNAL"],
    examples: ['pty.session.spawn \'{"session":"agent-k3f9a2-1","cwd":"<local-evidence>"}\''],
    handler: async (p) => {
      const session = sessionOf(p);
      if (!session) return invalid(tmsg("msg.pty.session.sessionRequired"));
      if (sessions.has(session)) {
        return { ok: false as const, code: "INVALID_PARAMS" as const, message: tmsg("msg.pty.session.alreadyAttached", { session }) };
      }
      const st: SessionState = {
        id: 0,
        tail: new BoundedTextTail(RING_CAP_BYTES),
        bytesSeen: 0,
        decoder: new TextDecoder(),
        spawnedAt: Date.now(),
      };
      const onOutput = createStream<ArrayBuffer>();
      onOutput.onmessage = (m) => {
        const bytes = new Uint8Array(m);
        const text = st.decoder.decode(bytes, { stream: true });
        st.bytesSeen += bytes.byteLength;
        st.tail.append(text);
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
        paneId: session, // Argument name at the core boundary (pty.rs) — the value is a session id
        windowLabel: currentWindowLabel() || null,
        replay: replayFromSeq == null ? "none" : { fromSeq: replayFromSeq },
        onOutput,
      })) as { id: number };
      st.id = res.id;
      sessions.set(session, st);
      return { session, attached: replayFromSeq != null };
    },
  });

  register("pty.session.write", {
    description: key("cmd.pty.session.write.desc"),
    triggers: { ko: "헤드리스 세션 입력 쓰기" },
    params: {
      session: { type: "string", required: true, description: key("cmd.pty.session.write.param.session") },
      data: { type: "string", required: true, description: key("cmd.pty.session.write.param.data") },
    },
    danger: "inject",
    broker: brokerOf(["commands", "commands:inject"], {
      type: "object",
      properties: { session: { type: "string" }, bytes: { type: "number" } },
      required: ["session", "bytes"],
      additionalProperties: false,
    }),
    returns: "{ session, bytes }",
    message: () => tmsg("msg.pty.session.write"),
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND"],
    examples: ['pty.session.write \'{"session":"agent-k3f9a2-1","data":"ls\\r"}\''],
    handler: async (p) => {
      const session = sessionOf(p);
      const data = typeof p.data === "string" ? p.data : null;
      if (!session || data == null) return invalid(tmsg("msg.pty.session.writeParamsRequired"));
      const st = sessions.get(session);
      if (!st) {
        return { ok: false as const, code: "TARGET_NOT_FOUND" as const, message: tmsg("msg.pty.session.notFound", { session }) };
      }
      await invoke("write_terminal", { id: st.id, data });
      return { session, bytes: new TextEncoder().encode(data).byteLength };
    },
  });

  register("pty.session.read", {
    description: key("cmd.pty.session.read.desc"),
    triggers: { ko: "헤드리스 세션 출력 읽기" },
    params: {
      session: { type: "string", required: true, description: key("cmd.pty.session.read.param.session") },
      lines: { type: "number", required: false, description: key("cmd.pty.session.read.param.lines") },
    },
    broker: brokerOf(["commands"], {
      type: "object",
      properties: {
        session: { type: "string" },
        tail: { type: "string" },
        bytesSeen: { type: "number" },
        capacityBytes: { type: "number" },
        retainedBytes: { type: "number" },
        droppedBytes: { type: "number" },
      },
      required: ["session", "tail", "bytesSeen", "capacityBytes", "retainedBytes", "droppedBytes"],
      additionalProperties: false,
    }),
    returns: "{ session, tail, bytesSeen, capacityBytes, retainedBytes, droppedBytes }",
    message: () => tmsg("msg.pty.session.read"),
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND"],
    examples: ['pty.session.read \'{"session":"agent-k3f9a2-1","lines":200}\''],
    handler: async (p) => {
      const session = sessionOf(p);
      if (!session) return invalid(tmsg("msg.pty.session.sessionRequired"));
      const st = sessions.get(session);
      if (!st) {
        return { ok: false as const, code: "TARGET_NOT_FOUND" as const, message: tmsg("msg.pty.session.notFound", { session }) };
      }
      let tail = st.tail.text();
      if (typeof p.lines === "number" && p.lines > 0) {
        tail = tail.split("\n").slice(-p.lines).join("\n");
      }
      return { session, tail, bytesSeen: st.bytesSeen, ...st.tail.state() };
    },
  });

  register("pty.session.alive", {
    description: key("cmd.pty.session.alive.desc"),
    triggers: { ko: "헤드리스 세션 생존 확인" },
    params: { session: { type: "string", required: true, description: key("cmd.pty.session.alive.param.session") } },
    broker: brokerOf(["commands"], {
      type: "object",
      properties: {
        session: { type: "string" },
        alive: { type: "boolean" },
        attached: { type: "boolean" },
      },
      required: ["session", "alive", "attached"],
      additionalProperties: false,
    }),
    returns: "{ session, alive, attached }",
    message: () => tmsg("msg.pty.session.alive"),
    errors: ["INVALID_PARAMS"],
    examples: ['pty.session.alive \'{"session":"agent-k3f9a2-1"}\''],
    handler: async (p) => {
      const session = sessionOf(p);
      if (!session) return invalid(tmsg("msg.pty.session.sessionRequired"));
      const alive = (await invoke("pty_pane_alive", { paneId: session })) as boolean;
      return { session, alive, attached: sessions.has(session) };
    },
  });

  register("pty.session.kill", {
    description: key("cmd.pty.session.kill.desc"),
    triggers: { ko: "헤드리스 세션 종료" },
    params: { session: { type: "string", required: true, description: key("cmd.pty.session.kill.param.session") } },
    danger: "destructive",
    broker: brokerOf(["commands", "commands:destructive"], {
      type: "object",
      properties: { session: { type: "string" } },
      required: ["session"],
      additionalProperties: false,
    }),
    returns: "{ session }",
    message: () => tmsg("msg.pty.session.kill"),
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND"],
    examples: ['pty.session.kill \'{"session":"agent-k3f9a2-1"}\''],
    handler: async (p) => {
      const session = sessionOf(p);
      if (!session) return invalid(tmsg("msg.pty.session.sessionRequired"));
      const st = sessions.get(session);
      if (!st) {
        return { ok: false as const, code: "TARGET_NOT_FOUND" as const, message: tmsg("msg.pty.session.notFound", { session }) };
      }
      sessions.delete(session);
      await invoke("close_terminal", { id: st.id });
      return { session };
    },
  });

  register("pty.session.list", {
    description: key("cmd.pty.session.list.desc"),
    triggers: { ko: "헤드리스 세션 목록" },
    params: {},
    broker: brokerOf(["commands"], {
      type: "object",
      properties: {
        sessions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              session: { type: "string" },
              bytesSeen: { type: "number" },
              spawnedAt: { type: "number" },
            },
            required: ["session", "bytesSeen", "spawnedAt"],
            additionalProperties: false,
          },
        },
      },
      required: ["sessions"],
      additionalProperties: false,
    }),
    returns: "{ sessions: [{session, bytesSeen, spawnedAt}] }",
    message: () => tmsg("msg.pty.session.list"),
    errors: [],
    examples: ["pty.session.list"],
    handler: async () => ({
      sessions: [...sessions.entries()].map(([session, st]) => ({
        session,
        bytesSeen: st.bytesSeen,
        spawnedAt: st.spawnedAt,
      })),
    }),
  });
}
