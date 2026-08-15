// Project settings modal — manages every creation-time setting: folder (read-only), alias, identity color, shell.
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
export const PROJECT_COLORS = [
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

export function ProjectSettingsModal({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const t = useT();
  // Overlay registration — blocks mouse pass-through into the browser hole while the modal is up.
  useOverlayActive();
  const project = useSessions((s) => s.projects.find((x) => x.id === projectId));
  const defaultProjectRoot = useSettings((s) => s.defaultProjectRoot);
  const setDefaultProjectRoot = useSettings((s) => s.setDefaultProjectRoot);
  const [name, setName] = useState(project?.title ?? "");
  const [shell, setShell] = useState(project?.shell ?? "");
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

  if (!project) return null;

  // Save through the command — calling the store directly drops observation, normalization, and gates
  // whole, and becomes a different path from the project.update that CLI and AI call (both stay quiet until they diverge).
  const save = () => {
    void execute("project.update", {
      project: projectId,
      // An empty alias falls back to the folder name (P4 — a display name always exists).
      title: name.trim() || baseName(project.root),
      shell: shell.trim() || "",
    }, {});
    onClose();
  };

  return (
    <div className="dmodal-overlay" onMouseDown={onClose}>
      <div
        ref={cardRef}
        className="dmodal-card dmodal-project"
        style={cardStyle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dmodal-head" onMouseDown={onHeaderDown}>
          <span className="dmodal-title">{t("project.settings")}</span>
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
              The root always exists (P1) and is the identity of the project (P4). */}
          <div className="drow">
            <span className="drow-label">{t("project.folder")}</span>
            <span className="dctl dctl-static" title={project.root}>
              {project.root}
            </span>
          </div>

          <div className="drow">
            <span className="drow-label">{t("project.alias")}</span>
            <input
              className="dctl"
              type="text"
              value={name}
              placeholder={baseName(project.root)}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (isComposingEnter(e)) return; // The Enter that commits an IME composition is not a save.
                if (e.key === "Enter") save();
              }}
            />
          </div>

          {/* Default project — the app opens on this project (root) the first time.
              Persisted in settings (defaultProjectRoot) and consumed by boot (main.tsx). Applied at once. */}
          <div className="drow">
            <span className="drow-label">{t("project.default")}</span>
            <label className="dctl dctl-check">
              <input
                type="checkbox"
                checked={defaultProjectRoot === project.root}
                onChange={(e) =>
                  setDefaultProjectRoot(e.target.checked ? project.root : "")
                }
              />
              <span>{t("project.defaultHint")}</span>
            </label>
          </div>

          <div className="drow">
            <span className="drow-label">{t("project.color")}</span>
            <div className="color-palette">
              {/* The color applies at once (preview = actual) — independent of the save button. */}
              <button
                type="button"
                className={`color-swatch color-none${!project.color ? " on" : ""}`}
                title={t("color.default")}
                onClick={() => void execute("project.color", { project: projectId }, {})}
              >
                <Icon name="none" size="sm" />
              </button>
              {PROJECT_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-swatch${project.color === c ? " on" : ""}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => void execute("project.color", { project: projectId, color: c }, {})}
                />
              ))}
            </div>
          </div>


          <div className="drow">
            <span className="drow-label">{t("settings.shell")}</span>
            <input
              className="dctl dctl-mono"
              type="text"
              list="ps-shell-options"
              value={shell}
              placeholder={t("shell.default")}
              onChange={(e) => setShell(e.target.value)}
            />
            <datalist id="ps-shell-options">
              <option value="/bin/zsh" />
              <option value="/bin/bash" />
              <option value="/bin/sh" />
              <option value="/opt/homebrew/bin/fish" />
              <option value="/opt/homebrew/bin/nu" />
            </datalist>
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
