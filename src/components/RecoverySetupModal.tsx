import { useEffect, useState } from "react";
import { useVault } from "../state/vault";
import { useOverlayActive } from "../state/ui";
import { useT } from "../i18n";

// 복구코드 셋업 모달 — 암호화를 켜거나(enable) 키·코드를 바꾸면(rotate/changeRecovery) 1회 반환된 복구코드를
// 여기서 딱 한 번 보여준다. 코드는 다시 못 얻으므로, "저장했음" 체크 전엔 Escape·overlay·닫기로 닫히지 않는다
// (게이트). 닫으면 store 의 휘발 코드가 지워진다(메모리 외 잔존 0). store 의 pending 이 곧 열림 상태다.
export function RecoverySetupModal() {
  const t = useT();
  useOverlayActive();
  const open = useVault((s) => s.openModal);
  const pending = useVault((s) => s.pendingCode);
  const close = useVault((s) => s.close);
  const [saved, setSaved] = useState(false);

  const showing = open === "setup" && pending !== null;

  // 새로 뜰 때 게이트 초기화.
  useEffect(() => {
    if (showing) setSaved(false);
  }, [showing]);

  useEffect(() => {
    if (!showing) return;
    const onKey = (e: KeyboardEvent) => {
      // 게이트 — 저장 확인 전엔 Escape 로 닫지 않는다(코드 1회성).
      if (e.key === "Escape") {
        e.stopPropagation();
        if (saved) close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [showing, saved, close]);

  if (!showing) return null;
  return (
    <div className="dmodal-overlay" onMouseDown={() => saved && close()}>
      <div
        className="dmodal-card dconfirm"
        data-node="modal/encrypt-setup"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dconfirm-title">{t("encrypt.setup.title")}</div>
        <div className="plugin-consent-notice">{t("encrypt.setup.desc")}</div>
        <input
          className="dctl dctl-mono"
          readOnly
          value={pending.code}
          data-node="modal/encrypt-setup/code"
          onFocus={(e) => e.currentTarget.select()}
        />
        <label className="dctl dctl-check">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
          />
          <span>{t("encrypt.setup.savedGate")}</span>
        </label>
        <div className="dconfirm-actions">
          <button
            type="button"
            className="dbtn dbtn-acc"
            data-node="modal/encrypt-setup/done"
            disabled={!saved}
            style={!saved ? { opacity: 0.4 } : undefined}
            onClick={() => close()}
          >
            {t("encrypt.setup.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
