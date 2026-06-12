// 플러그인 활성화 동의 모달 — §0-2 정직한 고지: 권한 목록(한국어 설명 + 주의 강조),
// 기여 체크리스트(이 플러그인이 추가하는 것 — 실행/설치 명령 원문 포함, 전부
// 매니페스트 선언에서 기계적으로 파생), 전체신뢰(샌드박스 없음) 고지를 보여주고,
// 사람의 명시적 동의만 기록한다(§0-5). 동의 부여는 이 UI 가 유일한 통로.

import { useEffect } from "react";
import {
  PERMISSION_INFO,
  pluginCommandName,
  type ContributedProgram,
} from "../plugins/spec";
import { detectPlatform } from "../plugins/programRegistry";
import type { PluginRuntime } from "../state/plugins";
import { useOverlayActive } from "../state/ui";
import { Icon } from "../ui/icons/Icon";
import { localize, useT } from "../i18n";

// 프로그램 선언 → 동의 화면 한 줄 요약(명령은 원문 그대로 — 산문 가공 금지).
function programSummary(
  p: ContributedProgram,
  t: ReturnType<typeof useT>,
): { text: string; cmds: string[] } {
  const title = localize(p.title);
  const where = p.path ? `${localize(p.path)} ▸ ${title}` : title;
  if (p.kind === "browser") {
    return {
      text: `${where} — ${t("plugin.consent.prog.browser")}${p.url ? `: ${p.url}` : ""}`,
      cmds: [],
    };
  }
  const cmds: string[] = [];
  let text: string;
  if (p.command) {
    text = `${where} — ${t("plugin.consent.prog.run")}`;
    cmds.push(p.command);
  } else {
    text = `${where} — ${t("plugin.consent.prog.bareTerminal")}`;
  }
  const install = p.ensure?.install[detectPlatform()];
  if (install) {
    text += ` · ${t("plugin.consent.prog.install")}`;
    cmds.push(install);
  }
  return { text, cmds };
}

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
  // 오버레이 등록 — 모달이 떠 있는 동안 브라우저 홀의 마우스 통과를 차단한다.
  useOverlayActive();
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
            {t("plugin.consent.title", { name: localize(m.name) })}
          </span>
          <span className="dmodal-spacer" />
          <button
            type="button"
            className="icon-btn dmodal-close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="dmodal-body">
          <div className="plugin-consent-meta">
            {m.id} · v{m.version}
            {m.author ? ` · ${m.author}` : ""}
          </div>
          <div className="plugin-consent-desc">{localize(m.description)}</div>

          <div className="dsec">{t("plugin.consent.permissions")}</div>
          {m.permissions.length === 0 ? (
            <div className="plugin-consent-none">
              {t("plugin.consent.noPermissions")}
            </div>
          ) : (
            <ul className="plugin-consent-list">
              {m.permissions.map((p) => {
                const base = PERMISSION_INFO[p];
                // "programs" 는 선언 기반 동적 고지 — 이 매니페스트가 실제로
                // 하는 것만 말한다(메뉴 등록만 / 명령 실행 / 설치까지). 권한의
                // 최대 능력을 일률 경고하면 과잉 고지 = 경고 피로(§0-2 위반).
                let info: { label: string; detail: string; caution?: true } =
                  base;
                if (p === "programs") {
                  const progs = m.contributes.programs;
                  const runs = progs.some(
                    (x) => x.kind === "terminal" && (x.command || x.ensure),
                  );
                  const installs = progs.some((x) => x.ensure);
                  info = {
                    label: base.label,
                    detail: installs
                      ? t("perm.programs.runInstall")
                      : runs
                        ? t("perm.programs.run")
                        : t("perm.programs.menuOnly"),
                    ...(runs || installs ? { caution: true as const } : {}),
                  };
                }
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

          {/* 기여 체크리스트 — 매니페스트 선언에서 기계적으로 파생(산문 0).
              명령/뷰/프로그램/포매터가 무엇이 추가되는지, 어떤 명령이 실행되는지
              원문 그대로. 비활성화·제거 시 전부 자동 회수됨을 고지. */}
          <div className="dsec">{t("plugin.consent.contributes")}</div>
          {(() => {
            const c = m.contributes;
            const rows: { key: string; text: string; cmds?: string[] }[] = [];
            for (const p of c.programs) {
              const s = programSummary(p, t);
              rows.push({
                key: `prog:${p.id}`,
                text: `${t("plugin.consent.kind.program")} — ${s.text}`,
                cmds: s.cmds,
              });
            }
            for (const v of c.views) {
              rows.push({
                key: `view:${v.id}`,
                text: `${t("plugin.consent.kind.view")} — ${localize(v.title)} (${v.placements.join(", ")})`,
              });
            }
            for (const cmd of c.commands) {
              rows.push({
                key: `cmd:${cmd.name}`,
                text: `${t("plugin.consent.kind.command")} — ${pluginCommandName(m.id, cmd.name)}: ${localize(cmd.title)}`,
              });
            }
            for (const f of c.formatters) {
              rows.push({
                key: `fmt:${f.id}`,
                text: `${t("plugin.consent.kind.formatter")} — ${localize(f.title)} (.${f.languages.join(" .")})`,
              });
            }
            for (const l of c.languages) {
              rows.push({
                key: `lang:${l.ext}`,
                text: `${t("plugin.consent.kind.language")} — .${l.ext} → ${l.lang}`,
              });
            }
            for (const s of c.iconSets) {
              rows.push({
                key: `icons:${s.id}`,
                text: `${t("plugin.consent.kind.iconSet")} — ${localize(s.title)}`,
              });
            }
            return rows.length === 0 ? (
              <div className="plugin-consent-none">
                {t("plugin.consent.noContributes")}
              </div>
            ) : (
              <>
                <ul className="plugin-consent-list">
                  {rows.map((r) => (
                    <li key={r.key} className="plugin-consent-item">
                      <span className="plugin-consent-detail">{r.text}</span>
                      {r.cmds?.map((cmd) => (
                        <code key={cmd} className="plugin-consent-cmd">
                          {cmd}
                        </code>
                      ))}
                    </li>
                  ))}
                </ul>
                <div className="plugin-consent-revoke">
                  {t("plugin.consent.revokeNote")}
                </div>
              </>
            );
          })()}

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
