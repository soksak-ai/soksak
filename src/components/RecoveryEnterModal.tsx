import { useEffect, useState } from "react";
import { useVault } from "../state/vault";
import { useOverlayActive } from "../state/ui";
import { execute } from "../commands/registry";
import { useT } from "../i18n";

// 복구코드 입력 모달 — 다른 기계/OS 로 이관했거나 키체인을 잃었을 때, 보관한 복구코드로 그 scope 의 봉인
// 데이터를 이 기계에서 다시 연다. 코드 검증·저장은 코어(data.encrypt.recover)가 하고 여기선 입력·오류표시만.
// overlay·Escape = 취소(셋업과 달리 게이트 없음 — 입력은 언제든 무해하게 닫힌다).
export function RecoveryEnterModal() {
  const t = useT();
  useOverlayActive();
  const open = useVault((s) => s.openModal);
  const scope = useVault((s) => s.targetScope);
  const close = useVault((s) => s.close);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const showing = open === "enter";

  useEffect(() => {
    if (!showing) return;
    setCode("");
    setErr(null);
  }, [showing]);

  useEffect(() => {
    if (!showing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [showing, close]);

  if (!showing) return null;

  const submit = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const out = await execute(
        "data.encrypt.recover",
        { scope, recoveryCode: code.trim() },
        { remote: false },
      );
      if (!out.ok) {
        setErr(out.message);
        return;
      }
      close();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dmodal-overlay" onMouseDown={close}>
      <div
        className="dmodal-card dconfirm"
        data-node="modal/encrypt-recover"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dconfirm-title">{t("encrypt.recover.title")}</div>
        <div className="plugin-consent-notice">{t("encrypt.recover.desc")}</div>
        <div className="drow">
          <span className="drow-label">{t("encrypt.recover.scope")}</span>
          <span className="dctl dctl-static dctl-mono" title={scope}>
            {scope}
          </span>
        </div>
        <input
          className="dctl dctl-mono"
          value={code}
          placeholder={t("encrypt.recover.placeholder")}
          autoFocus
          data-node="modal/encrypt-recover/code"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
        {err && (
          <div className="plugin-consent-notice" data-node="modal/encrypt-recover/err">
            {err}
          </div>
        )}
        <div className="dconfirm-actions">
          <button type="button" className="dbtn" onClick={close}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="dbtn dbtn-acc"
            data-node="modal/encrypt-recover/submit"
            disabled={busy || !code.trim()}
            style={busy || !code.trim() ? { opacity: 0.4 } : undefined}
            onClick={() => void submit()}
          >
            {t("encrypt.recover.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
