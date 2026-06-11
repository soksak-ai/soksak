import { useRef, useState } from "react";
import { useSessions, type Program, type ProjectTab } from "../state/sessions";
import { useUi } from "../state/ui";
import { useT } from "../i18n";

// 컨텐츠 탭 바(3단 구조의 가운데). 한 프로젝트 안의 독립 콘텐츠 영역(분할 그리드)을 전환.
// 1,2,3,… 자동 번호 + 이름변경(더블클릭) + 닫기 + `+` 메뉴(터미널 / 인공지능▸claude·codex /
// 브라우저 — 선택한 프로그램으로 새 컨텐츠).

export function ContentTabs({ project }: { project: ProjectTab }) {
  const t = useT();
  const addContent = useSessions((s) => s.addContent);
  const closeContent = useSessions((s) => s.closeContent);
  const setActiveContent = useSessions((s) => s.setActiveContent);
  const renameContent = useSessions((s) => s.renameContent);
  const suppressBrowser = useUi((s) => s.suppressBrowser);
  const releaseBrowser = useUi((s) => s.releaseBrowser);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // 메뉴는 fixed 로 띄운다 — 탭 바의 overflow-x:auto 가 absolute 드롭다운을 클리핑하므로.
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });

  const commit = (id: string, raw: string, fallback: string) => {
    renameContent(project.id, id, raw.trim() || fallback);
    setEditingId(null);
  };

  // 메뉴는 DOM 오버레이 — 아래 브라우저 webview 에 가리지 않게 열린 동안 숨김.
  const setMenu = (open: boolean) => {
    if (open) {
      const r = addBtnRef.current?.getBoundingClientRect();
      if (r) setMenuPos({ left: r.left, top: r.bottom + 2 });
    }
    setMenuOpen((cur) => {
      if (cur === open) return cur;
      if (open) suppressBrowser();
      else releaseBrowser();
      return open;
    });
  };

  const pick = (program: Program) => {
    addContent(project.id, program);
    setMenu(false);
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
      <div className="ctab-add-wrap">
        <button
          ref={addBtnRef}
          type="button"
          className="ctab-add"
          title={t("content.new")}
          onClick={() => setMenu(!menuOpen)}
        >
          +
        </button>
        {menuOpen && (
          <div
            className="ctab-menu"
            style={{ left: menuPos.left, top: menuPos.top }}
            onMouseLeave={() => setMenu(false)}
          >
            <div className="ctab-menu-item" onClick={() => pick("terminal")}>
              {t("program.terminal")}
            </div>
            <div className="ctab-menu-item has-sub">
              <span>{t("program.ai")}</span>
              <span className="ctab-menu-caret">▸</span>
              <div className="ctab-submenu">
                <div className="ctab-menu-item" onClick={() => pick("claude")}>
                  Claude
                </div>
                <div className="ctab-menu-item" onClick={() => pick("codex")}>
                  Codex
                </div>
              </div>
            </div>
            <div className="ctab-menu-item" onClick={() => pick("browser")}>
              {t("program.browser")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
