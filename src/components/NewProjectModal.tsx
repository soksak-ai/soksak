import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessions, type Program } from "../state/sessions";
import { useSuppressBrowser } from "../state/ui";
import { Icon } from "../ui/icons/Icon";
import { useT } from "../i18n";
import { useDraggableModal } from "./modalDrag";

// 새 프로젝트 모달 — 디자인 레퍼런스(soksak_final): 드래그 가능한 460px 카드,
// 헤더(+ 아이콘·⠿·✕), 행 레이아웃. 폴더 + 별칭(비면 폴더명) + 첫 프로그램 + 셸.

const baseName = (p?: string) =>
  p ? (p.split("/").filter(Boolean).pop() ?? p) : "";

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  // 네이티브 브라우저 웹뷰는 항상 DOM 위 — 모달이 떠 있는 동안 숨긴다.
  useSuppressBrowser();
  const addProject = useSessions((s) => s.addProject);
  const [alias, setAlias] = useState("");
  const [root, setRoot] = useState<string | undefined>(undefined);
  // "" = 기본값(전역 설정 따름). 지정하면 프로젝트 설정이 우선.
  const [program, setProgram] = useState<Program | "">("");
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
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") setRoot(sel);
  };

  const folderName = baseName(root);
  const create = () => {
    addProject({
      alias,
      root,
      program: program || undefined,
      shell: shell.trim() || undefined,
    });
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
          <span className="dmodal-plus icon-inline">
            <Icon name="add" size="sm" />
          </span>
          <span className="dmodal-title">{t("project.newTitle")}</span>
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
          <div className="drow">
            <span className="drow-label">{t("project.folder")}</span>
            <button type="button" className="dctl dctl-btn" onClick={pickFolder}>
              {root ? folderName : t("project.pickFolder")}
            </button>
          </div>
          {root && <div className="dpath">{root}</div>}

          <div className="drow">
            <span className="drow-label">{t("project.alias")}</span>
            <input
              className="dctl"
              type="text"
              value={alias}
              placeholder={folderName || t("project.aliasPh")}
              onChange={(e) => setAlias(e.target.value)}
            />
          </div>

          <div className="drow">
            <span className="drow-label">{t("project.program")}</span>
            <select
              className="dctl"
              value={program}
              onChange={(e) => setProgram(e.target.value as Program | "")}
            >
              <option value="">{t("program.default")}</option>
              <option value="terminal">{t("program.terminal")}</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="browser">{t("program.browser")}</option>
            </select>
          </div>

          <div className="drow">
            <span className="drow-label">{t("settings.shell")}</span>
            <input
              className="dctl dctl-mono"
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
            <button type="button" className="dbtn" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="button" className="dbtn dbtn-acc" onClick={create}>
              {t("project.create")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
