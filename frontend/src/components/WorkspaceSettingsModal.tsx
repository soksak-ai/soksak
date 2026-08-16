// Workspace settings modal — manages every creation-time setting: folder (read-only), alias, identity color.
// Opened by double-clicking a tab or rail chip (replaces inline rename).
import { execute } from "../commands/registry";
import { useEffect, useState } from "react";
import { isComposingEnter } from "../lib/imeKeys";
import { useSessions } from "../state/sessions";
import { useSettings } from "../state/settings";
import { useOverlayActive } from "../state/ui";
import { Icon } from "../ui/icons/Icon";
import { useT } from "../i18n";
import { useDraggableModal } from "./modalDrag";

// Identity color palette — 8 colors with enough contrast as border and text in both light and dark.
export const WORKSPACE_COLORS = [
  "#e5534b",
  "#e8883a",
  "#d4a72c",
  "#57ab5a",
  "#39c5cf",
  "#4a8fe8",
  "#986ee2",
  "#bf4b8a",
] as const;

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export function WorkspaceSettingsModal({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const t = useT();
  // Overlay registration — blocks mouse pass-through into the browser hole while the modal is up.
  useOverlayActive();
  const workspace = useSessions((s) => s.workspaces.find((x) => x.id === projectId));
  const defaultWorkspaceRoot = useSettings((s) => s.defaultWorkspaceRoot);
  const setDefaultWorkspaceRoot = useSettings((s) => s.setDefaultWorkspaceRoot);
  const [name, setName] = useState(workspace?.title ?? "");
  const { cardRef, cardStyle, onHeaderDown } = useDraggableModal();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (!workspace) return null;

  // Save through the command — calling the store directly drops observation, normalization, and gates
  // whole, and becomes a different path from the workspace.update that CLI and AI call (both stay quiet until they diverge).
  const save = () => {
    void execute("workspace.update", {
      workspace: projectId,
      // An empty alias falls back to the folder name (P4 — a display name always exists).
      title: name.trim() || baseName(workspace.root),
    }, {});
    onClose();
  };

  return (
    <div className="dmodal-overlay" onMouseDown={onClose}>
      <div
        ref={cardRef}
        className="dmodal-card dmodal-workspace"
        style={cardStyle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dmodal-head" onMouseDown={onHeaderDown}>
          <span className="dmodal-title">{t("workspace.settings")}</span>
          <span className="dmodal-spacer" />
          <span className="dmodal-grip icon-inline">
            <Icon name="grip" />
          </span>
          <button
            type="button"
            className="icon-btn dmodal-close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="dmodal-body">
          {/* The folder is immutable after creation (terminals and sessions depend on it) — read only.
              The root always exists (P1) and is the identity of the workspace (P4). */}
          <div className="drow">
            <span className="drow-label">{t("workspace.folder")}</span>
            <span className="dctl dctl-static" title={workspace.root}>
              {workspace.root}
            </span>
          </div>

          <div className="drow">
            <span className="drow-label">{t("workspace.alias")}</span>
            <input
              className="dctl"
              type="text"
              value={name}
              placeholder={baseName(workspace.root)}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (isComposingEnter(e)) return; // The Enter that commits an IME composition is not a save.
                if (e.key === "Enter") save();
              }}
            />
          </div>

          {/* Default workspace — the app opens on this workspace (root) the first time.
              Persisted in settings (defaultWorkspaceRoot) and consumed by boot (main.tsx). Applied at once. */}
          <div className="drow">
            <span className="drow-label">{t("workspace.default")}</span>
            <label className="dctl dctl-check">
              <input
                type="checkbox"
                checked={defaultWorkspaceRoot === workspace.root}
                onChange={(e) =>
                  setDefaultWorkspaceRoot(e.target.checked ? workspace.root : "")
                }
              />
              <span>{t("workspace.defaultHint")}</span>
            </label>
          </div>

          <div className="drow">
            <span className="drow-label">{t("workspace.color")}</span>
            <div className="color-palette">
              {/* The color applies at once (preview = actual) — independent of the save button. */}
              <button
                type="button"
                className={`color-swatch color-none${!workspace.color ? " on" : ""}`}
                title={t("color.default")}
                onClick={() => void execute("workspace.color", { workspace: projectId }, {})}
              >
                <Icon name="none" size="sm" />
              </button>
              {WORKSPACE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-swatch${workspace.color === c ? " on" : ""}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => void execute("workspace.color", { workspace: projectId, color: c }, {})}
                />
              ))}
            </div>
          </div>


          <div className="dmodal-actions">
            <button type="button" className="dbtn" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="button" className="dbtn dbtn-acc" onClick={save}>
              {t("common.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
