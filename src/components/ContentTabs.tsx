import { useRef, useState } from "react";
import { ProgramMenu } from "./ProgramMenu";
import { useSessions, type Program, type ProjectTab } from "../state/sessions";
import { useT } from "../i18n";

// 컨텐츠 탭 바(3단 구조의 가운데). 한 프로젝트 안의 독립 콘텐츠 영역(분할 그리드)을 전환.
// 1,2,3,… 자동 번호 + 이름변경(더블클릭) + 닫기 + `+` 메뉴(터미널 / 인공지능▸Claude·Codex /
// 브라우저 — 선택한 프로그램으로 새 컨텐츠).

export function ContentTabs({ project }: { project: ProjectTab }) {
  const t = useT();
  const addContent = useSessions((s) => s.addContent);
  const closeContent = useSessions((s) => s.closeContent);
  const setActiveContent = useSessions((s) => s.setActiveContent);
  const renameContent = useSessions((s) => s.renameContent);
  const [editingId, setEditingId] = useState<string | null>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(
    null,
  );

  const commit = (id: string, raw: string, fallback: string) => {
    renameContent(project.id, id, raw.trim() || fallback);
    setEditingId(null);
  };

  const toggleMenu = () => {
    if (menuPos) {
      setMenuPos(null);
      return;
    }
    const r = addBtnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ left: r.left, top: r.bottom + 2 });
  };

  const pick = (program: Program) => {
    addContent(project.id, program);
    setMenuPos(null);
  };

  return (
    <div className="content-tabs">
      {project.contents.map((c) => (
        <div
          key={c.id}
          className={`ctab${c.id === project.activeContentId ? " active" : ""}`}
          onClick={() => setActiveContent(project.id, c.id)}
          onDoubleClick={() => setEditingId(c.id)}
          title={c.title}
        >
          {editingId === c.id ? (
            <input
              className="ctab-rename"
              defaultValue={c.title}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => commit(c.id, e.target.value, c.title)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter")
                  commit(c.id, e.currentTarget.value, c.title);
                else if (e.key === "Escape") setEditingId(null);
              }}
            />
          ) : (
            <span className="ctab-title">{c.title}</span>
          )}
          {project.contents.length > 1 && (
            <button
              type="button"
              className="ctab-close"
              title={t("content.close")}
              onClick={(e) => {
                e.stopPropagation();
                closeContent(project.id, c.id);
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
      <button
        ref={addBtnRef}
        type="button"
        className="ctab-add"
        title={t("content.new")}
        onClick={toggleMenu}
      >
        +
      </button>
      {menuPos && (
        <ProgramMenu
          pos={menuPos}
          onPick={pick}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
}
