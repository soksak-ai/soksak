import { ProgramOptions } from "./ProgramOptions";
import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useSessions, type Program } from "../state/sessions";
import { useOverlayActive } from "../state/ui";
import { Icon } from "../ui/icons/Icon";
import { useT } from "../i18n";
import { useDraggableModal } from "./modalDrag";
import {
  ensureDefaultWorkspace,
  FOLDER_NAME_RE,
  validateProjectRoot,
} from "../lib/workspace";

// 새 프로젝트 모달 — 디자인 레퍼런스(soksak_final): 드래그 가능한 460px 카드,
// 헤더(+ 아이콘·⠿·✕), 행 레이아웃.
//
// 폴더는 명시 선택이다(암묵 모드 금지). 입력 필드의 의미는 모드가 정한다:
//   자동 지정 = 입력은 만들 "폴더명"(슬러그 필수, 저장 안 함 — P4) →
//     ~/.soksak/projects/<폴더명> 생성·사용, 별칭 기본 = 폴더명.
//   직접 선택 = 폴더 picker(홈/루트 금지 — P2 검증) — 입력은 "별칭"(자유,
//     비면 폴더명). 영속 정체성은 루트 경로 그 자체(P4, workspace.ts 헌법).

const baseName = (p?: string) =>
  p ? (p.split("/").filter(Boolean).pop() ?? p) : "";

type FolderMode = "auto" | "manual";

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  // 오버레이 등록 — 모달이 떠 있는 동안 브라우저 홀의 마우스 통과를 차단한다.
  useOverlayActive();
  const addProject = useSessions((s) => s.addProject);
  const [mode, setMode] = useState<FolderMode>("auto");
  const [name, setName] = useState(""); // auto=폴더명(슬러그) / manual=별칭(자유)
  const [root, setRoot] = useState<string | undefined>(undefined);
  const [rootError, setRootError] = useState<string | null>(null);
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
    if (typeof sel !== "string") return;
    setMode("manual");
    try {
      // P2: 홈(~)·파일시스템 루트(/) 금지 — 통과 시 정규화 경로(P5 비교 기준).
      const canon = await validateProjectRoot(sel);
      setRoot(canon);
      setRootError(null);
    } catch (e) {
      setRoot(undefined);
      setRootError(String(e));
    }
  };

  const nameValue = name.trim();
  // 자동 모드만 폴더명 슬러그 필수. 직접 모드의 별칭은 자유(비면 폴더명).
  const folderInvalid =
    mode === "auto" && (!nameValue || !FOLDER_NAME_RE.test(nameValue));
  const createDisabled = folderInvalid || (mode === "manual" && !root);

  const create = async () => {
    if (createDisabled) return; // 버튼 disabled 와 이중 방어
    const finalRoot =
      mode === "auto" ? await ensureDefaultWorkspace(nameValue) : root!;
    // 루트 초기화 정책(git init 등)은 코어가 아니라 project.created 이벤트를
    // 구독하는 플러그인 소유(soksak-plugin-git-init) — 여기선 생성만.
    addProject({
      alias: nameValue, // 비면 makeProject 가 폴더명 폴백
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
                  setRootError(null);
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
            <div className="dpath dpath-err">
              {rootError ?? t("project.folderRequired")}
            </div>
          )}

          <div className="drow">
            <span className="drow-label">
              {mode === "auto" ? t("project.folderName") : t("project.alias")}
            </span>
            <input
              className="dctl"
              type="text"
              value={name}
              placeholder={
                mode === "auto" ? t("project.folderNamePh") : baseName(root)
              }
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {/* 힌트는 실질 정보만: 형식 위반 에러, 자동 모드의 생성 경로.
              직접 선택 모드의 정상 상태는 힌트 없음(설명 과잉 = 노이즈). */}
          {mode === "auto" ? (
            <div
              className={`dpath${nameValue && folderInvalid ? " dpath-err" : ""}`}
            >
              {nameValue && folderInvalid
                ? t("project.folderNameInvalid")
                : t("project.folderNameHint", { name: nameValue || "<폴더명>" })}
            </div>
          ) : null}

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
