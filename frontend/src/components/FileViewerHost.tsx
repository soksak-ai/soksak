// File content host — routes kind:"file" views to the registered file viewer plugin(contract A1/A13).
// resolveFileViewer(path) finds the extension-matching provider and mounts it. The core has no render engine —
// it supplies the content slot only(isomorphic with PluginViewHost). No matching viewer → empty state(pure
// skeleton — plugin not installed).
// setDirty is the only back channel that reports to the core tab(unsaved marker).

import { memo, useEffect, useRef, useState } from "react";
import {
  resolveFileViewer,
  useFileViewerRegistry,
} from "../plugins/fileViewerRegistry";
import { formatAddress } from "../commands/address";
import { viewHostAnchors } from "../plugins/viewHostAnchors";
import { useSessions } from "../state/sessions";
import { useBootPhase } from "../state/bootPhase";
import { useT } from "../i18n";

// memo boundary(principle 2).
export const FileViewerHost = memo(function FileViewerHost({
  path,
  projectId,
  root,
  viewId,
}: {
  path: string;
  projectId: string;
  root: string | null;
  viewId: string;
}) {
  const t = useT();
  // Subscribe to version → re-evaluate and remount when a file viewer registers/unregisters(plugin activate/deactivate).
  useFileViewerRegistry((s) => s.version);
  const reg = resolveFileViewer(path);
  // Address anchor — without it the nodes a viewer exposes are missed by the view scan and leak into the
  // chrome fallback, producing the same address once per file view(live measurement: chrome/mode-code ×3 —
  // address.unique violation). Same contract as PluginViewHost(viewHostAnchors); with no viewer registered
  // there is no kind axis and therefore no anchor(and no exposed node either).
  const viewAddr = reg
    ? formatAddress({
        region: "content",
        view: `${reg.pluginId}.${reg.decl.id}`,
        tab: viewId,
      })
    : null;
  const setFileDirty = useSessions((s) => s.setFileDirty);
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !reg) return;
    setError(null);
    try {
      reg.provider.mount(el, {
        viewId,
        path,
        projectId,
        root,
        setDirty: (dirty) => setFileDirty(projectId, viewId, dirty),
      });
    } catch (e) {
      console.error(`file viewer mount failed (${path}):`, e);
      setError(String(e));
      el.replaceChildren();
      return;
    }
    return () => {
      try {
        reg.provider.unmount?.(el);
      } catch (e) {
        console.error(`file viewer unmount failed (${path}):`, e);
      }
      el.replaceChildren();
    };
  }, [reg, path, projectId, root, viewId, setFileDirty]);

  // Boot phase — unregistered before ready means "not yet", not "absent"(same contract as PluginViewHost).
  // A "no view" message reads as an error — show it only when it really is one(still unregistered after activation finished).
  const bootPhase = useBootPhase((s) => s.phase);
  // No matching viewer(file viewer plugin not installed/inactive) → empty-state notice. Errors overlay on top.
  const overlay = !reg ? (
    bootPhase !== "ready" ? (
      <div className="plugin-loading">{t("plugin.view.loading")}</div>
    ) : (
      <div className="plugin-empty">{t("plugin.view.missing")}</div>
    )
  ) : error ? (
    <div className="plugin-error">
      <div className="plugin-error-title">{t("plugin.view.error")}</div>
      <div className="plugin-error-msg">{error}</div>
    </div>
  ) : null;

  return (
    <div className="plugin-body">
      <div
        className="tab-viewer"
        {...(viewAddr ? viewHostAnchors(viewAddr, viewId) : {})}
        ref={containerRef}
        style={overlay ? { display: "none" } : undefined}
      />
      {overlay}
    </div>
  );
});
