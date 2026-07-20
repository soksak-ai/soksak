import { useEffect, useState } from "react";
import { execute } from "../commands/registry";
import { useSessions } from "../state/sessions";
import { useVault } from "../state/vault";
import { useT } from "../i18n";

// 설정 보안 섹션 — 전역 봉인 상태(백엔드·가용, secret.status)와 범위 한계 고지 + scope 단위 관리(암호화
// 켜기·복구·키 회전·복구코드 변경). 암호화는 scope 단위라 scope 를 투명하게 노출한다(기본값=활성 프로젝트
// id, 편집 가능). 복구코드는 셋업 모달이 1회 표시하고(vault store) 이 컴포넌트는 코드를 쥐지 않는다.
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

  // scope 단위 암호화 여부 조회 — null = 미조회/조회 실패(빈 scope 등).
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

  // scope 를 요구하는 명령을 실행하고 반환 data 를 준다(실패=오류표시+null). busy 게이트.
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
        <span className="dctl dctl-static dctl-mono">{backend}</span>
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
              disabled={busy}
              onClick={() => showEnter(scope.trim())}
            >
              {t("settings.security.recover")}
            </button>
            <button
              type="button"
              className="dbtn"
              disabled={busy}
              style={busy ? { opacity: 0.4 } : undefined}
              onClick={() => void onRotate()}
            >
              {t("settings.security.rotate")}
            </button>
            <button
              type="button"
              className="dbtn dbtn-danger"
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
