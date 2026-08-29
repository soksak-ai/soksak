// webview health (circuit breaker) commands — the observation and manual-recovery surface for
// renderer-process crash detection and automatic recovery (plan W6). The single truth for state is
// the core (webview_health.rs); this file only exposes it. Automatic recovery runs in the core via
// a per-label breaker (3 crashes max in a 60s window, exponential backoff), and exhaustion (open)
// surfaces through activity (webview.crash.exhausted) plus a window badge — these commands are the
// other half (read and manual recovery) for an agent or a person.

import { invoke } from "../framework";
import { register, type CommandHint } from "./registry";
import { key, tmsg } from "../i18n";
import { allViews, useSessions } from "../state/sessions";
import { orphanSurfaceLabels, viewIdFromSurfaceLabel } from "../lib/surfaceLabels";
import {
  CONTENT_VIEW_BODY,
  contentViewDomFacts,
  contentViewHost,
  nativeSurfaceDomFacts,
} from "../lib/contentViews";
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
  register("surface.inventory", {
    description: key("cmd.surface.inventory.desc"),
    triggers: { ko: "표면 정합 유령 네이티브 표면 잔존 대조 확인" },
    params: {},
    returns:
      "{ window, actual: [id], ghosts: [id], unowned: [id], unapplied: [id], orphans: [id], declarations:[{id,kind,ownerViewId,generation,declaredVisible,declaredAlpha,layer,rect}], engine: {registered, providerParentPresent, surfaces:[…]}, bodies: […], contentViews: {inDocument, detached: [label], dom: […], sampledAtUnixMs}, stateViews }",
    message: (d) => {
      const bad =
        Number((d.ghosts as string[] | undefined)?.length ?? 0) +
        Number((d.unowned as string[] | undefined)?.length ?? 0) +
        Number((d.unapplied as string[] | undefined)?.length ?? 0) +
        Number((d.orphans as string[] | undefined)?.length ?? 0) +
        Number((d.contentViews as { detached?: string[] } | undefined)?.detached?.length ?? 0);
      return bad > 0
        ? tmsg("msg.surface.inventory.ghost", { n: bad })
        : tmsg("msg.surface.inventory.clean", { n: Number(d.stateViews ?? 0) });
    },
    examples: ["surface.inventory"],
    handler: async () => {
      // **Query the host.** With only the framework's native list (webview_list), an
      // implementation that keeps content inside the document has three surfaces alive while the
      // list is empty and the whole answer becomes free — the ghost verdict comes from an empty
      // set, so it is always "no ghosts" (measured 2026-08-03: 3 browser views on screen with
      // actual: []). The host has its own list under both implementations.
      const labels = await contentViewHost().list();
      // This window's, by the declared window field rather than by a kind. Matching a kind would
      // hide every surface of a kind this core has not been told about, and substring matching
      // makes the answer depend on punctuation instead of the public label grammar.
      const mine = labels.filter((label) => viewIdFromSurfaceLabel(label) !== null);
      // Orphan child — a surface whose parent window is already closed matches no
      // window's prefix, so the window-local comparison never sees it (real incident: a browser
      // from a closed harness window floated over an empty main window). Parent survival is judged
      // by the window part of the label against the window list — grammar <kind>-<win>-<view>.
      const windows = await invoke<string[]>("window_list").catch(() => [] as string[]);
      const orphans = orphanSurfaceLabels(labels, windows);
      const viewIds = new Set<string>();
      for (const t of useSessions.getState().workspaces)
        for (const c of t.spaces) for (const v of allViews(c.layout)) viewIds.add(v.id);
      const declarations = nativeSurfaceDomFacts();
      const declarationById = new Map(declarations.map((fact) => [fact.id, fact]));
      const actual = new Set(mine);
      const ghosts = mine.filter((id) => !declarationById.has(id));
      const unowned = mine.filter((id) => {
        const owner = declarationById.get(id)?.ownerViewId;
        return owner !== undefined && (owner === null || !viewIds.has(owner));
      });
      const unapplied = declarations.filter((fact) => !actual.has(fact.id)).map((fact) => fact.id);
      if (ghosts.length > 0 || unowned.length > 0 || unapplied.length > 0 || orphans.length > 0) {
        // A ghost is recorded in the activity hub the moment it is found — readable without pixels (sok events).
        void invoke("activity_publish", {
          kind: "surface.ghost",
          source: "webview",
          payload: {
            ghosts,
            unowned,
            unapplied,
            orphans,
            stateViews: viewIds.size,
            message: `surface ghost=${ghosts.length} unowned=${unowned.length} unapplied=${unapplied.length} orphan=${orphans.length}`,
            origin: "internal",
          },
        }).catch(() => {});
      }
      // Native engine axis — the compositor inventory and backend receipt can disagree after an
      // apply failure. registered is the surface count held by the framework layer.
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
        unowned,
        unapplied,
        orphans,
        declarations,
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
    description: key("cmd.webview.health.query.desc"),
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
    description: key("cmd.webview.recover.desc"),
    triggers: { ko: "웹뷰 복구 웹뷰 되살리기 크래시 복구 화면 복구" },
    params: {
      label: {
        type: "string",
        description: key("cmd.webview.recover.param.label"),
        required: true,
      },
    },
    primary: "label",
    returns: "{ label, reloaded: true }",
    message: (d) => tmsg("msg.webview.recover", { label: String(d.label) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['webview.recover \'{"label":"browser-w-1234-v7"}\''],
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
