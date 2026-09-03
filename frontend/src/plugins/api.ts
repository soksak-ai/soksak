// Plugin API — the host surface passed to activate(ctx) (soksak-spec-plugin v1 §0).
// Rules:
//   - Permissions gate the API surface (§0-2): an undeclared permission leaves its surface undefined.
//   - The registry is the single truth for commands (§0-1): registering exposes them to sok/MCP.
//   - The manifest is the single truth for declarations: an undeclared command/view/formatter is
//     rejected.
//   - The internal tracker collects every registration — deactivation cannot leak (§0-4).
//   - Dependencies are injected through deps (testable structure, not a workaround).

import { moduleState } from "../lib/moduleState";
import { runtimePluginRequirements, runtimeSidecarReferences } from "./runtimeDependencies";
import type {
  CommandContext,
  CommandOutcome,
  CommandSpec,
  ParamSpec,
} from "../commands/registry";
import { createStream, engineProvision } from "../framework";
import { declarePluginRealm, type PluginRealm } from "./realm";
import type { SurfacePointerInput } from "../lib/contentViews";
import { contentViewHost } from "../lib/contentViews";
import { registerSurfaceInputProvider } from "../lib/surfaceInputProviders";
import { currentWindowLabel } from "../lib/webviewLabels";
import { surfaceLabel } from "../lib/surfaceLabels";
import { busEmit, busOn } from "./bus";
import {
  onPluginEvent,
  emitPluginEvent,
  type Disposable,
  type PluginEventMap,
} from "./hooks";
import { gateContribution } from "./conformance";
import {
  attachViewPresentationRuntime,
  useViewRegistry,
  type PluginViewProvider,
} from "./viewRegistry";
import { useIconRegistry, validateIconSetData } from "../ui/icons/registry";
import {
  registerStatusBarItem,
  type StatusBarItem,
} from "../ui/statusBarItems";
import { registerHeaderAction, type HeaderAction } from "../ui/headerActions";
import { useUi } from "../state/ui";
import { pushNotification, type NotificationInput } from "../lib/notify";
import { playSound, BUILTIN_SOUNDS } from "../ui/sound";
import {
  runningCommands,
  subscribeOutput,
} from "../terminal/ptyBridge";
import {
  feedPtyOutput,
  registerPtyIo,
  getPtyIo,
} from "../terminal/ptyObservationStore";
import { EVENT_PERMISSIONS } from "./hooks";
import type { IconSetData } from "../ui/icons/types";
import {
  contractRequirementSatisfiedBy,
  configDefaults,
  pluginCommandName,
  qualifiedViewId,
  type ContractProviderRef,
  type ContractRequirement,
  type PluginManifest,
  type PluginPermission,
  type LocalizedText,
} from "./spec";
import { localize, readingLanguage, tmsg } from "../i18n";
import { usePluginSettings, type SettingValue } from "../state/pluginSettings";
import { useSessions } from "../state/sessions";
import { redeemDropGrant } from "./dropGrants";

export type { Disposable } from "./hooks";

// ── Dependency injection surface ─────────────────────────────────────────────

/** Short key the plugin passes. The deps table maps it to the wire name (canonical: core
 *  spec-content-view). */
export type ContentViewEventKey = "nav" | "title" | "status" | "open-external" | "loading";

export interface PluginApiDeps {
  appVersion: string;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  execute: (
    name: string,
    params: Record<string, unknown>,
    ctx: CommandContext,
  ) => Promise<CommandOutcome>;
  registerCommand: (name: string, spec: CommandSpec) => void;
  unregisterCommand: (name: string) => boolean;
  getCommandDanger: (name: string) => "destructive" | "inject" | undefined;
  implementsOf?: (pluginId: string) => ContractProviderRef[];
  on: typeof onPluginEvent;
  currentWorkspace: () => { id: string; root: string | null } | null;
  // Core fs watcher (fs-change) subscription — callback receives the changed parent directory string.
  // Returns the unsubscribe.
  onFsChange: (cb: (dir: string) => void) => () => void;
  // Core data store change (data-change) subscription — the core singleton broadcasts to every window
  // (multi-window, same-workspace consistency). app.data.watch filters by ns/coll/scope. Returns the
  // unsubscribe. (Precedent: onFsChange.)
  onDataChange: (cb: (e: DataChangeEvent) => void) => () => void;
  // All-window clipboard change (clipboard-change) subscription — callback receives the changed text.
  // Returns the unsubscribe. (Precedent: onFsChange.) Polling is macOS-only (no NSPasteboard event);
  // Win/X11/Wayland use native events — the core absorbs the difference.
  onClipboardChange: (cb: (text: string) => void) => () => void;
  // Terminal pane cwd snapshot/subscription plus command-finished subscription (bridged from core
  // ptyBridge). Exposed by app.terminal.
  getCwd: (paneId: string) => string | undefined;
  subscribeCwd: (paneId: string, cb: (cwd: string) => void) => () => void;
  subscribeCommandFinished: (paneId: string, cb: () => void) => () => void;
  // Label-filtered content-view event subscription — app.webview.on.
  //
  // `event` is a value on a fixed axis. Typed as `string`, a typo compiles into an event that never
  // arrives, and that absence never surfaces as an error. Use the same axis as the surface declaration.
  subscribeWebview: (
    label: string,
    event: ContentViewEventKey,
    cb: (payload: Record<string, unknown>) => void,
  ) => () => void;
}

// data-change payload — isomorphic to the core DataChange. coll/scope/id are null depending on the
// operation.
export interface DataChangeEvent {
  ns: string;
  coll: string | null;
  scope: string | null;
  op: string;
  id: string | null;
}

// ── Types the plugin sees ────────────────────────────────────────────────────

export interface PluginCommandSpec {
  // description is read by a person in the palette and in `sok` help, and by an LLM discovering the
  // command — both put it through a key, and a plugin's key mechanism is its own text (I18N.md I1).
  // One string stands for every language, which is what an untranslated plugin has; a language map
  // is resolved against the reader. triggers = non-English trigger words (language → word), which
  // the host's catalogJson composes onto the base (docs/I18N.md §3).
  description: LocalizedText;
  triggers?: Record<string, string>;
  params?: Record<string, ParamSpec>;
  /** "handler" = the handler owns parameter validation (parameters absent from the spec pass through).
   *  Used where the spec text is on the plugin side, like a static module — registry validate is
   *  skipped. */
  paramsAuthority?: "handler";
  returns?: string;
  examples?: readonly string[];
  danger?: "destructive" | "inject";
  /** Standard answer (MESSAGE-PROTOCOL §3) — turns success data into a one-line human-readable message.
   *  Without it the answer degrades to a label and the loader warns (required at M5). Reference: runbook
   *  ok()/err(). */
  // A string, or a language map the host resolves against whoever asked. A plugin has no key in
  // the host table, so its sentence travels as text.
  message?: (data: Record<string, unknown>) => LocalizedText;
  /** @deprecated Renamed to message — transitional lifeline until the M5 sweep. New plugins use
   *  message. */
  summarize?: (data: Record<string, unknown>) => string;
  /** Spoken sentence (speak, §3) — the only speech axis: with speak, speak(outcome) is the sentence on
   *  success and failure alike; without it message is the fallback; "" = silence. say-type commands cut
   *  feedback with speak: () => "". */
  speak?: (out: { ok: boolean; code: string; message: string; data?: Record<string, unknown> }) => string;
  /** Trace spec (MESSAGE-PROTOCOL §4) — false = the run is excluded from the activity trace. Declare it
   *  only for commands that inflate the stream as a by-product of observation (say-type: one run record
   *  per spoken line). */
  trace?: false;
  /** hint — takes data on success or {code,message} on failure and offers up to 3 follow-up commands.
   *  An offer, not an instruction: information for the caller's own decision. */
  hint?: (
    data: Record<string, unknown>,
    ctx: PluginInvocation,
  ) => { cmd: string; why: string }[];
  /** inv = the execution context of this call (§5 inheritance). A handler that nests another command
   *  must use inv.execute — the parent's origin (schedule firing and such) and correlation (parentId:
   *  conversation turn) are inherited by the child run. Calling app.commands.execute disguises it as
   *  human origin and pollutes speech and emphasis (measured: the nested lookup in schedule reconcile
   *  was spoken on every firing). */
  handler: (
    params: Record<string, unknown>,
    inv?: PluginInvocation,
  ) => Promise<object> | object;
}

/** Invocation context injected into a command handler — the channel that inherits origin and correlation
 *  for nested runs (§5). */
export interface PluginInvocation {
  /** Run origin — omitted = human, "schedule" = schedule firing, and so on. */
  origin?: string;
  /** Correlation parent (conversation turn id) — when present, this run is part of that turn's set. */
  parent?: string;
  /** The pane the call came from, when the caller had one. What "the one in front of me" resolves
   *  against — absent means the caller named no pane, and a handler that needs one refuses rather
   *  than picking. */
  pane?: string;
  /** Nested run that inherits the parent context — use this for command calls inside a handler. */
  execute: (
    name: string,
    params?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; code: string; message: string; data?: Record<string, unknown> }>;
}

// Scheduler trigger (isomorphic to the core schedule.rs Trigger — forwarded in wire form). every_ms
// matches the core serde field name (a thin forward with no mapping). reconcile = a timerless poke event
// trigger.
export type SchedulerTrigger =
  | { kind: "at"; at: number } // one shot at an absolute ms (immediate when already past).
  | { kind: "every"; every_ms: number; anchor?: number } // fixed period (anchor grid).
  | { kind: "cron"; expr: string } // 5-field cron (UTC).
  | { kind: "reconcile" }; // once at registration (boot scan) + on poke.

export interface SchedulerRetry {
  max: number; // max retry count (0 = none).
  base_ms: number; // backoff base.
  max_ms: number; // backoff ceiling.
}

export interface SchedulerJobView {
  id: string;
  trigger: SchedulerTrigger;
  command: string;
  params: Record<string, unknown>;
  next_at: number | null; // next scheduled firing (null = idle or finished).
  running: boolean;
  concurrency: number;
}

export interface SoksakPluginApi {
  appVersion: string;
  pluginId: string;
  /** Identity and capability declaration of the realm this app runs in (§realm). Read it instead of
   *  probing for a surface — the same bundle is evaluated in the window realm and the child renderer
   *  realm, and their surfaces differ. */
  realm: PluginRealm;
  // The language to answer in (permission-free context §3.5) — the caller's inside a command, this
  // window's own outside one. A change to the window's own arrives as the locale.changed event.
  //
  // Measured 2026-08-18: this read the window's setting only, so a plugin command answered an
  // English `sok` call in Korean whenever the window was Korean (I18N.md I4a).
  locale: () => string;
  /** Window label of this plugin instance (multi-window — for per-window state and credential
   *  records). */
  windowLabel: () => string;
  commands?: {
    /** opts.origin — self-declaration for automatic behavior (§5): a run that is not human intent
     *  (backfill lookup, speech) declares "internal". It is still recorded; only its exposure (dimmed,
     *  not spoken) drops. */
    execute: (
      name: string,
      params?: Record<string, unknown>,
      opts?: { origin?: string },
    ) => Promise<CommandOutcome>;
    register: (name: string, spec: PluginCommandSpec) => Disposable;
  };
  events: {
    on: <K extends keyof PluginEventMap>(
      event: K,
      fn: (payload: PluginEventMap[K]) => void,
    ) => Disposable;
    /** Publish a progress delta (MESSAGE-PROTOCOL §2) — a long-running command reports what it is doing
     *  into the activity stream. Converting sidecar events into standard progress is the consuming
     *  plugin's job (A14 — the core is a blind relay). source is fixed to the plugin id, so the
     *  publisher is always visible. */
    progress: (command: string, delta: unknown) => void;
  };
  /** Self-described activity-log publish — a plugin publishes its own domain activity without a core
   *  bridge (§3). Display = message (plugin i18n), speech = optional speak. Consumers render only those
   *  two, blind to kind. source is fixed to the id. */
  activity: {
    publish: (
      kind: string,
      entry: { message: string; speak?: string } & Record<string, unknown>,
    ) => void;
  };
  ui?: {
    registerView: (viewId: string, provider: PluginViewProvider) => Disposable;
    /** Opens this plugin's view as a content tab. A view that stands beside the work is put there
     *  by arranging a set and standing it in a place; there is nothing to open. */
    openView: (viewId: string) => Promise<CommandOutcome>;
    /** Register an icon set (contributes.iconSets declaration required). data must supply every semantic
     *  name. */
    registerIconSet: (setId: string, data: unknown) => Disposable;
    /** Register or update a status bar item bound to a paneId (same id replaces — call again to toggle
     *  active). Shown in the status bar of the group where that pane is the active terminal. Returns the
     *  unsubscribe. */
    statusBarItem: (item: StatusBarItem) => Disposable;
    /** Register a toggle icon next to the right-hand titlebar controls (sidebar, dark mode, settings).
     *  Same id replaces — call again to toggle active. Requires the "ui:titlebar" permission. Returns
     *  the unsubscribe. */
    registerHeaderAction: (action: HeaderAction) => Disposable;
    /** Activate the input gate while a modal/overlay is shown, so clicks over the native content webview
     *  area land. Requires a "ui:overlay:*" permission. Call true on show and false on hide/cleanup (the
     *  caller balances the pair). */
    setOverlayActive: (active: boolean) => void;
    /** Sidebar tab badge for this plugin view (unread marker). number = count, "dot" = dot, null =
     *  clear. Inside a view use mount ctx.setBadge; this one updates from outside the view.
     *  Per-window. */
    setViewBadge: (viewId: string, badge: number | "dot" | null) => void;
  };
  storage?: {
    read: (key: string) => Promise<unknown>;
    write: (key: string, value: unknown) => Promise<void>;
    /** Take back one value. Without it a record outlives the thing it was for and nothing reaches
     *  it, and the store grows by everything that ever existed. */
    remove: (key: string) => Promise<void>;
    list: () => Promise<string[]>;
  };
  /** General-purpose embedded data store (core SQLite singleton). DB-agnostic — raw SQL is not exposed.
   *  The namespace is forced to this plugin id (another plugin's data is invisible). scope = per-workspace
   *  partition (e.g. projectId). watch = all-window change subscription (zero polling,
   *  multi-window/same-workspace consistent). "data" permission only. */
  data?: {
    kv: {
      get: (key: string) => Promise<unknown>;
      set: (key: string, value: unknown) => Promise<void>;
      delete: (key: string) => Promise<boolean>;
      keys: (prefix?: string) => Promise<string[]>;
      /** All-window subscription to kv changes (set/delete) in this plugin ns — applies CLI/MCP and
       *  other-window changes with zero polling. The callback receives the changed key. Collection
       *  changes are excluded (that is data.watch). Returns the unsubscribe. */
      watch: (cb: (key: string | null) => void) => Disposable;
    };
    /** Define a collection (idempotent) — indexes = structured query fields, fts = CJK full-text search
     *  fields. */
    define: (
      collection: string,
      opts: { indexes?: string[]; fts?: string[] },
    ) => Promise<void>;
    /** Upsert a record. Without an id one is generated and returned. The canonical id is injected into
     *  doc. */
    put: (
      collection: string,
      doc: Record<string, unknown>,
      opts?: { scope?: string; id?: string },
    ) => Promise<string>;
    get: (
      collection: string,
      id: string,
      opts?: { scope?: string },
    ) => Promise<unknown>;
    delete: (
      collection: string,
      id: string,
      opts?: { scope?: string },
    ) => Promise<boolean>;
    /** Structured query — where fields must be declared in define's indexes (or be created/updated). */
    query: (
      collection: string,
      opts?: {
        scope?: string;
        where?: Record<string, unknown>;
        order?: string;
        desc?: boolean;
        limit?: number;
        offset?: number;
      },
    ) => Promise<unknown[]>;
    /** CJK full-text search (FTS5 trigram). A query under 3 code points falls back to LIKE. */
    search: (
      collection: string,
      text: string,
      opts?: { scope?: string; limit?: number },
    ) => Promise<unknown[]>;
    count: (
      collection: string,
      opts?: { scope?: string; where?: Record<string, unknown> },
    ) => Promise<number>;
    /** retention (R5) — when the (coll,scope) count exceeds cap, evict the oldest by created. Returns
     *  the delete count. Called by persistent collections. */
    retentionTrim: (collection: string, scope: string, cap: number) => Promise<number>;
    /** retention (R5) — delete records with created < cutoffMs (time axis). Returns the delete count. */
    retentionReap: (collection: string, cutoffMs: number) => Promise<number>;
    /** Change subscription — callback on put/delete in this ns and coll (and that scope when given),
     *  across every window. Returns the unsubscribe. */
    watch: (
      collection: string,
      opts: { scope?: string } | undefined,
      cb: (e: DataChangeEvent) => void,
    ) => Disposable;
  };
  /** Encrypted secret vault (core crypto, no OS keychain dependency). Seals sensitive values such as API
   *  keys and tokens. The namespace is forced to this plugin id (same isolation as app.data). No get —
   *  plaintext readback is blocked (injection only). While the vault is locked, calls reject("vault
   *  locked"). "secrets" permission only. */
  secrets?: {
    /** Create a sealed random value when absent. Plaintext is never returned. */
    generate: (key: string, bytes: number) => Promise<{ created: boolean }>;
    /** Store a sealed value (envelope: a per-item DEK wrapped by the KEK). Same key replaces. */
    set: (key: string, value: string) => Promise<void>;
    /** Whether the key exists (the value is not exposed). */
    has: (key: string) => Promise<boolean>;
    /** Delete a key (true when it existed). */
    delete: (key: string) => Promise<boolean>;
    /** Key list for this ns only, not values (plaintext blocked). */
    keys: () => Promise<string[]>;
    /** Vault backend and lock state ({ backend:"vault", unlocked }). */
    backend: () => Promise<{ backend: string; unlocked: boolean }>;
  };
  /** General-purpose scheduler (core — fires commands on at/every/cron, and state ticks on reconcile).
   *  Time-based jobs are persistent (crash recovery). A job never runs twice concurrently with itself
   *  (lease). Failures retry with backoff. "schedule" permission. */
  scheduler?: {
    /** Register a job (idempotent — a given id replaces). Returns the id. command = the registry command
     *  to fire. retry/concurrency optional. */
    register: (job: {
      trigger: SchedulerTrigger;
      command: string;
      params?: Record<string, unknown>;
      id?: string;
      retry?: SchedulerRetry;
      concurrency?: number;
      /** Per-firing upper bound (ms) on waiting for the command reply — non-process jobs only
       *  (notify.show and such). Defaults to 30s, clamped by the core to [1s,3600s]. process_lease jobs
       *  ignore it (process-lifetime lease). */
      timeout_ms?: number;
      /** Opt-in to a process-lifetime lease. When true: if the fired command (exec-one) runs a process
       *  and holds its reply until onExit, the core holds the lease and waits for that reply (= process
       *  exit) — it never cuts a running process off, even a 1h search. Normal exit → ok, crash →
       *  ok:false → backoff. Only a zombie (a reply that never comes) is reaped at
       *  zombie_backstop_ms. */
      process_lease?: boolean;
      /** Zombie backstop for a process-lifetime job (ms after claim). Reaps only when the reply never
       *  comes. null = unbounded (until reply/cancel, human intervention). With process_lease and no
       *  value, defaults to 3h (10_800_000). */
      zombie_backstop_ms?: number | null;
    }) => Promise<string>;
    /** Request an immediate firing — that job when an id is given, otherwise every reconcile job
     *  (completion triggers, external changes). */
    poke: (id?: string) => Promise<void>;
    /** Cancel a job (also removes the persisted record; a firing process job's wait is woken at once).
     *  True when it existed. */
    cancel: (id: string) => Promise<boolean>;
    /** List registered jobs (ascending next_at). */
    list: () => Promise<SchedulerJobView[]>;
  };
  /** A notification is the same grade of object as a push (rich payload). In-app banner when focused, OS
   *  notification when not, with the same payload. Click/action activates through a deepLink
   *  (soksak://cmd/...) with the permission and danger gates intact. "notify" permission. */
  notify?: {
    push: (n: NotificationInput) => Promise<void>;
  };
  /** Notification sound (pure Web Audio). A builtin (default/ping/chime/success/alert) or a URL/asset
   *  path. */
  sound?: {
    play: (sound: string) => Promise<void>;
    builtins: () => string[];
  };
  fs?: {
    /** Read text. With offset (bytes) it reads from that point to the end — an incremental tail of a
     *  growing log. Track totalBytes as the next offset to read only the delta. truncated = the safety
     *  limit was exceeded. */
    readText?: (
      path: string,
      offset?: number,
    ) => Promise<{ text: string; truncated: boolean; totalBytes: number }>;
    /** Read a file as bytes → { base64, bytes }. No media type: the core reads the disk and holds
     *  no view of what a file is. Whoever renders it supplies that — an editor for its languages, an
     *  image viewer for its formats, an HWP plugin for one. "fs:read" permission. */
    readBinary?: (path: string) => Promise<{ base64: string; bytes: number }>;
    /** Local file → a URL a webview can load (core standard). Idempotent per path. Pass the media
     *  type this plugin reads the file as; without it the blob has none and the webview is left to
     *  sniff. Gated on "fs:read". */
    url?: (path: string, mime?: string) => Promise<string>;
    writeText?: (path: string, content: string) => Promise<void>;
    /** Direct children of a directory. With meta:true each child includes modified (unix seconds), for
     *  picking the newest file. */
    list?: (path: string, opts?: { meta?: boolean }) => Promise<unknown>;
    /** Watch a directory (core watcher, no polling). Calls cb(dir) on a change inside dir. Non-recursive
     *  — watch subfolders separately. Returns the unwatch. */
    watch?: (dir: string, cb: (dir: string) => void) => Disposable;
  };
  /** System clipboard — each method is gated on its read/write permission. watch = all-window change
   *  subscription (polling is macOS-only; the core absorbs the per-OS difference). The callback receives
   *  the changed text; the subscription itself is what "clipboard:read" consents to. */
  clipboard?: {
    readText?: () => Promise<string>;
    writeText?: (text: string) => Promise<void>;
    watch?: (cb: (e: { text: string }) => void) => Disposable;
  };
  /** Explicit file drop grants. Grant ids are opaque, window- and Plugin-bound, and one-shot. */
  fileGrants: {
    redeem(id: string): Promise<{
      kind: "file" | "image";
      path: string;
    } | null>;
  };
  terminal?: {
    /** Snapshot of the commands running now (at most 1 per pane). The current-state form of the
     *  command.started/finished events — for a plugin activated mid-run to sync at once (not polling).
     *  "terminal" permission only. */
    runningCommands?: () => {
      paneId: string;
      commandLine: string;
      cwd: string | null;
    }[];
    /** Inject raw input into the pane's terminal PTY — typing into whatever program is running.
     *  Enter is "\r". False before it is ready. "terminal:write" permission only. */
    sendText?: (paneId: string, text: string) => boolean;
    /** Screen text of the pane terminal (last `lines` lines; default is the whole viewport plus
     *  scrollback). undefined before it is ready. "terminal:read" permission only. For live TUI stream
     *  display and verifying input landed. */
    readBuffer?: (paneId: string, lines?: number) => string | undefined;
    /** Subscribe to pane terminal screen updates (coalesced to once per frame, no polling). Returns the
     *  unsubscribe. "terminal:read" permission only — triggers a buffer re-read (live stream, input
     *  verification). */
    onOutput?: (paneId: string, cb: () => void) => Disposable;
    /** Snapshot of this pane terminal's current working directory (cwd). undefined before shell
     *  integration (OSC 7/633). "terminal" permission. Used with ctx.paneId by cwd-following views such
     *  as a file explorer. */
    getCwd?: (paneId: string) => string | undefined;
    /** Subscribe to pane cwd changes (no polling). Fires once at registration when a value already
     *  exists. Returns the unsubscribe. "terminal" permission. */
    onCwd?: (paneId: string, cb: (cwd: string) => void) => Disposable;
    /** Subscribe to command completion in the pane (OSC 133/633 D) — triggers refresh of derived state
     *  such as git. Returns the unsubscribe. "terminal" permission. */
    onCommandFinished?: (paneId: string, cb: () => void) => Disposable;

    // Below: the owner's half. Everything above reads a pane somebody else drives; these two are how
    // that somebody supplies it.
    //
    // They were reached through `app.pty` while the core spawned the shell itself, which put the
    // owner's half inside a device capability it has nothing to do with. Whoever drives a shell now
    // drives it through a declared sidecar, and the core sees no bytes unless it is given them.

    /** Hand the decoder this pane's raw output.
     *
     *  The core decodes OSC 7/133/633 out of it — working directory, command boundaries — and
     *  answers `getCwd`, `onCommandFinished` and the rest from what it found. It decodes a protocol
     *  and interprets nothing: what a command boundary *means* is the caller's.
     *
     *  Without this the readings above stay empty on a pane that is running perfectly, which reads
     *  as shell integration that is not working rather than as a stream nobody supplied. */
    observe?: (paneId: string, bytes: Uint8Array) => void;
    /** Hand the host a way to read this pane's screen and to type into it.
     *
     *  `readBuffer`, `sendText` and `onOutput` above resolve through this registration, and without
     *  it they answer "not ready" for a pane that is running. The screen is whoever drew it's,
     *  so there is no other way for the host to reach it. Dispose on unmount. */
    registerIo?: (
      paneId: string,
      io: { readBuffer: (lines?: number) => string; sendInput: (data: string) => void },
    ) => Disposable;
  };
  /**
   * Declares to the core that this plugin delivers pointer input for its own surfaces.
   *
   * The core's own path has no route to a surface drawn by an engine sidecar — send a gesture to it and
   * the core has no place to deliver it (measured 2026-08-08: only one of three browsers worked).
   * Special-casing that engine in the core would couple them, so the owner answers for itself and the
   * core only delivers.
   *
   * `owns` takes one label and answers whether it is this plugin's — the core never guesses from label
   * syntax. The return value is the unsubscribe: when the view goes away so does the owner (leaving it
   * keeps sending to a dead sidecar).
   */
  /** A native surface this plugin owns: its label and the door for the kind's own verbs.
   *  "surface" permission. The pixels come from a render sidecar; this process composites them. */
  surface?: {
    label: (kind: string, viewId: string) => string;
    deliver: (label: string, message: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };

  provideSurfaceInput?: (provider: {
    owns: (label: string) => boolean;
    labelOfView?: (viewId: string) => string | null;
    sendInput: (label: string, input: {
      x: number; y: number;
      kind: "down" | "up" | "move" | "drag" | "enter" | "exit";
      button: "left" | "middle" | "right";
      clickCount: number;
      modifiers: { shift: boolean; alt: boolean; control: boolean; meta: boolean };
    }) => Promise<void>;
    sendWheel: (label: string, input: {
      x: number; y: number; deltaX: number; deltaY: number;
      deltaMode: "pixel" | "line" | "page";
      modifiers: { shift: boolean; alt: boolean; control: boolean; meta: boolean };
    }) => Promise<void>;
    inputState: (label: string, at?: { x: number; y: number }) => Promise<Record<string, unknown>>;
  }) => () => void;

  /** Child webview (WKWebView) the core embeds and drives — owned by a content view such as a browser.
   *  "webview" permission. The core creates and owns the native webview under a label key; the plugin
   *  drives it by label (JS cannot create a WKWebView). macOS first — eval/inject are macOS-only
   *  (graceful error/no-op elsewhere). */
  webview?: {
    /** Public axis a product uses to decide optional features. Do not branch on the adapter name. */
    capabilities: Readonly<{
      supportsDocumentStart: boolean;
      supportsInputInjection: boolean;
    }>;
    /**
     * kind + viewId → a label unique across every window: `<kind>-<window>-<view>`.
     *
     * The shape is the core's, because the window part is what makes the value unique and a plugin
     * rebuilding it inline would drop it — two windows then produce one label and the second
     * addresses the first window's surface. The kind is the caller's word: pass the same one the
     * declaration puts in `data-native-surface`.
     *
     * Until 2026-08-16 the core supplied the kind as well, so a browser was handed its own
     * identifier and no second kind of surface had anywhere to get a label from.
     */
    label: (kind: string, viewId: string) => string;
    /** Create a content view. With a published slot the adapter owns the rect; x/y/w/h apply only to a
     *  slotless surface. */
    open: (
      label: string,
      o: { url: string; x?: number; y?: number; w?: number; h?: number },
    ) => Promise<void>;
    /** Sync the slot rect (split/resize — once per frame recommended). */
    bounds: (label: string, x: number, y: number, w: number, h: number) => Promise<void>;
    /** Show or hide (the hidden slot of a tab switch or maximize). */
    visible: (label: string, visible: boolean, focus?: boolean) => Promise<void>;
    /** Real liveness — answers from the native view's window attachment, not the registry (the only
     *  surface that identifies a zombie). */
    alive: (label: string) => Promise<boolean>;
    /** Navigate to a URL. */
    navigate: (label: string, url: string) => Promise<void>;
    /** Per-view page zoom (0.25..4.0) — effective scale = window zoom × this value. Returns the applied
     *  view scale. */
    zoom: (label: string, factor: number) => Promise<number>;
    /** Open a URL in a standalone OS window (a new browser window). Unrelated to label-keyed webviews —
     *  the core creates the popup window itself (a general webview host surface, used by plugins that
     *  open a link in a new window). */
    openWindow: (url: string) => Promise<void>;
    /** Move through session history (delta = -1 back, +1 forward). */
    history: (label: string, delta: number) => Promise<void>;
    /** Stop loading (WKWebView stopLoading) — for the toolbar reload↔stop toggle. */
    stop?: (label: string) => Promise<void>;
    /** Reload — not the same as navigating to the current URL again (that pushes one more history
     *  entry). */
    reload: (label: string, ignoreCache?: boolean) => Promise<void>;
    /** What the surface is showing, read from the surface itself.
     *
     *  The address passed to navigate is a request. A redirect, a load that failed and a load still
     *  running are all invisible in it, and on a screen that has not painted the three look the
     *  same. The fields belong to the surface kind, so core reads none of them. */
    pageState: (label: string) => Promise<Record<string, unknown>>;
    /** One surface kind's own verb, forwarded unread to the backend that owns the label. */
    deliver: (label: string, message: Record<string, unknown>) => Promise<Record<string, unknown>>;
    /** Toggle the OS inspector (devtools) → whether it is open. */
    devtools: (label: string) => Promise<boolean>;
    /** Run JS in the page and return the result string (AI/E2E DOM control). macOS only. */
    eval: (label: string, js: string) => Promise<string>;
    /** Inject an init script (document-start/end, re-injected on every navigation). macOS only (no-op
     *  elsewhere). The returned Disposable is for tracking — removing an individual WKUserScript is
     *  unsupported (it stays for the webview's lifetime). */
    injectScript: (
      label: string,
      code: string,
      phase?: "document-start" | "document-end",
    ) => Disposable;
    /** The real engine input path. When the capability is false the implementation rejects with its
     *  name. */
    sendInput: (label: string, input: SurfacePointerInput) => Promise<void>;
    /** The real engine wheel input. Coordinates are view CSS px; delta signs match DOM WheelEvent. */
    wheel: (label: string, x: number, y: number, dx: number, dy: number) => Promise<void>;
    captureFull: (label: string, path: string, width: number, height: number) => Promise<{ path: string; bytes: number }>;
    /** Put a committed string into the focused editable element through the engine's text input path. */
    typeText: (label: string, text: string) => Promise<void>;
    /** Subscribe to webview events: "nav"({url}), "title"({title}), "status", "open-external"({url}).
     *  Returns the unsubscribe. */
    on: (
      label: string,
      event: ContentViewEventKey,
      cb: (payload: Record<string, unknown>) => void,
    ) => Disposable;
    /** List the currently live webview labels (prefix filter). For GC and cleanup. */
    list: (prefix?: string) => Promise<string[]>;
    /** Close the webview and clean up. */
    close: (label: string) => Promise<void>;
  };
  // `app.pty` stood here until 2026-08-20: spawn, write, resize, close, onData, and the daemon
  // commands behind them.
  //
  // A sidecar owns each shell now. A plugin declares the sidecar requirement, drives it through
  // `app.sidecar`, and hands the bytes to `app.terminal.observe` so the decoder still sees them —
  // which is the only part of this the core ever needed. A second implementation of a shell, on
  // another platform or another machine, installs with no edit here, and that was impossible while
  // this capability was the core's.
  /** Spawn an external subprocess with bidirectional raw stdio (general purpose — LSP/MCP/ACP/any CLI).
   *  "process" permission. Pure pipes rather than a PTY, so JSON-RPC framing stays intact. Event-driven
   *  (zero polling). */
  process?: {
    /** Spawn a program → handle (id). cwd/env optional. envRemove = keys to strip from the parent env
     *  (removing a nesting guard, for example). secretEnv = envVar → secretKey (a secret in this plugin
     *  ns). JS never touches plaintext — pass key names only and the core boundary resolves them from
     *  the vault into the child env (no exposure through shell args, ps, or history, R2). Locked or
     *  missing keys fail the spawn. Sidecars are opened through app.sidecar, not this process API. */
    spawn: (
      cmd: string,
      args: string[],
      opts?: {
        cwd?: string;
        env?: Record<string, string>;
        envRemove?: string[];
        secretEnv?: Record<string, string>;
      },
    ) => Promise<number>;
    /** Write to stdin (JSON-RPC frames and such). */
    write: (handle: number, data: string) => Promise<void>;
    /** Close stdin (the child keeps running) — delivers EOF to a child that reads its pipe input to end.
     *  Idempotent. */
    closeStdin: (handle: number) => Promise<void>;
    /** Subscribe to stdout bytes (returns the unsubscribe). Bytes arriving before the listener registers
     *  are buffered, so nothing is lost. */
    onData: (handle: number, cb: (data: Uint8Array) => void) => Disposable;
    /** Subscribe to stderr bytes (returns the unsubscribe). */
    onStderr: (handle: number, cb: (data: Uint8Array) => void) => Disposable;
    /** Subscribe to the exit code (returns the unsubscribe). When the exit came first, the callback
     *  fires once immediately. */
    onExit: (handle: number, cb: (code: number) => void) => Disposable;
    /** Kill and clean up. */
    kill: (handle: number) => Promise<void>;
  };
  /** Sidecar (engine module) channel — loads a shared native module declared in manifest sidecars[] into
   *  the app process and exchanges opaque JSON messages. "sidecar" permission (caution). The core is a
   *  blind relay (message meaning is a private plugin↔sidecar contract — docs/SIDECARS.md). A loaded
   *  module stays resident (there is no unload). */
  sidecar?: {
    /** Open a declared sidecar → channel handle. An undeclared name is rejected (declaration ≡ reality).
     *  The first open loads, validates, and inits. */
    open: (name: string, opts?: {
      secretEnv?: Record<string, string>;
      generatedSecretEnv?: Record<string, { key: string; bytes: number }>;
    }) => Promise<SidecarHandle>;
  };
  /** WebSocket client (plain ws://). "network" permission. Unlike the browser WebSocket it sends no
   *  Origin header, so it connects to servers that check Origin (webOS TV SSAP and such). Event-driven
   *  (zero polling). */
  ws?: {
    /** Connect to a ws:// URL → handle (id). Resolves after the connection is established. */
    connect: (url: string) => Promise<number>;
    /** Send a text frame. */
    send: (handle: number, text: string) => Promise<void>;
    /** Subscribe to received text (returns the unsubscribe). Text arriving before registration is
     *  buffered, so nothing is lost. */
    onMessage: (handle: number, cb: (text: string) => void) => Disposable;
    /** Subscribe to close (returns the unsubscribe). Fires once immediately when already closed. */
    onClose: (handle: number, cb: () => void) => Disposable;
    /** Close the connection and clean up. */
    close: (handle: number) => Promise<void>;
  };
  /** HTTP request (general purpose — the runbook api run type and such). "network" permission. The core
   *  performs the arbitrary-origin requests webview fetch cannot, plus secret header/body injection.
   *  secretSubst = placeholder → secretKey (this plugin ns). JS never touches plaintext — the core
   *  boundary resolves from the vault and substitutes the placeholders in url/headers/body (no exposure
   *  in history or the response, R2). impersonate="chrome" sends through a browser-fingerprint (JA3/JA4)
   *  backend, for passing fingerprint-blocking CDNs; "off" (default) is plain native-tls. An
   *  Authorization request uses redirect 0 and fails closed in chrome mode, where per-request redirect
   *  cannot be pinned. Response shape, secrets, and ns isolation are identical in both modes. */
  network?: {
    http: (req: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: string;
      contentType?: string;
      secretSubst?: Record<string, string>;
      impersonate?: "off" | "chrome";
    }) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
  };
  /** Plugin custom event bus — pub/sub on arbitrary topics (streaming coordination between plugins).
   *  Separate from the core-defined events (events.on). Example: acp-core emits session/update and the
   *  cockpit/lounge subscribe. No system access, so no permission is required (every plugin has it). */
  bus: {
    emit: (topic: string, payload: unknown) => void;
    on: (topic: string, fn: (payload: any) => void) => Disposable;
  };
  workspace: {
    current: () => { id: string; root: string | null } | null;
  };
  // User settings for this plugin (manifest configuration declaration). effective = workspace override ??
  // global ?? schema default. Read and subscribe only; the user changes settings from the settings
  // screen or a command.
  settings: {
    get: (key: string) => SettingValue | undefined;
    all: () => Record<string, SettingValue>;
    onChange: (cb: (all: Record<string, SettingValue>) => void) => Disposable;
  };
}

export interface PluginContext {
  app: SoksakPluginApi;
  manifest: PluginManifest;
  dir: string;
  // Disposables the plugin created itself; pushing one here disposes it on deactivation.
  subscriptions: Disposable[];
}

// ── Disposable collection ────────────────────────────────────────────────────

export class DisposableTracker {
  private items: Disposable[] = [];

  add<T extends Disposable>(d: T): T {
    this.items.push(d);
    return d;
  }

  wrap(dispose: () => void): Disposable {
    return this.add({ dispose });
  }

  // Dispose in reverse order — an individual failure is isolated (§0-4).
  disposeAll(): void {
    const items = this.items.splice(0).reverse();
    for (const d of items) {
      try {
        d.dispose();
      } catch (e) {
        console.error("plugin resource dispose failed:", e);
      }
    }
  }
}

// ── Management command block (§0-5, no self-propagation) ─────────────────────
// plugin.view.* is view open/close, not management, so it is allowed. plugin.<id>.* (plugin commands) is
// allowed too.

// Outside the hot-swap boundary — a fresh table is never refilled, because the code that fills it treats
// it as already filled.
const BLOCKED_MANAGEMENT = moduleState("plugins/api#BLOCKED_MANAGEMENT", () => new Set([
  "plugin.list",
  "plugin.install",
  "plugin.update",
  "plugin.remove",
  "plugin.enable",
  "plugin.disable",
  "plugin.reload",
]));
// Global set of plugin commands registered without message (label fallback) — the gate source
// plugin.conformance reports from (enforced at the publish/diagnostic boundary instead of rejected at
// load time, MESSAGE-PROTOCOL §3).
export const commandsMissingMessage = new Set<string>();

export function isBlockedForPlugins(name: string): boolean {
  // registry.* is an operator control plane: even a catalog lookup exposes descriptor/trust/credential
  // metadata. Enumerating individual names leaks by default whenever a new management command is added,
  // so the whole namespace is closed. Plugins read installable plugins through plugin.catalog only.
  return (
    BLOCKED_MANAGEMENT.has(name) ||
    name.startsWith("plugin.install.local") ||
    name === "sidecar.request" ||
    name.startsWith("sidecar.install.local") ||
    name.startsWith("registry.") ||
    // Plugins already receive ownership-fixed app.secrets/app.network facades. Exposing the
    // operator commands as a second path would let commands.execute choose an arbitrary vault
    // namespace and turn net.http.request into a credential confused deputy.
    name.startsWith("secret.") ||
    name === "net.http.request"
  );
}

// Extract the target plugin id from a command name (for the cross-plugin call decision).
// pluginCommandName = plugin.<id>.<cmd> (no dot in id). null = not cross-plugin: core commands (no
// plugin. prefix), plugin.view.* (host view ops), install management, and two-segment management
// segments). Only plugin.<id>.<cmd> returns <id>.
export function targetPluginId(name: string): string | null {
  if (!name.startsWith("plugin.")) return null;
  const rest = name.slice("plugin.".length);
  const dot = rest.indexOf(".");
  if (dot < 0) return null; // management (plugin.list and such) — isBlockedForPlugins blocks it.
  const seg = rest.slice(0, dot);
  if (seg === "view" || seg === "install") return null;
  return seg;
}

// Cross-plugin call authorization — whether the caller declared the target plugin in
// manifest.dependencies (direct dependency presence). Own commands, core, and view pass. An undeclared
// cross-plugin call returns the denial reason (null = allowed). Enforced at the call boundary, closing
// the gap where a dependencyGraph declaration only drove the install cascade and the consent display.
// Versions are install-time business.
// Call boundary — another plugin's command cannot be called without a declaration. There are two
// declaration axes, and either one passes:
//   L2 contract pin (consumes): the caller and target declare the same exact contract → pass.
//   L1 name pin (dependencies): the caller declares the target plugin id directly → pass.
// Neither one = denied. The boundary itself is unchanged; what changes is what gets declared (name →
// contract).
function crossPluginDenyReason(
  selfId: string,
  dependencies: Record<string, string> | undefined,
  consumes: ContractRequirement[] | undefined,
  implementsOf: ((pluginId: string) => ContractProviderRef[]) | undefined,
  commandName: string,
): string | null {
  const target = targetPluginId(commandName);
  if (target === null || target === selfId) return null;
  if (target in (dependencies ?? {})) return null;
  if (implementsOf) {
    const provided = implementsOf(target);
    if ((consumes ?? []).some((required) =>
      provided.some((provider) => contractRequirementSatisfiedBy(required, provider)))) {
      return null;
    }
  }
  return tmsg("plugin.call.undeclaredDependency", { target, command: commandName });
}

// ── API assembly ─────────────────────────────────────────────────────────────

const denied = (message: string): CommandOutcome => ({
  ok: false,
  code: "PERMISSION_DENIED",
  message,
});

// app.process implementation — per-handle (id) listeners plus a buffer for bytes arriving before
// registration (nothing lost). spawn builds 3 streams (stdout/stderr/exit), passes them to
// process_spawn, and onData/onStderr/onExit subscribe to them.
function createProcessApi(
  deps: PluginApiDeps,
  tracker: DisposableTracker,
  ns: string,
) {
  type Bytes = (d: Uint8Array) => void;
  interface ProcState {
    stdout: Set<Bytes>;
    stderr: Set<Bytes>;
    exit: Set<(code: number) => void>;
    stdoutBuf: Uint8Array[];
    stderrBuf: Uint8Array[];
    exitCode: number | null;
    receivers: Array<{ close(): void }>;
    receiversClosed: boolean;
  }
  const procs = new Map<number, ProcState>();
  const closeProcessReceivers = (state: ProcState) => {
    if (state.receiversClosed) return;
    state.receiversClosed = true;
    for (const receiver of state.receivers) receiver.close();
  };
  const dispatch = (set: Set<Bytes>, buf: Uint8Array[], b: Uint8Array) => {
    if (set.size) set.forEach((f) => f(b));
    else buf.push(b);
  };
  const subscribe = (set: Set<Bytes>, buf: Uint8Array[], cb: Bytes): Disposable => {
    set.add(cb);
    for (const b of buf.splice(0)) cb(b); // replay the pre-subscribe buffer at once (0 loss)
    return tracker.wrap(() => set.delete(cb));
  };
  return {
    async spawn(
      cmd: string,
      args: string[],
      opts?: {
        cwd?: string;
        env?: Record<string, string>;
        envRemove?: string[];
        secretEnv?: Record<string, string>;
      },
    ): Promise<number> {
      const st: ProcState = {
        stdout: new Set(),
        stderr: new Set(),
        exit: new Set(),
        stdoutBuf: [],
        stderrBuf: [],
        exitCode: null,
        receivers: [],
        receiversClosed: false,
      };
      const onStdout = createStream<ArrayBuffer>();
      onStdout.onmessage = (m) => dispatch(st.stdout, st.stdoutBuf, new Uint8Array(m));
      const onStderr = createStream<ArrayBuffer>();
      onStderr.onmessage = (m) => dispatch(st.stderr, st.stderrBuf, new Uint8Array(m));
      const onExit = createStream<number>();
      st.receivers = [onStdout, onStderr, onExit];
      onExit.onmessage = (code) => {
        if (st.exit.size) st.exit.forEach((f) => f(code));
        else st.exitCode = code;
        closeProcessReceivers(st);
      };
      // JS never touches plaintext — pass key names only (secretEnv: envVar → secretKey). ns = plugin
      // id. Plaintext resolution and child env injection happen only at the core boundary
      // (process_spawn) (R2). Without secretEnv, null.
      let id: number;
      try {
        id = (await deps.invoke("process_spawn", {
          cmd,
          args,
          cwd: opts?.cwd ?? null,
          env: opts?.env ?? null,
          envRemove: opts?.envRemove ?? null,
          ns,
          secretEnv: opts?.secretEnv ?? null,
          onStdout,
          onStderr,
          onExit,
        })) as number;
      } catch (error) {
        closeProcessReceivers(st);
        throw error;
      }
      procs.set(id, st);
      // A plugin lifetime also owns its processes. On deactivation/unload, reclaim the children instead
      // of waiting for the app generation to end. process_kill is idempotent and safe for an
      // already-exited handle.
      tracker.wrap(() => {
        const state = procs.get(id);
        if (!state) return;
        closeProcessReceivers(state);
        procs.delete(id);
        void deps.invoke("process_kill", { id }).catch(() => {});
      });
      return id;
    },
    write: async (handle: number, data: string): Promise<void> => {
      await deps.invoke("process_write", { id: handle, data });
    },
    closeStdin: async (handle: number): Promise<void> => {
      await deps.invoke("process_stdin_close", { id: handle });
    },
    onData(handle: number, cb: Bytes): Disposable {
      const st = procs.get(handle);
      return st ? subscribe(st.stdout, st.stdoutBuf, cb) : tracker.wrap(() => {});
    },
    onStderr(handle: number, cb: Bytes): Disposable {
      const st = procs.get(handle);
      return st ? subscribe(st.stderr, st.stderrBuf, cb) : tracker.wrap(() => {});
    },
    onExit(handle: number, cb: (code: number) => void): Disposable {
      const st = procs.get(handle);
      if (!st) return tracker.wrap(() => {});
      if (st.exitCode !== null) {
        cb(st.exitCode); // exit landed before the subscription — fire once immediately
        return tracker.wrap(() => {});
      }
      st.exit.add(cb);
      return tracker.wrap(() => st.exit.delete(cb));
    },
    kill: async (handle: number): Promise<void> => {
      await deps.invoke("process_kill", { id: handle });
      const state = procs.get(handle);
      if (state) closeProcessReceivers(state);
      procs.delete(handle);
    },
  };
}

// app.sidecar channel handle — an opaque channel to a declared sidecar. Meaning is a private
// plugin↔sidecar contract (docs/tech/SIDECARS.md); neither the core nor this API reads the content.
export interface SidecarHandle {
  /** Opaque request → the sidecar's synchronous response (JSON). */
  send: (msg: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Subscribe to sidecar events — an event has the shape {event, ...payload} and demuxes on the event
   *  field. Returns the unsubscribe. */
  on: (event: string, cb: (payload: Record<string, unknown>) => void) => Disposable;
  /** Open a byte stream on this sidecar: one request, then whatever the sidecar writes after it.
   *
   *  Bytes rather than JSON events because a stream's whole point is volume, and base64 inside an
   *  envelope costs a third more on every byte of it. The request is opaque here exactly as `send`'s
   *  is; what makes this different is that the answer is the connection.
   *
   *  `onEnd` fires once when the sidecar closes it, with a reason when there was one. It is separate
   *  from the bytes because "the sidecar stopped" is not a byte, and a consumer folding the two would
   *  have to decide what an empty read means. Disposing the returned handle ends the stream. */
  stream: (
    request: Record<string, unknown>,
    handlers: { onBytes: (data: Uint8Array) => void; onEnd?: (reason: string) => void },
  ) => Promise<{ answer: Record<string, unknown>; close: SidecarStreamClose }>;
  /** Release the channel. Idempotent. */
  close: () => Promise<void>;
}

export interface SidecarStreamClose extends Disposable {
  /** Completes after the Core has closed this exact stream connection. */
  settled: Promise<void>;
}

// app.sidecar implementation — opens only sidecars declared in manifest sidecars[] (declaration ≡
// reality: an undeclared open throws). Events and bytes are delivered by stream to this caller alone
// (no global emit — code that never opened the channel receives nothing, and nothing leaks).

// streamSeq names one caller's streams apart from each other. It is this side's counter: the core
// stamps arrivals with whatever label it was given and reads nothing into it.
let streamSeq = 0;

function createSidecarApi(
  deps: PluginApiDeps,
  tracker: DisposableTracker,
  manifest: PluginManifest,
) {
  return {
    open: async (name: string, opts?: {
      secretEnv?: Record<string, string>;
      generatedSecretEnv?: Record<string, { key: string; bytes: number }>;
    }): Promise<SidecarHandle> => {
      const decl = runtimeSidecarReferences(manifest).find((sidecar) => sidecar.id === name);
      if (!decl) {
        throw new Error(tmsg("plugin.sidecar.undeclared", { name }));
      }
      const listeners = new Map<string, Set<(p: Record<string, unknown>) => void>>();
      const onEvent = createStream<Record<string, unknown>>();
      onEvent.onmessage = (m) => {
        const ev = typeof m?.event === "string" ? (m.event as string) : "";
        listeners.get(ev)?.forEach((f) => f(m));
      };
      // The requirement travels with the open, because the manifest is this side's. The core reads
      // what the installed sidecar states it implements and refuses the two if they differ — declared
      // against actual, and neither taken on the other's word.
      let opened: { name?: unknown };
      try {
        opened = await deps.invoke("sidecar_open", {
          consumer: { id: manifest.id, version: manifest.version },
          sidecar: decl,
          ns: manifest.id,
          secretEnv: opts?.secretEnv ?? null,
          generatedSecretEnv: opts?.generatedSecretEnv ?? null,
          onEvent,
        }) as { name?: unknown };
      } catch (error) {
        onEvent.close();
        throw error;
      }
      const provider = typeof opened?.name === "string" && opened.name !== "" ? opened.name : "";
      if (!provider) {
        onEvent.close();
        throw new Error(tmsg("plugin.sidecar.openNoProvider", { name }));
      }
      let released = false;
      // Releasing the channel never ends the sidecar.
      //
      // A sidecar is a separate process so that what it holds outlives this application — shells that
      // survive a restart are the whole reason. A plugin being disabled is this application
      // finishing with the sidecar, not the sidecar's work being over, and closing one on deactivation
      // ended the shells somebody was working in (measured 2026-08-20). Ending a sidecar is
      // `sidecar_stop`, and nothing here calls it.
      const close = async () => {
        if (released) return;
        released = true;
        listeners.clear();
        onEvent.close();
        await deps.invoke("sidecar_release", { name: provider }).catch(() => {});
      };
      tracker.wrap(() => void close());
      return {
        send: async (msg) =>
          (await deps.invoke("sidecar_send", {
            name: provider,
            payload: JSON.stringify(msg),
          })) as Record<string, unknown>,
        on: (event, cb) => {
          let set = listeners.get(event);
          if (!set) {
            set = new Set();
            listeners.set(event, set);
          }
          set.add(cb);
          return tracker.wrap(() => void listeners.get(event)?.delete(cb));
        },
        stream: async (request, handlers) => {
          // A name of this caller's own, so two streams on one sidecar stay apart. The core never
          // reads it: it stamps arrivals with it and nothing else.
          streamSeq += 1;
          const label = `${provider}#${streamSeq}`;
          let stopStarted = false;
          let settle!: () => void;
          let reject!: (error: unknown) => void;
          const settled = new Promise<void>((resolve, rejected) => { settle = resolve; reject = rejected; });
          const onBytes = createStream<ArrayBuffer>();
          onBytes.onmessage = (m) => handlers.onBytes(new Uint8Array(m));
          const onEnd = createStream<Record<string, unknown>>();
          const closeReceivers = () => {
            onBytes.close();
            onEnd.close();
          };
          onEnd.onmessage = (m) => {
            if (stopStarted) return;
            stopStarted = true;
            closeReceivers();
            settle();
            handlers.onEnd?.(typeof m?.reason === "string" ? (m.reason as string) : "");
          };
          let answer: Record<string, unknown>;
          try {
            answer = (await deps.invoke("sidecar_stream", {
              name: provider,
              stream: label,
              payload: JSON.stringify(request),
              onBytes,
              onEnd,
            })) as Record<string, unknown>;
          } catch (error) {
            stopStarted = true;
            closeReceivers();
            settle();
            throw error;
          }
          // Disposing ends this stream and nothing else. A sidecar outlives any one connection,
          // and closing it because a view unmounted would end every other view's stream too.
          const stop: SidecarStreamClose = tracker.add({
            settled,
            dispose() {
              if (stopStarted) return;
              stopStarted = true;
              closeReceivers();
              void deps.invoke("sidecar_stream_close", { name: provider, stream: label })
                .then(() => settle(), reject);
            },
          });
          return { answer, close: stop };
        },
        close,
      };
    },
  };
}


// app.ws implementation — per-handle message/close listeners plus a buffer for pre-registration arrivals
// (nothing lost). Same shape as createProcessApi.
function createWsApi(deps: PluginApiDeps, tracker: DisposableTracker) {
  type Txt = (t: string) => void;
  interface WsState {
    msg: Set<Txt>;
    close: Set<() => void>;
    msgBuf: string[];
    closed: boolean;
    released: boolean;
    receivers: Array<{ close(): void }>;
    receiversClosed: boolean;
  }
  const conns = new Map<number, WsState>();
  const closeWsReceivers = (state: WsState) => {
    if (state.receiversClosed) return;
    state.receiversClosed = true;
    for (const receiver of state.receivers) receiver.close();
  };
  return {
    async connect(url: string): Promise<number> {
      const st: WsState = {
        msg: new Set(), close: new Set(), msgBuf: [], closed: false, released: false,
        receivers: [], receiversClosed: false,
      };
      const onMessage = createStream<string>();
      onMessage.onmessage = (t) => {
        if (st.msg.size) st.msg.forEach((f) => f(t));
        else st.msgBuf.push(t);
      };
      const onClose = createStream<null>();
      st.receivers = [onMessage, onClose];
      onClose.onmessage = () => {
        st.closed = true;
        st.close.forEach((f) => f());
        closeWsReceivers(st);
      };
      let id: number;
      try {
        id = (await deps.invoke("ws_connect", { url, onMessage, onClose })) as number;
      } catch (error) {
        closeWsReceivers(st);
        throw error;
      }
      conns.set(id, st);
      tracker.wrap(() => {
        if (st.released) return;
        st.released = true;
        closeWsReceivers(st);
        conns.delete(id);
        if (!st.closed) void deps.invoke("ws_close", { id }).catch(() => {});
      });
      return id;
    },
    send: async (handle: number, text: string): Promise<void> => {
      await deps.invoke("ws_send", { id: handle, text });
    },
    onMessage(handle: number, cb: Txt): Disposable {
      const st = conns.get(handle);
      if (!st) return tracker.wrap(() => {});
      st.msg.add(cb);
      for (const t of st.msgBuf.splice(0)) cb(t); // replay the pre-subscribe buffer (0 loss)
      return tracker.wrap(() => st.msg.delete(cb));
    },
    onClose(handle: number, cb: () => void): Disposable {
      const st = conns.get(handle);
      if (!st) return tracker.wrap(() => {});
      if (st.closed) {
        cb();
        return tracker.wrap(() => {});
      }
      st.close.add(cb);
      return tracker.wrap(() => st.close.delete(cb));
    },
    close: async (handle: number): Promise<void> => {
      const state = conns.get(handle);
      if (state?.released) return;
      await deps.invoke("ws_close", { id: handle });
      if (state) {
        state.released = true;
        closeWsReceivers(state);
      }
      conns.delete(handle);
    },
  };
}

// app.network implementation — http(req) delegates to the core net_http_request. ns is injected as the
// plugin id (blocks stealing another ns's secrets, R2/R6 — the caller cannot choose ns). secretSubst =
// placeholder → secretKey (no plaintext; substituted at the core boundary).
function createNetworkApi(deps: PluginApiDeps, ns: string) {
  return {
    http: async (req: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: string;
      contentType?: string;
      secretSubst?: Record<string, string>;
      impersonate?: "off" | "chrome";
    }): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
      return (await deps.invoke("net_http_request", {
        method: req.method,
        url: req.url,
        headers: req.headers ?? null,
        query: req.query ?? null,
        body: req.body ?? null,
        contentType: req.contentType ?? null,
        ns,
        secretSubst: req.secretSubst ?? null,
        impersonate: req.impersonate ?? null,
      })) as { status: number; headers: Record<string, string>; body: string };
    },
  };
}

export function buildPluginApi(
  manifest: PluginManifest,
  _dir: string,
  deps: PluginApiDeps,
  entrySource?: string,
): {
  api: SoksakPluginApi;
  tracker: DisposableTracker;
  registered: {
    commands: Set<string>;
    views: Set<string>;
    iconSets: Set<string>;
  };
} {
  const tracker = new DisposableTracker();
  // [conformance] Track the contribution ids actually registered — for the declared ≡ actual inventory
  // after activate.
  const registered = {
    commands: new Set<string>(),
    views: new Set<string>(),
    iconSets: new Set<string>(),
  };
  const id = manifest.id;
  const has = (p: PluginPermission) => manifest.permissions.includes(p);

  // Plugin call context: not remote (this API gate handles permissions — the documented §0-2 model).
  const pluginCtx: CommandContext = {};

  const executeGated = async (
    name: string,
    params?: Record<string, unknown>,
    // Passes origin and correlation (§5) — inherited by a nested run (inv) or self-declared by automatic
    // behavior (opts.origin). The gates apply identically either way.
    inherit?: { origin?: string; parent?: string },
  ): Promise<CommandOutcome> => {
    if (isBlockedForPlugins(name)) {
      return denied(tmsg("plugin.command.managementBlocked", { name }));
    }
    const danger = deps.getCommandDanger(name);
    const need: PluginPermission =
      danger === "destructive"
        ? "commands:destructive"
        : danger === "inject"
          ? "commands:inject"
          : "commands";
    if (!has(need)) {
      return denied(tmsg("plugin.permission.undeclared", { permission: need, name }));
    }
    // A cross-plugin call requires a dependency declaration — undeclared is denied (call-boundary
    // enforcement). Core, self, and view pass.
    const crossDeny = crossPluginDenyReason(
      id,
      runtimePluginRequirements(manifest),
      manifest.consumes,
      deps.implementsOf,
      name,
    );
    if (crossDeny) {
      return denied(crossDeny);
    }
    return deps.execute(name, params ?? {}, {
      ...pluginCtx,
      ...(inherit?.origin !== undefined ? { origin: inherit.origin } : {}),
      ...(inherit?.parent !== undefined ? { parent: inherit.parent } : {}),
    });
  };

  // The realm declaration is derived from the finished surface object — written by hand here, the
  // declaration would still report surfaces the permission gate removed.
  const draft: Omit<SoksakPluginApi, "realm"> = {
    appVersion: deps.appVersion,
    pluginId: id,
    locale: () => readingLanguage(),
    windowLabel: () => currentWindowLabel() || "main",

    events: {
      on: (event, fn) => {
        // Permission gate: sensitive events (command.* and such) require the declared permission to
        // subscribe. The consent screen shows that permission, so core/terminal access is disclosed to
        // the user.
        const need = EVENT_PERMISSIONS[event];
        if (need && !has(need)) {
          throw new Error(
            tmsg("plugin.event.needPermission", { event: String(event), permission: need }),
          );
        }
        return tracker.add(deps.on(event, fn));
      },
      progress: (command, delta) => {
        emitPluginEvent("command.progress", { command, delta, source: id });
      },
    },

    activity: {
      // Self-described publish — the plugin puts its own activity entry into the hub without a core
      // bridge. source is fixed to the plugin id (its own name tag only) and the payload is stored
      // verbatim (the hub is schema-agnostic). Same grade as events.progress (no permission).
      publish: (kind, entry) => {
        void deps.invoke("activity_publish", {
          kind,
          source: id,
          payload: { ...entry, window: currentWindowLabel() },
        });
      },
    },

    workspace: {
      current: () => deps.currentWorkspace(),
    },

    settings: {
      get: (key) => {
        const defs = configDefaults(manifest);
        if (!(key in defs)) return undefined; // a key outside the schema is not exposed
        return usePluginSettings
          .getState()
          .effective(id, key, defs[key], deps.currentWorkspace()?.root ?? undefined);
      },
      all: () =>
        usePluginSettings
          .getState()
          .allEffective(id, configDefaults(manifest), deps.currentWorkspace()?.root ?? undefined),
      onChange: (cb) => {
        const fire = () =>
          cb(
            usePluginSettings
              .getState()
              .allEffective(
                id,
                configDefaults(manifest),
                deps.currentWorkspace()?.root ?? undefined,
              ),
          );
        // Re-fires on a value change (global/workspace override) and on an active-workspace switch
        // (different root → different effective).
        const unSettings = usePluginSettings.subscribe(fire);
        const unProject = useSessions.subscribe((s, prev) => {
          if (s.activeId !== prev.activeId) fire();
        });
        return tracker.wrap(() => {
          unSettings();
          unProject();
        });
      },
    },

    commands: has("commands")
      ? {
          execute: executeGated,
          register: (name, spec) => {
            const declared = gateContribution({
              contributesKey: "commands",
              noun: tmsg("plugin.contrib.noun.command"),
              id: name,
              declared: manifest.contributes.commands,
              idOf: (c) => c.name,
            });
            registered.commands.add(name);
            // The manifest declaration is the authority for danger (visible at install and consent
            // time). When runtime spec.danger and the manifest both exist and differ, that is a
            // contradiction → reject. The manifest is the authority, but when only the runtime declares
            // danger (legacy) the runtime value is used to preserve the gate, with a warning that the
            // manifest must declare it.
            if (
              spec.danger !== undefined &&
              declared.danger !== undefined &&
              spec.danger !== declared.danger
            ) {
              throw new Error(
                tmsg("plugin.command.dangerMismatch", { name, declared: declared.danger, runtime: spec.danger }),
              );
            }
            const danger = declared.danger ?? spec.danger;
            if (declared.danger === undefined && spec.danger !== undefined) {
              console.warn(
                `[plugin:${id}] command '${name}' declares runtime danger='${spec.danger}' but contributes.commands does not — declare danger in the manifest so install and consent show it`,
              );
            }
            // Response envelope standard (MESSAGE-PROTOCOL): the command supplies message. summarize is
            // a lifeline for message (transitional compatibility — removed in the M5 sweep). With
            // neither, the answer falls back to a label with a warning, and plugin.conformance reports
            // that command under messagesMissing (an author-precise gate — rejecting at load time would
            // brick a plugin on a message regression, so the gate boundary is publish/diagnostics).
            const pluginAnswer = spec.message ?? spec.summarize;
            const full = pluginCommandName(id, name);
            if (typeof pluginAnswer !== "function") {
              console.warn(
                `[plugin:${id}] command '${name}' supplies no message — the answer degrades to a label (MESSAGE-PROTOCOL §3)`,
              );
              commandsMissingMessage.add(full);
            } else {
              commandsMissingMessage.delete(full);
            }
            const labelAnswer = () =>
              declared.title ? localize(declared.title) : name;
            deps.registerCommand(full, {
              description: spec.description,
              title: declared.title, // human label (ko/en) — the manifest owns it, the display surface resolves it
              triggers: spec.triggers, // the host catalogJson composes base+triggers (docs/I18N.md §3)
              params: spec.params ?? {},
              paramsAuthority: spec.paramsAuthority,
              returns: spec.returns ?? "object",
              examples: spec.examples,
              message: pluginAnswer ?? labelAnswer, // standard answer — a label when absent (transition scaffold, warned)
              speak: spec.speak, // spoken sentence (§3) — the whole speak axis (silent when absent — opt-in)
              // hint — passed through the same context conversion as handler. The cap and exception
              // safety belong to execute (a hint never breaks the response).
              hint: spec.hint
                ? (data, ctx) =>
                    spec.hint!(data, {
                      origin: ctx?.origin,
                      parent: ctx?.parent,
                      execute: (n, p) =>
                        executeGated(n, p, { origin: ctx?.origin, parent: ctx?.parent }),
                    })
                : undefined,
              trace: spec.trace, // instrumentation spec (§4) — false = keep an observation-byproduct command out of the record
              danger, // manifest authority (runtime fallback when absent — the gate is preserved)
              // registry.execute try/catches and converts to INTERNAL (§0-4). inv = the call-context
              // inheritance channel (§5): a handler's nested run inherits the parent's origin and
              // correlation (parent) — a child of a schedule firing is not disguised as human. The gates
              // (permission, cross-plugin) stay executeGated (no bypass).
              handler: (params, ctx) =>
                spec.handler(params, {
                  origin: ctx?.origin,
                  parent: ctx?.parent,
                  // The pane the call came from. A core command has always had it; without it here a
                  // Pane context is domain-neutral: browser navigation and terminal reads both
                  // need the caller's pane.
                  pane: ctx?.pane,
                  execute: (n, p) =>
                    executeGated(n, p, { origin: ctx?.origin, parent: ctx?.parent }),
                }),
            });
            return tracker.wrap(() => deps.unregisterCommand(full));
          },
        }
      : undefined,

    // The programs contribution is fully declarative — the loader registers it (no imperative API,
    // §2.6).

    ui: has("ui") || has("ui:statusbar") || has("ui:titlebar") || has("ui:overlay:screen") || has("ui:overlay:pane")
      ? {
          registerView: (viewId, provider) => {
            const decl = gateContribution({
              contributesKey: "views",
              noun: tmsg("plugin.contrib.noun.view"),
              id: viewId,
              declared: manifest.contributes.views,
              idOf: (v) => v.id,
            });
            registered.views.add(viewId);
            const registeredProvider = entrySource
              ? attachViewPresentationRuntime(provider, {
                  source: entrySource,
                  pluginId: id,
                  app: () => api,
                })
              : provider;
            const remove = useViewRegistry
              .getState()
              .register(id, decl, registeredProvider);
            return tracker.wrap(remove);
          },

          // Delegates to plugin.view.open, which opens a tab and refuses a view that does not
          // live on one.
          openView: (viewId) =>
            deps.execute(
              "plugin.view.open",
              { viewKey: qualifiedViewId(id, viewId) },
              pluginCtx,
            ),
          // Icon set registration — rejects anything outside the declaration (contributes.iconSets) and
          // validates the data in full (same pattern as registerView). Global set id =
          // "<pluginId>.<setId>".
          registerIconSet: (setId, data) => {
            const decl = gateContribution({
              contributesKey: "iconSets",
              noun: tmsg("plugin.contrib.noun.iconSet"),
              id: setId,
              declared: manifest.contributes.iconSets,
              idOf: (s) => s.id,
            });
            registered.iconSets.add(setId);
            const invalid = validateIconSetData(data);
            if (invalid) {
              throw new Error(tmsg("plugin.iconSet.invalidData", { setId, reason: invalid }));
            }
            const globalId = qualifiedViewId(id, setId);
            useIconRegistry.getState().register({
              id: globalId,
              name: localize(decl.title),
              data: data as IconSetData,
            });
            return tracker.wrap(() =>
              useIconRegistry.getState().unregister(globalId),
            );
          },
          // Status bar item bound to a paneId. The id is namespaced by
          // plugin to avoid collisions. Calling again with the same id replaces it (updating the active
          // toggle). Returns the unsubscribe.
          // [RULE] The status bar is a different area from content views ("ui") → requires the
          // "ui:statusbar" permission.
          statusBarItem: (item) => {
            if (!has("ui:statusbar")) {
              throw new Error(tmsg("plugin.ui.statusBarNeedsPermission"));
            }
            return tracker.wrap(
              registerStatusBarItem({ ...item, id: `${id}:${item.id}` }),
            );
          },
          // Toggle icon next to the right-hand titlebar controls. The id is namespaced by plugin to
          // avoid collisions.
          // [RULE] The titlebar is a different area from the status bar ("ui:statusbar") → requires the
          // "ui:titlebar" permission.
          registerHeaderAction: (action) => {
            if (!has("ui:titlebar")) {
              throw new Error(tmsg("plugin.ui.headerActionNeedsPermission"));
            }
            return tracker.wrap(
              registerHeaderAction({ ...action, id: `${id}:${action.id}` }),
            );
          },
          setViewBadge: (viewId, badge) =>
            useViewRegistry
              .getState()
              .setViewBadge(qualifiedViewId(id, viewId), badge),
          // Overlay input gate (useUi overlayCount → compositor plugin). Makes a click over the native
          // content webview land. [RULE] The overlay area requires a "ui:overlay:*" permission.
          setOverlayActive: (active) => {
            if (!(has("ui:overlay:screen") || has("ui:overlay:pane"))) {
              throw new Error(tmsg("plugin.ui.overlayNeedsPermission"));
            }
            if (active) useUi.getState().pushOverlay();
            else useUi.getState().popOverlay();
          },
        }
      : undefined,


    storage: has("storage")
      ? {
          read: async (key) => {
            const raw = (await deps.invoke("plugin_data_read", {
              id,
              key,
            })) as string | null;
            return raw == null ? null : (JSON.parse(raw) as unknown);
          },
          write: async (key, value) => {
            await deps.invoke("plugin_data_write", {
              id,
              key,
              value: JSON.stringify(value),
            });
          },
          remove: async (key) => {
            await deps.invoke("plugin_data_delete", { id, key });
          },
          list: async () =>
            (await deps.invoke("plugin_data_list", { id })) as string[],
        }
      : undefined,

    // General-purpose data store — ns is always injected as this plugin id (same isolation rule as
    // storage). Every call forwards to the core DbState (single truth). watch filters the all-window
    // data-change by ns/coll/scope.
    data: has("data")
      ? {
          kv: {
            get: (key) => deps.invoke("data_kv_get", { ns: id, key }),
            set: async (key, value) => {
              await deps.invoke("data_kv_set", { ns: id, key, value });
            },
            delete: (key) =>
              deps.invoke("data_kv_delete", { ns: id, key }) as Promise<boolean>,
            keys: (prefix) =>
              deps.invoke("data_kv_keys", { ns: id, prefix: prefix ?? null }) as Promise<
                string[]
              >,
            // kv changes only (no coll) — filters the all-window broadcast of set/delete in this plugin
            // ns (zero polling).
            watch: (cb) => {
              const un = deps.onDataChange((e) => {
                if (e.ns === id && e.coll == null) cb(e.id);
              });
              return tracker.wrap(un);
            },
          },
          define: async (collection, opts) => {
            await deps.invoke("data_define", {
              ns: id,
              coll: collection,
              indexes: opts.indexes ?? [],
              fts: opts.fts ?? [],
            });
          },
          put: (collection, doc, opts) =>
            deps.invoke("data_put", {
              ns: id,
              coll: collection,
              scope: opts?.scope ?? null,
              id: opts?.id ?? null,
              doc,
            }) as Promise<string>,
          get: (collection, recordId, opts) =>
            deps.invoke("data_get", {
              ns: id,
              coll: collection,
              id: recordId,
              scope: opts?.scope ?? null,
            }),
          delete: (collection, recordId, opts) =>
            deps.invoke("data_delete", {
              ns: id,
              coll: collection,
              id: recordId,
              scope: opts?.scope ?? null,
            }) as Promise<boolean>,
          query: (collection, opts) =>
            deps.invoke("data_query", {
              ns: id,
              coll: collection,
              scope: opts?.scope ?? null,
              filter: opts?.where ?? null,
              order: opts?.order ?? null,
              desc: opts?.desc ?? null,
              limit: opts?.limit ?? null,
              offset: opts?.offset ?? null,
            }) as Promise<unknown[]>,
          search: (collection, text, opts) =>
            deps.invoke("data_search", {
              ns: id,
              coll: collection,
              query: text,
              scope: opts?.scope ?? null,
              limit: opts?.limit ?? null,
            }) as Promise<unknown[]>,
          count: (collection, opts) =>
            deps.invoke("data_count", {
              ns: id,
              coll: collection,
              scope: opts?.scope ?? null,
              filter: opts?.where ?? null,
            }) as Promise<number>,
          // retention (R5) — count FIFO trim / TTL reaper. Returns the delete count. Called by
          // persistent collections such as terminal blocks.
          retentionTrim: (collection, scope, cap) =>
            deps.invoke("data_retention_trim", {
              ns: id,
              coll: collection,
              scope,
              cap,
            }) as Promise<number>,
          retentionReap: (collection, cutoffMs) =>
            deps.invoke("data_retention_reap", {
              ns: id,
              coll: collection,
              cutoff_ms: cutoffMs,
            }) as Promise<number>,
          watch: (collection, opts, cb) => {
            const un = deps.onDataChange((e) => {
              if (e.ns !== id || e.coll !== collection) return;
              if (opts?.scope != null && e.scope != null && e.scope !== opts.scope) {
                return;
              }
              cb(e);
            });
            return tracker.wrap(un);
          },
        }
      : undefined,

    // Encrypted secret vault — ns is always injected as this plugin id (same isolation as app.data).
    // Every call forwards to the core SecretsState (single truth). No get — plaintext readback is
    // blocked (injection only, 2b).
    secrets: has("secrets")
      ? {
          generate: async (key, bytes) =>
            deps.invoke("secret_generate", { ns: id, key, bytes }) as Promise<{ created: boolean }>,
          set: async (key, value) => {
            await deps.invoke("secret_set", { ns: id, key, value });
          },
          has: (key) =>
            deps.invoke("secret_has", { ns: id, key }) as Promise<boolean>,
          delete: (key) =>
            deps.invoke("secret_delete", { ns: id, key }) as Promise<boolean>,
          keys: () => deps.invoke("secret_keys", { ns: id }) as Promise<string[]>,
          backend: () =>
            deps.invoke("secret_backend") as Promise<{
              backend: string;
              unlocked: boolean;
            }>,
        }
      : undefined,

    // General-purpose scheduler — forwards to the core ScheduleState (single truth) through a thin
    // channel with no mapping (app.data precedent). register's command routes through the registry when
    // it fires. A reconcile job runs its state tick on poke.
    scheduler: has("schedule")
      ? {
          register: (job) => {
            // A scheduled run is still a call the plugin made. Without applying the same management
            // boundary as a direct commands.execute at registration time, schedule becomes a
            // time-delayed permission bypass.
            if (isBlockedForPlugins(job.command)) {
              return Promise.reject(
                new Error(tmsg("plugin.schedule.managementBlocked", { command: job.command })),
              );
            }
            // A schedule firing goes through the core remote channel and skips executeGated, so it could
            // bypass cross-plugin enforcement (A schedules plugin.B.cmd). Run the same check at
            // registration time, where the caller is identifiable.
            const crossDeny = crossPluginDenyReason(
              id,
              runtimePluginRequirements(manifest),
              manifest.consumes,
              deps.implementsOf,
              job.command,
            );
            if (crossDeny) {
              return Promise.reject(new Error(crossDeny));
            }
            const p = deps.invoke("schedule_register", {
              trigger: job.trigger,
              command: job.command,
              params: job.params ?? null,
              id: job.id ?? null,
              retry: job.retry ?? null,
              concurrency: job.concurrency ?? null,
              timeout_ms: job.timeout_ms ?? null,
              process_lease: job.process_lease ?? null,
              // With process_lease and no backstop, inject the 3h default. null = unbounded (core None),
              // so core None means only "unbounded" (JS owns the default). Ignored for non-process jobs,
              // so null there.
              zombie_backstop_ms: job.process_lease
                ? job.zombie_backstop_ms === undefined
                  ? 10_800_000
                  : job.zombie_backstop_ms
                : null,
              // Owner stamp (B2) — the core does not persist a job that has an owner (the plugin re-arms
              // it in activate). Boot re-arm therefore covers core jobs only, so a disabled plugin's job
              // never fires orphaned.
              owner: id,
            }) as Promise<string>;
            // Lifecycle binding (B1) — as with command registration above, the tracker cancels the job
            // on deactivate. Closes the hole where a schedule outlasts its owning plugin (safe even when
            // the author forgets).
            tracker.wrap(() => {
              void p.then((jid) => deps.invoke("schedule_cancel", { id: jid })).catch(() => {});
            });
            return p;
          },
          poke: async (jobId) => {
            await deps.invoke("schedule_poke", { id: jobId ?? null });
          },
          cancel: (jobId) =>
            deps.invoke("schedule_cancel", { id: jobId }) as Promise<boolean>,
          list: () =>
            deps.invoke("schedule_list") as Promise<SchedulerJobView[]>,
        }
      : undefined,

    // Notification (= push) plus sound. System notifications are gated on the "notify" permission
    // (disclosed on the consent screen). Sound shares that capability.
    notify: has("notify")
      ? {
          push: (n) => pushNotification(n),
        }
      : undefined,
    sound: has("notify")
      ? {
          play: (s) => playSound(s),
          builtins: () => [...BUILTIN_SOUNDS],
        }
      : undefined,

    fs:
      has("fs:read") || has("fs:write")
        ? {
            readText: has("fs:read")
              ? async (path, offset) => {
                  const data = (await deps.invoke("read_text_file", {
                    path,
                    offset,
                  })) as {
                    content: string;
                    truncated: boolean;
                    total_bytes: number;
                  };
                  return {
                    text: data.content,
                    truncated: data.truncated,
                    totalBytes: data.total_bytes,
                  };
                }
              : undefined,
            readBinary: has("fs:read")
              ? (path) =>
                  deps.invoke("read_file_base64", { path }) as Promise<{
                    base64: string;
                    bytes: number;
                  }>
              : undefined,
            // [RULE] Local file → a URL a webview can load directly. The core standard: every plugin
            // that reads a file and displays it (editor, media, image viewer) uses this path. The
            // asset:// protocol blocks the hidden directory (.soksak) from its scope, so this builds a
            // blob URL over read_file_base64 (the validated path the editor uses). Idempotent: same path
            // → same URL (no re-read, no re-creation). Revoked on unload. Shares the "fs:read" gate.
            //
            // The media type is the caller's. The core answered one from a table of 24 extensions
            // until 2026-08-16, so a plugin for anything outside it had to edit the core to be
            // answered — a missing capability (A9), not a default. The cache key includes the
            // type: two plugins may read the same bytes as different things.
            url: has("fs:read")
              ? (() => {
                  const urlCache = new Map<string, string>();
                  return async (path: string, mime?: string): Promise<string> => {
                    const key = `${mime ?? ""}\u0000${path}`;
                    const hit = urlCache.get(key);
                    if (hit) return hit;
                    const { base64 } = (await deps.invoke("read_file_base64", {
                      path,
                    })) as { base64: string };
                    const bin = atob(base64);
                    const bytes = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                    const objectUrl = URL.createObjectURL(
                      new Blob([bytes], mime ? { type: mime } : undefined),
                    );
                    urlCache.set(key, objectUrl);
                    tracker.wrap(() => {
                      URL.revokeObjectURL(objectUrl);
                      urlCache.delete(key);
                    });
                    return objectUrl;
                  };
                })()
              : undefined,
            writeText: has("fs:write")
              ? async (path, content) => {
                  await deps.invoke("write_text_file", { path, content });
                }
              : undefined,
            list: has("fs:read")
              ? (path, opts) =>
                  deps.invoke("list_children", { path, meta: opts?.meta })
              : undefined,
            // Subscribes to the core watcher (no polling). Non-recursive — the caller calls watch per
            // subfolder.
            // [RULE] Watching is part of reading (when to read again) → shares the "fs:read" gate.
            watch: has("fs:read")
              ? (dir, cb) => {
                  // A refused subscription is reported, not thrown into the void.
                  //
                  // `void invoke(...)` left the rejection unhandled, so a build with no watcher —
                  // this one refuses `watch_dir` by name — turned every subscription into a
                  // renderer error and the plugin was handed a Disposable for a watch that does not
                  // exist. Measured 2026-08-16: three of them sat in the activity stream while the
                  // file tree's live refresh was dead and every test was green.
                  void deps.invoke("watch_dir", { path: dir }).catch((cause: unknown) => {
                    console.warn(`[plugin:${id}] this build does not watch ${dir}: ${String(cause)}`);
                  });
                  const un = deps.onFsChange((changed) => {
                    if (changed === dir) cb(dir);
                  });
                  return tracker.wrap(() => {
                    un();
                    void deps.invoke("unwatch_dir", { path: dir }).catch(() => {});
                  });
                }
              : undefined,
          }
        : undefined,

    // [RULE] Clipboard area — different capabilities get different permissions: read ("clipboard:read":
    // read the content plus subscribe to changes) and write ("clipboard:write": overwrite the content).
    // watch is part of reading → shares the "clipboard:read" gate (fs.watch precedent). The core absorbs
    // per-OS native events (Win/X11/Wayland) and macOS changeCount polling into a single
    // clipboard-change signal — the plugin never sees the OS branch.
    clipboard:
      has("clipboard:read") || has("clipboard:write")
        ? {
            readText: has("clipboard:read")
              ? () => deps.invoke("clipboard_read") as Promise<string>
              : undefined,
            writeText: has("clipboard:write")
              ? async (text: string) => {
                  await deps.invoke("clipboard_write", { text });
                }
              : undefined,
            watch: has("clipboard:read")
              ? (cb: (e: { text: string }) => void) => {
                  // Some frameworks cannot watch (they emit no clipboard-change event). Such a framework
                  // rejects with its name, and that rejection must be handled — left to `void`, an
                  // unhandled reject fires on every boot (measured 2026-08-01: twice per Electron boot),
                  // and that noise buries real errors.
                  //
                  // Do not swallow it: record the reason in the ledger. Without a record, "watching does
                  // not work" appears nowhere and the plugin waits for a change that never comes.
                  void deps
                    .invoke("clipboard_watch_start")
                    .catch((e) => {
                      void deps
                        .invoke("activity_publish", {
                          kind: "plugin.capability",
                          source: "plugin",
                          payload: {
                            capability: "clipboard.watch",
                            available: false,
                            // The visible line states what does not work and why. Stating only the
                            // mechanism ("this app does not watch") leaves the reader without who lost
                            // what — state who requested it and what consequently does not run. The
                            // developer-facing reason the framework rejected with goes in the payload.
                            plugin: id,
                            message: tmsg("plugin.clipboard.watchUnavailable", { id }),
                            reason: String(e).slice(0, 200),
                          },
                        })
                        .catch(() => {});
                    });
                  const un = deps.onClipboardChange((text) => cb({ text }));
                  return tracker.wrap(() => {
                    un();
                    // Stopping can be rejected for the same reason — handle it. Otherwise every dispose
                    // creates one more unhandled reject.
                    void deps.invoke("clipboard_watch_stop").catch(() => {});
                  });
                }
              : undefined,
          }
        : undefined,

    fileGrants: {
      redeem: async (grantId: string) => redeemDropGrant({
        pluginId: id,
        window: currentWindowLabel() || "main",
        id: grantId,
      }),
    },

    // [RULE] Terminal area — different capabilities get different permissions: observation ("terminal":
    // command.* snapshots), screen read ("terminal:read": buffer content and updates — the whole screen
    // text), and input write ("terminal:write": PTY key injection). All three are separate permissions.
    terminal:
      has("terminal") || has("terminal:read") || has("terminal:write")
        ? {
            ...(has("terminal")
              ? {
                  runningCommands: () => runningCommands(),
                  getCwd: (paneId: string) => deps.getCwd(paneId),
                  onCwd: (paneId: string, cb: (cwd: string) => void) =>
                    tracker.wrap(deps.subscribeCwd(paneId, cb)),
                  onCommandFinished: (paneId: string, cb: () => void) =>
                    tracker.wrap(deps.subscribeCommandFinished(paneId, cb)),
                }
              : {}),
            ...(has("terminal:read")
              ? {
                  // Reads the screen through the registered PTY IO (substrate) — the key a plugin
                  // terminal registered with registerIo.
                  readBuffer: (paneId: string, lines?: number) =>
                    getPtyIo(paneId)?.readBuffer(lines),
                  onOutput: (paneId: string, cb: () => void) =>
                    tracker.wrap(subscribeOutput(paneId, cb)),
                }
              : {}),
            ...(has("terminal:write")
              ? {
                  // sendText: substrate IO (plugin terminal registerIo). Absent = false (not ready).
                  sendText: (paneId: string, text: string) => {
                    const io = getPtyIo(paneId);
                    if (io) {
                      io.sendInput(text);
                      return true;
                    }
                    return false;
                  },
                }
              : {}),
            // The owner's half, under the plain "terminal" permission.
            //
            // Supplying a stream is not reading somebody else's: a plugin that drives a shell hands
            // its own bytes to the decoder and its own screen to the host, and the read permissions
            // above are what gate anyone else getting at either.
            ...(has("terminal")
              ? {
                  observe: (paneId: string, bytes: Uint8Array) => feedPtyOutput(paneId, bytes),
                  registerIo: (
                    paneId: string,
                    io: { readBuffer: (lines?: number) => string; sendInput: (data: string) => void },
                  ): Disposable => tracker.wrap(registerPtyIo(paneId, io)),
                }
              : {}),
          }
        : undefined,
    // Where this plugin declares that it delivers pointer input for its own surfaces. The core has no
    // notion of the engine — the owner takes a label and answers whether it is its own, and the core
    // only delivers there.
    // A native surface owned by a plugin: the label it declares under and the door for the
    // kind's own verbs. The webview capability below stays a web view's — eval and navigation do
    // not travel with this.
    surface: has("surface")
      ? {
          label: (kind: string, viewId: string) => surfaceLabel(kind, viewId),
          deliver: (label: string, message: Record<string, unknown>) => contentViewHost().deliver(label, message),
        }
      : undefined,
    provideSurfaceInput: has("webview") || has("surface")
      ? (provider) => registerSurfaceInputProvider(id, provider)
      : undefined,
    // Drives the core-owned child webview (browser plugin). Native commands are webview_* (capability
    // prefix, docs/NAMING.md rule). Labels are derived only from the surfaceLabels single truth.
    webview: has("webview")
      ? {
          capabilities: Object.freeze({
            supportsDocumentStart: engineProvision.supportsDocumentStart,
            supportsInputInjection: engineProvision.supportsInputInjection,
          }),
          label: (kind: string, viewId: string) => surfaceLabel(kind, viewId),
          open: (label, o) => contentViewHost().open(label, o as Record<string, unknown>),
          bounds: (label, x, y, w, h) =>
            contentViewHost().bounds(label, x, y, w, h) as unknown as Promise<void>,
          visible: (label, visible, focus) => {
            return contentViewHost().visible(label, visible, focus);
          },
          alive: (label) => contentViewHost().alive(label),
          navigate: (label, url) => contentViewHost().navigate(label, url),
          zoom: (label, factor) => contentViewHost().zoom(label, factor),
          openWindow: (url) =>
            contentViewHost().openWindow(url),
          history: (label, delta) => contentViewHost().history(label, delta),
          stop: (label) => contentViewHost().stop(label),
          // What the surface is showing, as opposed to what it was asked to show. A redirect and a
          // load that never landed are both invisible in the address the caller navigated to.
          pageState: (label) => contentViewHost().pageState(label),
          deliver: (label, message) => contentViewHost().deliver(label, message),
          reload: (label, ignoreCache) => contentViewHost().reload(label, ignoreCache),
          devtools: (label) => contentViewHost().devtools(label),
          eval: (label, js) => contentViewHost().evalJs(label, js),
          injectScript: (label, code, phase) =>
            tracker.wrap(
              contentViewHost().injectScript(label, code, phase ?? "document-start"),
            ),
          sendInput: (label, input) => contentViewHost().sendInput(label, input),
          wheel: (label, x, y, dx, dy) => contentViewHost().wheel(label, {
            x, y, deltaX: dx, deltaY: dy, deltaMode: "pixel",
            modifiers: { shift: false, alt: false, control: false, meta: false },
          }),
          captureFull: (label, path, width, height) => contentViewHost().captureFull(label, path, width, height),
          typeText: (label, text) => contentViewHost().typeText(label, text),
          on: (label, event, cb) =>
            tracker.wrap(
              deps.subscribeWebview(label, event, (payload) => {
                cb(payload);
              }),
            ),
          list: async (prefix) => {
            const all = await contentViewHost().list();
            return prefix ? all.filter((l) => l.startsWith(prefix)) : all;
          },
          close: (label) =>
            contentViewHost().close(label),
        }
      : undefined,
    process: has("process") ? createProcessApi(deps, tracker, id) : undefined,
    sidecar: has("sidecar") ? createSidecarApi(deps, tracker, manifest) : undefined,
    network: has("network") ? createNetworkApi(deps, id) : undefined,
    ws: has("network") ? createWsApi(deps, tracker) : undefined,
    bus: {
      emit: (topic: string, payload: unknown) => busEmit(topic, payload),
      on: (topic: string, fn: (payload: unknown) => void) =>
        tracker.wrap(busOn(topic, fn)),
    },
  };
  const api: SoksakPluginApi = declarePluginRealm("window", draft);

  return { api, tracker, registered };
}
