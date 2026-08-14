import { create } from "zustand";
import { moduleState } from "../lib/moduleState";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";

// App settings: language (i18n) + chrome (tab position, icons, focus, and so on). Persisted to
// localStorage. Terminal appearance (font/cursor/scrollback/renderer/shell) is not owned by the
// core — the terminal plugin's manifest configuration is the single truth (no duplication).
// Core settings have no terminal fields.

export type Language = "ko" | "en";
export type TabPosition = "top" | "left";
// Split panel header: title bar (single view) or tabs (multiple views plus +).
export type SplitHeaderMode = "title" | "tabs";
// Remote (AI/CLI/MCP) dangerous-command policy. allow = run immediately, deny = block
// (permission gate, M3).
export type DangerPolicy = "allow" | "deny";
// Focus area indicator: outline = rectangular outline, corners = 4 corner brackets.
export type FocusIndicator = "outline" | "corners";
// Tab close confirmation policy (R6) — warn = confirm dialog on a blocking status (unsaved,
// running, and so on), off = always close immediately.
export type TabCloseConfirm = "warn" | "off";
// Right plugin sidebar placement: overlay = floats over the content (the original), push = takes
// area like the left sidebar (pushes the content aside).
export type RightSidebarMode = "overlay" | "push";
// Left rail visual mode (§12-⑤): pane = like a split pane (card tint + elevation), ground = a flat
// plane lying on the floor.
export type RailLook = "pane" | "ground";
// 3-way switch for rail-panel relation rendering — a temporary axis for comparison; once decided,
// keep only the adopted option and delete the rest.
// stroke = stroke + label (default — user-confirmed), moment = a brief flash only at the instant
// the binding changes, tint = low-opacity accent fill only.
export type RailRelation = "tint" | "moment" | "stroke";
// Bound panel background (permanent setting) — none (default, user-confirmed) | faint (accent 1%).
export type RailFill = "none" | "faint";
// Swap-adjacency indicator (permanent setting) — edge = dotted outer right edge (default,
// user-adopted) | seam = dotted inner shared edge.
export type RailSeamStyle = "seam" | "edge";

interface SettingsState {
  language: Language;
  // Project (topmost) tab position. left = a vertical rail to the left of the sidebar.
  projectTabPosition: TabPosition;
  // Content (workspace) tab position. left = the left vertical strip (reference 138px).
  contentTabPosition: TabPosition;
  // Split panel header mode (default title).
  splitHeaderMode: SplitHeaderMode;
  // Remote dangerous-command policy: destructive (close/remove) / injection (input, arbitrary JS).
  remoteDestructive: DangerPolicy;
  remoteInject: DangerPolicy;
  // Icon set id (built-in "lucide" plus plugin-registered sets). Falls back to lucide when unregistered.
  iconSet: string;
  // Whether the icon button round box (border + background) is always shown. off = bare (hover only).
  iconBox: boolean;
  // Focus group indicator style (shown on the active group when there are 2 or more groups).
  focusIndicator: FocusIndicator;
  // Default project root to point at on first app open ("" = automatic project1). Saved by the
  // "default project" checkbox in project settings — consumed by boot (main.tsx).
  defaultProjectRoot: string;
  // Tab close confirmation policy (R6 — warn by default).
  tabCloseConfirm: TabCloseConfirm;
  rightSidebarMode: RightSidebarMode;
  railLook: RailLook;
  railRelation: RailRelation;
  railFill: RailFill;
  focusDim: boolean;
  railSeamStyle: RailSeamStyle;
  /** Whether to rearrange panes to resolve adjacency when the focus left edge is blocked in FLOW. PIN ignores it. */
  railPullFocused: boolean;
  /**
   * Color of the solid seam — the line drawn when the rail arrives at the pane and adjacency is
   * **real** (railPullFocused=false).
   *
   * "" is the theme-defined color (empty = delegate). A value set here wins. It does not overwrite
   * the theme token; it applies only in the rail overlay's own slot — if two things use one token,
   * specificity determines which wins.
   */
  railSolidColor: string;
  /**
   * Dim strength — 0..1. Non-focused panes (dimIdle) and panes wedged in where the rail cannot
   * arrive (dimBlocked).
   *
   * The two values are the user handle for the rule of one number per level (lib/dimLevel). There
   * are two painting media (a veil for hole panes, filter for DOM panes) but both read only this number.
   */
  dimIdle: number;
  dimBlocked: number;
  // In FLOW, swap same-row siblings on screen only when the focused panel's own left edge is blocked.
  // App UI font (= global app chrome). Unrelated to the terminal font — the terminal plugin owns
  // that separately.
  // appFontFamily → --app-font (root font-family), appFontSize → --app-font-size (root font-size).
  appFontFamily: string;
  windowZoom: number;
  // Agent CLI the orchestrator natural-language console spawns (resolved from the login shell
  // PATH). Default claude — E2E passes a scripted stub path for deterministic verification
  // (orchestrator/agent.ts).
  orchestratorAgent: string;
  // Agent model (--model). Command routing turns round-trip often, so a fast model dominates
  // perceived latency — default haiku. "" = the agent CLI's own default model.
  orchestratorModel: string;
  setLanguage: (l: Language) => void;
  setProjectTabPosition: (p: TabPosition) => void;
  setContentTabPosition: (p: TabPosition) => void;
  setSplitHeaderMode: (m: SplitHeaderMode) => void;
  setRemoteDestructive: (p: DangerPolicy) => void;
  setRemoteInject: (p: DangerPolicy) => void;
  setIconSet: (id: string) => void;
  setIconBox: (v: boolean) => void;
  setFocusIndicator: (v: FocusIndicator) => void;
  setDefaultProjectRoot: (root: string) => void;
  setTabCloseConfirm: (v: TabCloseConfirm) => void;
  setRightSidebarMode: (v: RightSidebarMode) => void;
  setRailLook: (v: RailLook) => void;
  setRailRelation: (v: RailRelation) => void;
  setRailFill: (v: RailFill) => void;
  setFocusDim: (v: boolean) => void;
  setRailSeamStyle: (v: RailSeamStyle) => void;
  setRailPullFocused: (v: boolean) => void;
  setRailSolidColor: (v: string) => void;
  setDimIdle: (v: number) => void;
  setDimBlocked: (v: number) => void;
  setAppFontFamily: (v: string) => void;
  setWindowZoom: (v: number) => void;
  setOrchestratorAgent: (v: string) => void;
  setOrchestratorModel: (v: string) => void;
}

const DEFAULTS = {
  language: "ko" as Language,
  projectTabPosition: "top" as TabPosition,
  contentTabPosition: "top" as TabPosition,
  splitHeaderMode: "title" as SplitHeaderMode,
  remoteDestructive: "allow" as DangerPolicy,
  remoteInject: "allow" as DangerPolicy,
  iconSet: "lucide",
  iconBox: false,
  focusIndicator: "outline" as FocusIndicator,
  defaultProjectRoot: "",
  tabCloseConfirm: "warn" as TabCloseConfirm,
  rightSidebarMode: "overlay" as RightSidebarMode,
  railLook: "ground" as RailLook,
  railRelation: "stroke" as RailRelation,
  railFill: "none" as RailFill,
  focusDim: true,
  railSeamStyle: "edge" as RailSeamStyle,
  // A blocked edge in FLOW is resolved by the smallest leaf swap by default. Not applied to PIN.
  railPullFocused: true,
  // Empty = theme color. A user value paints the solid seam instead.
  railSolidColor: "",
  // User-confirmed 2026-08-02: non-focused panes sink 50%, panes wedged where the rail cannot
  // arrive sink 70%.
  dimIdle: 0.5,
  dimBlocked: 0.7,
  appFontFamily:
    '"JetBrains Mono", "SF Mono", "Cascadia Code", Menlo, Consolas, "Courier New", monospace',
  // Whole-window zoom factor (⌘± when the frame is selected) — one value shared by every surface
  // (main plus child webviews).
  windowZoom: 1,
  orchestratorAgent: "claude",
  orchestratorModel: "haiku",
};

/** Folds into 0..1 — a non-number is not turned into 0; a separate slot rejects it (settings.set). */
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const KEY = "soksak.settings";

type PersistedSettings = typeof DEFAULTS;

/**
 * Extracts only the persisted fields — the shared single truth for load/save/applyPersisted and the
 * **read surface**.
 *
 * Everything stored is readable. An unreadable value makes the state undiagnosable, and without
 * diagnosis a defect ends as "cannot reproduce" (real incident 2026-08-02: `railLook` was stored
 * but had no slot to read it and no slot to change it, so there was no way even to determine the
 * condition on the user's screen).
 * Writes may be narrow — some settings have their own validation in a dedicated command. Reads
 * must not be narrow.
 */
export function serialize(s: SettingsState): PersistedSettings {
  return {
    language: s.language,
    projectTabPosition: s.projectTabPosition,
    contentTabPosition: s.contentTabPosition,
    splitHeaderMode: s.splitHeaderMode,
    remoteDestructive: s.remoteDestructive,
    remoteInject: s.remoteInject,
    iconSet: s.iconSet,
    iconBox: s.iconBox,
    focusIndicator: s.focusIndicator,
    defaultProjectRoot: s.defaultProjectRoot,
    tabCloseConfirm: s.tabCloseConfirm,
    rightSidebarMode: s.rightSidebarMode,
    railLook: s.railLook,
    railRelation: s.railRelation,
    railFill: s.railFill,
    focusDim: s.focusDim,
    railSeamStyle: s.railSeamStyle,
    railPullFocused: s.railPullFocused,
    railSolidColor: s.railSolidColor,
    dimIdle: s.dimIdle,
    dimBlocked: s.dimBlocked,
    appFontFamily: s.appFontFamily,
    windowZoom: s.windowZoom,
    orchestratorAgent: s.orchestratorAgent,
    orchestratorModel: s.orchestratorModel,
  };
}

// app.data is authoritative, ls is the synchronous cache. init runs at boot. apply = write the
// authority into the store on arrival (no save).
const settingsSync = createCoreSync<PersistedSettings>({
  key: "settings",
  lsKey: KEY,
  fallback: DEFAULTS,
  apply: (v) => useSettings.setState({ ...DEFAULTS, ...v }),
});
export const initSettingsPersistence = (deps: CoreStoreDeps): (() => void) =>
  settingsSync.init(deps);

function load(): PersistedSettings {
  // Unknown (deleted) keys are dropped — e.g. the old appFontSize. Only keys present in DEFAULTS
  // are accepted, so a dead axis cannot come back as state.
  const stored = settingsSync.loadSync() as Record<string, unknown>;
  const known: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (k in stored) known[k] = stored[k];
  }
  return { ...DEFAULTS, ...known } as PersistedSettings;
}

// The store is outside the module boundary — a hot swap that replaces it makes registrations,
// subscriptions, and screen state all new, while the side that filled them treats them as already
// filled and never refills (empty forever).
export const useSettings = moduleState("state/settings#store", () =>
  create<SettingsState>((set, get) => {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const saveDebounced = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      save();
    }, 300);
  };
  const save = () => {
    settingsSync.save(serialize(get()));
  };
  return {
    ...load(),
    setLanguage: (language) => {
      set({ language });
      save();
    },
    setProjectTabPosition: (projectTabPosition) => {
      set({ projectTabPosition });
      save();
    },
    setContentTabPosition: (contentTabPosition) => {
      set({ contentTabPosition });
      save();
    },
    setSplitHeaderMode: (splitHeaderMode) => {
      set({ splitHeaderMode });
      save();
    },
    setRemoteDestructive: (remoteDestructive) => {
      set({ remoteDestructive });
      save();
    },
    setRemoteInject: (remoteInject) => {
      set({ remoteInject });
      save();
    },
    setIconSet: (iconSet) => {
      set({ iconSet });
      save();
    },
    setIconBox: (iconBox) => {
      set({ iconBox });
      save();
    },
    setFocusIndicator: (focusIndicator) => {
      set({ focusIndicator });
      save();
    },
    setDefaultProjectRoot: (defaultProjectRoot) => {
      set({ defaultProjectRoot });
      save();
    },
    setTabCloseConfirm: (tabCloseConfirm) => {
      set({ tabCloseConfirm });
      save();
    },
    setRailLook: (railLook) => {
      set({ railLook });
      save();
    },
    setRailRelation: (railRelation) => {
      set({ railRelation });
      save();
    },
    setRailFill: (railFill) => {
      set({ railFill });
      save();
    },
    setFocusDim: (focusDim) => {
      set({ focusDim });
      save();
    },
    setRailSeamStyle: (railSeamStyle) => {
      set({ railSeamStyle });
      save();
    },
    setRailPullFocused: (railPullFocused) => {
      set({ railPullFocused });
      save();
    },
    setRailSolidColor: (railSolidColor) => {
      set({ railSolidColor });
      save();
    },
    // The strength cannot leave 0..1 — outside it, brightness goes negative and the screen inverts.
    setDimIdle: (v) => {
      set({ dimIdle: clamp01(v) });
      save();
    },
    setDimBlocked: (v) => {
      set({ dimBlocked: clamp01(v) });
      save();
    },
    setRightSidebarMode: (rightSidebarMode) => {
      set({ rightSidebarMode });
      save();
    },
    setAppFontFamily: (appFontFamily) => {
      set({ appFontFamily });
      save();
    },
    setWindowZoom: (windowZoom) => {
      // Clamp the window zoom factor (0.5..2.0). Persist is debounced (300ms) against key-repeat storms.
      set({ windowZoom: Math.max(0.5, Math.min(2, windowZoom)) });
      saveDebounced();
    },
    setOrchestratorAgent: (orchestratorAgent) => {
      set({ orchestratorAgent });
      save();
    },
    setOrchestratorModel: (orchestratorModel) => {
      set({ orchestratorModel });
      save();
    },
  };
}),
);
