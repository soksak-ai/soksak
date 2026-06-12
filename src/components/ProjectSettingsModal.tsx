// 프로젝트 설정 모달 — 생성 시 설정 전부를 관리: 폴더(읽기 전용)·별칭·식별 색·
// 첫 프로그램·셸. 탭/레일 칩 더블클릭으로 연다(인라인 rename 대체).
import { useEffect, useState } from "react";
import { isComposingEnter } from "../lib/imeKeys";
import { useSessions, type Program } from "../state/sessions";
import { useSuppressBrowser } from "../state/ui";
import { Icon } from "../ui/icons/Icon";
import { useT } from "../i18n";
import { useDraggableModal } from "./modalDrag";

// 식별 색 팔레트 — 라이트/다크 양쪽에서 보더·텍스트로 충분한 대비를 갖는 8색.
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

export function ProjectSettingsModal({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const t = useT();
  // 네이티브 브라우저 웹뷰는 항상 DOM 위 — 모달이 떠 있는 동안 숨긴다.
  useSuppressBrowser();
  const project = useSessions((s) => s.tabs.find((x) => x.id === projectId));
  const updateProject = useSessions((s) => s.updateProject);
  const setProjectColor = useSessions((s) => s.setProjectColor);
  const [name, setName] = useState(project?.title ?? "");
  const [program, setProgram] = useState<Program | "">(project?.program ?? "");
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

  const save = () => {
    updateProject(projectId, {
      title: name,
      program: program || null,
      shell: shell.trim() || null,
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
          {/* 폴더는 생성 후 불변(터미널/세션이 그 위에 서 있음) — 읽기 전용 표시. */}
          <div className="drow">
            <span className="drow-label">{t("project.folder")}</span>
            <span className="dctl dctl-static" title={project.root}>
              {project.root ?? "—"}
            </span>
          </div>

          <div className="drow">
            <span className="drow-label">{t("project.alias")}</span>
            <input
              className="dctl"
              type="text"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (isComposingEnter(e)) return; // IME 조합 확정 Enter 는 저장 아님
                if (e.key === "Enter") save();
              }}
            />
          </div>

          <div className="drow">
            <span className="drow-label">{t("project.color")}</span>
            <div className="color-palette">
              {/* 색상은 즉시 적용(미리보기 = 실제) — 저장 버튼과 무관. */}
              <button
                type="button"
                className={`color-swatch color-none${!project.color ? " on" : ""}`}
                title={t("color.default")}
                onClick={() => setProjectColor(projectId, null)}
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
                  onClick={() => setProjectColor(projectId, c)}
                />
              ))}
            </div>
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
