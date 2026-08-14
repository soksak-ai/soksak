import { useEffect, useState } from "react";
import { useVault } from "../state/vault";
import { useOverlayActive } from "../state/ui";
import { execute } from "../commands/registry";
import { useT } from "../i18n";

// Recovery code entry modal — after a move to another machine/OS or a lost keychain, the stored
// recovery code reopens that scope's sealed data on this machine. The core (data.encrypt.recover)
// verifies and stores the code; this component only takes input and shows errors.
// Overlay click and Escape = cancel (no gate, unlike setup — closing input is always harmless).
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
