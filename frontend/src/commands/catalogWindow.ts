// Window surface commands — position, size, focus, open/close, monitors, layers.
//
// Split out of the catalog: a window is a surface the framework owns (AppFramework), and the
// commands on that axis stay in one block so "what can be asked of a window" reads in one place.
//
// The catalog owns the shared resolvers (`windowTarget`, `P`, `notFound`) — redefining them here
// would fork the same rule per file (omitted label = the addressed target).
import { invoke, currentWindow, clearNativeSurfaces, windowByLabel } from "../framework";
import { tmsg, key} from "../i18n";
import { register } from "./registry";
import { notFound } from "./refuse";
import { currentWindowLabel } from "../lib/webviewLabels";
import { validateWorkspaceRoot } from "../lib/workspaceRoot";
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
import { prepareInputFrameObservation } from "./inputFrameObservation";
import { collectExposed } from "./catalogDom";
import {
  RESIZE_TRANSACTION_PHASES,
  sampleWindowResizeProbe,
  type ResizeSequenceStep,
} from "../lib/windowResizeProbe";

export function registerWindowCatalog(): void {
  register("window.info", {
    description: key("cmd.window.info.desc"),
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
    description: key("cmd.window.viewport.desc"),
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
    description: key("cmd.window.move.desc"),
    params: {
      x: { type: "number", description: key("cmd.window.move.param.x"), required: true },
      y: { type: "number", description: key("cmd.window.move.param.y"), required: true },
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
    description: key("cmd.window.resize.desc"),
    params: {
      w: { type: "number", description: key("cmd.window.resize.param.w"), required: true },
      h: { type: "number", description: key("cmd.window.resize.param.h"), required: true },
    },
    returns: "{ w, h, observed:true }",
    message: (d) => tmsg("msg.window.resize", { w: Number(d.w), h: Number(d.h) }),
    examples: ['window.resize \'{"w":1200,"h":800}\''],
    handler: async (p) => {
      const w = p.w as number;
      const h = p.h as number;
      const win = currentWindow();
      let finish!: () => void;
      let last: { width: number; height: number } | null = null;
      let before: { width: number; height: number } | null = null;
      let after: { width: number; height: number } | null = null;
      const observed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
          `window resize timed out: requested=${w}x${h} before=${JSON.stringify(before)}`
            + ` after=${JSON.stringify(after)} event=${JSON.stringify(last)}`,
        )), 8_000);
        finish = () => { clearTimeout(timer); resolve(); };
      });
      const unsubscribe = await win.onResized((size) => {
        last = size;
        if (size.width === w && size.height === h) finish();
      });
      try {
        before = await win.outerSize();
        if (before.width === w && before.height === h) finish();
        const position = await win.outerPosition();
        await invoke("window_place", {
          label: currentWindowLabel(), x: position.x, y: position.y, w, h,
        });
        after = await win.outerSize();
        if (after.width === w && after.height === h) finish();
        await observed;
        return { w, h, observed: true };
      } finally {
        unsubscribe();
      }
    },
  });

  register("window.resizeSequence", {
    description: key("cmd.window.resizeSequence.desc"),
    params: {
      sizes: {
        type: "json",
        description: key("cmd.window.resizeSequence.param.sizes", {
          phases: RESIZE_TRANSACTION_PHASES.join("|"),
        }),
        required: true,
      },
      intervalMs: {
        type: "number",
        description: key("cmd.window.resizeSequence.param.intervalMs"),
      },
      recordDir: { type: "string", description: key("cmd.window.resizeSequence.param.recordDir") },
      recordFrames: { type: "number", description: key("cmd.window.resizeSequence.param.recordFrames") },
      recordIntervalMs: { type: "number", description: key("cmd.window.resizeSequence.param.recordIntervalMs") },
      recordMaxBytes: {
        type: "number",
        description: key("cmd.window.resizeSequence.param.recordMaxBytes", { max: WINDOW_RECORD_MAX_BYTES }),
      },
    },
    returns:
      "{ steps, recording:{status:'not-requested'|'complete'|'failed',mode:'realtime',dir?,requestedFrames?,frames?,reason?}, resizeElapsedMs, elapsedMs, final:{w,h}, baseline:{status:'not-observed'|'unavailable'|'observed',reason?,observation?}, samples:[{step,size,status:'observed'|'unavailable',observation?,reason?}], measurement:{passed,unavailableSteps} }",
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
          throw new Error(tmsg("msg.window.resizeSequence.recordDirEmpty"));
        }
        if (recordDir !== undefined
          && (!Number.isSafeInteger(requestedFrames) || requestedFrames < 1 || requestedFrames > 600)) {
          throw new Error(tmsg("msg.window.resizeSequence.recordFrames"));
        }
        if (recordDir !== undefined
          && (!Number.isFinite(requestedIntervalMs)
            || requestedIntervalMs < 0
            || requestedIntervalMs > 1_000)) {
          throw new Error(tmsg("msg.window.resizeSequence.recordIntervalMs"));
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
          throw new Error(tmsg("msg.window.resizeSequence.recordDirRequired"));
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
    description: key("cmd.window.focus.desc"),
    triggers: { ko: "창 포커스 창 활성화 창 앞으로" },
    params: { label: P.windowLabel },
    returns: "{ focused: true, key }",
    message: (d) => tmsg(d.key === true ? "msg.window.focus" : "msg.window.focus.notKey"),
    examples: ["window.focus", 'window.focus \'{"label":"w-<uuid>"}\''],
    errors: ["TARGET_NOT_FOUND"],
    handler: async (p) => {
      const label = windowTarget(p);
      const labels = await invoke<string[]>("window_list");
      if (!labels.includes(label)) return notFound("msg.window.notFound", { label });
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
    description: key("cmd.window.maximize.desc"),
    triggers: { ko: "창 최대화 전체화면 창 키우기 최대화 해제" },
    params: {
      label: P.windowLabel,
      off: { type: "boolean", description: key("cmd.window.maximize.param.off") },
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
      if (!win) return notFound("msg.window.notFound", { label });
      if (off) await win.unmaximize();
      else await win.maximize();
      return { maximized: !off };
    },
  });

  register("window.reload", {
    description: key("cmd.window.reload.desc"),
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
      await clearNativeSurfaces();
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
    description: key("cmd.window.open.desc"),
    triggers: { ko: "새 창 창 열기 새 윈도우 워크스페이스 새 창 오케스트레이터 창" },
    params: {
      root: {
        type: "string",
        description: key("cmd.window.open.param.root"),
      },
      alias: {
        type: "string",
        description: key("cmd.window.open.param.alias"),
      },
      mode: {
        type: "string",
        description: key("cmd.window.open.param.mode"),
        enum: ["orchestrator"],
      },
      focus: {
        type: "boolean",
        description: key("cmd.window.open.param.focus"),
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
      // Empty workspace windows do not exist — opening and creating workspaces is a control plane
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
        root = await validateWorkspaceRoot(p.root as string);
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
        "workspace_owners",
      );
      const owner = owners.owners.find((o) => o.root === root)?.window;
      if (owner) {
        await invoke("window_focus", { label: owner }).catch(() => {});
        return { existingWindow: owner };
      }
      let init = `root=${encodeURIComponent(root)}`;
      if (typeof p.alias === "string" && p.alias) init += `&alias=${encodeURIComponent(p.alias)}`;
      return {
        label: await invoke<string>("window_create", {
          init,
          ...(typeof p.focus === "boolean" ? { focus: p.focus } : {}),
        }),
      };
    },
  });

  register("window.list", {
    description: key("cmd.window.list.desc"),
    windowScoped: false,
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
    description: key("cmd.window.restorePrevious.desc"),
    triggers: { ko: "이전 워크스페이스 복구 직전 세대 되돌리기 작업 복구" },
    params: {
      label: P.windowLabel,
      apply: {
        type: "boolean",
        description: key("cmd.window.restorePrevious.param.apply"),
      },
    },
    returns: "{ found, workspaces, tabs, applied }",
    message: (d) =>
      d.found
        ? tmsg("msg.window.restorePrevious.found", {
            n: Number(d.workspaces ?? 0),
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
      if (!prev) return { found: false, workspaces: 0, tabs: 0, applied: false };
      const size = snapshotSize(prev);
      if (p.apply !== true) return { found: true, ...size, applied: false };
      // Undo is also a write, so the current value is pushed into the past — a wrong undo can be
      // undone again.
      const restored = await invoke<boolean>("data_kv_undo", { ns: "core", key });
      return { found: true, ...size, applied: restored };
    },
  });

  register("window.workspaces", {
    description: key("cmd.window.workspaces.desc"),
    triggers: { ko: "창 워크스페이스 매핑 어느 창 워크스페이스 열림 창별 워크스페이스" },
    params: {},
    returns: "{ workspaces: [{ root, name, window }] }",
    message: (d) => tmsg("msg.window.workspaces", { n: ((d.workspaces as unknown[]) ?? []).length }),
    examples: ["window.workspaces"],
    handler: async () => {
      const owners = await invoke<{ owners: { root: string; window: string }[] }>(
        "workspace_owners",
      );
      const workspaces = owners.owners.map((o) => ({
        root: o.root,
        name: o.root.split("/").filter(Boolean).pop() ?? o.root,
        window: o.window,
      }));
      return { workspaces };
    },
  });

  register("window.close", {
    description: key("cmd.window.close.desc"),
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
      if (!labels.includes(label)) return notFound("msg.window.notFound", { label });
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

  register("window.layers", {
    description: key("cmd.window.layers.desc"),
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
    description: key("cmd.window.monitors.desc"),
    triggers: {
      ko: "모니터 목록 해상도 창 배치 현황 듀얼 모니터 파악",
    },
    params: {},
    returns:
      "{ space: \"dip\", monitors: [{index,name,x,y,w,h,scale}], windows: [{label,x,y,w,h,focused,monitor}] }",
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
    description: key("cmd.window.place.desc"),
    triggers: {
      ko: "창 배치 이동 모니터로 옮기기 위치 지정",
    },
    params: {
      label: P.windowLabel,
      x: { type: "number", description: key("cmd.window.place.param.x"), required: true },
      y: { type: "number", description: key("cmd.window.place.param.y"), required: true },
      w: { type: "number", description: key("cmd.window.place.param.w"), required: true },
      h: { type: "number", description: key("cmd.window.place.param.h"), required: true },
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
      if (!labels.includes(label)) return notFound("msg.window.notFound", { label });
      await invoke("window_place", { label, x: p.x, y: p.y, w: p.w, h: p.h });
      return {};
    },
  });

  register("window.input.state", {
    description: key("cmd.window.input.state.desc"),
    params: {},
    returns: "{ windowFocused, inputOwner, responderMarked, lastPointer, pointerEventsQueued, pointerEventsDropped }",
    message: (d) => tmsg("msg.window.input.state", {
      owner: String(d.inputOwner ?? ""),
      marked: String(Boolean(d.responderMarked)),
    }),
    examples: ["window.input.state window=win-example"],
    handler: async () => invoke("window_input_state"),
  });

  register("window.input.mark", {
    description: key("cmd.window.input.mark.desc"),
    params: {
      text: { type: "string", description: key("cmd.window.input.mark.param.text") },
    },
    returns: "{ windowFocused, inputOwner, responderMarked }",
    message: (d) => tmsg("msg.window.input.mark", {
      owner: String(d.inputOwner ?? ""),
      marked: String(Boolean(d.responderMarked)),
    }),
    examples: ["window.input.mark window=win-example text=ㅎ", "window.input.mark window=win-example text="],
    handler: async (p) => invoke("window_input_mark", { text: p.text ?? "" }),
  });

  register("window.input.pointer.wait", {
    description: key("cmd.window.input.pointer.wait.desc"),
    params: {
      sequence: { type: "number", description: key("cmd.window.input.pointer.wait.param.sequence"), required: true },
      timeoutMs: { type: "number", description: key("cmd.window.input.pointer.wait.param.timeoutMs"), required: true },
    },
    returns: "{ sequence, phase:'up', x, y, atUnixMs, window }",
    message: (d) => tmsg("msg.window.input.pointer.wait", { sequence: String(d.sequence ?? "") }),
    errors: ["INVALID_PARAMS", "TIMEOUT"],
    examples: ["window.input.pointer.wait window=win-example sequence=1099511627777 timeoutMs=2000"],
    handler: async (p) => invoke("window_input_pointer_wait", {
      sequence: p.sequence,
      timeoutMs: p.timeoutMs,
    }),
  });

  register("window.input.pointer.inject", {
    description: key("cmd.window.input.pointer.inject.desc"),
    params: {
      x: { type: "number", description: key("cmd.window.input.pointer.inject.param.x"), required: true },
      y: { type: "number", description: key("cmd.window.input.pointer.inject.param.y"), required: true },
    },
    returns: "{ sequence, posted:true, inputRoute:'contract-injection', cursorPositionMayChange:false, x, y }",
    message: (d) => tmsg("msg.window.input.pointer.inject", { sequence: String(d.sequence ?? "") }),
    examples: ["window.input.pointer.inject window=win-example x=400 y=200"],
    handler: async (p) => invoke("window_input_pointer_inject", { x: p.x, y: p.y }),
  });

  register("window.input.pointer.drag", {
    description: key("cmd.window.input.pointer.drag.desc"),
    params: {
      fromX: { type: "number", description: key("cmd.window.input.pointer.drag.param.fromX"), required: true },
      fromY: { type: "number", description: key("cmd.window.input.pointer.drag.param.fromY"), required: true },
      toX: { type: "number", description: key("cmd.window.input.pointer.drag.param.toX"), required: true },
      toY: { type: "number", description: key("cmd.window.input.pointer.drag.param.toY"), required: true },
      steps: { type: "number", description: key("cmd.window.input.pointer.drag.param.steps"), required: true },
      durationMs: { type: "number", description: key("cmd.window.input.pointer.drag.param.durationMs"), default: 0 },
    },
    returns: "{ sequence, posted:true, inputRoute:'contract-injection', cursorPositionMayChange:false, fromX, fromY, toX, toY, steps, durationMs }",
    message: (d) => tmsg("msg.window.input.pointer.drag", { sequence: String(d.sequence ?? "") }),
    errors: ["INVALID_PARAMS"],
    examples: ["window.input.pointer.drag window=win-example fromX=400 fromY=200 toX=400 toY=320 steps=8 durationMs=240"],
    handler: async (p) => invoke("window_input_pointer_drag", {
      fromX: p.fromX, fromY: p.fromY, toX: p.toX, toY: p.toY, steps: p.steps,
      durationMs: p.durationMs ?? 0,
    }),
  });

  register("window.input.pointer.click", {
    description: key("cmd.window.input.pointer.click.desc"),
    params: {
      x: { type: "number", description: key("cmd.window.input.pointer.click.param.x"), required: true },
      y: { type: "number", description: key("cmd.window.input.pointer.click.param.y"), required: true },
      recordDir: { type: "string", description: key("cmd.ui.input.click.param.recordDir") },
      recordFrames: { type: "number", description: key("cmd.ui.input.click.param.recordFrames"), default: 40 },
      recordIntervalMs: { type: "number", description: key("cmd.ui.input.click.param.recordIntervalMs"), default: 16 },
      recordLeadMs: { type: "number", description: key("cmd.ui.input.click.param.recordLeadMs"), default: 0 },
      recordMaxBytes: { type: "number", description: key("cmd.ui.input.click.param.recordMaxBytes") },
      traceAddresses: { type: "json", description: key("cmd.ui.input.click.param.traceAddresses") },
    },
    returns: "{ window, sequence, delivered:true, inputRoute, cursorPositionMayChange:false, x, y, windowFocused, foregroundPreserved:true, recording, trace? }",
    message: (d) => tmsg("msg.window.input.pointer.click", { sequence: String(d.sequence ?? "") }),
    examples: ["window.input.pointer.click window=win-example x=400 y=200"],
    handler: async (p) => {
      const nodes = collectExposed();
      const observation = await prepareInputFrameObservation(p, (address) => {
        const found = nodes.find((node) => node.address === address);
        return found ? { address, el: found.el } : null;
      });
      await observation.ready();
      const receipt = await invoke<Record<string, unknown>>("window_input_pointer_click", { x: p.x, y: p.y });
      return { ...receipt, ...(await observation.result()) };
    },
  });

  register("window.input.key.press", {
    description: key("cmd.window.input.key.press.desc"),
    params: {
      key: { type: "string", description: key("cmd.window.input.key.press.param.key"), required: true },
      ctrl: { type: "boolean", description: key("cmd.window.input.key.press.param.ctrl") },
      meta: { type: "boolean", description: key("cmd.window.input.key.press.param.meta") },
      shift: { type: "boolean", description: key("cmd.window.input.key.press.param.shift") },
      alt: { type: "boolean", description: key("cmd.window.input.key.press.param.alt") },
    },
    returns: "{ window, sequence, delivered:true, inputRoute, key, windowFocused, foregroundPreserved:true }",
    message: (d) => tmsg("msg.window.input.key.press", { key: String(d.key ?? "") }),
    examples: ["window.input.key.press window=win-example key=Enter"],
    handler: async (p) => invoke("window_input_key_press", {
      key: p.key,
      ctrl: p.ctrl ?? false,
      meta: p.meta ?? false,
      shift: p.shift ?? false,
      alt: p.alt ?? false,
    }),
  });

  register("window.native-close.status", {
    description: key("cmd.window.nativeClose.status.desc"),
    params: {},
    returns: "{ window, present, enabled, visible, windowVisible, x, y, width, height }",
    message: (d) => tmsg("msg.window.nativeClose.status", { enabled: String(Boolean(d.enabled)) }),
    examples: ["window.native-close.status window=win-example"],
    handler: async () => invoke("window_native_close_status"),
  });

  register("window.native-close.click", {
    description: key("cmd.window.nativeClose.click.desc"),
    params: {},
    returns: "{ window, sequence, posted:true, tracked:true }",
    message: (d) => tmsg("msg.window.nativeClose.click", { sequence: String(d.sequence ?? "") }),
    examples: ["window.native-close.click window=win-example"],
    danger: "destructive",
    handler: async () => invoke("window_native_close_click"),
  });

  register("window.native-close.wait", {
    description: key("cmd.window.nativeClose.wait.desc"),
    params: {
      sequence: { type: "number", description: key("cmd.window.nativeClose.wait.param.sequence"), required: true },
      timeoutMs: { type: "number", description: key("cmd.window.nativeClose.wait.param.timeoutMs"), required: true },
    },
    returns: "{ window, sequence, closed:true }",
    message: (d) => tmsg("msg.window.nativeClose.wait", { sequence: String(d.sequence ?? "") }),
    errors: ["INVALID_PARAMS", "TIMEOUT"],
    examples: ["window.native-close.wait sequence=1099511627777 timeoutMs=5000"],
    handler: async (p) => invoke("window_native_close_wait", {
      sequence: p.sequence, timeoutMs: p.timeoutMs,
    }),
  });
}
