// Project daemon commands (daemon.*) — the declaration is the project's Procfile (standard
// convention), soksak-specific policy such as autostart and the stop command is in the local DB
// (app.data core ns), and run/logs/cleanup are in the core singleton (daemon.rs).
// Security contract: a file committed to the repository never causes "open means run" — autostart
// starts only what the user allowed through daemon.autostart, at project open (supply-chain attack
// path blocked).
import { invoke } from "../framework";
import { register, type CommandContext, type CommandHint } from "./registry";
import { tmsg } from "../i18n";
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

/** Target project of this window — an explicit project id wins, otherwise the active project. Daemon
 *  policy and the Procfile are keyed by root while the answer names the resolved id, so both are returned. */
function resolveTarget(
  params: Record<string, unknown>,
): { id: string; root: string } | null {
  const s = useSessions.getState();
  const t = params.project
    ? s.projects.find((x) => x.id === params.project)
    : (s.projects.find((x) => x.id === s.activeId) ?? s.projects[0]);
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
  project: { type: "string" as const, description: "Project id (omit = active project)" },
  name: { type: "string" as const, description: "Daemon name from the Procfile", required: true },
};

const noProject = () => ({
  ok: false as const,
  code: "TARGET_NOT_FOUND",
  message: tmsg("msg.daemon.noProject"),
});

export function registerDaemonCatalog(): void {
  register("daemon.list", {
    description:
      "List the project's daemons — Procfile declarations merged with runtime state (running/stopped, pid, uptime) and local policy (autostart, managed stop command). A Procfile found in the project is only discovered, never auto-run, until the user allows it with daemon.autostart.",
    triggers: { ko: "데몬 목록 상시 프로세스 서버 목록" },
    params: { project: P.project },
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
      if (!target) return noProject();
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
    description:
      "Register a long-running project process (dev server, watcher, database) as a daemon — appends a standard `name: command` line to the project's Procfile. If your project has such a process, register it: with autostart allowed it starts whenever the project opens. Container stacks work too (a foreground `docker compose up` cleans itself up on stop).",
    triggers: { ko: "데몬 등록 추가 서버 자동 시작" },
    params: {
      name: P.name,
      cmd: { type: "string", description: "Shell command to run from the project root", required: true },
      project: P.project,
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
      if (!target) return noProject();
      const { id: projectId, root } = target;
      const { text } = await readProcfile(root);
      const next = upsertEntry(text, p.name as string, p.cmd as string);
      await writeProcfile(root, next);
      return { projectId, name: p.name, cmd: p.cmd };
    },
  });

  register("daemon.remove", {
    danger: "destructive",
    description:
      "Remove a daemon declaration from the project's Procfile. A running instance is stopped first.",
    triggers: { ko: "데몬 제거 삭제" },
    params: { name: P.name, project: P.project },
    returns: "{ projectId, name, removed }",
    message: (d) => tmsg("msg.daemon.remove", { name: String(d.name) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["daemon.remove dev"],
    handler: async (p) => {
      const target = resolveTarget(p);
      if (!target) return noProject();
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
    description:
      "Start a declared daemon (omit name = every declared daemon that is not running). Output goes to an in-memory ring buffer — read it with daemon.logs.",
    triggers: { ko: "데몬 시작 서버 시작 기동" },
    params: { name: { ...P.name, required: false }, project: P.project },
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
      if (!target) return noProject();
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
    description:
      "Stop a running daemon (omit name = all). The whole process tree is terminated — SIGTERM first, SIGKILL after a grace period. A managed daemon (one with a stop command set via daemon.set) runs its stop command instead.",
    triggers: { ko: "데몬 정지 서버 정지 중지" },
    params: { name: { ...P.name, required: false }, project: P.project },
    // The owner fixes the answer — it is the same from any window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ projectId, stopped: [name] }",
    primary: "name",
    message: (d) => tmsg("msg.daemon.stop", { n: ((d.stopped as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ["daemon.stop dev", "daemon.stop"],
    handler: async (p) => {
      const target = resolveTarget(p);
      if (!target) return noProject();
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
    description: "Restart a daemon — stop (tree kill or managed stop command) and start again.",
    triggers: { ko: "데몬 재시작" },
    params: { name: P.name, project: P.project },
    returns: "{ projectId, name, pid }",
    message: (d) => tmsg("msg.daemon.restart", { name: String(d.name) }),
    errors: ["TARGET_NOT_FOUND", "INTERNAL"],
    examples: ["daemon.restart dev"],
    handler: async (p, ctx: CommandContext) => {
      void ctx;
      const target = resolveTarget(p);
      if (!target) return noProject();
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
    description:
      "Read a daemon's recent output from the in-memory ring buffer (last 500 lines at most; nothing is written to disk — redirect inside your command if you need persistence).",
    triggers: { ko: "데몬 로그 출력 보기" },
    params: {
      name: P.name,
      lines: { type: "number", description: "How many recent lines (default 100)" },
      project: P.project,
    },
    // The owner fixes the answer — it is the same from any window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ projectId, name, lines: [string] }",
    message: (d) => tmsg("msg.daemon.logs", { n: ((d.lines as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["daemon.logs dev", "daemon.logs '{\"name\":\"dev\",\"lines\":300}'"],
    handler: async (p) => {
      const target = resolveTarget(p);
      if (!target) return noProject();
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
    description:
      "Allow or revoke automatic start when this project opens (omit name = every declared daemon). This is a local, per-machine consent stored outside the repository — a cloned Procfile never runs anything by itself.",
    triggers: { ko: "데몬 자동 시작 허용" },
    params: {
      name: { ...P.name, required: false },
      on: { type: "boolean", description: "true = start when the project opens", required: true },
      project: P.project,
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
      if (!target) return noProject();
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
    description:
      "Set per-daemon local options — currently the stop command for detached tools whose start and stop differ (e.g. start `docker compose up -d`, stop `docker compose down`). Stored locally, never in the Procfile.",
    triggers: { ko: "데몬 설정 종료 명령" },
    params: {
      name: P.name,
      stop: { type: "string", description: "Command that shuts the daemon down (empty string clears it)" },
      project: P.project,
    },
    returns: "{ projectId, name, stop? }",
    message: (d) => tmsg("msg.daemon.set", { name: String(d.name) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["daemon.set '{\"name\":\"db\",\"stop\":\"docker compose down\"}'"],
    handler: async (p) => {
      const target = resolveTarget(p);
      if (!target) return noProject();
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

  register("pty.daemon.status", {
    description:
      "Report the PTY session daemon (soksak-ptyd), its pid/protocol, and the exact supervisor-owned session inventory. sessionOwners exposes each session/window/pane/shellPid/generation; ownershipComplete is true only when every reported session has an owner row. A dead daemon means terminals use generation-owned in-process PTYs on their next spawn.",
    triggers: { ko: "pty데몬 상태 터미널 데몬 세션 데몬" },
    params: {},
    // The owner fixes the answer — it is the same from any window (registry.ts windowScoped).
    windowScoped: false,
    returns:
      "{ running, pid?, sessions?, sessionOwners: [{owner:'pty-supervisor',session,windowLabel,paneId,shellPid,generation}], ownershipComplete, protocol, handoffContract?, handoffContractRequired, staged, stagedPath }",
    message: (d) =>
      d.running
        ? tmsg("msg.pty.daemon.status", { sessions: Number(d.sessions ?? 0) })
        : tmsg("msg.pty.daemon.status.down"),
    errors: ["INTERNAL"],
    examples: ["pty.daemon.status"],
    hint: (d) =>
      d.running
        ? []
        : [{ cmd: "pty.daemon.restart", why: tmsg("hint.pty.daemon.restart") }],
    handler: async () => (await invoke("pty_daemon_status")) as Record<string, unknown>,
  });

  register("pty.daemon.restart", {
    description:
      "Restart the PTY session daemon. Destructive: every daemon-owned shell and its child processes are killed before a fresh daemon is staged and started — open terminals lose their sessions and respawn fresh shells.",
    triggers: { ko: "pty데몬 재시작 터미널 데몬 재시작" },
    params: {},
    // The owner fixes the answer — it is the same from any window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ killed, pid }",
    message: (d) => tmsg("msg.pty.daemon.restart", { killed: Number(d.killed ?? 0) }),
    danger: "destructive",
    errors: ["INTERNAL"],
    examples: ["pty.daemon.restart"],
    handler: async () => (await invoke("pty_daemon_restart")) as Record<string, unknown>,
  });

  register("pty.daemon.upgrade", {
    description:
      "Hot-upgrade the PTY session daemon in place — no restart, no lost sessions. The running daemon stages the new binary, hands each live shell's master fd to a new daemon by fd inheritance (the shell never sees a SIGHUP), then exits. Distinct from pty.daemon.restart, which kills every shell. Use it to roll a new ptyd generation without disturbing open terminals.",
    triggers: { ko: "pty데몬 판올림 무중단 업그레이드 데몬 핫스왑" },
    params: {},
    // The owner fixes the answer — it is the same from any window (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ upgraded, pid, sessions }",
    message: (d) => tmsg("msg.pty.daemon.upgrade", { sessions: Number(d.sessions ?? 0) }),
    errors: ["INTERNAL"],
    examples: ["pty.daemon.upgrade"],
    handler: async () => (await invoke("pty_daemon_upgrade")) as Record<string, unknown>,
  });
}

/** Project-open hook — reap recorded pids, then autostart only the allowed daemons (security contract). */
export async function daemonOnProjectOpen(root: string): Promise<void> {
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
    // A daemon start failure never blocks project open — daemon.list shows the state.
  }
}
