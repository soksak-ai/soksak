import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Program } from "../state/sessions";
import { useSuppressBrowser } from "../state/ui";
import { Icon } from "../ui/icons/Icon";
import { useT } from "../i18n";

// 프로그램 선택 메뉴(터미널 / 에이전트▸Claude·Codex / 브라우저). 컨텐츠 + 와 분할 탭바
// + 가 동일하게 사용.
//   - body 포털: 그룹 셀(스태킹 컨텍스트) 안에서 fixed+z-index 는 형제 셀에 덮인다 —
//     포털로 모든 스태킹/클리핑을 벗어나 항상 위.
//   - 닫힘 = 외부 pointerdown(캡처) + Escape. mouseLeave 닫힘은 폐기(스쳐도 닫혀
//     불안정했고, 메뉴에 마우스가 한 번도 안 들어오면 영영 안 닫혔다).
//   - 떠 있는 동안 브라우저 webview 를 숨긴다(네이티브 레이어가 DOM 메뉴를 가리므로).

export function ProgramMenu({
  pos,
  onPick,
  onClose,
}: {
  pos: { left: number; top: number };
  onPick: (program: Program) => void;
  onClose: () => void;
}) {
  const t = useT();
  useSuppressBrowser();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 캡처 단계 — 다른 핸들러의 stopPropagation 에도 닫힘 보장. 메뉴를 연 클릭은
    // 이 effect 부착 전에 끝나므로 즉시 닫힘 없음.
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="ctab-menu"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="ctab-menu-item" onClick={() => onPick("terminal")}>
        {t("program.terminal")}
      </div>
      <div className="ctab-menu-item has-sub">
        <span>{t("program.ai")}</span>
        <span className="ctab-menu-caret icon-inline">
          <Icon name="chevron-right" size="sm" />
        </span>
        <div className="ctab-submenu">
          <div className="ctab-menu-item" onClick={() => onPick("claude")}>
            Claude
          </div>
          <div className="ctab-menu-item" onClick={() => onPick("codex")}>
            Codex
          </div>
        </div>
      </div>
      <div className="ctab-menu-item" onClick={() => onPick("browser")}>
        {t("program.browser")}
      </div>
    </div>,
    document.body,
  );
}
