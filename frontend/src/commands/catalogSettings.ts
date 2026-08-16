// settings.* / theme.* — the settings and theme catalog (split out — the single truth is the same
// registry).
//
// Separated from the core catalog: the sealed file length (scripts/gates/baseline-file-length.txt)
// required catalog.ts to be split below 1500 lines, and this block already has its own clear axis
// (one setting value and where it is applied). Same shape as the precedents (catalogCapture,
// catalogDebug).
//
// Terminal appearance (shell/font/cursor/scrollback/renderer) is not here — it is not a core
// setting; the terminal plugin owns it (manifest configuration → plugin.<id>.settings.*).

import { invoke, frameworkPath } from "../framework";
import { recordWindowFrames } from "./windowRecorder";
import { suggestLayout, type MonitorFact, type WindowFact } from "../lib/layoutSuggest";
import { tmsg } from "../i18n";
import { register } from "./registry";
import { notFound } from "./refuse";
import { serialize, useSettings } from "../state/settings";
import { useTheme } from "../state/theme";
import { useIconRegistry } from "../ui/icons/registry";
import { applyWindowZoom } from "../lib/zoomIntent";

export function registerSettingsCatalog(): void {
  // splitHeaderMode is fixed to tab mode (decision 2026-06), so it is excluded from the surface.
  const SETTING_KEYS = [
    "language",
    "workspaceTabPosition",
    "contentTabPosition",
    "iconSet",
    "iconBox",
    "focusIndicator",
    "railRelation",
    "railFill",
    "focusDim",
    "railSeamStyle",
    "railPullFocused",
    "railSolidColor",
    "dimIdle",
    "dimBlocked",
    "appFontFamily",
    "windowZoom",
  ] as const;

  register("settings.get", {
    description: tmsg("cmd.settings.get.desc"),
    triggers: { ko: "설정 확인 앱 설정 조회 환경설정" },
    params: {},
    returns: "{ <every persisted setting>, iconSets[], theme, themeMode }",
    message: () => tmsg("msg.settings.get"),
    examples: ["settings.get"],
    handler: () => {
      const s = useSettings.getState();
      return {
        // **Everything persisted is read back.** Deriving from the write list (SETTING_KEYS) drops
        // settings that have their own dedicated command silently, and one of them (railLook) had
        // nowhere to be queried at all. The source of reads is the one persisted snapshot — as the
        // stored list grows, reads grow with it.
        ...serialize(s),
        // The selectable icon sets (built-in + those registered by active plugins).
        iconSets: Object.values(useIconRegistry.getState().sets).map((x) => ({
          id: x.id,
          name: x.name,
        })),
        theme: useTheme.getState().current,
        themeMode: useTheme.getState().effectiveMode,
      };
    },
  });

  register("settings.set", {
    description: `Change an application setting. key: ${SETTING_KEYS.join("|")}`,
    triggers: { ko: "설정 변경 설정 바꾸기 환경설정 변경 폰트 크기 언어" },
    params: {
      key: {
        type: "string",
        description: tmsg("cmd.settings.set.param.key"),
        enum: SETTING_KEYS,
        required: true,
      },
      value: {
        type: "json",
        description:
          "Value — language:ko|en, workspaceTabPosition:top|left, contentTabPosition:top|left, iconSet:string (registered set id — unregistered falls back to lucide), iconBox:boolean, focusIndicator:outline|corners, railRelation:tint|moment|stroke (rail-pane relation surface — tint fill only, moment flash on rebind, stroke outline+label), railFill:none|faint (bound-pane background in stroke mode — none is the default, faint is a 1% accent tint), focusDim:boolean (spotlight — every pane dims except the active one), railSeamStyle:seam|edge (how a manufactured FLOW adjacency is marked: seam dashes the inner shared edge, edge dashes the outer right edge), railPullFocused:boolean (FLOW-only blocked-line policy: true minimally swaps a leaf pane to preserve adjacency; false preserves pane order and stops the rail at the nearest clean line. PIN always preserves both the rail station and pane layout), railSolidColor:string (CSS color for a solid relation seam — empty leaves it to the theme), dimIdle:number (0-1 — how far a pane that is not focused sinks), dimBlocked:number (0-1 — how far a pane stranded between the rail and the focused pane sinks; deeper than dimIdle, or being covered is invisible), appFontFamily:string (CSS font-family stack), windowZoom:number (0.5-2.0 — whole-window zoom factor applied to the main webview and every child webview)",
        required: true,
      },
    },
    returns: "{ key, value }",
    message: (d) => tmsg("msg.settings.set", { key: String(d.key) }),
    errors: ["INVALID_PARAMS"],
    examples: [
      'settings.set \'{"key":"workspaceTabPosition","value":"left"}\'',
      'settings.set \'{"key":"contentTabPosition","value":"left"}\'',
      'settings.set \'{"key":"iconBox","value":true}\'',
    ],
    handler: async (p) => {
      const s = useSettings.getState();
      const key = p.key as (typeof SETTING_KEYS)[number];
      const v = p.value;
      const bad = (need: string) => ({
        ok: false as const,
        code: "INVALID_PARAMS" as const,
        message: tmsg("msg.settings.set.invalidValue", { key, need }),
      });
      switch (key) {
        case "language":
          if (v !== "ko" && v !== "en") return bad("ko|en");
          s.setLanguage(v);
          break;
        case "workspaceTabPosition":
          if (v !== "top" && v !== "left") return bad("top|left");
          s.setWorkspaceTabPosition(v);
          break;
        case "contentTabPosition":
          if (v !== "top" && v !== "left") return bad("top|left");
          s.setContentTabPosition(v);
          break;
        case "iconSet":
          if (typeof v !== "string" || !v.trim())
            return bad(tmsg("msg.settings.set.needIconSet"));
          s.setIconSet(v.trim());
          break;
        case "iconBox":
          if (typeof v !== "boolean") return bad("boolean");
          s.setIconBox(v);
          break;
        case "focusIndicator":
          if (v !== "outline" && v !== "corners") return bad("outline|corners");
          s.setFocusIndicator(v);
          break;
        case "railRelation":
          if (v !== "tint" && v !== "moment" && v !== "stroke")
            return bad("tint|moment|stroke");
          s.setRailRelation(v);
          break;
        case "railFill":
          if (v !== "none" && v !== "faint") return bad("none|faint");
          s.setRailFill(v);
          break;
        case "focusDim":
          if (typeof v !== "boolean") return bad("boolean");
          s.setFocusDim(v);
          break;
        case "railSeamStyle":
          if (v !== "seam" && v !== "edge") return bad("seam|edge");
          s.setRailSeamStyle(v);
          break;
        case "railPullFocused":
          if (typeof v !== "boolean") return bad("boolean");
          s.setRailPullFocused(v);
          break;
        case "railSolidColor": // "" = leave it to the theme
          if (typeof v !== "string") return bad(tmsg("msg.settings.set.needCssColor"));
          s.setRailSolidColor(v.trim());
          break;
        // Both intensity axes share one rule — written separately, only one of them gets fixed. A
        // non-number is not folded to 0: 0 means "no dimming", so it would be a silent success.
        case "dimIdle":
        case "dimBlocked":
          if (typeof v !== "number" || !Number.isFinite(v)) return bad("number(0~1)");
          (key === "dimIdle" ? s.setDimIdle : s.setDimBlocked)(v);
          break;
        case "appFontFamily":
          if (typeof v !== "string" || !v.trim())
            return bad(tmsg("msg.settings.set.needFontFamily"));
          s.setAppFontFamily(v.trim());
          break;
        case "windowZoom":
          if (typeof v !== "number" || !Number.isFinite(v))
            return bad(tmsg("msg.settings.set.needWindowZoom"));
          s.setWindowZoom(v);
          await applyWindowZoom(useSettings.getState().windowZoom);
          break;
        default:
          // **A key on the list with no matching branch succeeds silently.** The caller then
          // treats the setting as changed and builds a flow on it while the value stays as it was
          // (measured 2026-08-02: railPullFocused got OK and did not change). An unhandled key is
          // rejected with its name.
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: tmsg("msg.settings.set.noSink", { key }),
          };
      }
      return { key, value: v };
    },
  });

  register("layout.suggest", {
    description:
      "Suggest window placements from current monitor/window facts (pure strategy — nothing moves). strategy spread: orchestrator windows take a monitor free of workspace windows whole (or the right third alongside on a single monitor); workspace windows fill their own monitor. strategy grid: tile all windows on the first monitor. Feed each placement to window.place to execute.",
    triggers: {
      ko: "창 배치 제안 전략 모니터 분배 오케스트레이터 배치",
    },
    params: {
      strategy: {
        type: "string",
        description: tmsg("cmd.layout.suggest.param.strategy"),
        enum: ["spread", "grid"],
        default: "spread",
      },
      roles: {
        type: "json",
        description:
          'Optional label→role map, e.g. {"main":"orchestrator"} — unlisted windows count as workspace windows',
      },
    },
    returns: "{ placements: [{label,monitor,x,y,w,h}] }",
    message: (d) => tmsg("msg.layout.suggest", { n: ((d.placements as unknown[]) ?? []).length }),
    examples: [
      'layout.suggest \'{"strategy":"spread","roles":{"main":"orchestrator"}}\'',
    ],
    handler: async (p) => {
      const facts = (await invoke("window_monitors")) as {
        monitors: MonitorFact[];
        windows: WindowFact[];
      };
      const placements = suggestLayout({
        monitors: facts.monitors,
        windows: facts.windows,
        strategy: (p.strategy as "spread" | "grid") ?? "spread",
        roles: (p.roles as Record<string, "orchestrator" | "workspace">) ?? undefined,
      });
      return { placements };
    },
  });

  register("activity.recent", {
    description:
      "Query the app-wide activity stream (P12 execution visibility): registry command executions (command/source/danger/duration/outcome — param keys only, no values), terminal command start/finish, AI turn ends, view activations. Cursor with since (exclusive seq) to fetch only new entries; entries carry monotonic seq + epoch-ms ts. Same answer from any window (process-wide singleton hub).",
    triggers: {
      ko: "활동 피드 실행 기록 최근 명령 스트림 조회 오케스트레이터",
    },
    params: {
      since: {
        type: "number",
        description: tmsg("cmd.activity.recent.param.since"),
      },
      limit: {
        type: "number",
        description: tmsg("cmd.activity.recent.param.limit"),
        default: 200,
      },
    },
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ entries: [{ seq, ts, kind, source, payload }] }",
    message: (d) => tmsg("msg.activity.recent", { n: ((d.entries as unknown[]) ?? []).length }),
    examples: [
      'activity.recent \'{"limit":20}\'',
      'activity.recent \'{"since":1234}\'',
    ],
    // §5 R2: a query is a fact too — it is recorded (linear growth only, not feedback; the tts
    // axis blocks the read-aloud loop). A component's own backfill is declared by the caller as
    // origin:"internal" (only the exposure drops).
    handler: async (p) => {
      const entries = await invoke("activity_recent", {
        since: p.since ?? null,
        limit: p.limit ?? 200,
      });
      return { entries };
    },
  });

  register("window.themeScan", {
    description:
      "Measure whether a dark/light theme transition is atomic across screen regions. Records the toggle, then reports each region's transition frame and how many frames they are out of sync (a torn frame is chrome already switched while content has not). Idempotent — replaces ad-hoc capture scripts. Restores the original theme when done.",
    triggers: {
      ko: "테마 전환 검사 원자성 깜빡임 tear 측정 다크 라이트 토글 회귀",
    },
    params: {
      theme: {
        type: "string",
        description: tmsg("cmd.window.themeScan.param.theme"),
      },
      from: {
        type: "string",
        description: tmsg("cmd.window.themeScan.param.from"),
        enum: ["light", "dark"],
      },
      to: {
        type: "string",
        description: tmsg("cmd.window.themeScan.param.to"),
        enum: ["light", "dark"],
      },
      frames: { type: "number", description: "Frames to capture (default 40)" },
      intervalMs: {
        type: "number",
        description: tmsg("cmd.window.themeScan.param.intervalMs"),
      },
      applyAtMs: {
        type: "number",
        description: tmsg("cmd.window.themeScan.param.applyAtMs"),
      },
      settleMs: {
        type: "number",
        description: tmsg("cmd.window.themeScan.param.settleMs"),
      },
      skipCapture: {
        type: "boolean",
        description:
          "Measure latency only (applyJsMs, applyReflowMs) and skip frame capture — fast, robust even when the window is backgrounded. For A/B latency tuning.",
      },
      regions: {
        type: "json",
        description:
          "Named fractional rects {name:{x0,y0,x1,y1}} (0..1). Default samples chrome top bar, center content, and left sidebar.",
      },
    },
    returns:
      "{ frames, frameMs (measured capture interval), spreadFrames, spreadMs, atomic, regions:[{name,start,end,transitionFrame}] }",
    message: (d) =>
      d.atomic !== undefined
        ? d.atomic
          ? tmsg("msg.window.themeScan.atomic")
          : tmsg("msg.window.themeScan.torn", { n: Number(d.spreadFrames) })
        : tmsg("msg.window.themeScan"),
    examples: [
      "window.themeScan",
      'window.themeScan \'{"theme":"Midnight","frames":48}\'',
    ],
    handler: async (p) => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const ts = useTheme.getState();
      const theme = (p.theme as string | undefined) ?? ts.current;
      const startMode = (p.from as "light" | "dark" | undefined) ?? "dark";
      const endMode = (p.to as "light" | "dark" | undefined) ?? "light";
      // Defaults are conservative so the call fits inside the 10s RPC with room (native capture
      // takes ~55ms per frame, slower than intervalMs and stalling now and then — a transition is
      // 3-5 frames, so 20 frames is enough).
      const frames = (p.frames as number | undefined) ?? 20;
      const intervalMs = (p.intervalMs as number | undefined) ?? 16;
      const applyAtMs = (p.applyAtMs as number | undefined) ?? 180;
      const settleMs = (p.settleMs as number | undefined) ?? 600;
      const regionMap =
        (p.regions as Record<
          string,
          { x0: number; y0: number; x1: number; y1: number }
        >) ?? {
          // Chrome top bar / center content (editor, terminal) / left sidebar — the three regions
          // that expose a tear.
          top: { x0: 0.3, y0: 0.0, x1: 0.95, y1: 0.06 },
          center: { x0: 0.45, y0: 0.15, x1: 0.95, y1: 0.85 },
          left: { x0: 0.02, y0: 0.2, x1: 0.22, y1: 0.85 },
        };
      const names = Object.keys(regionMap);
      const regionList = names.map((n) => regionMap[n]);

      // The original theme/mode — restored after the scan (idempotent call, no side effects).
      const prevTheme = ts.current;
      const prevMode = ts.effectiveMode;

      let stage = "start";
      try {
        stage = "path";
        const { tempDir, join } = frameworkPath;
        const dir = await join(
          await tempDir(),
          "soksak",
          `themescan-${Date.now()}`,
        );

        // 1) Set the start mode + settle.
        stage = "applyStart";
        useTheme.getState().apply(theme, startMode);
        await sleep(settleMs);
        // 1b) Clean latency measurement (before capture, so a concurrent capture slowing rAF does
        // not contaminate it). Instead of rAF, a forced reflow (offsetHeight) measures synchronous
        // style recalc+layout — robust even in a background window (paint/composite are excluded,
        // but recalc+layout is the main cost of a theme change). applyJsMs = synchronous JS (the
        // plugin theme.changed handler), applyReflowMs = that plus recalc+layout.
        stage = "measurePaint";
        const applyT0 = performance.now();
        useTheme.getState().apply(theme, endMode);
        const applyJsMs = performance.now() - applyT0;
        void document.documentElement.offsetHeight;
        const applyReflowMs = performance.now() - applyT0;
        // skipCapture: latency only, no capture — fast and robust (even for an occluded window or
        // headless). For optimization A/B.
        if (p.skipCapture) {
          useTheme.getState().apply(prevTheme, prevMode);
          return {
            applyJsMs: Math.round(applyJsMs),
            applyReflowMs: Math.round(applyReflowMs),
            skipped: "capture",
          };
        }
        // Back to startMode for the capture pass, with a short settle.
        useTheme.getState().apply(theme, startMode);
        await sleep(250);
        // 2) Start recording (no await) → toggle to the end mode after applyAtMs → await the
        // recording.
        stage = "record";
        const recT0 = performance.now();
        const recP = recordWindowFrames({
          dir,
          frames,
          intervalMs,
        });
        await sleep(applyAtMs);
        useTheme.getState().apply(theme, endMode);
        const n = await recP;
        // Measured frame interval (native capture can be slower than intervalMs — tear ms is
        // computed from this).
        const realFrameMs = n > 0 ? (performance.now() - recT0) / n : intervalMs;
        // 3) Per-frame region luminance → tear verdict.
        stage = "analyze";
        const grid = await invoke<number[][]>(
          "plugin:webview-capture|analyze_regions",
          { dir, regions: regionList },
        );
        // 4) Restore the original theme.
        useTheme.getState().apply(prevTheme, prevMode);

        stage = "interpret";
        const round = (v: number) => Math.round(v);
        const per = names.map((name, c) => {
          const start = grid[0]?.[c] ?? 0;
          const end = grid[grid.length - 1]?.[c] ?? 0;
          const mid = (start + end) / 2;
          const rising = end >= start;
          let transitionFrame = -1;
          for (let f = 0; f < grid.length; f++) {
            const v = grid[f]?.[c] ?? 0;
            if (rising ? v >= mid : v <= mid) {
              transitionFrame = f;
              break;
            }
          }
          return { name, start: round(start), end: round(end), transitionFrame };
        });
        const tfs = per.map((r) => r.transitionFrame).filter((f) => f >= 0);
        const minTf = tfs.length ? Math.min(...tfs) : 0;
        const maxTf = tfs.length ? Math.max(...tfs) : 0;
        const spreadFrames = maxTf - minTf;
        return {
          frames: n,
          frameMs: Math.round(realFrameMs),
          applyJsMs: Math.round(applyJsMs),
          applyReflowMs: Math.round(applyReflowMs),
          spreadFrames,
          spreadMs: Math.round(spreadFrames * realFrameMs),
          atomic: spreadFrames === 0,
          regions: per,
        };
      } catch (e) {
        // A failure rather than a hang returns with the stage (so it does not go silent as a
        // timeout).
        try {
          useTheme.getState().apply(prevTheme, prevMode);
        } catch {
          /* A failed restore is secondary */
        }
        return { error: String(e), stage };
      }
    },
  });

  register("theme.list", {
    description:
      "List available themes (built-in + external ~/.soksak/themes), including files that failed validation and their reasons.",
    triggers: { ko: "테마 목록 테마 보기 사용 가능 테마" },
    params: {},
    returns:
      "{ current, mode, themes:[{name,defaultMode,modes,source,warnings,relation}], rejected }",
    message: (d) => tmsg("msg.theme.list", { n: ((d.themes as unknown[]) ?? []).length }),
    examples: ["theme.list"],
    handler: () => {
      const s = useTheme.getState();
      return {
        current: s.current,
        mode: s.effectiveMode,
        themes: Object.values(s.themes).map((th) => ({
          name: th.name,
          defaultMode: th.defaultMode,
          modes: th.colorsAlt ? ["light", "dark"] : [th.defaultMode],
          source: th.source,
          warnings: s.warnings[th.name] ?? [],
          relation: th.relation,
        })),
        rejected: s.rejected,
      };
    },
  });

  register("theme.apply", {
    description: tmsg("cmd.theme.apply.desc"),
    triggers: { ko: "테마 적용 테마 바꾸기 다크 모드 라이트 모드 색 테마" },
    params: {
      name: { type: "string", description: "Theme name (see theme.list)", required: true },
      mode: { type: "string", description: "Color mode", enum: ["light", "dark"] },
    },
    returns: "{ name, mode }",
    message: (d) => tmsg("msg.theme.apply", { name: String(d.name) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['theme.apply \'{"name":"Paper"}\'', 'theme.apply \'{"name":"Midnight","mode":"light"}\''],
    handler: (p) => {
      const s = useTheme.getState();
      const ok2 = s.apply(p.name as string, p.mode as "light" | "dark" | undefined);
      if (!ok2) return notFound("msg.theme.apply.notFound", { name: String(p.name) });
      const cur = useTheme.getState();
      return { name: cur.current, mode: cur.effectiveMode };
    },
  });

  register("theme.reload", {
    description: tmsg("cmd.theme.reload.desc"),
    triggers: { ko: "테마 새로고침 테마 리로드 외부 테마 재스캔" },
    params: {},
    returns: "{ count, rejected }",
    message: (d) => tmsg("msg.theme.reload", { n: Number(d.count) }),
    examples: ["theme.reload"],
    handler: async () => {
      await useTheme.getState().reload();
      const s = useTheme.getState();
      return { count: Object.keys(s.themes).length, rejected: s.rejected };
    },
  });

  register("theme.install", {
    description: tmsg("cmd.theme.install.desc"),
    triggers: { ko: "테마 설치 테마 추가 외부 테마 설치" },
    params: {
      path: { type: "string", description: "Absolute path to theme .json file", required: true },
    },
    returns: "{ installed(install path), rejected? }",
    message: (d) =>
      d.rejected
        ? tmsg("msg.theme.install.rejected")
        : tmsg("msg.theme.install.installed", { path: String(d.installed) }),
    errors: ["INTERNAL"],
    examples: ['theme.install \'{"path":"<local-evidence>/dracula.json"}\''],
    handler: async (p) => {
      const installed = await useTheme.getState().install(p.path as string);
      const s = useTheme.getState();
      const reject = s.rejected.find((r) => r.file === installed);
      return reject ? { installed, rejected: reject.errors } : { installed };
    },
  });

}
