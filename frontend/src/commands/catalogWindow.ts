// Window surface commands — position, size, focus, open/close, monitors, layers.
//
// Split out of the catalog: a window is a surface the framework owns (AppFramework), and the
// commands on that axis stay in one block so "what can be asked of a window" reads in one place.
//
// The catalog owns the shared resolvers (`windowTarget`, `P`, `notFound`) — redefining them here
// would fork the same rule per file (omitted label = the addressed target).
import { invoke, currentWindow, suspendNativeSurfaces, windowByLabel } from "../framework";
import { tmsg } from "../i18n";
import { register } from "./registry";
import { notFound } from "./refuse";
import { currentWindowLabel } from "../lib/webviewLabels";
import { validateProjectRoot } from "../lib/projectRoot";
import { forgetWindowSlot } from "../state/windowBoot";
import {
  snapshotSize,
  type WindowSnapshotLike,
} from "../state/snapshotGeneration";
import { windowTarget, P } from "./catalog";
import {
  WINDOW_RECORD_MAX_BYTES,
  recordWindowFrames,
  validWindowRecordMaxBytes,
} from "./windowRecorder";
import { runWindowResizeSequence } from "./windowResizeSequence";
import {
  RESIZE_TRANSACTION_PHASES,
  sampleWindowResizeProbe,
  type ResizeSequenceStep,
} from "../lib/windowResizeProbe";

export function registerWindowCatalog(): void {
  register("window.info", {
    description: "Get window screen position, size, and scale factor (for automation validation — outerPosition is physical pixels).",
    params: {},
    returns: "{ x, y, w, h, scale }",
    message: (d) => tmsg("msg.window.info", { w: Number(d.w), h: Number(d.h) }),
    examples: ["window.info"],
    handler: async () => {
      const win = currentWindow();
      const [pos, size, scale] = await Promise.all([
        win.outerPosition(),
        win.outerSize(),
        win.scaleFactor(),
      ]);
      return { x: pos.x, y: pos.y, w: size.width, h: size.height, scale };
    },
  });

  register("window.viewport", {
    description: "Read the exact native content/main-WKWebView frame and this renderer's DOM viewport/root rectangles in their declared coordinate spaces.",
    params: {},
    returns: "{ window,generation,sequence,trigger,owner,backingScale,coordinateSpace,contentBounds,requestedFrame,mainRootFrame,corrected,matched,events:[{window,generation,sequence,trigger,owner,backingScale,coordinateSpace,contentBounds,requestedFrame,mainRootFrame,corrected,matched}],maxEvents,dom:{innerWidth,innerHeight,devicePixelRatio,documentElement,body},fill:{widthRatio,heightRatio,areaRatio,matched} }",
    message: () => "window viewport receipt",
    examples: ["window.viewport"],
    handler: async () => {
      const native = await invoke<{
        window: string;
        generation: number;
        sequence: number;
        trigger: "attach" | "logical-size" | "content-bounds" | "backing-scale";
        owner: string;
        matched: boolean;
        backingScale: number;
        coordinateSpace: string;
        contentBounds: { x: number; y: number; w: number; h: number };
        requestedFrame: { x: number; y: number; w: number; h: number };
        mainRootFrame: { x: number; y: number; w: number; h: number };
        corrected: boolean;
        events: Array<{
          window: string;
          generation: number;
          sequence: number;
          trigger: string;
          owner: string;
          backingScale: number;
          coordinateSpace: string;
          contentBounds: { x: number; y: number; w: number; h: number };
          requestedFrame: { x: number; y: number; w: number; h: number };
          mainRootFrame: { x: number; y: number; w: number; h: number };
          corrected: boolean;
          matched: boolean;
        }>;
        maxEvents: number;
      }>("window_viewport_native", { label: currentWindowLabel() });
      const rect = (element: Element) => {
        const value = element.getBoundingClientRect();
        return { x: value.x, y: value.y, w: value.width, h: value.height };
      };
      const dom = {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        documentElement: rect(document.documentElement),
        body: rect(document.body),
      };
      const widthRatio = native.mainRootFrame.w / native.contentBounds.w;
      const heightRatio = native.mainRootFrame.h / native.contentBounds.h;
      return {
        ...native,
        dom,
        fill: {
          widthRatio,
          heightRatio,
          areaRatio: widthRatio * heightRatio,
          matched: native.mainRootFrame.x === native.contentBounds.x
            && native.mainRootFrame.y === native.contentBounds.y
            && widthRatio === 1
            && heightRatio === 1
            && dom.innerWidth === native.contentBounds.w
            && dom.innerHeight === native.contentBounds.h
            && dom.documentElement.x === 0 && dom.documentElement.y === 0
            && dom.documentElement.w === dom.innerWidth
            && dom.documentElement.h === dom.innerHeight
            && dom.body.x === 0 && dom.body.y === 0
            && dom.body.w === dom.innerWidth
            && dom.body.h === dom.innerHeight,
        },
      };
    },
  });

  register("window.move", {
    description: "Move the window to a screen position in physical pixels (for automation and multi-monitor validation).",
    params: {
      x: { type: "number", description: "Physical x coordinate", required: true },
      y: { type: "number", description: "Physical y coordinate", required: true },
    },
    returns: "{ x, y }",
    message: (d) => tmsg("msg.window.move", { x: Number(d.x), y: Number(d.y) }),
    examples: ['window.move \'{"x":0,"y":0}\''],
    handler: async (p) => {
      await currentWindow().setPhysicalPosition(p.x as number, p.y as number);
      return { x: p.x, y: p.y };
    },
  });

  register("window.resize", {
    description: "Resize the window to a physical pixel size (for automation and resize-path E2E — drives the native window resize, the same path as edge-drag, which pane.resize does not exercise).",
    params: {
      w: { type: "number", description: "Physical width", required: true },
      h: { type: "number", description: "Physical height", required: true },
    },
    returns: "{ w, h }",
    message: (d) => tmsg("msg.window.resize", { w: Number(d.w), h: Number(d.h) }),
    examples: ['window.resize \'{"w":1200,"h":800}\''],
    handler: async (p) => {
      await currentWindow().setPhysicalSize(p.w as number, p.h as number);
      return { w: p.w, h: p.h };
    },
  });

  register("window.resizeSequence", {
    description:
      "Apply a finite sequence of native physical window sizes in order. Before the first size is requested the same observer that answers every step is read once, and that pre-resize observation is returned as baseline; a value is never derived from the requested sizes. baseline.status separates an observer that was never asked, one that refused because no settled native transaction exists yet, and a real observation — a refusal reports its reason and never cancels the finite resize transaction. Optional realtime recording is separate visual evidence: successful readiness places the baseline frame before the first resize, while recording startup/readiness/completion failures are reported in recording.status and never cancel the finite resize transaction. Used to reproduce live-resize stalls, blanks, stale frames, and surface drift without focusing the window.",
    params: {
      sizes: {
        type: "json",
        description: "Ordered array of physical pixel sizes: [{w,h,phase?}, ...] (1..120). "
          + `phase declares what this step is for (${RESIZE_TRANSACTION_PHASES.join("|")}); `
          + "an observation reports it back beside the geometry it actually measured, so a "
          + "step whose result contradicts its declared intent is visible. Unknown phase names "
          + "are refused.",
        required: true,
      },
      intervalMs: {
        type: "number",
        description: "Caller-owned delay between size changes in ms (default 8, 0..1000)",
      },
      recordDir: { type: "string", description: "Optional output directory for transition PNGs" },
      recordFrames: { type: "number", description: "Frames to record when recordDir is set (default 64, max 600)" },
      recordIntervalMs: { type: "number", description: "Recording interval in ms (default 16, 0..1000)" },
      recordMaxBytes: {
        type: "number",
        description: `Optional total encoded PNG byte budget (positive safe integer, max ${WINDOW_RECORD_MAX_BYTES})`,
      },
    },
    returns:
      "{ steps, recording:{status:'not-requested'|'complete'|'failed',mode:'realtime',dir?,requestedFrames?,frames?,reason?}, resizeElapsedMs, elapsedMs, final:{w,h}, baseline:{status:'not-observed'|'unavailable'|'observed',reason?,observation?}, samples:[{step,size,observation}] }",
    message: (d) => {
      const recording = d.recording as Record<string, unknown> | undefined;
      return tmsg("msg.window.resizeSequence", {
        steps: Number(d.steps),
        frames: Number(recording?.frames ?? 0),
      });
    },
    errors: ["INVALID_PARAMS"],
    examples: [
      'window.resizeSequence \'{"sizes":[{"w":900,"h":700},{"w":1500,"h":800},{"w":1200,"h":900}],"intervalMs":8}\'',
    ],
    handler: async (p) => {
      try {
        const sizes = p.sizes as ResizeSequenceStep[];
        const intervalMs = (p.intervalMs as number | undefined) ?? 8;
        const recordDir = p.recordDir as string | undefined;
        const requestedFrames = (p.recordFrames as number | undefined) ?? 64;
        const requestedIntervalMs = (p.recordIntervalMs as number | undefined) ?? 16;
        const requestedMaxBytes = p.recordMaxBytes;
        if (recordDir !== undefined && recordDir.trim().length === 0) {
          throw new Error("recordDir must not be empty");
        }
        if (recordDir !== undefined
          && (!Number.isSafeInteger(requestedFrames) || requestedFrames < 1 || requestedFrames > 600)) {
          throw new Error("recordFrames must be a safe integer between 1 and 600");
        }
        if (recordDir !== undefined
          && (!Number.isFinite(requestedIntervalMs)
            || requestedIntervalMs < 0
            || requestedIntervalMs > 1_000)) {
          throw new Error("recordIntervalMs must be between 0 and 1000");
        }
        if (requestedMaxBytes !== undefined && !validWindowRecordMaxBytes(requestedMaxBytes)) {
          throw new Error(
            `recordMaxBytes must be a safe integer between 1 and ${WINDOW_RECORD_MAX_BYTES}`,
          );
        }
        if (recordDir === undefined && (
          p.recordFrames !== undefined
          || p.recordIntervalMs !== undefined
          || requestedMaxBytes !== undefined
        )) {
          throw new Error("recordDir is required when recording options are provided");
        }
        const record = recordDir
          ? {
              dir: recordDir,
              frames: requestedFrames,
              intervalMs: requestedIntervalMs,
              ...(requestedMaxBytes === undefined ? {} : { maxBytes: requestedMaxBytes }),
            }
          : undefined;
        const win = currentWindow();
        return await runWindowResizeSequence({
          sizes,
          intervalMs,
          record,
          setSize: (w, h) => win.setPhysicalSize(w, h),
          recordFrames: recordWindowFrames,
          observe: async (request) => await sampleWindowResizeProbe(request),
        });
      } catch (error) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  register("window.focus", {
    description:
      "Bring a window to the front and focus it. Without label, focuses the window this command runs in (clears inactive state for automation); with label, focuses that window (see window.list).",
    triggers: { ko: "창 포커스 창 활성화 창 앞으로" },
    params: { label: P.windowLabel },
    returns: "{ focused: true, key }",
    message: (d) => tmsg(d.key === true ? "msg.window.focus" : "msg.window.focus.notKey"),
    examples: ["window.focus", 'window.focus \'{"label":"w-<uuid>"}\''],
    errors: ["TARGET_NOT_FOUND"],
    handler: async (p) => {
      const label = windowTarget(p);
      const labels = await invoke<string[]>("window_list");
      if (!labels.includes(label)) return notFound(tmsg("msg.window.notFound", { label }));
      // Bring the app forward only for this window — pulling the app forward on a call that named
      // someone else's window is focus theft.
      if (label === currentWindowLabel()) await invoke("window_activate");
      // Making a window key is **the window's operation**, and the label names that window.
      // "this webview right now" cannot do it: the main renderer of a workspace window is the
      // webview inside it, not the window, so the framework refuses (measured 2026-08-08:
      // `current webview is not a WebviewWindow`). Without focus, that window's child webview has
      // `document.hasFocus()` false and typing does not land.
      await invoke("window_focus", { label });
      // **The request and the result are different facts.** When another app is active, bringing
      // the window forward does not make the OS hand over the keyboard (measured 2026-08-08:
      // success was returned but that window was not key, and every keyboard command on it was
      // refused). The caller must have that fact to decide what comes next.
      const key = (await invoke<boolean>("window_is_key", { label })) === true;
      return { focused: true, key };
    },
  });

  register("window.maximize", {
    description:
      "Maximize a window to fill the screen (native window maximize — distinct from tab.maximize, which only enlarges one tab within a space). Without label, targets the window this command runs in; with label, targets that window (see window.list). Pass off:true to restore (unmaximize).",
    triggers: { ko: "창 최대화 전체화면 창 키우기 최대화 해제" },
    params: {
      label: P.windowLabel,
      off: { type: "boolean", description: "Restore (unmaximize) instead of maximizing" },
    },
    returns: "{ maximized: boolean }",
    message: (d) =>
      d.maximized ? tmsg("msg.window.maximize") : tmsg("msg.window.maximize.off"),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      "window.maximize",
      'window.maximize \'{"off":true}\'',
      'window.maximize \'{"label":"w-<uuid>"}\'',
    ],
    handler: async (p) => {
      const off = p.off === true;
      const label = windowTarget(p);
      const win = await windowByLabel(label);
      if (!win) return notFound(tmsg("msg.window.notFound", { label }));
      if (off) await win.unmaximize();
      else await win.maximize();
      return { maximized: !off };
    },
  });

  register("window.reload", {
    description:
      "Fully reload the app webview (location.reload). Picks up core/plugin code changes during development — including modules HMR misses (e.g. already-activated plugin API surfaces). Active plugins are re-activated automatically after reload (install and consent are persisted).",
    triggers: { ko: "앱 리로드 새로고침 플러그인 재시작 코드 반영" },
    params: {},
    returns: "{ reloaded: true }",
    message: () => tmsg("msg.window.reload"),
    examples: ["window.reload"],
    handler: async () => {
      // Hide this window's child surfaces (browsers) before the reload — during the renderer
      // reboot gap (JS blank ~150ms) a ghost window with the previous browser still up is not
      // closed by the boot-prologue hide alone (that hide runs only after the new renderer starts).
      // The hide must complete before the reload.
      await suspendNativeSurfaces();
      // **The side that observes the destruction writes the record.** A renderer calling
      // `location.reload()` on itself cannot record its own death — activity publishing is
      // fire-and-forget, so it is cut the moment the window dies. Measured (2026-08-01): every
      // other command left a ledger entry, but this one left not even `command.executed`, and when
      // the reload made the window unresponsive there was no reason recorded anywhere.
      //
      // Ask the framework instead: the renderer is what terminates, and the side that received the
      // request remains. Write first, terminate after. The reply still goes first — the channel
      // disappears with the destruction.
      // **Do not swallow.** If this call fails the window is still alive and the caller already
      // got `reloaded:true` — a silent mismatch shows up only as "reload sometimes does nothing".
      // Measured 2026-08-01: swallowed by `void`, the screen looked reloaded while this call failed
      // every time on a wrong window lookup (the old path was still there).
      setTimeout(() => {
        void invoke("window_reload", { label: currentWindowLabel() }).catch((e) =>
          invoke("activity_publish", {
            kind: "webview.lifecycle",
            source: "webview",
            payload: {
              event: "reload-failed",
              labels: [currentWindowLabel()],
              origin: "command",
              message: `· webview reload failed — ${String(e).slice(0, 120)}`,
            },
          }).catch(() => {}),
        );
      }, 30);
      return { reloaded: true };
    },
  });

  // ── Multi-window ─────────────────────────────────────────────────────────
  register("window.open", {
    description:
      "Open a new project window for a project root (P6: if the root is already open in some window, no window is created — that window is focused and returned as existingWindow). root is required unless mode orchestrator, which brings the control plane (main) forward instead — opening and creating projects live there; empty project windows do not exist.",
    triggers: { ko: "새 창 창 열기 새 윈도우 프로젝트 새 창 오케스트레이터 창" },
    params: {
      root: {
        type: "string",
        description: "Project root to open in the new window (absolute path).",
      },
      alias: {
        type: "string",
        description: "Display alias for the project tab (defaults to the folder name).",
      },
      shell: {
        type: "string",
        description: "Shell binary for the project's terminals (defaults to the user shell).",
      },
      mode: {
        type: "string",
        description:
          "orchestrator = bring the control plane (main) forward. Mutually exclusive with root.",
        enum: ["orchestrator"],
      },
      focus: {
        type: "boolean",
        description:
          "Whether the new window takes focus (default true). Automation and visual verification must pass false to preserve the user's active app.",
      },
    },
    returns: "{ label } | { existingWindow } (root already open — focused instead)",
    message: (d) =>
      d.existingWindow ? tmsg("msg.window.open.existing") : tmsg("msg.window.open.created"),
    errors: ["INVALID_PARAMS"],
    hint: (d) => {
      if (d.code) return [];
      // Show how to address a command at the new window's label (--window <label>).
      const label = (d.label as string | undefined) ?? (d.existingWindow as string | undefined);
      if (!label) return [];
      return [
        {
          cmd: `--window ${label} state.tree`,
          why: tmsg("hint.flow.window.open.target", { label }),
        },
      ];
    },
    examples: [
      'window.open \'{"root":"/Users/me/work"}\'',
      'window.open \'{"root":"/Users/me/work","focus":false}\'',
      'window.open \'{"mode":"orchestrator"}\'',
    ],
    handler: async (p) => {
      if (p.mode === "orchestrator") {
        if (p.root) {
          return {
            ok: false as const,
            code: "INVALID_PARAMS" as const,
            message: tmsg("msg.window.open.modeWithRoot"),
          };
        }
        // There is exactly one control plane, main (NAMING 4b reserved word) — bring it forward if
        // present, and if the user closed it, reopen under the same reserved label (boot branches
        // on the label, so no init is needed).
        const labels = await invoke<string[]>("window_list");
        if (labels.includes("main")) {
          await invoke("window_focus", { label: "main" }).catch(() => {});
          return { existingWindow: "main" };
        }
        await invoke("window_create", { label: "main" });
        return { label: "main" };
      }
      // Empty workspace windows do not exist — opening and creating projects is a control plane
      // (main) surface.
      if (!p.root) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.window.open.rootRequired"),
        };
      }
      let root: string;
      try {
        root = await validateProjectRoot(p.root as string);
      } catch (e) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: String(e),
        };
      }
      // P6 pre-check: when the root is already open, create no window and focus the owning one
      // (zero duplicate windows). The race between check and create is finally enforced by the new
      // window's boot claim (on failure it degrades to an empty state).
      const owners = await invoke<{ owners: { root: string; window: string }[] }>(
        "project_owners",
      );
      const owner = owners.owners.find((o) => o.root === root)?.window;
      if (owner) {
        await invoke("window_focus", { label: owner }).catch(() => {});
        return { existingWindow: owner };
      }
      let init = `root=${encodeURIComponent(root)}`;
      if (typeof p.alias === "string" && p.alias) init += `&alias=${encodeURIComponent(p.alias)}`;
      if (typeof p.shell === "string" && p.shell) init += `&shell=${encodeURIComponent(p.shell)}`;
      return {
        label: await invoke<string>("window_create", {
          init,
          ...(typeof p.focus === "boolean" ? { focus: p.focus } : {}),
        }),
      };
    },
  });

  register("window.list", {
    description: "List open window labels. Use to discover targets for commands that accept a window argument.",
    triggers: { ko: "창 목록 윈도우 목록 열린 창" },
    params: {},
    returns: "{ labels }",
    message: (d) => tmsg("msg.window.list", { n: ((d.labels as unknown[]) ?? []).length }),
    examples: ["window.list"],
    handler: async () => ({ labels: await invoke<string[]>("window_list") }),
  });

  // A safety net requires that a human can see the retained previous generation — a backup that
  // cannot be read back is not a backup.
  register("window.restorePrevious", {
    description:
      "Inspect or restore the previous workspace generation for a window. The store keeps the last few values of every key, so any write — a bug, a crash, a bad tool — leaves something to come back to. Without `apply` this only reports what is there.",
    triggers: { ko: "이전 워크스페이스 복구 직전 세대 되돌리기 작업 복구" },
    params: {
      label: P.windowLabel,
      apply: {
        type: "boolean",
        description: "Write the previous generation back (default false = report only).",
      },
    },
    returns: "{ found, projects, tabs, applied }",
    message: (d) =>
      d.found
        ? tmsg("msg.window.restorePrevious.found", {
            n: Number(d.projects ?? 0),
            applied: String(d.applied),
          })
        : tmsg("msg.window.restorePrevious.none"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["window.restorePrevious", 'window.restorePrevious \'{"apply":true}\''],
    handler: async (p) => {
      const label = windowTarget(p);
      const key = `window/${label}`;
      // **The store retains the past.** A separate copy here would put the same fact in two
      // places, and then only one gets updated — "undo returns the wrong value". The store retains
      // on every write, so there is no retention condition to decide here.
      const past = await invoke<WindowSnapshotLike[]>("data_kv_history", { ns: "core", key });
      const prev = past?.[0] ?? null;
      if (!prev) return { found: false, projects: 0, tabs: 0, applied: false };
      const size = snapshotSize(prev);
      if (p.apply !== true) return { found: true, ...size, applied: false };
      // Undo is also a write, so the current value is pushed into the past — a wrong undo can be
      // undone again.
      const restored = await invoke<boolean>("data_kv_undo", { ns: "core", key });
      return { found: true, ...size, applied: restored };
    },
  });

  register("window.projects", {
    description:
      "Map open windows to the project each one hosts (root path + name + window label). The meaning layer over window.list — use it first to pick the right window before targeting commands with --window. Same answer from any window (process-wide registry).",
    triggers: { ko: "창 프로젝트 매핑 어느 창 프로젝트 열림 창별 프로젝트" },
    params: {},
    returns: "{ projects: [{ root, name, window }] }",
    message: (d) => tmsg("msg.window.projects", { n: ((d.projects as unknown[]) ?? []).length }),
    examples: ["window.projects"],
    handler: async () => {
      const owners = await invoke<{ owners: { root: string; window: string }[] }>(
        "project_owners",
      );
      const projects = owners.owners.map((o) => ({
        root: o.root,
        name: o.root.split("/").filter(Boolean).pop() ?? o.root,
        window: o.window,
      }));
      return { projects };
    },
  });

  register("window.close", {
    description:
      "Close a window. Omit label to close the window this command is addressed to — the envelope already names it, so the common case needs no argument. An unknown label is TARGET_NOT_FOUND, not an internal failure.",
    triggers: { ko: "창 닫기 윈도우 닫기" },
    params: { label: P.windowLabel },
    returns: "{ ok, label }",
    message: () => tmsg("msg.window.close"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ["window.close", 'window.close \'{"label":"w-<uuid>"}\''],
    handler: async (p) => {
      // The envelope already names the target window; demanding label on top of that kills a close
      // addressed at that window on a missing argument (measured: e2e could not close its own
      // window, so views piled up on every run). Same rule as the other surfaces — omitted =
      // the addressed target.
      const label = windowTarget(p);
      const labels = await invoke<string[]>("window_list");
      if (!labels.includes(label)) return notFound(tmsg("msg.window.notFound", { label }));
      // A close command also edits the ledger — removing only the window lets the next boot bring
      // it back (forgetWindowSlot). Even on the self-close path this runs before the destruction:
      // after it, this code no longer runs.
      await forgetWindowSlot(label);
      if (label === currentWindowLabel()) {
        // A command that destroys itself replies first — the reply channel disappears with that
        // destruction (measured: a self-window close came back as WINDOW_DESTROYED, so the caller
        // read a failure even though the window did close). window.reload uses the same shape for
        // the same reason.
        setTimeout(() => void invoke("window_close", { label }), 30);
        return { ok: true, label };
      }
      await invoke("window_close", { label });
      return { ok: true, label };
    },
  });

  register("window.occlusion", {
    description:
      "Toggle occlusion detection for every native webview in the addressed window. When false, the main renderer and native child content surfaces continue rendering while fully covered by other apps. Returns the number of native webviews actually updated, so capture automation can reject a main-only partial arm.",
    params: {
      enabled: {
        type: "boolean",
        description: "Occlusion detection on (default) / off",
        required: true,
      },
    },
    returns: "{ occlusion, webviews }",
    message: (d) =>
      d.occlusion ? tmsg("msg.window.occlusion.on") : tmsg("msg.window.occlusion.off"),
    examples: ['window.occlusion \'{"enabled":false}\''],
    handler: async (p) => {
      const enabled = !!p.enabled;
      const webviews = await invoke<number>("plugin:webview-capture|set_occlusion", { enabled });
      return { occlusion: enabled, webviews };
    },
  });

  register("window.layers", {
    description:
      "Read the compositor plugin's typed native surface inventory for this window. Returns generation-bound model/presentation frames, visibility, alpha, pane ownership, resize policy, provider-parent state, and renderer topology without exposing native pointers or walking private AppKit trees.",
    triggers: {
      ko: "네이티브 뷰 계층 레이어 덤프 child 위치 진단",
    },
    params: {},
    returns: "{ native } — compositor plugin inspection receipt",
    message: () => tmsg("msg.window.layers"),
    examples: ["window.layers"],
    handler: async () => {
      const native = await invoke<Record<string, unknown>>("engine_surface_stats");
      return { native };
    },
  });

  register("window.monitors", {
    description:
      "Monitor and window placement facts (physical px): every monitor's rect/scale/name and every window's rect, focus state, and owning monitor index. Facts only — placement strategy is layout.suggest, execution is window.place (same coordinate space).",
    triggers: {
      ko: "모니터 목록 해상도 창 배치 현황 듀얼 모니터 파악",
    },
    params: {},
    returns:
      "{ monitors: [{index,name,x,y,w,h,scale}], windows: [{label,title,x,y,w,h,focused,monitor}] }",
    message: (d) =>
      tmsg("msg.window.monitors", {
        n: ((d.monitors as unknown[]) ?? []).length,
        m: ((d.windows as unknown[]) ?? []).length,
      }),
    examples: ["window.monitors"],
    handler: async () => {
      return (await invoke("window_monitors")) as object;
    },
  });

  register("window.place", {
    description:
      "Place a window at an exact frame (physical px — the window.monitors coordinate space). Position and size applied once. Use layout.suggest output directly. The OS may clamp frames into the usable area (e.g. below the macOS menu bar) — read back window.monitors for the settled frame.",
    triggers: {
      ko: "창 배치 이동 모니터로 옮기기 위치 지정",
    },
    params: {
      label: P.windowLabel,
      x: { type: "number", description: "Left edge (physical px)", required: true },
      y: { type: "number", description: "Top edge (physical px)", required: true },
      w: { type: "number", description: "Width (physical px)", required: true },
      h: { type: "number", description: "Height (physical px)", required: true },
    },
    returns: "{ ok }",
    message: () => tmsg("msg.window.place"),
    errors: ["TARGET_NOT_FOUND"],
    examples: [
      'window.place \'{"x":0,"y":0,"w":2560,"h":1440}\'',
      'window.place \'{"label":"main","x":2560,"y":0,"w":2560,"h":1440}\'',
    ],
    handler: async (p) => {
      const label = windowTarget(p);
      const labels = await invoke<string[]>("window_list");
      if (!labels.includes(label)) return notFound(tmsg("msg.window.notFound", { label }));
      await invoke("window_place", { label, x: p.x, y: p.y, w: p.w, h: p.h });
      return {};
    },
  });
}
