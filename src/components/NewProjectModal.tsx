import { ProgramOptions } from "./ProgramOptions";
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessions, type Program } from "../state/sessions";
import { useSuppressBrowser } from "../state/ui";
import { Icon } from "../ui/icons/Icon";
import { useT } from "../i18n";
import { useDraggableModal } from "./modalDrag";
import { ensureDefaultWorkspace, PROJECT_ID_RE } from "../lib/workspace";

// 새 프로젝트 모달 — 디자인 레퍼런스(soksak_final): 드래그 가능한 460px 카드,
// 헤더(+ 아이콘·⠿·✕), 행 레이아웃. 폴더 + 별칭(비면 폴더명) + 첫 프로그램 + 셸.
// 폴더 미지정 모드: 이름이 디렉토리명 계약이 되므로 자유 별칭이 아니라
// id(영문 슬러그) 필수 — ~/soksak/<id> 를 생성해 루트로 쓴다(workspace.ts).

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
  // 폴더 미지정 = id 모드: 입력값이 ~/soksak/<id> 디렉토리명이 된다.
  const idMode = !root;
  const idValue = alias.trim();
  const idInvalid = idMode && (!idValue || !PROJECT_ID_RE.test(idValue));
  const create = async () => {
    let finalRoot = root;
    if (idMode) {
      if (idInvalid) return; // 버튼 disabled 와 이중 방어
      finalRoot = await ensureDefaultWorkspace(idValue);
    }
    // 루트 초기화 정책(git init 등)은 코어가 아니라 project.created 이벤트를
    // 구독하는 플러그인 소유(soksak-git-init) — 여기선 생성만.
    addProject({
      alias: idMode ? idValue : alias,
      root: finalRoot,
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
            <span className="drow-label">
              {idMode ? t("project.id") : t("project.alias")}
            </span>
            <input
              className="dctl"
              type="text"
              value={alias}
              placeholder={idMode ? t("project.idPh") : folderName}
              onChange={(e) => setAlias(e.target.value)}
            />
          </div>
          {idMode && (
            <div className={`dpath${idValue && idInvalid ? " dpath-err" : ""}`}>
              {idValue && idInvalid
                ? t("project.idInvalid")
                : t("project.idHint", { id: idValue || "<id>" })}
            </div>
          )}

          <div className="drow">
            <span className="drow-label">{t("project.program")}</span>
            <select
              className="dctl"
              value={program}
              onChange={(e) => setProgram(e.target.value as Program | "")}
            >
              <option value="">{t("program.default")}</option>
              <ProgramOptions current={program || undefined} />
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
            <button
              type="button"
              className="dbtn dbtn-acc"
              disabled={idInvalid}
              onClick={create}
            >
              {t("project.create")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
