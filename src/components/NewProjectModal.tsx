import { ProgramOptions } from "./ProgramOptions";
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessions, type Program } from "../state/sessions";
import { useSuppressBrowser } from "../state/ui";
import { Icon } from "../ui/icons/Icon";
import { useT } from "../i18n";
import { useDraggableModal } from "./modalDrag";
import {
  ensureDefaultWorkspace,
  PROJECT_ID_RE,
  slugifyId,
} from "../lib/workspace";

// 새 프로젝트 모달 — 디자인 레퍼런스(soksak_final): 드래그 가능한 460px 카드,
// 헤더(+ 아이콘·⠿·✕), 행 레이아웃.
//
// 폴더는 명시 선택이다(암묵 모드 금지 — 사용자 결정):
//   자동 지정 = ~/soksak/<id> 생성·사용 — 프로젝트 id 직접 입력 필수.
//   직접 선택 = 폴더 picker — 폴더명을 슬러그화해 id 자동 입력(수정 가능).
// 프로젝트 id 는 모드 무관 단일 규칙(영문 슬러그) — 디렉토리명 계약이자 탭의
// 초기 표시명. 한글 등 자유 표시명은 생성 후 프로젝트 설정(별칭)에서 변경.

const baseName = (p?: string) =>
  p ? (p.split("/").filter(Boolean).pop() ?? p) : "";

type FolderMode = "auto" | "manual";

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  // 네이티브 브라우저 웹뷰는 항상 DOM 위 — 모달이 떠 있는 동안 숨긴다.
  useSuppressBrowser();
  const addProject = useSessions((s) => s.addProject);
  const [mode, setMode] = useState<FolderMode>("auto");
  const [id, setId] = useState("");
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
    if (typeof sel === "string") {
      setMode("manual");
      setRoot(sel);
      // 폴더명 → id 자동 입력(슬러그화). 이후 수정 가능.
      setId(slugifyId(baseName(sel)));
    }
  };

  const idValue = id.trim();
  const idInvalid = !idValue || !PROJECT_ID_RE.test(idValue);
  // 자동 = id 만 있으면 됨. 직접 = 폴더까지 골라야 함.
  const createDisabled = idInvalid || (mode === "manual" && !root);

  const create = async () => {
    if (createDisabled) return; // 버튼 disabled 와 이중 방어
    const finalRoot =
      mode === "auto" ? await ensureDefaultWorkspace(idValue) : root;
    // 루트 초기화 정책(git init 등)은 코어가 아니라 project.created 이벤트를
    // 구독하는 플러그인 소유(soksak-git-init) — 여기선 생성만.
    addProject({
      alias: idValue,
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
            <div className="dseg">
              <button
                type="button"
                className={`dbtn dseg-btn${mode === "auto" ? " active" : ""}`}
                onClick={() => {
                  setMode("auto");
                  setRoot(undefined);
                }}
              >
                {t("project.folderAuto")}
              </button>
              <button
                type="button"
                className={`dbtn dseg-btn${mode === "manual" ? " active" : ""}`}
                onClick={pickFolder}
              >
                {root ? baseName(root) : t("project.pickFolder")}
              </button>
            </div>
          </div>
          {mode === "manual" && root && <div className="dpath">{root}</div>}
          {mode === "manual" && !root && (
            <div className="dpath dpath-err">{t("project.folderRequired")}</div>
          )}

          <div className="drow">
            <span className="drow-label">{t("project.id")}</span>
            <input
              className="dctl"
              type="text"
              value={id}
              placeholder={t("project.idPh")}
              onChange={(e) => setId(e.target.value)}
            />
          </div>
          <div className={`dpath${idValue && idInvalid ? " dpath-err" : ""}`}>
            {idValue && idInvalid
              ? t("project.idInvalid")
              : mode === "auto"
                ? t("project.idHint", { id: idValue || "<id>" })
                : t("project.idAsAlias")}
          </div>

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
              disabled={createDisabled}
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
