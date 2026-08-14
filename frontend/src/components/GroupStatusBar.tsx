import { memo, useEffect, useState } from "react";
import { getCwdOfHost, subscribeCwd } from "../terminal/ptyBridge";
import { hasPtyObservation } from "../terminal/ptyObservationStore";
import { Icon } from "../ui/icons/Icon";
import type { Tab, Pane } from "../state/sessions";
import { useT } from "../i18n";
import {
  statusBarItemsForTab,
  subscribeStatusBarItems,
  type StatusBarItem,
} from "../ui/statusBarItems";

// Status bar at the bottom of a split pane (group). Active view info:
//   - terminal: current working directory (cwd, subscribed to shell integration events — no polling)
//   - file: path + dirty flag + code/preview mode

function TerminalStatus({ paneId }: { paneId: string }) {
  const t = useT();
  const [cwd, setCwd] = useState<string | undefined>(() => getCwdOfHost(paneId));
  useEffect(() => {
    setCwd(getCwdOfHost(paneId));
    return subscribeCwd(paneId, setCwd);
  }, [paneId]);
  // Subscribe to the plugin status bar items bound to this pane (e.g. "gui" from claude-GUI).
  const [items, setItems] = useState<StatusBarItem[]>(() =>
    statusBarItemsForTab(paneId),
  );
  useEffect(() => {
    const update = () => setItems(statusBarItemsForTab(paneId));
    update();
    return subscribeStatusBarItems(update);
  }, [paneId]);
  return (
    <>
      <span className="pane-status-left" title={cwd}>
        {cwd ?? "~"}
      </span>
      <span className="pane-status-right">
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            className={`pane-status-item${it.active ? " active" : ""}`}
            title={it.title}
            onClick={(e) => {
              e.stopPropagation();
              it.onClick();
            }}
          >
            {it.label}
          </button>
        ))}
        {items.length > 0 && <span className="pane-status-sep">|</span>}
        {t("view.terminal")}
      </span>
    </>
  );
}

function FileStatus({ view }: { view: Extract<Tab, { kind: "file" }> }) {
  const t = useT();
  return (
    <>
      <span className="pane-status-left" title={view.path}>
        {view.path}
      </span>
      <span className="pane-status-right icon-inline" style={{ gap: 4 }}>
        {view.status?.code === "dirty" && <Icon name="dirty" size="xs" />}
        {view.mode === "code" ? t("viewer.code") : t("viewer.preview")}
      </span>
    </>
  );
}

// memo boundary (principle 2): no re-render on unrelated store writes that preserve group identity.
export const GroupStatusBar = memo(function GroupStatusBar({
  group,
}: {
  group: Pane;
}) {
  const active = group.tabs.find((v) => v.id === group.activeTabId);
  // Terminal = a plugin view with a PTY observation (view.id = paneId). cwd and status bar items key off the substrate.
  const isTerminal = active != null && hasPtyObservation(active.id);
  return (
    <div className="pane-status">
      {isTerminal ? (
        <TerminalStatus paneId={active.id} />
      ) : active?.kind === "file" ? (
        <FileStatus view={active} />
      ) : null}
    </div>
  );
});
