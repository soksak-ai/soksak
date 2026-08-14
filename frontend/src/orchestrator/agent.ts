// Agent runner for the orchestrator's natural-language console — one conversation turn is performed by
// one one-shot spawn of claude.
//
// Correlation rule (docs/MESSAGE-PROTOCOL.md): every execution originating in a turn has that turn's
// turnId as its parentId. The spawn env SOKSAK_PARENT=turnId runs through sok → socket meta → registry
// trace so that command.executed is grouped, and chat.prompt (parent), command.progress, and chat.answer
// (close) published by this file complete the set. Why a one-shot spawn: parent rotates exactly only
// through the spawn env (a resident process would depend on LLM cooperation). Conversation continuity is
// joined by session_id → --resume.
//
// The spawn form follows the verified precedent (the old vtuber claudeCli.ts) exactly: login shell -lc
// wrap (GUI PATH trap), cwd=$HOME (blocks project context leakage), --setting-sources "" (blocks hooks and
// plugins, keeps OAuth), --system-prompt (identity replacement — given as a user message, the role is
// refused). The only allowed tool is this app's CLI binary (Bash(<bin>:*), <bin>=sok/sok-dev/sok-debug).

import { moduleState } from "../lib/moduleState";
import { createStream, invoke } from "../framework";
import { safeListen } from "../lib/safeListen";
import { useSettings } from "../state/settings";
import { publishActivity } from "../state/activityFeed";
import { AgentStreamParser } from "./agentStream";
import { execute, type CommandOutcome } from "../commands/registry";
import { cliName } from "../lib/cliIdentity";

// Records for conversation continuity (--resume) and for children left by a reload — valid only within the
// same app run, so sessionStorage (survives window.reload, gone on app restart — on restart the process id
// space is new, so the record is invalid).
const SESSION_KEY = "soksak.orchestrator.session";
const TURN_KEY = "soksak.orchestrator.turn";

// Runaway cap — stop and window close are the normal paths, but a hard cap keeps an unattended turn from running forever.
const TURN_CAP_MS = 15 * 60_000;
// Text delta publish batching — publishing per token pollutes the hub (ring, persistence). Send in sentence chunks.
const DELTA_FLUSH_MS = 700;
const DELTA_FLUSH_CHARS = 120;

interface ActiveTurn {
  turnId: string;
  proc: number;
}

// Outside the hot-swap boundary — a fresh value drops both the "already done" memory and the lazy initialization,
// and the filler does not fill again.
/** The turn in progress — there is only one, and cancel and stop reasons attach to it. */
const liveTurn = moduleState("orchestrator/agent#turn", () => ({
  active: null as ActiveTurn | null,
  inFlight: false,
  cancelled: false,
  stopReason: null as string | null,
}));
// BUSY gate — liveTurn.active is only set after the spawn resolves (a duplicate ask races through before
// that), so it is raised on entry.
// Prerequisite (teaching, catalog) cache — the command surface changes only through the plugin lifecycle:
// it is not re-fetched every turn, and it is invalidated only when a plugin.enable/disable/reload/...
// execution is observed in the activity stream (event-based — no TTL, no polling). Removes the noise of a
// prep fetch filling the set every turn.
// Outside the hot-swap boundary — if these values become new ones, the "already done" memory, the lazy
// initialization, and the unsubscribe slot disappear together, and the side that filled them does not fill
// them again.
/** Prerequisite cache — its lifetime differs from a turn's (invalidated only when the command surface changes). */
const prepCache = moduleState("orchestrator/agent#prepCache", () => ({
  prep: null as { key: string; skillDoc: string; catalog: string } | null,
}));

/** Once at boot (main) — invalidates the prerequisite cache by observing command surface changes. */
export function watchPrepInvalidation(): void {
  safeListen<{ kind: string; payload: Record<string, unknown> }>("activity", (e) => {
    if (e.payload.kind !== "command.executed") return;
    const cmd = String((e.payload.payload as { command?: unknown })?.command ?? "");
    if (/^plugin\.(enable|disable|reload|install|remove|update)\b/.test(cmd)) prepCache.prep = null;
  });
}

const nsGet = (k: string): string | null => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};
const nsSet = (k: string, v: string | null): void => {
  try {
    if (v === null) sessionStorage.removeItem(k);
    else sessionStorage.setItem(k, v);
  } catch {
    // An unusable storage (harness) loses only continuity — the turn itself is fine.
  }
};

// Login shell wrapper — avoids the GUI PATH trap and puts the CLI directory paired with the app
// (SOKSAK_CLI_DIR) in front of PATH: `sok …` resolves even when the user's PATH has no sok (fresh install,
// dev tree).
const PATH_PRELUDE = `[ -n "$SOKSAK_CLI_DIR" ] && PATH="$SOKSAK_CLI_DIR:$PATH"; `;

// Short process run + stdout collection (login shell — avoids the GUI PATH trap). Failure becomes an Error.
async function runCapture(shellCmd: string, env?: Record<string, string>): Promise<string> {
  // Completion is judged on the stdout channel alone — stdout and exit are different channels with no
  // ordering guarantee, so on large output (313KB catalog) an exit arriving first returned truncated output
  // (measured: JSON parse failure → empty catalog → the agent groped for commands by guessing). The shell
  // prints a terminating sentinel (+ exit code) on the same stdout at the end of the output, and completion
  // and code are read together through the in-channel order (which is guaranteed).
  const SENTINEL = "__SOKSAK_CAPTURE_EOF__";
  let out = "";
  let err = "";
  const dec = new TextDecoder();
  const onStderr = createStream<ArrayBuffer>();
  onStderr.onmessage = (m) => {
    err += dec.decode(new Uint8Array(m), { stream: true });
  };
  const done = new Promise<number>((resolve) => {
    let settled = false;
    const settle = (code: number) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };
    const onStdout = createStream<ArrayBuffer>();
    onStdout.onmessage = (m) => {
      out += dec.decode(new Uint8Array(m), { stream: true });
      const at = out.lastIndexOf(SENTINEL);
      if (at >= 0) {
        const code = Number(out.slice(at + SENTINEL.length).trim() || "-1");
        out = out.slice(0, at);
        settle(Number.isFinite(code) ? code : -1);
      }
    };
    const onExit = createStream<number>();
    // exit is a fallback only (spawn failure, death before the sentinel) — the sentinel alone is the
    // authority on success. exit can arrive before the last stdout delivery (cross-channel ordering is not
    // guaranteed — the very race this function fixes), so only the fallback's "declare failure" is delayed
    // briefly to absorb in-flight delivery.
    onExit.onmessage = (code) => {
      setTimeout(() => settle(code === 0 ? -1 : code), 200);
    };
    void invoke("process_spawn", {
      cmd: "/bin/sh",
      // The sentinel is printed regardless of the command's success or failure (with $?) — exec is not possible (a following command is required).
      args: ["-lc", `${PATH_PRELUDE}{ ${shellCmd} ; }; printf '\\n${SENTINEL} %s\\n' "$?"`],
      cwd: null,
      env: env ?? null,
      envRemove: null,
      scrubAiEnv: true,
      ns: null,
      secretEnv: null,
      onStdout,
      onStderr,
      onExit,
    }).catch(() => settle(-1));
  });
  const code = await done;
  if (code !== 0) throw new Error(err.trim() || `exit code ${code}`);
  return out;
}

// Compresses the sok commands response (JSON envelope) into a one-line-per-command catalog for the prompt (pure).
// The purpose is removing discovery round trips (measured: without the catalog, --help→commands→filter took 6 Bash calls and 30+ seconds).
export function compactCatalog(raw: string): string {
  try {
    const d = JSON.parse(raw) as {
      data?: { commands?: unknown[] };
      commands?: unknown[];
    };
    const cmds = (d.data?.commands ?? d.commands ?? []) as {
      name?: string;
      description?: string;
      params?: Record<string, { required?: boolean }>;
    }[];
    return cmds
      .filter((c) => typeof c.name === "string")
      .map((c) => {
        const ps = Object.entries(c.params ?? {})
          .map(([k, v]) => (v?.required ? `${k}*` : k))
          .join(", ");
        const desc = String(c.description ?? "").split(/(?<=\.)\s/)[0].slice(0, 90);
        return `${c.name}${ps ? ` {${ps}}` : ""} — ${desc}`;
      })
      .join("\n");
  } catch {
    return ""; // A catalog failure demotes to the discovery workflow (the slow path) — the turn continues
  }
}

// system prompt — role and behavior rules + the soksak-control teaching text verbatim (sok skill print,
// live single truth) + the whole command catalog (removes discovery round trips). With --setting-sources ""
// headless there is no skill autoload, so loading it into the prompt directly is the straight path.
// sokPath = the absolute path of the sok executable (when known) — the agent Bash's PATH is untrustworthy
// (measured: it rebuilds its own). The variable part (stage) goes last — the front part must be identical
// across turns for the prompt cache to hit (a repeat within 5 minutes is faster).
function buildSystemPrompt(
  skillDoc: string,
  sokPath: string,
  catalog: string,
  stageWindow?: string,
): string {
  const stage = stageWindow
    ? `The default stage window is set by env SOKSAK_WINDOW=${stageWindow} — a sok command with no window runs in that window.`
    : `No default stage window is set — for a command that handles windows, find the window with \`${sokPath} window.projects\` and target it explicitly with \`${sokPath} --window <label> <command>\`.`;
  return [
    "You are the natural-language console agent of the soksak (terminal app) orchestrator. Complete the user's instruction by running sok CLI commands, and report the result to the user in one or two Korean sentences.",
    "",
    "Rules:",
    `- The sok executable of this environment: \`${sokPath}\` — \`sok\` in the document below always runs as this path. Do not expect sok on PATH.`,
    `- The call form is exactly \`${sokPath} <command> '<JSON>'\` and nothing else — parameters are one JSON blob in single quotes, and flags such as --url or key=value arguments do not exist (the only flag: \`--window <label>\`). Example: \`${sokPath} panel.split '{"side":"right"}'\`.`,
    "- Drive the app with a single sok command. A pipe, &&, an env prefix, or another program is denied automatically by permissions.",
    "- Pick the command straight from the catalog below — re-listing (sok commands) is forbidden. When a command is refused, check the schema once with `help <command>`, fix it, and retry.",
    "- Report after checking the command response (the JSON envelope) — never report a guess.",
    "- The last output is the answer to the user: concise Korean, no listing of identifiers such as window labels.",
    "",
    skillDoc.trim(),
    ...(catalog
      ? ["", "## Command catalog (name {parameters, *=required} — description)", catalog]
      : []),
    "",
    stage,
  ].join("\n");
}

interface AskParams {
  text: string;
  window?: string;
}

/** Natural-language turn execution — the body of the orchestrator.ask handler. */
export async function ask(p: AskParams): Promise<CommandOutcome> {
  if (liveTurn.inFlight) {
    return {
      ok: false,
      code: "BUSY",
      message: tmsg("msg.orchestrator.ask.busy"),
    };
  }
  const text = p.text.trim();
  if (!text) return { ok: false, code: "INVALID_PARAMS", message: tmsg("msg.orchestrator.ask.textRequired") };
  liveTurn.inFlight = true;
  try {
    return await askInner(text, p.window);
  } finally {
    liveTurn.inFlight = false;
  }
}

async function askInner(text: string, explicitWindow?: string): Promise<CommandOutcome> {
  // The stage = the user's actual work location — explicit (param) > last focused workspace window.
  // The orchestrator rail selection is only a feed filter, not the stage (measured: a leftover selection
  // leaked commands into someone else's window — filter and intent confused). When typing in the console
  // the active window is main, so the user's intent for the stage is "the workspace I was last working in".
  const stageWindow =
    explicitWindow ??
    (await invoke<string | null>("ipc_last_project_window").catch(() => null)) ??
    undefined;
  const turnId = crypto.randomUUID();
  publishActivity("chat.prompt", "orchestrator", { text, turnId, message: `💬 ${text}` });
  const close = (ok: boolean, code: string, answer: string): CommandOutcome => {
    publishActivity("chat.answer", "orchestrator", {
      text: answer,
      parentId: turnId,
      ok,
      code,
      message: `↩ ${answer}`,
    });
    return ok
      ? { ok, code, message: answer, data: { turnId, answer } }
      : { ok, code, message: answer };
  };

  // Socket and teaching prep — a missing sok or an unusable app socket is closed as an answer exactly as it is (no silence).
  const socket = await invoke<string | null>("ipc_socket_path").catch(() => null);
  if (!socket) return close(false, "INTERNAL", tmsg("msg.orchestrator.ask.noSocket"));
  const cliDir = await invoke<string | null>("ipc_cli_dir").catch(() => null);
  // The CLI binary matched to this app (sok/sok-dev/sok-debug). A dev app has only sok-dev (no sok), and the
  // CLI is bound by compile-time identity and refuses a socket from another env (P9 betrayal block). So
  // spawn, permission, and teaching are unified on this name — hardcoding sok dies instantly on dev/debug
  // through a missing file or a refused socket.
  const bin = cliName();
  const sokPath = cliDir ? `${cliDir}/${bin}` : bin;
  const baseEnv: Record<string, string> = {
    SOKSAK_SOCKET: socket,
    ...(cliDir ? { SOKSAK_CLI_DIR: cliDir } : {}),
  };
  // Prerequisites (teaching, catalog) — not re-fetched while the cache is valid (invalidation = observing
  // the plugin lifecycle). Fetched once on first use and once after invalidation, and that prep execution
  // folds into this turn's set as its offspring.
  // The catalog is per stage window (plugin commands load only in workspace windows — main is the control plane).
  const prepKey = stageWindow ?? "";
  let skillDoc: string;
  let catalog: string;
  if (prepCache.prep && prepCache.prep.key === prepKey) {
    ({ skillDoc, catalog } = prepCache.prep);
  } else {
    try {
      skillDoc = await runCapture(`${sokPath} skill print`, { ...baseEnv, SOKSAK_PARENT: turnId });
    } catch (e) {
      return close(
        false,
        "INTERNAL",
        tmsg("msg.orchestrator.ask.cliMissing", {
          bin,
          cause: String(e instanceof Error ? e.message : e).slice(0, 200),
        }),
      );
    }
    const catalogWindow =
      stageWindow ??
      (await execute("window.projects", {}, { remote: false, parent: turnId })
        .then((r) => (r.data as { projects?: { window?: string }[] } | undefined)?.projects?.[0]?.window)
        .catch(() => undefined));
    catalog = compactCatalog(
      await runCapture(
        `${sokPath} ${catalogWindow ? `--window ${catalogWindow} ` : ""}commands`,
        { ...baseEnv, SOKSAK_PARENT: turnId },
      ).catch(() => ""),
    );
    // An empty catalog (failure) is not cached — the next turn retries (only a demotion to the slow discovery path).
    if (catalog) prepCache.prep = { key: prepKey, skillDoc, catalog };
  }

  const agentBin = useSettings.getState().orchestratorAgent.trim() || "claude";
  // A command routing turn round-trips often — a fast model dominates perceived latency (measured: opus takes 4-6 seconds per round trip).
  const agentModel = useSettings.getState().orchestratorModel.trim();
  // sok is instructed and allowed by absolute path — the agent Bash's PATH rebuilds itself and is untrustworthy (measured).
  // env (SOKSAK_*) is fully inherited (measured) — correlation and socket binding are passed through env. (sokPath is fixed above)
  const env: Record<string, string> = {
    ...baseEnv,
    SOKSAK_PARENT: turnId,
    ...(stageWindow ? { SOKSAK_WINDOW: stageWindow } : {}),
  };

  // Resuming the conversation (--resume) can be a leftover (agent replacement, session cleanup on the claude
  // side — measured: with an id left by a stub, the real binary died instantly at startup with
  // error_during_execution). On an instant death of the resume (0 trace), the session is discarded exactly
  // once and retried as a new conversation — with any trace, retry is forbidden (risk of double command execution).
  let resume = nsGet(SESSION_KEY);
  for (let attempt = 0; ; attempt++) {
  // The prompt goes right after -p (positional) — --allowedTools is variadic (<tools...>), so a prompt
  // placed after it is swallowed as a tool name (measured: instant death with "Input must be provided").
  const args = [
    "-p",
    text,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--setting-sources",
    "",
    "--system-prompt",
    buildSystemPrompt(skillDoc, sokPath, catalog, stageWindow),
    "--allowedTools",
    `Bash(${bin}:*)`,
    ...(cliDir ? [`Bash(${cliDir}/${bin}:*)`] : []),
    ...(agentModel ? ["--model", agentModel] : []),
    ...(resume ? ["--resume", resume] : []),
  ];

  const parser = new AgentStreamParser();
  const dec = new TextDecoder();
  // Assignment inside a closure (channel callback) is outside TS flow analysis — held as record properties so the declared type governs.
  const turn: { streamed: string; result: { ok: boolean; text: string } | null; session: string | null } = {
    streamed: "",
    result: null,
    session: null,
  };

  // Batched text delta publishing — prevents hub pollution (token → sentence chunk).
  let pendingDelta = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushDelta = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const chunk = pendingDelta.trim();
    pendingDelta = "";
    if (chunk) {
      publishActivity("command.progress", "orchestrator", {
        command: "orchestrator.ask",
        delta: chunk,
        parentId: turnId,
        message: `⋯ orchestrator.ask: ${chunk}`,
      });
    }
  };
  const queueDelta = (t: string) => {
    pendingDelta += t;
    if (pendingDelta.length >= DELTA_FLUSH_CHARS) flushDelta();
    else if (!flushTimer) flushTimer = setTimeout(flushDelta, DELTA_FLUSH_MS);
  };

  const onStdout = createStream<ArrayBuffer>();
  onStdout.onmessage = (m) => {
    for (const ev of parser.feed(dec.decode(new Uint8Array(m), { stream: true }))) {
      if (ev.kind === "session") turn.session = ev.sessionId;
      else if (ev.kind === "text") {
        turn.streamed += ev.text;
        queueDelta(ev.text);
      } else if (ev.kind === "tool") {
        flushDelta();
        const toolDelta = ev.detail ? `$ ${ev.detail}` : tmsg("msg.orchestrator.ask.tool", { name: ev.name });
        publishActivity("command.progress", "orchestrator", {
          command: "orchestrator.ask",
          delta: toolDelta,
          parentId: turnId,
          message: `⋯ orchestrator.ask: ${toolDelta}`,
        });
      } else {
        turn.result = { ok: ev.ok, text: ev.text };
      }
    }
  };
  const stderr = { tail: "" };
  const onStderr = createStream<ArrayBuffer>();
  onStderr.onmessage = (m) => {
    stderr.tail = (stderr.tail + dec.decode(new Uint8Array(m), { stream: true })).slice(-500);
  };
  // Fast exit race: for an ultra-short process (a stub and the like) the exit channel can arrive before the
  // spawn invoke resolves — if .then revives liveTurn.active after exit, BUSY is permanent. The finished
  // gate blocks it.
  let finished = false;
  const exited = new Promise<number>((resolve) => {
    const onExit = createStream<number>();
    onExit.onmessage = resolve;
    void invoke<number>("process_spawn", {
      cmd: "/bin/sh",
      // The verified claudeCli.ts form: login shell PATH + $HOME fixed + exec replacement. "$0"/"$@" keeps arguments intact.
      args: ["-lc", `${PATH_PRELUDE}cd "$HOME" 2>/dev/null; exec "$0" "$@"`, agentBin, ...args],
      cwd: null,
      env,
      envRemove: null,
      scrubAiEnv: true, // Nested-session guard — the AI session env set (the process.rs single truth) is removed wholesale
      group: true, // stop reclaims the agent's child tree (Bash grandchildren) too — killing only the direct child leaves an EOF hostage
      ns: null,
      secretEnv: null,
      onStdout,
      onStderr,
      onExit,
    }).then(
      (id) => {
        if (finished) return; // The turn already ended — re-occupying it is forbidden
        liveTurn.active = { turnId, proc: id };
        nsSet(TURN_KEY, JSON.stringify({ proc: id, turnId }));
      },
      () => resolve(-1),
    );
  });

  liveTurn.cancelled = false;
  const cap = setTimeout(() => {
    void stop(tmsg("msg.orchestrator.stop.timeCap"));
  }, TURN_CAP_MS);
  const code = await exited;
  finished = true;
  clearTimeout(cap);
  flushDelta();
  const wasCancelled = liveTurn.cancelled;
  liveTurn.cancelled = false;
  liveTurn.active = null;
  nsSet(TURN_KEY, null);
  if (turn.session) nsSet(SESSION_KEY, turn.session);

  if (wasCancelled) {
    const reason = liveTurn.stopReason ?? tmsg("msg.orchestrator.stop.default");
    liveTurn.stopReason = null;
    return close(false, "CANCELLED", reason);
  }
  // Instant-death detection for resume — resume was used and it ended with an error or no response and no
  // trace (streamed text) at all. Discard the session and retry once as a new conversation (self-healing of
  // the leftover session described in the comment above).
  const stillborn = !turn.streamed && (!turn.result || !turn.result.ok);
  if (attempt === 0 && resume && stillborn) {
    resume = null;
    nsSet(SESSION_KEY, null);
    publishActivity("command.progress", "orchestrator", {
      command: "orchestrator.ask",
      delta: tmsg("msg.orchestrator.ask.resumeRestart"),
      parentId: turnId,
      message: `⋯ orchestrator.ask: ${tmsg("msg.orchestrator.ask.resumeRestart")}`,
    });
    continue;
  }
  if (turn.result) {
    const answer = (turn.result.text || turn.streamed).trim() || tmsg("msg.orchestrator.ask.emptyAnswer");
    return close(turn.result.ok, turn.result.ok ? "OK" : "INTERNAL", answer);
  }
  // Exit with no result = spawn failure or crash. Report as it is, with the stderr tail attached.
  const errTail = stderr.tail.trim();
  return close(
    false,
    "INTERNAL",
    tmsg("msg.orchestrator.ask.noAnswer", {
      code,
      tail: errTail ? ` — ${errTail.slice(-200)}` : "",
    }),
  );
  }
}

/** Stop the turn in progress — the body of the orchestrator.stop handler. The exit path on the ask side closes the set. */
export async function stop(reason?: string): Promise<CommandOutcome> {
  if (!liveTurn.active) return { ok: true, code: "NOOP", message: tmsg("msg.orchestrator.stop.idle"), data: { stopped: false } };
  liveTurn.cancelled = true;
  liveTurn.stopReason = reason ?? tmsg("msg.orchestrator.stop.default");
  await invoke("process_kill", { id: liveTurn.active.proc }).catch(() => {});
  return { ok: true, code: "OK", message: tmsg("msg.orchestrator.stop.stopped"), data: { stopped: true } };
}

/** Once at boot — cleans up children left by a reload. When this window (main) reloads the JS handle is gone
 * but the child claude survives (process.rs pump→drain). The sessionStorage record survives across a reload
 * and is gone on app restart (new id space — prevents killing the wrong process), so when a record exists
 * the process is killed and that set is closed as INTERRUPTED. */
export function cleanupOrphanTurn(): void {
  const raw = nsGet(TURN_KEY);
  if (!raw) return;
  nsSet(TURN_KEY, null);
  try {
    const rec = JSON.parse(raw) as { proc?: number; turnId?: string };
    if (typeof rec.proc === "number") {
      void invoke("process_kill", { id: rec.proc }).catch(() => {});
    }
    if (typeof rec.turnId === "string" && rec.turnId) {
      publishActivity("chat.answer", "orchestrator", {
        text: tmsg("msg.orchestrator.stop.reload"),
        parentId: rec.turnId,
        ok: false,
        code: "INTERRUPTED",
        message: `↩ ${tmsg("msg.orchestrator.stop.reload")}`,
      });
    }
  } catch {
    // A corrupted record is discarded — the next turn is fine.
  }
}
