import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessions, type Program } from "../state/sessions";
import { useT } from "../i18n";

// 프로젝트 생성 모달: 폴더 선택 + 별칭(비면 폴더명) + 첫 프로그램(터미널/claude/codex).

const baseName = (p?: string) =>
  p ? (p.split("/").filter(Boolean).pop() ?? p) : "";

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const addProject = useSessions((s) => s.addProject);
  const [alias, setAlias] = useState("");
  const [root, setRoot] = useState<string | undefined>(undefined);
  // "" = 기본값(전역 설정 defaultProgram 따름). 지정하면 프로젝트 설정이 우선.
  const [program, setProgram] = useState<Program | "">("");

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
    addProject({ alias, root, program: program || undefined });
    onClose();
  };

  return (
    <div className="settings-overlay" onMouseDown={onClose}>
      <div className="settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">{t("project.newTitle")}</span>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            title={t("common.cancel")}
          >
            ×
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-row">
            <label>{t("project.folder")}</label>
            <button type="button" className="np-folder" onClick={pickFolder}>
              {root ? folderName : t("project.pickFolder")}
            </button>
          </div>
          {root && <div className="np-path">{root}</div>}

          <div className="settings-row">
            <label>{t("project.alias")}</label>
            <input
              type="text"
              value={alias}
              placeholder={folderName || t("project.aliasPh")}
              onChange={(e) => setAlias(e.target.value)}
            />
          </div>

          <div className="settings-row">
            <label>{t("project.program")}</label>
            <select
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

          <div className="np-actions">
            <button type="button" className="np-cancel" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="button" className="np-create" onClick={create}>
              {t("project.create")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
