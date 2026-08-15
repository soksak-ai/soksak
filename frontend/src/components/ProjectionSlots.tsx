// Rail projection slots (plans/sidebar-projection-spec.md R1, R5) — renders the sidebar
// declaration of the bound view into the rail. live slot = PluginViewHost (instance identity =
// instanceKey — shared keeps the same instance as the binding moves, per-view separates per bound
// view), degraded = an empty slot + a notice, satisfied-by-pin = no render (the pin stack already
// renders that instance — R4 absorption).
// keep-alive: an instance created once is kept through a display toggle (R1 — structural state
// preserved).

import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PluginViewHost } from "./PluginViewHost";
import { projectionFor } from "../state/projectionWiring";
import { useProjection } from "../state/projection";
import { findViewById, useSessions, viewDisplayTitle } from "../state/sessions";
import { useSettings } from "../state/settings";
import { useViewRegistry, getRegisteredView } from "../plugins/viewRegistry";
import { usePlugins } from "../state/plugins";
import { useBootPhase } from "../state/bootPhase";
import { useContractSelection } from "../state/contractSelection";
import { localize, useT } from "../i18n";

export const ProjectionSlots = memo(function ProjectionSlots({
  projectId,
  root,
  paneId,
  side,
  commitProjection = true,
}: {
  projectId: string;
  root: string | null;
  paneId: string | null;
  side: "left" | "right";
  /** The parent display commit that transitions with the rail station. false keeps the current identity. */
  commitProjection?: boolean;
}) {
  const t = useT();
  const bootPhase = useBootPhase((st) => st.phase);
  // Subscribes to every resolution input — the active chain (sessions), registration
  // (viewRegistry), pins (projection), active plugins.
  const tab = useSessions((s) => s.workspaces.find((x) => x.id === projectId));
  const regVersion = useViewRegistry((s) => s.version);
  const entry = useProjection((s) => s.byWorkspace[projectId]);
  const plugins = usePlugins((s) => s.plugins);
  // A change of contract implementation selection also changes slot resolution (A6 — the user
  // swaps the implementation).
  const selection = useContractSelection((s) => s.selected);
  const proj = useMemo(
    () => projectionFor(projectId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, tab, regVersion, entry, plugins, selection],
  );

  // keep-alive accumulation: instanceKey → resolvedRef.
  const mountedRef = useRef(new Map<string, string>());
  const sideProj = side === "left" ? proj?.left : (proj?.right ?? null);
  const slots = sideProj?.slots ?? [];
  const absorbed = new Set(
    slots
      .filter((s) => s.status === "satisfied-by-pin" && s.instanceKey)
      .map((s) => s.instanceKey as string),
  );
  for (const s of slots) {
    if (s.status === "live" && s.instanceKey && s.resolvedRef) {
      mountedRef.current.set(s.instanceKey, s.resolvedRef);
    }
  }
  // Three cleanups: unregistered refs (ghosts), pin-absorbed instanceKeys (single render — the pin
  // stack owns it, A9), per-view instances of a dead bound view (3rd key segment = viewId).
  const liveViewIds = new Set<string>();
  if (tab) {
    for (const c of tab.spaces) {
      const walk = (n: { type: string; value?: { tabs: { id: string }[] }; children?: unknown[] }) => {
        if (n.type === "leaf" && n.value) for (const v of n.value.tabs) liveViewIds.add(v.id);
        else if (n.children) for (const ch of n.children) walk(ch as never);
      };
      walk(c.layout as never);
    }
  }
  for (const [key, ref] of [...mountedRef.current]) {
    const perViewId = key.split("|")[2];
    if (
      !getRegisteredView(ref) ||
      absorbed.has(key) ||
      (perViewId !== undefined && !liveViewIds.has(perViewId))
    ) {
      mountedRef.current.delete(key);
    }
  }

  const liveKeys = new Set(
    slots
      .filter((s) => s.status === "live" && s.instanceKey)
      .map((s) => s.instanceKey as string),
  );
  // Transition-period discipline: "undeclared" collapses quietly with no banner — a banner is only
  // for a declared binding whose resolution failed (actionable information). The undeclared banner
  // is enabled together with A1 parser enforcement (§7 step 4) — a banner before that is noise,
  // not tolerance.
  const degraded = slots.filter(
    (s) => s.status === "degraded" && s.source !== "undeclared",
  );

  const railLook = useSettings((s) => s.railLook);
  const setRailLook = useSettings((s) => s.setRailLook);

  // Region handover (§12-④) — this component owns no independent timer.
  // The departing representation keeps the previous identity with commitProjection=false, and the
  // newly placed arriving representation uses the current identity at once. The pane's FLIP hides
  // one and reveals the other.
  const fingerprint = [...liveKeys].sort().join(",");
  const [shownFingerprint, setShownFingerprint] = useState(fingerprint);
  const shownKeys = new Set(
    shownFingerprint ? shownFingerprint.split(",") : [],
  );
  useLayoutEffect(() => {
    if (!commitProjection || shownFingerprint === fingerprint) return;
    setShownFingerprint(fingerprint);
  }, [commitProjection, fingerprint, shownFingerprint]);

  // An unresolved binding while boot is incomplete — the bound view is present but its plugin is
  // not activated yet, so the projection contract (rails) is unresolved. Collapsing it turns a
  // slot about to be filled into a blank, which contradicts the fact (user measurement 2026-07-27:
  // only the bookmarks projection disappeared with no loading state). The slot shows the loading
  // state.
  const bootLoading =
    bootPhase !== "ready" &&
    shownKeys.size === 0 &&
    degraded.length === 0 &&
    !!proj?.binding.viewId;
  // With nothing visible the region collapses — keep-alive mounts stay but take no layout
  // (display:none). With no mounts at all the render itself is skipped.
  const visible = shownKeys.size > 0 || degraded.length > 0 || bootLoading;
  if (!visible && mountedRef.current.size === 0) {
    return null;
  }

  // §12-④ movement is not produced here — enter/exit effects on the content swap of a rebinding
  // are forbidden. The only expression of real movement is the coordinate travel (transition) of
  // the rail frame (.sidebar).
  let first = true;

  return (
    <div
      className="projections"
      style={visible ? undefined : { display: "none" }}
      data-node={`projection/${side}`}
    >
      {[...mountedRef.current].map(([instanceKey, refKey]) => {
        const live = shownKeys.has(instanceKey);
        const decl = getRegisteredView(refKey)?.decl;
        const showToggle = live && side === "left" && first;
        if (live) first = false;
        // Bound view name — which view the sidebar serves is shown in this one place in the host
        // header (the floating "connected" badge was removed — relation display simplified, user
        // decision).
        const boundId = instanceKey.split("|")[2] ?? proj?.binding.viewId ?? null;
        const boundView = boundId && tab ? findViewById([tab], boundId) : null;
        return (
          <div
            key={instanceKey}
            className="projection"
            // The card has its own address — the geometry of the container (projection/{side}) is
            // not the geometry of the card. While there was no address and the container was
            // measured instead, the checker looked at a place with no card and reported "no
            // border" (measured 2026-07-27). To be measured, it is exposed.
            data-node={`projection/${side}/card/${refKey}`}
            style={{ display: live ? "flex" : "none" }}
          >
            {/* Common form (§12-①②) — the header is the host's (feature identity + rail controls); the feature replaces the body only. */}
            <div className="projection-header" data-node={`projection/${side}/frame/${refKey}`}>
              <span className="projection-icon">{decl?.icon ?? ""}</span>
              <span className="projection-title">{decl ? localize(decl.title) : refKey}</span>
              {boundView && (
                <span className="projection-bound">{viewDisplayTitle(boundView)}</span>
              )}
              {showToggle && (
                <button
                  type="button"
                  className="proj-look-toggle"
                  data-node="projection/left/look"
                  title={t("projection.look.toggle")}
                  onClick={() => setRailLook(railLook === "pane" ? "ground" : "pane")}
                >
                  {railLook === "pane" ? "▦" : "▬"}
                </button>
              )}
            </div>
            <div className="projection-card">
              <PluginViewHost
                viewKey={refKey}
                projectId={projectId}
                root={root}
                region={side}
                paneId={paneId}
                boundViewId={instanceKey.split("|")[2] ?? proj?.binding.viewId ?? null}
                // Address uniqueness (axiom A1) — the same refKey exists once per bound view.
                instanceId={instanceKey.split("|")[2] ?? proj?.binding.viewId ?? null}
              />
            </div>
          </div>
        );
      })}
      {bootLoading && (
        <div className="projection projection-degraded" data-node={`projection/${side}/loading`}>
          {t("plugin.view.loading")}
        </div>
      )}
      {degraded.map((s, i) => (
        <div key={`deg-${i}`} className="projection projection-degraded" data-node={`projection/${side}/degraded`}>
          {
            // Unresolved while boot is incomplete means "not yet", not a defect — wording that
            // reads as an error appears only when it really is a problem (still unresolved after
            // activation completed), the same contract as the three PluginViewHost states.
            bootPhase !== "ready"
              ? t("plugin.view.loading")
              : s.source === "undeclared"
                ? t("projection.degraded.undeclared")
                : t("projection.degraded.unresolved")
          }
        </div>
      ))}
    </div>
  );
});
