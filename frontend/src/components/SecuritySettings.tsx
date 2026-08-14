import { useEffect, useState } from "react";
import { execute } from "../commands/registry";
import { useSessions } from "../state/sessions";
import { useVault } from "../state/vault";
import { useT, type MsgKey } from "../i18n";

// Sealing KEK backend raw value (secrets.rs) → localized label. Unmapped values ("—" while loading,
// and others) are shown verbatim.
const BACKEND_LABEL: Record<string, MsgKey> = {
  keychain: "settings.security.kind.keychain",
  wincred: "settings.security.kind.wincred",
  "secret-service": "settings.security.kind.secretService",
  "os-key": "settings.security.kind.osKey",
  e2e: "settings.security.kind.e2e",
  none: "settings.security.kind.none",
};

// Settings security section — global sealing state (backend and availability, secret.status) and the
// scope-limit notice, plus per-scope management (enable encryption, recover, rotate key, change
// recovery code). Encryption is per scope, so the scope is exposed openly (default = active project
// id, editable). The setup modal shows the recovery code once (vault store); this component never
// holds the code.
export function SecuritySettings() {
  const t = useT();
  const activeId = useSessions((s) => s.activeId);
  const showSetup = useVault((s) => s.showSetup);
  const showEnter = useVault((s) => s.showEnter);
  const [backend, setBackend] = useState("—");
  const [sealAvailable, setSealAvailable] = useState(false);
  const [scope, setScope] = useState(activeId);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const out = await execute("secret.status", {}, { remote: false });
      if (out.ok && out.data) {
        setBackend(String(out.data.backend ?? "—"));
        setSealAvailable(Boolean(out.data.seal_available));
      }
    })();
  }, []);

  // Query per-scope encryption state — null = not queried or query failed (empty scope, and others).
  const refreshScope = async (s: string) => {
    if (!s.trim()) {
      setEnabled(null);
      return;
    }
    const out = await execute("data.encrypt.status", { scope: s.trim() }, { remote: false });
    setEnabled(out.ok && out.data ? Boolean(out.data.enabled) : null);
  };
  useEffect(() => {
    void refreshScope(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // Run a command that requires a scope and return its data (failure = error display + null). Busy gate.
  const call = async (name: string): Promise<Record<string, unknown> | null> => {
    if (busy || !scope.trim()) return null;
    setBusy(true);
    setErr(null);
    try {
      const out = await execute(name, { scope: scope.trim() }, { remote: false });
      if (!out.ok) {
        setErr(out.message);
        return null;
      }
      return out.data ?? {};
    } catch (e) {
      setErr(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const onEnable = async () => {
    const d = await call("data.encrypt.enable");
    if (d) {
      showSetup(String(d.recoveryCode ?? ""), "setup");
      await refreshScope(scope);
    }
  };
  const onRotate = async () => {
    const d = await call("data.encrypt.rotate");
    if (d) showSetup(String(d.recoveryCode ?? ""), "rotate");
  };
  const onChangeRecovery = async () => {
    const d = await call("data.encrypt.changeRecovery");
    if (d) showSetup(String(d.recoveryCode ?? ""), "changeRecovery");
  };

  return (
    <>
      <div className="dsec">{t("settings.security")}</div>
      <div className="drow">
        <span className="drow-label">{t("settings.security.backend")}</span>
        <span className="dctl dctl-static">
          {BACKEND_LABEL[backend] ? t(BACKEND_LABEL[backend]) : backend}
        </span>
      </div>
      <div className="drow">
        <span className="drow-label">{t("settings.security.seal")}</span>
        <span className="dctl dctl-static">
          {sealAvailable ? t("settings.security.sealOn") : t("settings.security.sealOff")}
        </span>
      </div>
      <div className="plugin-consent-notice">{t("settings.security.limits")}</div>
      <div className="drow">
        <span className="drow-label">{t("settings.security.scope")}</span>
        <input
          className="dctl dctl-mono"
          value={scope}
          placeholder={t("settings.security.scopePlaceholder")}
          data-node="settings/security/scope"
          onChange={(e) => setScope(e.target.value)}
        />
      </div>
      <div className="drow">
        <span className="drow-label">{t("settings.security.state")}</span>
        <span className="dctl dctl-static">
          {enabled === null
            ? "—"
            : enabled
              ? t("settings.security.on")
              : t("settings.security.off")}
        </span>
      </div>
      {err && <div className="plugin-consent-notice">{err}</div>}
      <div className="dmodal-actions">
        {enabled === false && (
          <button
            type="button"
            className="dbtn dbtn-acc"
            data-node="settings/security/enable"
            disabled={busy || !scope.trim()}
            style={busy || !scope.trim() ? { opacity: 0.4 } : undefined}
            onClick={() => void onEnable()}
          >
            {t("settings.security.enable")}
          </button>
        )}
        {enabled === true && (
          <>
            <button
              type="button"
              className="dbtn"
              data-node="settings/security/recover"
              disabled={busy}
              onClick={() => showEnter(scope.trim())}
            >
              {t("settings.security.recover")}
            </button>
            <button
              type="button"
              className="dbtn"
              data-node="settings/security/rotate"
              disabled={busy}
              style={busy ? { opacity: 0.4 } : undefined}
              onClick={() => void onRotate()}
            >
              {t("settings.security.rotate")}
            </button>
            <button
              type="button"
              className="dbtn dbtn-danger"
              data-node="settings/security/changeRecovery"
              disabled={busy}
              style={busy ? { opacity: 0.4 } : undefined}
              onClick={() => void onChangeRecovery()}
            >
              {t("settings.security.changeRecovery")}
            </button>
          </>
        )}
      </div>
    </>
  );
}
