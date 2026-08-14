// Orchestrator window shell (A3) — the screen for observing the whole orchestration
// (the view of P12). Left: window/monitor map (window.monitors facts) / right: activity feed
// (activity broadcast + recent backfill) / bottom: command console (registry execution). The shell
// consumes only the command and event surfaces — never reference core internal state (sessions and
// the like) directly: P13 holds only if it has the same standing as an external client (phone, CLI).

import { backfillFeed } from "./activityBackfill";
import { invoke, currentWindow , dragRegion } from "../framework";
import { useCallback, useEffect, useRef, useState } from "react";
import { safeListen } from "../lib/safeListen";
import { currentWindowLabel } from "../lib/webviewLabels";
import { execute, getSpec } from "../commands/registry";
import { Icon } from "../ui/icons/Icon";
import { NewProjectModal, type CreateProjectArgs } from "../components/NewProjectModal";
import { hasMessage, localize, useT, type MsgKey, type TFn } from "../i18n";
import { actorKeyOf, foldFeed, itemWindow, type ActivityEntry, type ChatCard } from "./feedFold";

const FEED_CAP = 500;

// One feed line — a self-describing entry (MESSAGE-PROTOCOL §3). The consumer does not enumerate
// kind: a command trace (has durationMs) gets generic framing (domain-agnostic), everything else
// uses the message the producer put there.
function lineOf(e: ActivityEntry): string {
  const p = e.payload;
  if (typeof p.durationMs === "number") {
    const head = `${p.command} ${p.ok ? "✓" : `✗ ${p.code ?? ""}`} (${p.durationMs}ms)`;
    return p.message ? `${head} → ${p.message}` : head;
  }
  return typeof p.message === "string" && p.message ? p.message : e.kind;
}

// Command to a human-readable label — never expose the raw key
// (plugin.soksak-plugin-<id>.<command>).
// Ownership structure (the only form that scales to 18 languages):
//   · Plugin command = title (LocalizedText) in manifest contributes.commands — owned and
//     translated by the author.
//   · Core command = a cmd.* key in the language table (adding a language = adding one table, the
//     definition site does not change). The commandTitles.test.ts gate enforces full command
//     coverage — partial coverage is not allowed.
//   · With neither, description (English prose) — the raw key is never shown.
function commandLabel(cmd: string, t: TFn, carried?: unknown): string {
  // Label source the stream delivered (LocalizedText) — plugin commands load only in the executing
  // window, so this path is the only label supply across the window boundary (stream self-sufficiency).
  if (carried && (typeof carried === "string" || typeof carried === "object"))
    return localize(carried as Parameters<typeof localize>[0]);
  const spec = getSpec(cmd);
  if (spec?.title) return localize(spec.title);
  const key = `cmd.${cmd}`;
  if (hasMessage(key)) return t(key as MsgKey);
  return spec?.description ?? cmd;
}

// Response media render — draws only the display media the envelope declared (MESSAGE-PROTOCOL:
// the consumer never guesses keys). base64 becomes a data URI immediately; path is lazily loaded
// through read_file_base64 (on failure it is silently omitted — file deleted, and so on).
function MediaView({ media, seq, onZoom }: { media: unknown; seq: number; onZoom: (src: string) => void }) {
  const m = media as { kind?: string; base64?: string; path?: string } | undefined;
  const isImage = typeof m?.kind === "string" && m.kind.startsWith("image/");
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    if (m?.base64) {
      setSrc(`data:${m.kind};base64,${m.base64}`);
      return;
    }
    if (m?.path) {
      let disposed = false;
      void invoke<{ mime: string; base64: string }>("read_file_base64", { path: m.path })
        .then((f) => {
          if (!disposed) setSrc(`data:${f.mime};base64,${f.base64}`);
        })
        .catch(() => {});
      return () => {
        disposed = true;
      };
    }
  }, [isImage, m?.base64, m?.path, m?.kind]);
  if (!isImage || !src) return null;
  return (
    <img
      className="orch-shot"
      alt=""
      src={src}
      data-node={`orch/turn/${seq}/media`}
      title={t("orch.zoomImage")}
      onClick={(e) => {
        e.stopPropagation(); // separate from the bubble's raw JSON toggle
        onZoom(src);
      }}
    />
  );
}

// HH:MM:SS — chat bubble meta. 0 or missing gives an empty string.
function fmtTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Renders one activity — a command execution becomes request/response chat bubbles (start and end
// timestamps shown), everything else a single event line. The window in the meta is displayed as
// the project name (nameOf). Request arguments (params) are noise, so they stay out of the bubble
// body and the full payload appears only in title (hover) — the result summary stays in the
// response bubble.
function renderEntry(
  e: ActivityEntry,
  nameOf: (win: string) => string,
  showWho: boolean, // project name only in the "all" view (when filtered it is already in the header)
  onToggle: (seq: number) => void, // click: expand the raw JSON
  isExpanded: boolean,
  t: TFn,
  onZoom: (src: string) => void,
  deltas?: ActivityEntry[], // progress deltas folded into this turn (MESSAGE-PROTOCOL §2 — request → delta → response)
) {
  const win = String(e.payload.window ?? "");
  // Speaker badge (§5 R3) — derived by actorKeyOf (one rule), label resolved from the i18n table
  // `actor.<key>` (same ownership structure as command labels cmd.* — adding a key = one table
  // line, code unchanged). A human hand gets no badge (the window/console name is the speaker).
  const actorKey = actorKeyOf(e);
  const actorLabel = actorKey
    ? hasMessage(`actor.${actorKey}`)
      ? t(`actor.${actorKey}` as MsgKey)
      : actorKey
    : "";
  const who = win ? nameOf(win) : e.source;
  const meta = (ts: number) => (
    <>
      {fmtTime(ts)}
      {showWho ? ` · ${who}` : ""}
      {actorLabel && <span className="orch-actor">{actorLabel}</span>}
    </>
  );
  const raw = isExpanded ? (
    <pre className="orch-raw">{JSON.stringify(e.payload, null, 2)}</pre>
  ) : null;
  // System-originated (§5 — scheduler utterances, boot byproducts) — the record stays visible but
  // dimmed (human-originated is the signal).
  const sys = typeof e.payload.origin === "string" && e.payload.origin ? " sys" : "";
  if (e.kind === "command.executed") {
    const p = e.payload;
    const ok = p.ok !== false;
    return (
      <div key={e.seq} className={`orch-turn${sys}`}>
        <div className="orch-bubble req" data-node={`orch/turn/${e.seq}/req`}>
          <div className="orch-bubble-meta">{meta(Number(p.startedAt))}</div>
          <div className="orch-bubble-body">{commandLabel(String(p.command), t, p.title)}</div>
        </div>
        {/* Progress deltas — between request and response, the trace of what was done during the run (§2). */}
        {deltas?.map((d) => (
          <div key={d.seq} className="orch-delta" data-node={`orch/turn/${e.seq}/delta/${d.seq}`}>
            ⋯ {String((d.payload as { delta?: unknown }).delta ?? "")}
          </div>
        ))}
        {/* Response = the standard answer message. A click expands the raw JSON (the whole envelope). */}
        <div
          className={`orch-bubble res ${ok ? "ok" : "err"}${isExpanded ? " open" : ""}`}
          data-node={`orch/turn/${e.seq}/res`}
          title={t("orch.showRawJson")}
          onClick={() => onToggle(e.seq)}
        >
          <div className="orch-bubble-meta">
            {fmtTime(Number(p.finishedAt))} · {String(p.durationMs ?? "")}ms
          </div>
          <div className="orch-bubble-body">
            {ok ? "✓" : `✗ ${String(p.code ?? "")}`} {String(p.message ?? "")}
          </div>
          {/* When the response declares media, render it as is (standard — no key guessing): base64 immediately, path lazily. */}
          <MediaView media={p.media} seq={e.seq} onZoom={onZoom} />
        </div>
        {raw}
      </div>
    );
  }
  return (
    <div key={e.seq} className={`orch-event k-${e.kind.split(".").join("-")}${sys}`}>
      <div className="orch-event-line" onClick={() => onToggle(e.seq)} title={t("orch.showRawJson")}>
        <span className="orch-bubble-meta">{meta(e.ts)}</span>
        <span className="orch-line">{lineOf(e)}</span>
      </div>
      {raw}
    </div>
  );
}

// Chat set card — question (user) → set members in seq order (child commands go through
// renderEntry as-is, deltas become progress lines, the answer becomes a response bubble) → when
// not closed, a progress indicator plus stop. The card is anchored to the parent (prompt) window.
function renderChatCard(
  card: ChatCard,
  nameOf: (win: string) => string,
  showWho: boolean,
  onToggle: (seq: number) => void,
  expanded: Set<number>,
  t: TFn,
  onZoom: (src: string) => void,
  onStop: () => void,
) {
  const prompt = card.prompt;
  return (
    <div key={`chat-${prompt.seq}`} className="orch-chat" data-node={`orch/chat/${prompt.seq}`}>
      <div className="orch-bubble req chat" data-node={`orch/chat/${prompt.seq}/prompt`}>
        <div className="orch-bubble-meta">
          {fmtTime(prompt.ts)}
          {showWho ? ` · ${t("orch.console")}` : ""}
        </div>
        <div className="orch-bubble-body">{String(prompt.payload.text ?? "")}</div>
      </div>
      <div className="orch-chat-body">
        {card.body.map((e) => {
          if (e.kind === "command.progress") {
            return (
              <div key={e.seq} className="orch-delta" data-node={`orch/chat/${prompt.seq}/delta/${e.seq}`}>
                ⋯ {String((e.payload as { delta?: unknown }).delta ?? "")}
              </div>
            );
          }
          if (e.kind === "chat.answer") {
            const ok = e.payload.ok !== false;
            const open = expanded.has(e.seq);
            return (
              <div
                key={e.seq}
                className={`orch-bubble res chat ${ok ? "ok" : "err"}${open ? " open" : ""}`}
                data-node={`orch/chat/${prompt.seq}/answer`}
                title={t("orch.showRawJson")}
                onClick={() => onToggle(e.seq)}
              >
                <div className="orch-bubble-meta">{fmtTime(e.ts)}</div>
                <div className="orch-bubble-body">{String(e.payload.text ?? "")}</div>
                {open && <pre className="orch-raw">{JSON.stringify(e.payload, null, 2)}</pre>}
              </div>
            );
          }
          return renderEntry(e, nameOf, showWho, onToggle, expanded.has(e.seq), t, onZoom, undefined);
        })}
      </div>
      {!card.closed && (
        <div className="orch-chat-running" data-node={`orch/chat/${prompt.seq}/running`}>
          <span>⋯ {t("orch.chatRunning")}</span>
          <button type="button" data-node={`orch/chat/${prompt.seq}/stop`} onClick={onStop}>
            {t("orch.stop")}
          </button>
        </div>
      )}
    </div>
  );
}

export function OrchestratorApp() {
  const t = useT();
  const [feed, setFeed] = useState<ActivityEntry[]>([]);
  // The left side lists all projects (recently opened ∪ currently open). window != null means it is
  // open and has that window.
  const [projects, setProjects] = useState<{ root: string; name: string; window: string | null }[]>([]);
  const [cmd, setCmd] = useState("");
  const [result, setResult] = useState<string>("");
  const [pinned, setPinned] = useState(false); // pin = always-on-top (local to this window, off after reopening)
  // Feed filter selection — the unit is the project (root). The highlight is keyed by root too:
  // one window can host several projects, so a per-window highlight looks like multiple
  // simultaneous selections (bug report). Feed events include only the window label, so the filter
  // runs on the selected project's window.
  const [selected, setSelected] = useState<{ root: string; window: string } | null>(null);
  const [unread, setUnread] = useState(0); // count of entries that arrived while scrolled up
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set()); // entries (seq) with raw JSON expanded
  const [zoomSrc, setZoomSrc] = useState<string | null>(null); // image zoom (lightbox)
  const feedRef = useRef<HTMLDivElement>(null);

  const toggleExpand = useCallback((seq: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);
  const atBottomRef = useRef(true); // whether the feed is near the bottom — at the bottom it follows, otherwise unread accumulates

  // Feed scroll tracking: near the bottom keep following and reset unread to 0; scrolled up, stop
  // following.
  const onFeedScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottomRef.current) setUnread(0);
  }, []);

  // Pin toggle (z-order case 1) — when on, the orchestrator stays pinned on top regardless.
  const togglePin = useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      void currentWindow().setAlwaysOnTop(next).catch(() => {});
      return next;
    });
  }, []);

  // The left window list is only a feed filter selection — it does not raise (focus) a window.
  // Clicking an item narrows the feed to that window (the "all" item clears the filter); bringing a
  // window forward is handled by the focus icon at the right of the item.
  const focusWindow = useCallback((label: string) => {
    void invoke("window_focus", { label }).catch(() => {});
  }, []);

  // Window label in the feed meta (w-<uuid>) to a project name — a window label means nothing to a person.
  const nameOf = useCallback(
    (win: string) =>
      win === currentWindowLabel()
        ? t("orch.console") // run from this window (the console) — an action of the orchestrator itself, not of a project
        : (projects.find((p) => p.window === win)?.name ?? win),
    [projects, t],
  );

  // Left project list = recently opened (project.recent) ∪ currently open (project_owners). Open
  // ones have an owning window. Refreshed automatically on project-registry-change for every
  // project open/close.
  const refreshProjects = useCallback(() => {
    void (async () => {
      let recents: { root: string; alias?: string }[] = [];
      let owners: { root: string; window: string }[] = [];
      try {
        // Internal query (filling the rail) — not a human intent (§5 origin:"internal", not instrumented).
        const r = await execute("project.recent", {}, { remote: false, origin: "internal" });
        if (r.ok) recents = (r.data as { recents?: typeof recents } | undefined)?.recents ?? [];
      } catch {
        /* Ignore — empty list */
      }
      try {
        owners = (
          await invoke<{ owners: { root: string; window: string }[] }>("project_owners")
        ).owners;
      } catch {
        /* Ignore */
      }
      const ownerOf = new Map(owners.map((o) => [o.root, o.window]));
      const aliasOf = new Map(recents.map((r) => [r.root, r.alias]));
      const order: string[] = [];
      const seen = new Set<string>();
      for (const r of [...recents.map((x) => x.root), ...owners.map((x) => x.root)]) {
        if (!seen.has(r)) {
          seen.add(r);
          order.push(r);
        }
      }
      setProjects(
        order.map((root) => ({
          root,
          name: aliasOf.get(root) || root.split("/").filter(Boolean).pop() || root,
          window: ownerOf.get(root) ?? null,
        })),
      );
    })();
  }, []);

  // Clicking an unopened project = open it (create a window at that root; if already open, P6
  // focuses that window).
  const openProject = useCallback((root: string) => {
    void execute("window.open", { root }, { remote: false }).catch(() => {});
  }, []);

  // Project creation — the control plane is the single surface for open and create (the workspace
  // picker is gone). The modal prepares and validates the folder, and this opens a new workspace
  // window at that root.
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const createProject = useCallback(async (args: CreateProjectArgs) => {
    await execute(
      "window.open",
      { root: args.root, ...(args.alias ? { alias: args.alias } : {}), ...(args.shell ? { shell: args.shell } : {}) },
      { remote: false },
    );
  }, []);

  useEffect(() => {
    // Native title (distinguishes entries in the Dock window list) — same rule as a project window:
    // name only, no app-name suffix.
    void currentWindow().setTitle(t("orch.title")).catch(() => {});
    // Live subscription after the backfill (cursor) — 0 polling. Subscribe/unsubscribe goes through
    // the single safeListen utility (guards double unsubscribe). The backfill is a convenience and
    // the subscription is the substance — start without it if it fails, but record the reason.
    void backfillFeed<ActivityEntry>(
      () => invoke<ActivityEntry[]>("activity_recent", { since: null, limit: 200 }),
      (reason) => console.warn(`[orchestrator] ${reason}`),
    ).then(setFeed);
    const un = safeListen<ActivityEntry>("activity", (ev) => {
      const e = ev.payload;
      setFeed((cur) => {
        if (cur.length && cur[cur.length - 1].seq >= e.seq) return cur; // dedup the backfill overlap
        const next = [...cur, e];
        return next.length > FEED_CAP ? next.slice(next.length - FEED_CAP) : next;
      });
      if (!atBottomRef.current) setUnread((u) => u + 1); // while scrolled up, accumulate unread
    });
    // The core broadcasts on every project open/close and owning-window change — the left project
    // list refreshes automatically.
    const unReg = safeListen("project-registry-change", refreshProjects);
    refreshProjects();
    return () => {
      un();
      unReg();
    };
  }, [refreshProjects]);

  // On a new item: if at the bottom, keep following. If scrolled up, leave the scroll alone and
  // report through the unread badge (onFeedScroll tracks atBottomRef).
  useEffect(() => {
    const el = feedRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [feed]);

  const runCommand = useCallback(async () => {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    // A `>` prefix = straight to the raw command (the original console — the power-user and E2E
    // path). The default is a natural-language turn.
    if (trimmed.startsWith(">")) {
      const rawCmd = trimmed.slice(1).trim();
      if (!rawCmd) return;
      const sp = rawCmd.indexOf(" ");
      const name = sp < 0 ? rawCmd : rawCmd.slice(0, sp);
      let params: Record<string, unknown> = {};
      if (sp >= 0) {
        try {
          params = JSON.parse(rawCmd.slice(sp + 1)) as Record<string, unknown>;
        } catch (e) {
          setResult(t("orch.paramsJsonError", { error: String(e) }));
          return;
        }
      }
      // The console is a human hand — ui origin (the danger gate is remote-only). Instrumentation
      // records the execution in the feed.
      const out = await execute(name, params, { remote: false });
      setResult(JSON.stringify(out, null, 2));
      return;
    }
    // Natural-language turn — the feed's chat card shows progress and the answer
    // (chat.prompt→…→chat.answer). The stage is not passed along: a rail selection is only a feed
    // filter (filter ≠ intent). The default stage is the "last focused workspace window" the core
    // tracks (orchestrator/agent.ts).
    setCmd("");
    setResult("");
    const out = await execute("orchestrator.ask", { text: trimmed }, { remote: false });
    // Only a rejection before the set opens (BUSY and the like) goes to the result box — errors
    // after the set closed are shown by the card.
    if (!out.ok && (out.code === "BUSY" || out.code === "INVALID_PARAMS")) {
      setResult(`${out.code}: ${out.message}`);
    }
  }, [cmd]);

  return (
    <div className="orch-root" data-node="orch">
      <header className="orch-header" data-node="titlebar" {...dragRegion}>
        <span className="orch-title">{t("orch.title")}</span>
        <button
          type="button"
          className={`icon-btn orch-pin${pinned ? " active" : ""}`}
          data-node="orch/pin"
          title={pinned ? t("orch.unpin") : t("orch.pin")}
          aria-pressed={pinned}
          onClick={togglePin}
        >
          <Icon name={pinned ? "pin-filled" : "pin"} />
        </button>
      </header>
      <div className="orch-body">
        <section className="orch-map" data-node="orch/map">
          <h2>{t("orch.projects")}</h2>
          {/* "All" = clears the feed filter. It is a filter selection, so it stays in the list (not as a badge to the right of the feed). */}
          <button
            type="button"
            className={`orch-proj all${selected === null ? " selected" : ""}`}
            data-node="orch/proj/all"
            onClick={() => setSelected(null)}
          >
            {t("orch.allProjects")}
          </button>
          {projects.map((p) => {
            const open = p.window !== null;
            return (
              <div
                key={p.root}
                className={`orch-proj${open ? "" : " closed"}${
                  selected?.root === p.root ? " selected" : ""
                }`}
              >
                {/* Label click: an open project filters the feed to its window. A closed one is not opened —
                    opening a window is the job of the right-hand icon alone (a selection must not force a window into existence). */}
                <button
                  type="button"
                  className="orch-proj-label"
                  data-node={`orch/proj/${p.name}`}
                  title={p.root}
                  onClick={() => open && p.window && setSelected({ root: p.root, window: p.window })}
                >
                  {p.name}
                </button>
                {/* Right-hand icon: one arrow for both cases (+ reads as "add") — color separates them.
                    Open = bring that window forward, closed = open it in a new window. */}
                <button
                  type="button"
                  className="orch-proj-call"
                  data-node={`orch/proj-call/${p.name}`}
                  title={open ? t("orch.callWindow") : t("orch.openProject")}
                  onClick={() => (open ? focusWindow(p.window as string) : openProject(p.root))}
                >
                  <Icon name="arrow-up-right" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="orch-proj-new"
            data-node="orch/new-project"
            onClick={() => setNewProjectOpen(true)}
          >
            <Icon name="add" size="sm" /> {t("project.new")}
          </button>
        </section>
        <section className="orch-feed-wrap">
          <h2>
            {t("orch.feed")}
            {selected && (
              <span className="orch-feed-scope">
                {" — "}
                {projects.find((p) => p.root === selected.root)?.name ?? selected.window}
              </span>
            )}
          </h2>
          <div className="orch-feed" data-node="orch/feed" ref={feedRef} onScroll={onFeedScroll}>
            {(() => {
              // Folding runs over the whole feed before filtering (feedFold — parentId is canonical
              // plus a legacy heuristic). Set visibility is decided by the parent: a chat card
              // (parent window = main = own) stays whole down to its children (w-*) whatever project
              // is selected — the set-level extension of "your own actions are always visible".
              const own = currentWindowLabel();
              const items = foldFeed(feed);
              const visible = selected
                ? items.filter(
                    (it) => itemWindow(it) === selected.window || itemWindow(it) === own,
                  )
                : items;
              return visible.map((it) =>
                it.kind === "chat"
                  ? renderChatCard(
                      it,
                      nameOf,
                      selected === null,
                      toggleExpand,
                      expanded,
                      t,
                      setZoomSrc,
                      () => void execute("orchestrator.stop", {}, { remote: false }),
                    )
                  : renderEntry(
                      it.entry,
                      nameOf,
                      selected === null,
                      toggleExpand,
                      expanded.has(it.entry.seq),
                      t,
                      setZoomSrc,
                      it.deltas,
                    ),
              );
            })()}
          </div>
          {unread > 0 && (
            <button
              type="button"
              className="orch-unread"
              data-node="orch/unread"
              onClick={() => {
                const el = feedRef.current;
                if (el) el.scrollTop = el.scrollHeight;
                setUnread(0);
              }}
            >
              <Icon name="arrow-down" /> {t("orch.unread")} {unread}
            </button>
          )}
        </section>
      </div>
      {newProjectOpen && (
        <NewProjectModal onClose={() => setNewProjectOpen(false)} create={createProject} />
      )}
      {zoomSrc && (
        <div
          className="orch-lightbox"
          data-node="orch/lightbox"
          onClick={() => setZoomSrc(null)}
          onKeyDown={(e) => e.key === "Escape" && setZoomSrc(null)}
          role="button"
          tabIndex={0}
        >
          <img alt="" src={zoomSrc} />
        </div>
      )}
      <footer className="orch-console">
        <input
          data-node="orch/console"
          value={cmd}
          placeholder={t("orch.consoleHint")}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runCommand();
          }}
        />
        <button type="button" data-node="orch/run" onClick={() => void runCommand()}>
          {t("orch.run")}
        </button>
        {result && <pre className="orch-result">{result}</pre>}
      </footer>
    </div>
  );
}
