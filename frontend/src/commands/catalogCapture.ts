// Screen capture — registered at the end of registerCatalog() (catalog split — catalogHealth precedent).
//
// Cropping (rect, node) and saving (path, base64) are **separate axes** and compose freely. Until now
// a crop ignored path entirely and answered base64 only: the caller got ok:true and there was no file
// (measured 2026-07-31). The ignoring was silent, so where it went wrong could not be read from
// outside.

import { invoke, frameworkPath } from "../framework";
import { tmsg } from "../i18n";
import { settleAnimationsForCapture } from "./captureSettle";
import { contentViewHost, hasContentViewHost } from "../lib/contentViews";
import { isLayoutMotionActive, onLayoutMotion } from "../lib/layoutMotion";
import { resolveExposed } from "./catalogDom";
import { surfaceRectOf } from "../lib/surfaceRect";
import { register } from "./registry";
import { formatAddress } from "./address";
import { currentWindowLabel } from "../lib/webviewLabels";
import { locateTab } from "./catalog";
import { useSessions } from "../state/sessions";
import {
  recordWindowFrames,
  validWindowRecordFrameTimeoutMs,
  validWindowRecordFrames,
  validWindowRecordIntervalMs,
  validWindowRecordMaxBytes,
  WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS,
  WINDOW_RECORD_MAX_FRAMES,
  WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS,
  WINDOW_RECORD_MAX_INTERVAL_MS,
  WINDOW_RECORD_MAX_BYTES,
} from "./windowRecorder";
import { CAPTURE_CALIBRATION_ID, setCaptureCalibration } from "./captureCalibration";
import { setCaptureMotionAnchors } from "./captureMotionAnchors";

/**
 * Absolute address of a tab's body slot — GroupArea exposes it as `layout/tab/<viewId>` (one set with
 * that slot).
 *
 * A relative address does not find it: the canonical address form is absolute, including window and
 * workspace (axiom A1), and formatAddress is the single place that assembles it — hand-concatenation
 * makes two sets of rules.
 */
function nodeOfTab(projectId: string, viewId: string): string {
  return formatAddress({
    window: currentWindowLabel(),
    workspace: projectId,
    chrome: `layout/tab/${viewId}`,
  });
}

/**
 * Until layout motion ends — the end arrives as an event.
 *
 * Already stopped: answers immediately (idempotent). In progress: waits for one end notification.
 */
function settledLayout(): Promise<void> {
  if (!isLayoutMotionActive()) return Promise.resolve();
  return new Promise((resolve) => {
    const off = onLayoutMotion((active) => {
      if (active) return;
      off();
      resolve();
    });
  });
}

/**
 * "The final frame that should be showing" and "this exact instant" are different requests.
 *
 * The default is settling — a command must produce an exact result regardless of state. But settling
 * drives in-flight finite animations to their end, so **what drifts only mid-transition** can never
 * be seen through this path (real incident 2026-08-02: measuring by app capture a drift where several
 * layers followed different frames produced only post-settle pictures and read as "normal").
 */
const SETTLE_PARAM = {
  type: "boolean" as const,
  description:
    "Finish in-flight finite animations before capturing (default true — a command must yield the frame that should be showing). Pass false to capture the CURRENT instant instead: required to see mismatches that exist only mid-transition, because settling ends them.",
};

/**
 * Statistics of painted pixels — numbers, not a picture.
 *
 * A wide region is not read in full: with enough samples the mean does not move, and reading every
 * pixel is merely slow. Sampling walks an even grid (no randomness — the same screen must give the
 * same answer).
 *
 * Luminance is **on displayed values** (no gamma decode). The question answered here is "how dark
 * does this look to a human eye", and a black veil of alpha a multiplies the displayed value by
 * (1 − a), so it reads exactly on this axis.
 */
async function pixelStats(pngBase64: string): Promise<{
  w: number;
  h: number;
  samples: number;
  mean: { r: number; g: number; b: number };
  luminance: number;
  min: number;
  max: number;
}> {
  const img = new Image();
  img.src = `data:image/png;base64,${pngBase64}`;
  await img.decode();
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d context is unavailable — pixels cannot be read");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, w, h);
  // Sample ceiling — the grid step derives from the area (a rule, not a value).
  const MAX_SAMPLES = 200_000;
  const step = Math.max(1, Math.ceil(Math.sqrt((w * h) / MAX_SAMPLES)));
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  let min = 1;
  let max = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      sr += r;
      sg += g;
      sb += b;
      n += 1;
      const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (l < min) min = l;
      if (l > max) max = l;
    }
  }
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const mean = { r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n) };
  return {
    w,
    h,
    samples: n,
    mean,
    luminance: round((0.2126 * mean.r + 0.7152 * mean.g + 0.0722 * mean.b) / 255),
    min: round(min),
    max: round(max),
  };
}

/** The cropped region and the work to undo — the answer of the crop axis. */
type Region = {
  rect?: { x: number; y: number; w: number; h: number };
  tabId?: string;
  restore: (() => void) | null;
};

/**
 * What a region capture answers: the image, and what went into it.
 *
 * The note is not decoration. An empty pane in a capture has two causes that look identical —
 * the window declared no surface, or it declared one and nothing was painted — and `surfaces`,
 * `drawn` and `skipped` are where that difference is written down.
 */
type CaptureAnswer = {
  png: string;
  note: { surfaces: number; drawn: number; skipped?: string[]; path?: string };
};

type Refusal = { ok: false; code: string; message: string };

const isRefusal = (v: Region | Refusal): v is Refusal => "ok" in v;

/**
 * Resolves the crop axis — rect (coordinates), node (address), and tab (tab name) converge on the
 * same answer.
 *
 * This must be one place: if the command that captures pixels and the command that measures pixels
 * resolve separately, a day comes when the same address answers two regions. The undo work (restore)
 * is part of the answer too — observation is not mutation, so when a tab was activated for the shot,
 * whatever was active before is restored.
 */
async function resolveRegion(p: Record<string, unknown>): Promise<Region | Refusal> {
  let rect = p.rect as { x: number; y: number; w: number; h: number } | undefined;
  let restore: (() => void) | null = null;
  let tabId: string | undefined;
  let nodeAddr = p.node as string | undefined;
  if (typeof p.tab === "string" && p.tab) {
    const loc = locateTab(p.tab);
    if (!loc || !loc.tab) {
      return {
        ok: false,
        code: "TARGET_NOT_FOUND",
        message: tmsg("msg.tab.notFoundId", { id: p.tab }),
      };
    }
    const st = useSessions.getState();
    const prevSpace = loc.workspace.activeSpaceId;
    const prevView = loc.pane.activeTabId;
    if (prevSpace !== loc.space.id || prevView !== loc.tab.id) {
      st.setActiveContent(loc.workspace.id, loc.space.id);
      st.setActiveView(loc.workspace.id, loc.tab.id);
      restore = () => {
        const back = useSessions.getState();
        if (prevView) back.setActiveView(loc.workspace.id, prevView);
        if (prevSpace) back.setActiveContent(loc.workspace.id, prevSpace);
      };
      // Switching moves the layout — the shot must come after the slot is at its final position.
      //
      // The wait **ends on an event.** rAF is unusable (rAF stops for an occluded window, and
      // capturing while the window is not in front is the point of this command — measured
      // 2026-07-31: a 30-second timeout, and even the restore did not run). A numeric timer is not
      // used either (whatever number is written has no basis). Layout motion announces its own start
      // and end, so the wait is on that end.
      settleAnimationsForCapture();
      await settledLayout();
    }
    tabId = loc.tab.id;
    nodeAddr = nodeOfTab(loc.workspace.id, loc.tab.id);
  }
  // Region named by address — one tab or panel is captured as is, with no hand-computed coordinates.
  // The measuring place is the same as ui.measure (resolveExposed): with two of them, the same
  // address answers a different region.
  if (nodeAddr) {
    const found = resolveExposed(nodeAddr);
    if (!("el" in found)) {
      restore?.();
      return found as Refusal;
    }
    const r = found.el.getBoundingClientRect();
    // Uses the surface rect rule as is (surfaceRectOf — fold inward). A node rect is almost always
    // fractional while capture works only on integer pixels, so passing it unfolded is refused as an
    // "empty/invalid crop rect" (measured 2026-07-31). Two sets of folding rules put the capture and
    // the stand-in at different positions.
    // `margin` widens the crop around the node, in CSS points, clamped to the window.
    //
    // A node captured to its own edges answers what it looks like and nothing about where it is.
    // The questions a capture of one element is asked — is it clipped, is something over it, is it
    // aligned with the thing beside it — are all about its surroundings, and the answer is a
    // picture that holds them.
    const margin = Math.max(0, Number(p.margin ?? 0));
    const cropped = surfaceRectOf({
      left: Math.max(0, r.left - margin),
      top: Math.max(0, r.top - margin),
      right: Math.min(window.innerWidth, r.right + margin),
      bottom: Math.min(window.innerHeight, r.bottom + margin),
    });
    if (cropped.w < 1 || cropped.h < 1) {
      restore?.();
      return {
        ok: false,
        code: "INVALID_PARAMS",
        message: tmsg("msg.capture.node.noSize", {
          w: Math.round(r.width),
          h: Math.round(r.height),
          node: nodeAddr,
        }),
      };
    }
    // A rect outside the actual screen has no pixels to capture. Refuse with a name and a reason, and
    // give a recovery path.
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (
      cropped.x + cropped.w <= 0 ||
      cropped.y + cropped.h <= 0 ||
      cropped.x >= vw ||
      cropped.y >= vh
    ) {
      restore?.();
      return {
        ok: false,
        code: "OFFSCREEN",
        message: tmsg("msg.capture.node.offscreen", {
          x: cropped.x,
          y: cropped.y,
          vw,
          vh,
          node: nodeAddr,
        }),
      };
    }
    rect = { x: cropped.x, y: cropped.y, w: cropped.w, h: cropped.h };
  }
  if (
    rect &&
    (typeof rect.x !== "number" ||
      typeof rect.y !== "number" ||
      typeof rect.w !== "number" ||
      typeof rect.h !== "number")
  ) {
    restore?.();
    return { ok: false, code: "INVALID_PARAMS", message: tmsg("msg.capture.rect.numbers") };
  }
  return { rect, tabId, restore };
}

export function registerCaptureCatalog(): void {
  register("capture.calibration", {
    description:
      "Show, hide, or inspect the three fixed 64×40 DOM compositor calibration rulers used to compare chrome pixels with embedded-surface pixels during cropped window transitions. Reapplying the same visibility is idempotent.",
    params: {
      visible: { type: "boolean", description: "true=show, false=remove; omit to inspect current status" },
    },
    returns: "{ visible, color, rect, rects }",
    message: (d) => `DOM compositor calibration: ${d.visible ? "visible" : "hidden"}`,
    examples: ['capture.calibration \'{"visible":true}\'', 'capture.calibration \'{"visible":false}\''],
    handler: async (p) =>
      typeof p.visible === "boolean"
        ? setCaptureCalibration(p.visible)
        : setCaptureCalibration(Boolean(document.getElementById(CAPTURE_CALIBRATION_ID))),
  });

  register("capture.motion-anchors", {
    description:
      "Attach finite E2E pixel anchors to exposed DOM tab slots. Each anchor inherits its slot's layout transform, so a page marker of the same color must share its x coordinate in every recorded PNG. Passing an empty anchors array removes all anchors idempotently.",
    params: {
      anchors: {
        type: "json",
        description: tmsg("cmd.capture.motion-anchors.param.anchors"),
        required: true,
      },
    },
    returns: "{ visible, count, anchors:[{address,color,rect}] }",
    message: (d) => `DOM motion anchors: ${Number(d.count ?? 0)}`,
    errors: ["NOT_EXPOSED", "INVALID_PARAMS"],
    examples: ['capture.motion-anchors \'{"anchors":[]}\''],
    handler: async (p) => {
      if (!Array.isArray(p.anchors)) {
        return { ok: false, code: "INVALID_PARAMS", message: "anchors must be an array" };
      }
      const targets = [];
      for (const raw of p.anchors) {
        const item = raw as { address?: unknown; color?: unknown; x?: unknown; y?: unknown };
        if (typeof item?.address !== "string" || typeof item.color !== "string") {
          return { ok: false, code: "INVALID_PARAMS", message: "anchor requires string address and color" };
        }
        if ((item.x !== undefined && (typeof item.x !== "number" || !Number.isFinite(item.x)))
          || (item.y !== undefined && (typeof item.y !== "number" || !Number.isFinite(item.y)))) {
          return { ok: false, code: "INVALID_PARAMS", message: "anchor x/y must be finite numbers" };
        }
        const found = resolveExposed(item.address);
        if (!("el" in found)) return found;
        targets.push({ address: item.address, color: item.color, host: found.el, x: item.x, y: item.y });
      }
      const result = setCaptureMotionAnchors(document, targets);
      if (hasContentViewHost()) await contentViewHost().chromePresentationSettled();
      return result;
    },
  });

  register("window.snapshot", {
    description:
      "Capture the window contents to a PNG. Captures even when fully occluded by other apps (occlusion detection is temporarily disabled during capture). Includes WebGL terminal. Parent folder is created automatically. Cropping and saving compose freely: rect (CSS px, window coords — same space as ui.measure), node (an exposed address from ui.tree), or tab (a content tab id) selects the region, and path saves it while base64:true returns it inline. Capturing a tab that is not active activates it for the shot and restores whatever was active afterwards, so the screen returns to where it was. With neither path nor base64, a cropped capture still returns inline.",
    triggers: { ko: "스크린샷 캡처 화면 저장 PNG 저장 스냅샷 부분 영역" },
    params: {
      path: {
        type: "string",
        description: tmsg("cmd.window.snapshot.param.path"),
      },
      base64: {
        type: "boolean",
        description: tmsg("cmd.window.snapshot.param.base64"),
      },
      rect: {
        type: "json",
        description:
          "Crop region {x,y,w,h} in CSS px, window coordinates (ui.measure space). Combine with path to save the crop.",
      },
      node: {
        type: "string",
        description:
          "Exposed address (ui.tree) to capture — its rect is measured for you. Use this to capture one panel or element without computing coordinates.",
      },
      tab: {
        type: "string",
        description:
          "Content tab id to capture. Inactive tabs are parked offscreen, so this activates the tab (and its space) for the shot and restores what was active afterwards.",
      },
      margin: {
        type: "number",
        description:
          "Points of surroundings to keep around a node or tab crop (default 0), clamped to the window. A node captured to its own edges shows what it looks like and nothing about where it is — whether it is clipped, covered, or aligned with what is beside it are all questions about its surroundings.",
      },
      settle: SETTLE_PARAM,
    },
    returns:
      "{ tabId?, saved, media:{kind,path} } when path is given (cropped or full) | { tabId?, media:{kind:'image/png',base64} } otherwise — tabId echoes the resolved tab when tab was passed",
    message: (d) =>
      d.saved
        ? tmsg("msg.window.snapshot.saved", { path: String(d.saved) })
        : tmsg("msg.window.snapshot.captured"),
    // Sentence for the ear (§3) — the path goes only into message (the eye). Failure echoes message
    // (diagnosis).
    speak: (out) =>
      out.ok
        ? out.data?.saved
          ? tmsg("msg.window.snapshot.speak.saved")
          : tmsg("msg.window.snapshot.speak.captured")
        : out.message,
    hint: (d) => {
      if (d.code) return [];
      // Two branches for re-capture — maximize the view to capture it larger, or switch to another
      // space and compare screens.
      return [
        { cmd: "tab.maximize", why: tmsg("hint.flow.snapshot.maximize") },
        { cmd: "space.list", why: tmsg("hint.flow.snapshot.switch") },
      ];
    },
    errors: ["INVALID_PARAMS", "OFFSCREEN", "TARGET_NOT_FOUND", "NOT_EXPOSED", "AMBIGUOUS_HOST"],
    examples: [
      "window.snapshot",
      'window.snapshot \'{"path":"<local-evidence>/shot.png"}\'',
      'window.snapshot \'{"rect":{"x":100,"y":80,"w":400,"h":300},"base64":true}\'',
      'window.snapshot \'{"rect":{"x":100,"y":80,"w":400,"h":300},"path":"<local-evidence>/crop.png"}\'',
      'window.snapshot \'{"node":"win/main/proj/p1/chrome/tab/space/0","path":"<local-evidence>/tab.png"}\'',
    ],
    handler: async (p, ctx) => {
      // **Two writers on one path and one of them disappears.**
      //
      // When two frameworks hold the same label, this request goes to both (to all when none can be
      // chosen — that is correct). But if the caller named a file path, the later executor overwrites
      // the earlier one and both answers are OK — measured 2026-08-08: two answers, one file, and
      // neither answer stated that. Work reported as success that leaves nothing behind is not
      // success.
      //
      // This is not a refusal but **guidance to narrow the address**: naming a window or taking
      // base64 gives each answer its own image.
      if (p.path !== undefined && (ctx?.hosts ?? 1) > 1) {
        return {
          ok: false,
          code: "AMBIGUOUS_HOST",
          message: tmsg("msg.window.snapshot.ambiguousHost", { hosts: ctx?.hosts ?? 0 }),
        };
      }
      // Capture is a command — front or back, the window yields the exact final frame. A non-front
      // window stops its timeline and traps the entry animation on an intermediate frame (undoing
      // occlusion in arm_capture alone does not run the timeline), so finite animations are settled
      // explicitly right before capture. Common front stage of every capture path.
      if (p.settle !== false) settleAnimationsForCapture();
      // The crop axis resolves in one place (resolveRegion) — the same function as window.pixels.
      const region = await resolveRegion(p);
      if (isRefusal(region)) return region;
      const { rect, tabId, restore } = region;
      if (rect || p.base64) {
        // The answer is the image and the statement of what went into it. A capture that drew
        // none of the window's surfaces looks exactly like one that had none to draw, and the
        // note is the only place that difference is written down.
        const shot = await invoke<CaptureAnswer>(
          "window_snapshot_region",
          rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : {},
        );
        const pngBase64 = shot.png;
        // A cropped image is also **left at the path the caller named.** Until now, passing rect
        // ignored path entirely and answered base64 only: the caller got ok:true and there was no
        // file (measured 2026-07-31). Cropping and saving are separate axes and compose freely.
        const outPath = p.path as string | undefined;
        if (outPath) {
          const w = await invoke<{ path: string; bytes: number }>(
            "write_file_base64",
            { path: outPath, base64: pngBase64 },
          );
          restore?.();
          return {
            ...(tabId ? { tabId } : {}),
            saved: w.path,
            bytes: w.bytes,
            note: shot.note,
            media: { kind: "image/png", path: w.path },
          };
        }
        // Images are declared in the envelope media (standard) — consumers render media only, with
        // no key guessing.
        restore?.();
        return {
          ...(tabId ? { tabId } : {}),
          note: shot.note,
          media: { kind: "image/png", base64: pngBase64 },
        };
      }
      let path = p.path as string | undefined;
      if (!path) {
        const { tempDir, join } = frameworkPath;
        path = await join(
          await tempDir(),
          "soksak",
          `snapshot-${Date.now()}.png`,
        );
      }
      const saved = await invoke<string>("window_snapshot", {
        path,
      });
      // A file capture is declared in media too — the feed reads the path and renders an image, so
      // the path text is not all that shows.
      return { saved, media: { kind: "image/png", path: saved } };
    },
  });

  // Answers in numbers **what was actually painted** on screen.
  //
  // Why this must be a command (real incident 2026-08-02): a blur that never applied was reported as
  // "done" twice in a row. The computed style was right (veil alpha 0.22 → 0.7) and a capture existed,
  // but the judgment came from looking at that capture **by eye**. The eye cannot separate "looks a
  // bit darker" from "70% darker". An axis that cannot be measured always ends up guessed, and that
  // answer is not trustworthy.
  //
  // The declaration (style) and the result (pixels) are different facts. Even a correct declaration
  // leaves pixels unchanged when it is covered, clipped, or composited under another layer. So there
  // is a separate place to query pixels.
  register("window.pixels", {
    description:
      "Measure what is actually painted in a region — mean color and luminance, not a picture. Same region axes as window.snapshot (rect | node | tab), so the address you measure is the address you capture. Use this to verify that a declared style reached the screen: computed style says what was declared, this says what was painted (an overlay can be clipped, covered, or composited under a native surface and the declaration still reads correct). Compare two states or two regions by their luminance.",
    triggers: { ko: "픽셀 색 밝기 실제칠해짐 검증 휘도 평균색" },
    params: {
      rect: {
        type: "json",
        description:
          "Region {x,y,w,h} in CSS px, window coordinates (ui.measure space)",
      },
      node: {
        type: "string",
        description: tmsg("cmd.window.pixels.param.node"),
      },
      tab: {
        type: "string",
        description:
          "Content tab id. Inactive tabs are parked offscreen, so this activates the tab for the shot and restores what was active afterwards",
      },
      settle: SETTLE_PARAM,
    },
    returns:
      "{ tabId?, w, h, samples, mean:{r,g,b}, luminance, min, max } — luminance is 0..1 on displayed (gamma-encoded) values; min/max are the darkest and brightest sampled luminance",
    message: (d) =>
      tmsg("msg.window.pixels", { l: Number(d.luminance ?? 0).toFixed(3) }),
    errors: ["INVALID_PARAMS", "OFFSCREEN", "TARGET_NOT_FOUND", "NOT_EXPOSED"],
    examples: [
      'window.pixels \'{"node":"win/main/proj/p1/chrome/layout/tab/tab-abc"}\'',
      'window.pixels \'{"rect":{"x":100,"y":80,"w":400,"h":300}}\'',
    ],
    handler: async (p) => {
      if (p.settle !== false) settleAnimationsForCapture();
      const region = await resolveRegion(p);
      if (isRefusal(region)) return region;
      const { rect, tabId, restore } = region;
      try {
        // The answer is the image and the statement of what went into it. A capture that drew
        // none of the window's surfaces looks exactly like one that had none to draw, and the
        // note is the only place that difference is written down.
        const shot = await invoke<CaptureAnswer>(
          "window_snapshot_region",
          rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : {},
        );
        const pngBase64 = shot.png;
        return { ...(tabId ? { tabId } : {}), note: shot.note, ...(await pixelStats(pngBase64)) };
      } finally {
        restore?.();
      }
    },
  });

  register("window.record", {
    description:
      "Capture the window as a sequence of PNGs (dir/f0000.png ...) for use as a video source. All frames are rendered even when occluded (occlusion detection disabled for the duration). Folder is created automatically.",
    triggers: { ko: "녹화 연속 캡처 프레임 저장 동영상 소스" },
    params: {
      dir: {
        type: "string",
        description: tmsg("cmd.window.record.param.dir"),
        required: true,
      },
      frames: {
        type: "number",
        description: `Number of frames (default 40, range 1..${WINDOW_RECORD_MAX_FRAMES})`,
      },
      intervalMs: {
        type: "number",
        description: `Interval between frames in ms (default 40, range 0..${WINDOW_RECORD_MAX_INTERVAL_MS})`,
      },
      maxBytes: {
        type: "number",
        description: `Optional total encoded PNG byte budget (positive safe integer, max ${WINDOW_RECORD_MAX_BYTES})`,
      },
      frameTimeoutMs: {
        type: "number",
        description: `Per-frame native completion deadline in ms (default ${WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS}, max ${WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS})`,
      },
    },
    returns: "{ dir, frames, maxBytes:number|null, frameTimeoutMs }",
    message: (d) => tmsg("msg.window.record", { n: Number(d.frames) }),
    errors: ["INVALID_PARAMS"],
    examples: [
      'window.record \'{"dir":"<local-evidence>/rec"}\'',
      'window.record \'{"dir":"<local-evidence>/rec","frames":120,"intervalMs":33}\'',
      'window.record \'{"dir":"<local-evidence>/rec","frames":120,"maxBytes":536870912}\'',
    ],
    // **The frame loop is policy, not a surface.** The framework already answers "capture one frame"
    // (snapshot_region). How many frames, at what interval, under what names, is this app's decision,
    // and reimplementing it per shell makes it work in one framework and not another — one shell
    // answered and the other did not, so a mid-transition defect was invisible on that side (measured
    // 2026-08-02: UNKNOWN on Electron, so the toggle instant was never seen). Running the loop once
    // here gives the same answer under every shell.
    //
    // No settling — the point of recording is **mid-transition**. Settling ends the thing to be seen
    // at that instant.
    handler: async (p) => {
      const dir = p.dir as string;
      const frames = p.frames ?? 40;
      // The caller states the interval — what to watch at how many fps is not determined here.
      const intervalMs = p.intervalMs ?? 40;
      const maxBytes = p.maxBytes;
      const frameTimeoutMs = p.frameTimeoutMs
        ?? WINDOW_RECORD_DEFAULT_FRAME_TIMEOUT_MS;
      if (!validWindowRecordFrames(frames)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.window.record.framesRange", { max: WINDOW_RECORD_MAX_FRAMES }),
        };
      }
      if (!validWindowRecordIntervalMs(intervalMs)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.window.record.intervalRange", {
            max: WINDOW_RECORD_MAX_INTERVAL_MS,
          }),
        };
      }
      if (maxBytes !== undefined && !validWindowRecordMaxBytes(maxBytes)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.window.record.maxBytesRange", { max: WINDOW_RECORD_MAX_BYTES }),
        };
      }
      if (!validWindowRecordFrameTimeoutMs(frameTimeoutMs)) {
        return {
          ok: false as const,
          code: "INVALID_PARAMS" as const,
          message: tmsg("msg.window.record.frameTimeoutRange", {
            max: WINDOW_RECORD_MAX_FRAME_TIMEOUT_MS,
          }),
        };
      }
      const recording = recordWindowFrames({
        dir,
        frames,
        intervalMs,
        ...(maxBytes === undefined ? {} : { maxBytes }),
        frameTimeoutMs,
      });
      const landed = await recording;
      // Why fewer frames landed than were asked for. Dropped here until
      // 2026-08-16, so a deadline every frame missed answered ok:true, frames 0,
      // and nothing a caller could act on.
      const stopped = await recording.stopped;
      return {
        dir,
        maxBytes: maxBytes ?? null,
        frameTimeoutMs,
        frames: landed,
        ...(stopped ? { stopped } : {}),
      };
    },
  });
}
