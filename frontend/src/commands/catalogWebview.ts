// webview health (circuit breaker) commands — the observation and manual-recovery surface for
// renderer-process crash detection and automatic recovery (plan W6). The single truth for state is
// the core (webview_health.rs); this file only exposes it. Automatic recovery runs in the core via
// a per-label breaker (3 crashes max in a 60s window, exponential backoff), and exhaustion (open)
// surfaces through activity (webview.crash.exhausted) plus a window badge — these commands are the
// other half (read and manual recovery) for an agent or a person.

import { invoke } from "../framework";
import { register, type CommandHint } from "./registry";
import { tmsg } from "../i18n";
import { allViews, useSessions } from "../state/sessions";
import { browserLabelPrefix, browserViewIdFromLabel, orphanBrowserLabels } from "../lib/webviewLabels";
import { CONTENT_VIEW_BODY, contentViewDomFacts, contentViewHost } from "../lib/contentViews";
import { presentationNowUnixMs } from "../lib/presentationClock";

interface LabelHealth {
  label: string;
  state: "closed" | "recovering" | "open";
  attempt: number | null;
  crashesInWindow: number;
  totalCrashes: number;
  lastCrashAgoMs: number | null;
  lastReason: string | null;
}

export function registerWebviewCatalog(): void {
  register("webview.surfaces", {
    description:
      "Reconcile this window's state (which views exist) against the browser content views actually alive for this window. ghosts = views whose view no longer exists in state — a stale surface floating over the window (the 'browser over an empty window' mismatch). detached = content surfaces that live in the document but not inside the slot that declared them — they are being pushed by coordinates, so slot and surface are two clocks and one of them is always late (empty pane, edge afterimage). A non-empty ghosts or detached list is always a defect fact. Judged from the same sources the app itself uses (state store + the content view host), no pixels involved.",
    triggers: { ko: "표면 정합 유령 웹뷰 잔존 브라우저 대조 확인" },
    params: {},
    returns:
      "{ window, actual: [label], ghosts: [label], orphans: [label], engine: {registered, providerParentPresent, surfaces:[{label,hidden,effectivelyHidden,alpha,effectiveAlpha,frame}]}, bodies: [{node,x,y,w,h,children,overlay,…}], contentViews: {inDocument, detached: [label], dom: [{label,slotLabel,computedVisibility,opacity,filter,composition:{kind,viewId,topologyPath,visible}|null,rect}], sampledAtUnixMs}, stateViews } — sampledAtUnixMs is when this ledger read itself, on the same presentation clock as ui.layout.wait-settled, so a caller can tell one settled observation window from two; opacity/filter are how much light the adapter lets through its own surface, so a second dimming on top of the focus lighting plane is readable instead of assumed absent",
    message: (d) => {
      const bad =
        Number((d.ghosts as string[] | undefined)?.length ?? 0) +
        Number((d.orphans as string[] | undefined)?.length ?? 0) +
        Number((d.contentViews as { detached?: string[] } | undefined)?.detached?.length ?? 0);
      return bad > 0
        ? tmsg("msg.webview.surfaces.ghost", { n: bad })
        : tmsg("msg.webview.surfaces.clean", { n: Number(d.stateViews ?? 0) });
    },
    examples: ["webview.surfaces"],
    handler: async () => {
      // **Query the host.** With only the framework's native list (webview_list), an
      // implementation that keeps content inside the document has three surfaces alive while the
      // list is empty and the whole answer becomes free — the ghost verdict comes from an empty
      // set, so it is always "no ghosts" (measured 2026-08-03: 3 browser views on screen with
      // actual: []). The host has its own list under both implementations.
      const labels = await contentViewHost().list();
      const mine = labels.filter((l) => l.startsWith(browserLabelPrefix()));
      // Orphan child — a child (b-<win>-…) whose parent window is already closed matches no
      // window's prefix, so the window-local comparison never sees it (real incident: a browser
      // from a closed harness window floated over an empty main window). Parent survival is judged
      // by prefix match against the window list — label grammar b-<win>-<view>.
      const windows = await invoke<string[]>("window_list").catch(() => [] as string[]);
      const orphans = orphanBrowserLabels(labels, windows);
      const viewIds = new Set<string>();
      for (const t of useSessions.getState().workspaces)
        for (const c of t.spaces) for (const v of allViews(c.layout)) viewIds.add(v.id);
      const ghosts = mine.filter((l) => {
        const v = browserViewIdFromLabel(l);
        return v !== null && !viewIds.has(v);
      });
      if (ghosts.length > 0 || orphans.length > 0) {
        // A ghost is recorded in the activity hub the moment it is found — readable without pixels (sok events).
        void invoke("activity_publish", {
          kind: "surface.ghost",
          source: "webview",
          payload: {
            ghosts,
            orphans,
            stateViews: viewIds.size,
            message: `· surface ghost ×${ghosts.length} orphan ×${orphans.length}: ${[...ghosts, ...orphans].join(", ")}`,
            origin: "internal",
          },
        }).catch(() => {});
      }
      // Engine (CEF) axis — surfaces the WKWebView list cannot see (real incident: a leftover
      // browser frame after reload was misjudged as "no ghosts"). registered = surface count
      // registered in the core layer.
      const engine = await invoke<{ registered: number; providerParentPresent: boolean }>(
        "engine_surface_stats",
      ).catch(() => ({ registered: -1, providerParentPresent: false }));
      // View body facts — a machine separates the branches of "empty space" (normal render, reason
      // card, plugin-empty, a truly empty mount) (real incident: the branch behind a black Google
      // page was guessed from pixels alone). This is a renderer command, so the DOM is read directly.
      const bodies: Record<string, unknown>[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(".tab-viewer.plugin-view-container")) {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.x + r.width <= 0 || r.x >= window.innerWidth) continue;
        const body = el.parentElement;
        bodies.push({
          node: el.getAttribute("data-node") ?? el.getAttribute("data-view-addr") ?? "?",
          // Position is a fact too — a rect with size only is half an answer and cannot settle
          // "did the surface land exactly on the folded slot". On a framework that keeps content
          // inside the page, these four are the same axis as a native child frame.
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          children: el.childElementCount,
          shadowChildren: el.shadowRoot ? el.shadowRoot.childElementCount : null,
          firstClass: (el.firstElementChild?.className ?? "").toString().slice(0, 60),
          firstHtml: (el.firstElementChild?.outerHTML ?? "").slice(0, 160),
          overlay: body?.querySelector(".plugin-error")
            ? "error"
            : body?.querySelector(".plugin-empty")
              ? "empty"
              : body?.querySelector(".plugin-loading")
                ? "loading"
                : "none",
        });
      }
      // Is the surface **inside its own slot.** A surface in the document must be a descendant of
      // the slot that declared it — outside the slot means it is being pushed by coordinates, so
      // slot and surface are two clocks and one of them is always late (slot at the new position,
      // surface at the old = empty pane, edge afterimage).
      //
      // The framework is never consulted: with no surfaces in the document all three are 0 and
      // that is the fact. With surfaces present but outside their slot, the name lands in detached
      // — "absent" and "outside" stay separate.
      const detached: string[] = [];
      const inDocument = document.querySelectorAll("[data-content-view]");
      for (const el of inDocument) {
        const own = el.getAttribute("data-content-view") ?? "";
        if (el.parentElement?.closest(`[${CONTENT_VIEW_BODY}]`)?.getAttribute(CONTENT_VIEW_BODY) !== own)
          detached.push(own);
      }
      return {
        actual: mine,
        ghosts,
        orphans,
        engine,
        bodies,
        stateViews: viewIds.size,
        contentViews: {
          inDocument: inDocument.length,
          detached,
          dom: contentViewDomFacts(),
          // When this ledger sampled itself. If the slot read and the surface read happen at
          // different times, the difference between the two coordinates is indistinguishable from
          // a composition defect — with nowhere to check, the judging side falls back to assuming
          // "both were seen at the same instant".
          sampledAtUnixMs: presentationNowUnixMs(),
        },
      };
    },
  });

  register("webview.health.query", {
    description:
      "Report webview renderer-process health per label: circuit-breaker state (closed / recovering / open), crash counts in the rolling 60s window, lifetime total, and the last termination reason if the platform provided one. Labels: a window label is that window's main webview, b-<win>-<view> is a browser child. state=open means automatic recovery is exhausted — recover it manually with webview.recover.",
    triggers: { ko: "웹뷰 건강 웹뷰 상태 크래시 조회 복구 상태" },
    params: {},
    returns:
      "{ count, entries: [{label, state, attempt, crashesInWindow, totalCrashes, lastCrashAgoMs, lastReason}] }",
    message: (d) => tmsg("msg.webview.health.query", { n: Number(d.count ?? 0) }),
    hint: (d) => {
      const entries = Array.isArray(d.entries) ? (d.entries as LabelHealth[]) : [];
      return entries
        .filter((e) => e.state === "open")
        .slice(0, 3)
        .map<CommandHint>((e) => ({
          cmd: `webview.recover '{"label":"${e.label}"}'`,
          why: tmsg("hint.webview.recoverOpen", { label: e.label }),
        }));
    },
    examples: ["webview.health.query"],
    handler: async () => {
      const entries = await invoke<LabelHealth[]>("webview_health_query");
      return { count: entries.length, entries };
    },
  });

  register("webview.recover", {
    description:
      "Manually recover a webview: reset its circuit breaker (clears the crash window and the open state) and reload it in place. Use after webview.health.query shows state=open, or any time a webview is blank/wedged. The window's main webview reloads through the normal boot path (terminals survive — PTYs live in the core); a browser child (b-<win>-<view>) reloads in place without being re-created.",
    triggers: { ko: "웹뷰 복구 웹뷰 되살리기 크래시 복구 화면 복구" },
    params: {
      label: {
        type: "string",
        description:
          "webview label — a window label for that window's main webview, or b-<win>-<view> for a browser child (list via webview.health.query or window.list)",
        required: true,
      },
    },
    primary: "label",
    returns: "{ label, reloaded: true }",
    message: (d) => tmsg("msg.webview.recover", { label: String(d.label) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['webview.recover \'{"label":"brw-w-1234-v7"}\''],
    handler: async (p) => {
      try {
        await invoke("webview_recover", { label: p.label });
      } catch (e) {
        const msg = String(e);
        // Promote the core existence-check failure matched below to a typed error (R9 — no raw error leaks).
        if (msg.includes("webview not found"))
          return { ok: false as const, code: "TARGET_NOT_FOUND" as const, message: msg };
        throw e;
      }
      return { label: p.label, reloaded: true };
    },
  });
}
