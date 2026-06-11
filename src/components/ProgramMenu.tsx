import { useEffect } from "react";
import type { Program } from "../state/sessions";
import { useUi } from "../state/ui";
import { useT } from "../i18n";

// 프로그램 선택 메뉴(터미널 / 에이전트▸Claude·Codex / 브라우저). 컨텐츠 + 와 분할 탭바
// + 가 동일하게 사용. fixed — overflow 클리핑/스태킹과 무관하게 항상 위(좌표는 호출측).
// 떠 있는 동안 브라우저 webview 를 숨긴다(네이티브 레이어가 DOM 메뉴를 가리므로) —
// suppress/release 는 마운트/언마운트에 묶어 누수가 없다.

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
  const suppressBrowser = useUi((s) => s.suppressBrowser);
  const releaseBrowser = useUi((s) => s.releaseBrowser);

  useEffect(() => {
    suppressBrowser();
    return () => releaseBrowser();
  }, [suppressBrowser, releaseBrowser]);

  return (
    <div
      className="ctab-menu"
      style={{ left: pos.left, top: pos.top }}
      onMouseLeave={onClose}
    >
      <div className="ctab-menu-item" onClick={() => onPick("terminal")}>
        {t("program.terminal")}
      </div>
      <div className="ctab-menu-item has-sub">
        <span>{t("program.ai")}</span>
        <span className="ctab-menu-caret">▸</span>
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
    </div>
  );
}
