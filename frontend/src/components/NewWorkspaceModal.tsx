import { useEffect, useState } from "react";
import { dialog } from "../framework";
import { addWorkspaceClaimed } from "../state/workspaceRegistry";
import { useOverlayActive } from "../state/ui";
import { Icon } from "../ui/icons/Icon";
import { useT } from "../i18n";
import { useDraggableModal } from "./modalDrag";
import {
  ensureDefaultWorkspaceRoot,
  FOLDER_NAME_RE,
  validateWorkspaceRoot,
} from "../lib/workspaceRoot";

// New workspace modal — product contract: draggable 460px card,
// header (+ icon, ⠿, ✕), row layout.
//
// The folder is an explicit choice (no implicit mode). The mode fixes what the input field means:
//   auto = the input is the "folder name" to create (slug required, not persisted — P4) →
//     creates and uses ~/.soksak/workspaces/<folder name>, alias defaults to the folder name.
//   manual = folder picker (home/root rejected — P2 validation) — the input is the "alias" (free
//     form, folder name when empty). Persistent identity is the root path itself (P4, the
//     workspaceRoot.ts constitution).

const baseName = (p?: string) =>
  p ? (p.split("/").filter(Boolean).pop() ?? p) : "";

type FolderMode = "auto" | "manual";

// create injection: default = add a workspace tab to this window (workspace). The control plane
// (orchestrator) injects creation of a new workspace window instead — the modal owns only folder
// preparation and validation, and the caller supplies "what gets opened" (one UI for open and
// create, two consumers).
export interface CreateWorkspaceArgs {
  alias: string;
  root: string;
  shell?: string;
}

export function NewWorkspaceModal({
  onClose,
  create: createOverride,
}: {
  onClose: () => void;
  create?: (args: CreateWorkspaceArgs) => Promise<void>;
}) {
  const t = useT();
  // Overlay registration — blocks mouse pass-through in the browser hole while the modal is up.
  useOverlayActive();
  const [mode, setMode] = useState<FolderMode>("auto");
  const [name, setName] = useState(""); // auto = folder name slug / manual = free-form alias
  const [root, setRoot] = useState<string | undefined>(undefined);
  const [rootError, setRootError] = useState<string | null>(null);
  const [shell, setShell] = useState("");
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

  const pickFolder = async () => {
    const sel = await dialog.openDirectory();
    if (typeof sel !== "string") return;
    setMode("manual");
    try {
      // P2: home (~) and filesystem root (/) rejected — on pass, the canonical path (P5 comparison basis).
      const canon = await validateWorkspaceRoot(sel);
      setRoot(canon);
      setRootError(null);
    } catch (e) {
      setRoot(undefined);
      setRootError(String(e));
    }
  };

  const nameValue = name.trim();
  // Only auto mode requires the folder name slug. The manual mode alias is free form (folder name when empty).
  const folderInvalid =
    mode === "auto" && (!nameValue || !FOLDER_NAME_RE.test(nameValue));
  const createDisabled = folderInvalid || (mode === "manual" && !root);

  const create = async () => {
    if (createDisabled) return; // Second guard behind the disabled button.
    const finalRoot =
      mode === "auto" ? await ensureDefaultWorkspaceRoot(nameValue) : root!;
    // Root initialization policy (git init and the like) is owned by plugins subscribing to the
    // workspace.created event, not by core — this site only creates.
    const args = {
      alias: nameValue, // Empty falls back to the folder name in makeWorkspace.
      root: finalRoot,
      shell: shell.trim() || undefined,
    };
    // P6 (globally single open) gate — if it is open in another window, that window is focused.
    if (createOverride) await createOverride(args);
    else await addWorkspaceClaimed(args);
    onClose();
  };

  return (
    <div
      className="dmodal-overlay"
      data-node="modal/workspace-new"
      onMouseDown={onClose}
    >
      <div
        ref={cardRef}
        className="dmodal-card dmodal-workspace"
        data-node="modal/workspace-new/card"
        style={cardStyle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dmodal-head" onMouseDown={onHeaderDown}>
          <span className="dmodal-plus icon-inline">
            <Icon name="add" size="sm" />
          </span>
          <span className="dmodal-title">{t("workspace.newTitle")}</span>
          <span className="dmodal-spacer" />
          <span className="dmodal-grip icon-inline">
            <Icon name="grip" />
          </span>
          <button
            type="button"
            className="icon-btn dmodal-close"
            data-node="modal/workspace-new/close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="dmodal-body">
          <div className="drow">
            <span className="drow-label">{t("workspace.folder")}</span>
            <div className="dseg">
              <button
                type="button"
                className={`dbtn dseg-btn${mode === "auto" ? " active" : ""}`}
                data-node="modal/workspace-new/folder-auto"
                onClick={() => {
                  setMode("auto");
                  setRoot(undefined);
                  setRootError(null);
                }}
              >
                {t("workspace.folderAuto")}
              </button>
              <button
                type="button"
                className={`dbtn dseg-btn${mode === "manual" ? " active" : ""}`}
                data-node="modal/workspace-new/folder-pick"
                onClick={pickFolder}
              >
                {root ? baseName(root) : t("workspace.pickFolder")}
              </button>
            </div>
          </div>
          {mode === "manual" && root && <div className="dpath">{root}</div>}
          {mode === "manual" && !root && (
            <div className="dpath dpath-err">
              {rootError ?? t("workspace.folderRequired")}
            </div>
          )}

          <div className="drow">
            <span className="drow-label">
              {mode === "auto" ? t("workspace.folderName") : t("workspace.alias")}
            </span>
            <input
              className="dctl"
              data-node="modal/workspace-new/name"
              type="text"
              value={name}
              placeholder={
                mode === "auto" ? t("workspace.folderNamePh") : baseName(root)
              }
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {/* The hint shows only real information: the format error, and the path auto mode creates.
              Manual mode in its normal state has no hint (excess explanation is noise). */}
          {mode === "auto" ? (
            <div
              className={`dpath${nameValue && folderInvalid ? " dpath-err" : ""}`}
            >
              {nameValue && folderInvalid
                ? t("workspace.folderNameInvalid")
                : t("workspace.folderNameHint", { name: nameValue || t("workspace.folderNamePlaceholder") })}
            </div>
          ) : null}

          <div className="drow">
            <span className="drow-label">{t("settings.shell")}</span>
            <input
              className="dctl dctl-mono"
              data-node="modal/workspace-new/shell"
              type="text"
              list="np-shell-options"
              value={shell}
              placeholder={t("shell.default")}
              onChange={(e) => setShell(e.target.value)}
            />
            <datalist id="np-shell-options">
              <option value="/bin/zsh" />
              <option value="/bin/bash" />
              <option value="/bin/sh" />
              <option value="/opt/homebrew/bin/fish" />
              <option value="/opt/homebrew/bin/nu" />
            </datalist>
          </div>

          <div className="dmodal-actions">
            <button
              type="button"
              className="dbtn"
              data-node="modal/workspace-new/cancel"
              onClick={onClose}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="dbtn dbtn-acc"
              data-node="modal/workspace-new/create"
              disabled={createDisabled}
              onClick={create}
            >
              {t("workspace.create")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
