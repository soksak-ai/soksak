// Workspace daemon commands (daemon.*) — the declaration is the workspace's Procfile (standard
// convention), soksak-specific policy such as autostart and the stop command is in the local DB
// (app.data core ns), and run/logs/cleanup are in the core singleton (daemon.rs).
// Security contract: a file committed to the repository never causes "open means run" — autostart
// starts only what the user allowed through daemon.autostart, at workspace open (supply-chain attack
// path blocked).
import { invoke } from "../framework";
import { register, type CommandContext, type CommandHint } from "./registry";
import { tmsg, key} from "../i18n";
import { useSessions } from "../state/sessions";
import { parseProcfile, removeEntry, upsertEntry, type ProcfileEntry } from "../lib/procfile";

interface DaemonPolicy {
  autostart?: Record<string, boolean>;
  stop?: Record<string, string>;
  /** Minimal record for reaping — after an abnormal exit, daemon_reap matches the command line and clears leftovers. */
  pids?: Record<string, { pid: number; cmd: string }>;
}

interface CoreDaemonStatus {
  root: string;
  name: string;
  pid: number;
  running: boolean;
  exit_code: number | null;
  uptime_ms: number;
  restarts: number;
}

const NS = "core";
const policyKey = (root: string) => `daemon/${root}`;

/** Target workspace of this window — an explicit workspace id wins, otherwise the active workspace. Daemon
 *  policy and the Procfile are keyed by root while the answer names the resolved id, so both are returned. */
function resolveTarget(
  params: Record<string, unknown>,
): { id: string; root: string } | null {
  const s = useSessions.getState();
  const t = params.workspace
    ? s.workspaces.find((x) => x.id === params.workspace)
    : (s.workspaces.find((x) => x.id === s.activeId) ?? s.workspaces[0]);
  return t?.root ? { id: t.id, root: t.root } : null;
}

async function readProcfile(root: string): Promise<{ text: string; entries: ProcfileEntry[] }> {
  try {
    const d = (await invoke("read_text_file", { path: `${root}/Procfile` })) as { content: string };
    return { text: d.content, entries: parseProcfile(d.content) };
  } catch {
    return { text: "", entries: [] };
  }
}

async function writeProcfile(root: string, text: string): Promise<void> {
  await invoke("write_text_file", { path: `${root}/Procfile`, content: text });
}

async function readPolicy(root: string): Promise<DaemonPolicy> {
  const v = (await invoke("data_kv_get", { ns: NS, key: policyKey(root) })) as DaemonPolicy | null;
  return v ?? {};
}

async function writePolicy(root: string, p: DaemonPolicy): Promise<void> {
  await invoke("data_kv_set", { ns: NS, key: policyKey(root), value: p });
}

async function coreStatus(root: string): Promise<CoreDaemonStatus[]> {
  return (await invoke("daemon_status", { root })) as CoreDaemonStatus[];
}

/** Start one daemon — record the pid in the policy (for reaping). A detached one (with stop set) differs only in being marked managed. */
async function startOne(root: string, e: ProcfileEntry, policy: DaemonPolicy): Promise<number> {
  const pid = (await invoke("daemon_start", {
    root,
    name: e.name,
    cmd: e.cmd,
    restart: null,
  })) as number;
  policy.pids = { ...(policy.pids ?? {}), [e.name]: { pid, cmd: e.cmd } };
  await writePolicy(root, policy);
  return pid;
}

const P = {
  workspace: { type: "string" as const, description: key("cmd.daemon.param.workspace") },
  name: { type: "string" as const, description: key("cmd.daemon.param.name"), required: true },
};

const noWorkspace = () => ({
  ok: false as const,
  code: "TARGET_NOT_FOUND",
  message: tmsg("msg.daemon.noWorkspace"),
});

export function registerDaemonCatalog(): void {
  register("daemon.list", {
    description: key("cmd.daemon.list.desc"),
    triggers: { ko: "데몬 목록 상시 프로세스 서버 목록" },
    params: { workspace: P.workspace },
    returns:
      "{ projectId, daemons: [{ name, cmd, running, pid?, uptimeMs?, autostart, managed, exitCode? }] }",
    message: (d) => tmsg("msg.daemon.list", { n: ((d.daemons as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["daemon.list"],
    hint: (d) => {
      const list = (d.daemons as { name: string; running: boolean; autostart: boolean }[]) ?? [];
      const idle = list.find((x) => !x.running);
      const out: CommandHint[] = [];
      if (idle)
        out.push({ cmd: `daemon.start ${idle.name}`, why: tmsg("hint.daemon.start") });
      if (list.length && list.some((x) => !x.autostart))
        out.push({ cmd: "daemon.autostart '{\"on\":true}'", why: tmsg("hint.daemon.autostart") });
      if (!list.length) out.push({ cmd: "daemon.add '{\"name\":\"dev\",\"cmd\":\"npm run dev\"}'", why: tmsg("hint.daemon.add") });
      return out;
    },
    handler: async (p) => {
      const target = resolveTarget(p);
      if (!target) return noWorkspace();
      const { id: projectId, root } = target;
      const [{ entries }, policy, status] = await Promise.all([
        readProcfile(root),
        readPolicy(root),
        coreStatus(root),
      ]);
      const daemons = entries.map((e) => {
        const st = status.find((x) => x.name === e.name);
        return {
          name: e.name,
          cmd: e.cmd,
          running: st?.running ?? false,
          pid: st?.running ? st.pid : undefined,
          uptimeMs: st?.running ? st.uptime_ms : undefined,
          exitCode: st && !st.running ? st.exit_code : undefined,
          autostart: policy.autostart?.[e.name] ?? false,
          managed: Boolean(policy.stop?.[e.name]),
        };
      });
      return { projectId, daemons };
    },
  });

  register("daemon.add", {
    description: key("cmd.daemon.add.desc"),
    triggers: { ko: "데몬 등록 추가 서버 자동 시작" },
    params: {
      name: P.name,
      cmd: { type: "string", description: key("cmd.daemon.add.param.cmd"), required: true },
      workspace: P.workspace,
    },
    returns: "{ projectId, name, cmd }",
    message: (d) => tmsg("msg.daemon.add", { name: String(d.name) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: ["daemon.add '{\"name\":\"dev\",\"cmd\":\"npm run dev\"}'"],
    hint: (d) =>
      d.code
        ? []
        : [
            { cmd: `daemon.start ${String(d.name)}`, why: tmsg("hint.daemon.start") },
            { cmd: `daemon.autostart '{"name":"${String(d.name)}","on":true}'`, why: tmsg("hint.daemon.autostart") },
          ],
    handler: async (p) => {
      const target = resolveTarget(p);
      if (!target) return noWorkspace();
      const { id: projectId, root } = target;
      const { text } = await readProcfile(root);
      const next = upsertEntry(text, p.name as string, p.cmd as string);
      await writeProcfile(root, next);
      return { projectId, name: p.name, cmd: p.cmd };
    },
  });

  register("daemon.remove", {
    danger: "destructive",
    description: key("cmd.daemon.remove.desc"),
    triggers: { ko: "데몬 제거 삭제" },
    params: { name: P.name, workspace: P.workspace },
    returns: "{ projectId, name, removed }",
    message: (d) => tmsg("msg.daemon.remove", { name: String(d.name) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["daemon.remove dev"],
    handler: async (p) => {
      const target = resolveTarget(p);
      if (!target) return noWorkspace();
      const { id: projectId, root } = target;
      const name = p.name as string;
      await invoke("daemon_stop", { root, name });
      const { text } = await readProcfile(root);
      const r = removeEntry(text, name);
      if (!r.removed)
        return { ok: false as const, code: "TARGET_NOT_FOUND", message: tmsg("msg.daemon.unknown", { name }) };
      await writeProcfile(root, r.text);
      const policy = await readPolicy(root);
      if (policy.autostart) delete policy.autostart[name];
      if (policy.stop) delete policy.stop[name];
      if (policy.pids) delete policy.pids[name];
      await writePolicy(root, policy);
      return { projectId, name, removed: true };
    },
  });

  register("daemon.start", {
    description: key("cmd.daemon.start.desc"),
    triggers: { ko: "데몬 시작 서버 시작 기동" },
    params: { name: { ...P.name, required: false }, workspace: P.workspace },
    // The owner fixes the answer — it is the same from any window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ projectId, started: [{ name, pid }] }",
    primary: "name",
    message: (d) => tmsg("msg.daemon.start", { n: ((d.started as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ["daemon.start dev", "daemon.start"],
    hint: (d) => {
      const started = (d.started as { name: string }[]) ?? [];
      return started.length
        ? [{ cmd: `daemon.logs ${started[0].name}`, why: tmsg("hint.daemon.logs") }]
        : [];
    },
    handler: async (p) => {
      const target = resolveTarget(p);
      if (!target) return noWorkspace();
      const { id: projectId, root } = target;
      const { entries } = await readProcfile(root);
      const policy = await readPolicy(root);
      const status = await coreStatus(root);
      const targets = p.name
        ? entries.filter((e) => e.name === p.name)
        : entries.filter((e) => !status.find((s) => s.name === e.name)?.running);
      if (p.name && !targets.length)
        return { ok: false as const, code: "TARGET_NOT_FOUND", message: tmsg("msg.daemon.unknown", { name: String(p.name) }) };
      const started = [];
      for (const e of targets) {
        started.push({ name: e.name, pid: await startOne(root, e, policy) });
      }
      return { projectId, started };
    },
  });

  register("daemon.stop", {
    description: key("cmd.daemon.stop.desc"),
    triggers: { ko: "데몬 정지 서버 정지 중지" },
    params: { name: { ...P.name, required: false }, workspace: P.workspace },
    // The owner fixes the answer — it is the same from any window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ projectId, stopped: [name] }",
    primary: "name",
    message: (d) => tmsg("msg.daemon.stop", { n: ((d.stopped as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ["daemon.stop dev", "daemon.stop"],
    handler: async (p) => {
      const target = resolveTarget(p);
      if (!target) return noWorkspace();
      const { id: projectId, root } = target;
      const policy = await readPolicy(root);
      const name = p.name as string | undefined;
      const stopped: string[] = [];
      // A managed daemon (with a stop command set) is brought down by that command — for tools whose start and stop are asymmetric.
      const managed = Object.entries(policy.stop ?? {}).filter(([n]) => !name || n === name);
      for (const [n, stopCmd] of managed) {
        await invoke("daemon_run_once", { root, cmd: stopCmd, timeoutSecs: 60 });
        stopped.push(n);
      }
      const rest = (await invoke("daemon_stop", { root, name: name ?? null })) as string[];
      stopped.push(...rest.filter((n) => !stopped.includes(n)));
      return { projectId, stopped };
    },
  });

  register("daemon.restart", {
    description: key("cmd.daemon.restart.desc"),
    triggers: { ko: "데몬 재시작" },
    params: { name: P.name, workspace: P.workspace },
    returns: "{ projectId, name, pid }",
    message: (d) => tmsg("msg.daemon.restart", { name: String(d.name) }),
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ["daemon.restart dev"],
    handler: async (p, ctx: CommandContext) => {
      void ctx;
      const target = resolveTarget(p);
      if (!target) return noWorkspace();
      const { id: projectId, root } = target;
      const name = p.name as string;
      const { entries } = await readProcfile(root);
      const e = entries.find((x) => x.name === name);
      if (!e)
        return { ok: false as const, code: "TARGET_NOT_FOUND", message: tmsg("msg.daemon.unknown", { name }) };
      const policy = await readPolicy(root);
      const stopCmd = policy.stop?.[name];
      if (stopCmd) await invoke("daemon_run_once", { root, cmd: stopCmd, timeoutSecs: 60 });
      else await invoke("daemon_stop", { root, name });
      const pid = await startOne(root, e, policy);
      return { projectId, name, pid };
    },
  });

  register("daemon.logs", {
    description: key("cmd.daemon.logs.desc"),
    triggers: { ko: "데몬 로그 출력 보기" },
    params: {
      name: P.name,
      lines: { type: "number", description: key("cmd.daemon.logs.param.lines") },
      workspace: P.workspace,
    },
    // The owner fixes the answer — it is the same from any window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ projectId, name, lines: [string] }",
    message: (d) => tmsg("msg.daemon.logs", { n: ((d.lines as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["daemon.logs dev", "daemon.logs '{\"name\":\"dev\",\"lines\":300}'"],
    handler: async (p) => {
      const target = resolveTarget(p);
      if (!target) return noWorkspace();
      const { id: projectId, root } = target;
      try {
        const lines = (await invoke("daemon_logs", {
          root,
          name: p.name,
          lines: p.lines ?? null,
        })) as string[];
        return { projectId, name: p.name, lines };
      } catch (e) {
        return { ok: false as const, code: "TARGET_NOT_FOUND", message: String(e) };
      }
    },
  });

  register("daemon.autostart", {
    description: key("cmd.daemon.autostart.desc"),
    triggers: { ko: "데몬 자동 시작 허용" },
    params: {
      name: { ...P.name, required: false },
      on: { type: "boolean", description: key("cmd.daemon.autostart.param.on"), required: true },
      workspace: P.workspace,
    },
    returns: "{ projectId, autostart: Record<name, boolean> }",
    message: (d) =>
      tmsg("msg.daemon.autostart", {
        state: tmsg((d.on as boolean) ? "msg.daemon.autostart.on" : "msg.daemon.autostart.off"),
      }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["daemon.autostart '{\"name\":\"dev\",\"on\":true}'", "daemon.autostart '{\"on\":true}'"],
    handler: async (p) => {
      const target = resolveTarget(p);
      if (!target) return noWorkspace();
      const { id: projectId, root } = target;
      const { entries } = await readProcfile(root);
      const policy = await readPolicy(root);
      const targets = p.name ? entries.filter((e) => e.name === p.name) : entries;
      if (p.name && !targets.length)
        return { ok: false as const, code: "TARGET_NOT_FOUND", message: tmsg("msg.daemon.unknown", { name: String(p.name) }) };
      policy.autostart = { ...(policy.autostart ?? {}) };
      for (const e of targets) policy.autostart[e.name] = p.on as boolean;
      await writePolicy(root, policy);
      return { projectId, on: p.on, autostart: policy.autostart };
    },
  });

  register("daemon.set", {
    description: key("cmd.daemon.set.desc"),
    triggers: { ko: "데몬 설정 종료 명령" },
    params: {
      name: P.name,
      stop: { type: "string", description: key("cmd.daemon.set.param.stop") },
      workspace: P.workspace,
    },
    returns: "{ projectId, name, stop? }",
    message: (d) => tmsg("msg.daemon.set", { name: String(d.name) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["daemon.set '{\"name\":\"db\",\"stop\":\"docker compose down\"}'"],
    handler: async (p) => {
      const target = resolveTarget(p);
      if (!target) return noWorkspace();
      const { id: projectId, root } = target;
      const name = p.name as string;
      const { entries } = await readProcfile(root);
      if (!entries.some((e) => e.name === name))
        return { ok: false as const, code: "TARGET_NOT_FOUND", message: tmsg("msg.daemon.unknown", { name }) };
      const policy = await readPolicy(root);
      policy.stop = { ...(policy.stop ?? {}) };
      if (p.stop) policy.stop[name] = p.stop as string;
      else delete policy.stop[name];
      await writePolicy(root, policy);
      return { projectId, name, stop: policy.stop[name] };
    },
  });

  // ── PTY session daemon (soksak-ptyd) — separate from Procfile daemons: the survival base of terminal shells ──
  // Observation and restart surface for the daemon itself, which owns shells and their child
  // processes outside the app so they survive an app restart. A status query never starts the daemon
  // (observation does not inflate its target).

  // `pty.daemon.*` stood here until 2026-08-20: status, restart and a live upgrade of a daemon the
  // application built into itself.
  //
  // A shell is a unit a plugin declares now, so its lifetime is the unit group's — `sidecar_status`
  // reports what is open and `sidecar_stop` ends one. Keeping a second set of names for one unit
  // would make the application's command table grow per unit, which is the lock-in the substrate
  // exists to prevent: the next unit would want three of its own.
}

/** Workspace-open hook — reap recorded pids, then autostart only the allowed daemons (security contract). */
export async function daemonOnWorkspaceOpen(root: string): Promise<void> {
  try {
    const policy = await readPolicy(root);
    // (1) Reap leftovers from an abnormal exit — matching the command line prevents killing the wrong process.
    const pids = Object.values(policy.pids ?? {}).map((x) => [x.pid, x.cmd] as [number, string]);
    if (pids.length) {
      await invoke("daemon_reap", { entries: pids });
      policy.pids = {};
      await writePolicy(root, policy);
    }
    // (2) Autostart the allowed ones.
    const { entries } = await readProcfile(root);
    for (const e of entries) {
      if (policy.autostart?.[e.name]) await startOne(root, e, policy);
    }
  } catch {
    // A daemon start failure never blocks workspace open — daemon.list shows the state.
  }
}
