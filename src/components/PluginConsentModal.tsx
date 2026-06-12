// 플러그인 활성화 동의 모달 — §0-2 정직한 고지: 권한 목록(한국어 설명 + 주의 강조)과
// 전체신뢰(샌드박스 없음) 고지를 보여주고, 사람의 명시적 동의만 기록한다(§0-5).
// 동의 부여는 이 UI 가 유일한 통로 — 원격 명령은 존재하지 않는다.

import { useEffect } from "react";
import { PERMISSION_INFO } from "../plugins/spec";
import type { PluginRuntime } from "../state/plugins";
import { useT } from "../i18n";

export function PluginConsentModal({
  plugin,
  onConsent,
  onClose,
}: {
  plugin: PluginRuntime;
  onConsent: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const m = plugin.manifest;

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

  return (
    <div className="dmodal-overlay" onMouseDown={onClose}>
      <div
        className="dmodal-card plugin-consent-card"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dmodal-head">
          <span className="dmodal-title">
            {t("plugin.consent.title", { name: m.name })}
          </span>
          <span className="dmodal-spacer" />
          <button type="button" className="dmodal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="dmodal-body">
          <div className="plugin-consent-meta">
            {m.id} · v{m.version}
            {m.author ? ` · ${m.author}` : ""}
          </div>
          <div className="plugin-consent-desc">{m.description}</div>

          <div className="dsec">{t("plugin.consent.permissions")}</div>
          {m.permissions.length === 0 ? (
            <div className="plugin-consent-none">
              {t("plugin.consent.noPermissions")}
            </div>
          ) : (
            <ul className="plugin-consent-list">
              {m.permissions.map((p) => {
                const info = PERMISSION_INFO[p];
                return (
                  <li
                    key={p}
                    className={`plugin-consent-item${info.caution ? " caution" : ""}`}
                  >
                    <span className="plugin-consent-label">
                      {info.caution ? "⚠ " : ""}
                      {info.label}
                    </span>
                    <span className="plugin-consent-detail">{info.detail}</span>
                  </li>
                );
              })}
            </ul>
          )}

          {/* 전체신뢰 고지(§0-2) — 권한은 격리가 아님을 그대로 말한다. */}
          <div className="plugin-consent-notice">{t("plugin.consent.notice")}</div>

          <div className="plugin-consent-actions">
            <button type="button" className="dbtn" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button type="button" className="dbtn dbtn-acc" onClick={onConsent}>
              {t("plugin.consent.agree")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
