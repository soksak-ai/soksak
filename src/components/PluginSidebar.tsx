// 우측 플러그인 사이드바 — 아이콘 레일(등록된 sidebar-right 뷰들 + ⚙ 관리) + 활성 뷰.
// keep-alive: 한 번 연 뷰는 숨김(display)으로 유지 — 프로젝트별 인스턴스(App.tsx 의
// terminal-pane 안에서 렌더되므로 프로젝트 전환에도 세션 유지, 앱 관례 동일).
// 관리 패널: 설치(git 소스)·동의·활성/비활성·갱신·제거·rejected 사유 — 설정 모달과
// 분리된 플러그인 전용 관리 표면.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { isComposingEnter } from "../lib/imeKeys";
import { Icon } from "../ui/icons/Icon";
import {
  useViewRegistry,
  viewsForPlacement,
} from "../plugins/viewRegistry";
import { usePlugins, type PluginRuntime } from "../state/plugins";
import { useSessions, type ProjectTab } from "../state/sessions";
import { PluginViewHost } from "./PluginViewHost";
import { PluginConsentModal } from "./PluginConsentModal";
import { localize, useT } from "../i18n";

const MANAGER = "manager"; // 예약 키 — 뷰 전역 키는 항상 점을 포함하므로 충돌 없음.

// memo 경계(원칙 2): 다른 프로젝트의 store 쓰기에는 리렌더되지 않는다.
export const PluginSidebar = memo(function PluginSidebar({
  project,
}: {
  project: ProjectTab;
}) {
  const t = useT();
  const version = useViewRegistry((s) => s.version);
  const sidebarViews = useMemo(
    () => viewsForPlacement("sidebar-right"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  const setRightView = useSessions((s) => s.setRightView);
  const rightView = project.rightView;

  // 열렸는데 선택이 없거나 사라진 뷰면: 첫 등록 뷰 → 없으면 관리 패널.
  useEffect(() => {
    if (!project.rightOpen) return;
    const valid =
      rightView === MANAGER || sidebarViews.some((v) => v.key === rightView);
    if (rightView && valid) return;
    setRightView(project.id, sidebarViews[0]?.key ?? MANAGER);
  }, [project.rightOpen, project.id, rightView, sidebarViews, setRightView]);

  // keep-alive: 이 프로젝트에서 한 번 연 뷰 키 누적(등록 해제되면 자연 제외).
  const openedRef = useRef<Set<string>>(new Set());
  if (rightView && rightView !== MANAGER) openedRef.current.add(rightView);
  const opened = [...openedRef.current].filter((k) =>
    sidebarViews.some((v) => v.key === k),
  );

  const activeTitleRaw = sidebarViews.find((v) => v.key === rightView)?.view
    .decl.title;
  const activeTitle =
    rightView === MANAGER
      ? t("plugin.manager")
      : activeTitleRaw
        ? localize(activeTitleRaw)
        : "";

  return (
    <div className="plugin-side">
      <div className="plugin-rail">
        {sidebarViews.map(({ key, view }) => (
          <button
            key={key}
            type="button"
            className={`icon-btn icon-btn--boxed plugin-rail-btn${rightView === key ? " active" : ""}`}
            title={localize(view.decl.title)}
            onClick={() => setRightView(project.id, key)}
          >
            {/* 플러그인 아이콘 = 매니페스트 선언 문자열(외부 계약) — 그대로 표시 */}
            {view.decl.icon}
          </button>
        ))}
        <div className="plugin-rail-spacer" />
        <button
          type="button"
          className={`icon-btn icon-btn--boxed plugin-rail-btn${rightView === MANAGER ? " active" : ""}`}
          title={t("plugin.manager")}
          onClick={() => setRightView(project.id, MANAGER)}
        >
          <Icon name="settings" />
        </button>
      </div>
      <div className="plugin-side-main">
        <div className="plugin-side-head">{activeTitle}</div>
        <div className="plugin-side-body">
          {opened.map((k) => (
            <div
              key={k}
              className="plugin-view-slot"
              style={{ display: rightView === k ? "flex" : "none" }}
            >
              <PluginViewHost
                viewKey={k}
                projectId={project.id}
                root={project.root ?? null}
              />
            </div>
          ))}
          {rightView === MANAGER && <PluginManagerPanel />}
          {rightView !== MANAGER && opened.length === 0 && (
            <div className="plugin-side-empty">
              <div>{t("plugin.empty")}</div>
              <button
                type="button"
                className="dbtn"
                onClick={() => setRightView(project.id, MANAGER)}
              >
                {t("plugin.manager.open")}
              </button>
            </div>
          )}
        </div>
        {/* 하단 스테이터스바 — 터미널 패널(egroup-status)과 같은 시각 언어:
            좌측 컨텍스트(프로젝트 루트), 우측 현재 뷰 제목. */}
        <div className="plugin-side-status">
          <span className="pss-left" title={project.root}>
            {project.root ?? "—"}
          </span>
          <span className="pss-right">{activeTitle}</span>
        </div>
      </div>
    </div>
  );
});

// ── 관리 패널 ────────────────────────────────────────────────────────────────

function statusKey(p: PluginRuntime): "enabled" | "disabled" | "error" {
  return p.status;
}

function PluginManagerPanel() {
  const t = useT();
  const plugins = usePlugins((s) => s.plugins);
  const rejected = usePlugins((s) => s.rejected);
  const [source, setSource] = useState("");
  const [refName, setRefName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [consentFor, setConsentFor] = useState<PluginRuntime | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = (await fn()) as { ok?: boolean; message?: string } | unknown;
      if (r && typeof r === "object" && (r as { ok?: boolean }).ok === false) {
        setMsg((r as { message?: string }).message ?? t("plugin.failed"));
      }
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doInstall = () =>
    run(async () => {
      const s = source.trim();
      if (!s) return { ok: false, message: t("plugin.install.sourceRequired") };
      const r = await usePlugins
        .getState()
        .install(s, refName.trim() || undefined);
      if (r.ok) {
        setSource("");
        setRefName("");
      }
      return r;
    });

  const doEnable = (p: PluginRuntime) =>
    run(async () => {
      const r = await usePlugins.getState().enable(p.manifest.id);
      if (!r.ok && r.code === "CONSENT_REQUIRED") {
        setConsentFor(p);
        return { ok: true }; // 모달로 이어짐 — 패널 에러 표시는 생략
      }
      return r;
    });

  const consentAndEnable = (p: PluginRuntime) =>
    run(async () => {
      usePlugins.getState().grantConsent(p.manifest.id);
      setConsentFor(null);
      return usePlugins.getState().enable(p.manifest.id);
    });

  const list = Object.values(plugins).sort((a, b) =>
    a.manifest.id.localeCompare(b.manifest.id),
  );

  return (
    <div className="plugin-manager">
      <div className="dsec">{t("plugin.install.section")}</div>
      <div className="plugin-install-row">
        <input
          className="plugin-input"
          placeholder={t("plugin.install.sourcePh")}
          value={source}
          disabled={busy}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) =>
            e.key === "Enter" && !isComposingEnter(e) && doInstall()
          }
        />
        <input
          className="plugin-input plugin-input-ref"
          placeholder={t("plugin.install.refPh")}
          value={refName}
          disabled={busy}
          onChange={(e) => setRefName(e.target.value)}
          onKeyDown={(e) =>
            e.key === "Enter" && !isComposingEnter(e) && doInstall()
          }
        />
        <button type="button" className="dbtn" disabled={busy} onClick={doInstall}>
          {t("plugin.install")}
        </button>
      </div>
      {msg && <div className="plugin-msg">{msg}</div>}

      {/* §B7 — 텍스트+아이콘 행은 flex/center 컨테이너가 정렬 소유. */}
      <div className="dsec dsec-row">
        {t("plugin.installed.section")}
        <button
          type="button"
          className="plugin-reload"
          title={t("common.refresh")}
          disabled={busy}
          onClick={() => run(() => usePlugins.getState().reload().then(() => ({ ok: true })))}
        >
          <Icon name="refresh" size="sm" />
        </button>
      </div>
      {list.length === 0 && (
        <div className="plugin-side-empty-sub">{t("plugin.none")}</div>
      )}
      {/* 카드 3행 구조: 타이틀|버전|상태 → 설명(전폭) → 액션. 좁은 사이드바에서
          설명이 액션 칼럼에 짓눌려 한 단어씩 줄바꿈되던 문제 해결. */}
      {list.map((p) => (
        <div key={p.manifest.id} className="plugin-row">
          <div className="plugin-row-title">
            <span className="plugin-row-name">{localize(p.manifest.name)}</span>
            <span className="plugin-row-ver">v{p.manifest.version}</span>
            {p.source === "dev" && <span className="plugin-badge dev">dev</span>}
            <span className={`plugin-badge ${statusKey(p)}`}>
              {t(`plugin.status.${statusKey(p)}`)}
            </span>
          </div>
          <div className="plugin-row-desc">{localize(p.manifest.description)}</div>
          {/* 역할 칩 — 검증된 선언(contributes)에서 기계적 파생(산문 카테고리
              금지: 자유 메타데이터는 검증 불가). 무엇을 추가하는지(메뉴 항목/
              화면/명령/포매터/문법/아이콘)가 한눈에. */}
          {(() => {
            const c = p.manifest.contributes;
            const chips: { key: string; text: string }[] = [];
            for (const pr of c.programs) {
              chips.push({
                key: `prog:${pr.id}`,
                text: `${t("plugin.contrib.program")} ${pr.path ? `${localize(pr.path)} ▸ ` : ""}${localize(pr.title)}`,
              });
            }
            for (const v of c.views) {
              chips.push({
                key: `view:${v.id}`,
                text: `${t("plugin.contrib.view")} ${localize(v.title)}`,
              });
            }
            if (c.commands.length > 0) {
              chips.push({
                key: "cmds",
                text: `${t("plugin.contrib.command")} ${c.commands.length}`,
              });
            }
            for (const f of c.formatters) {
              chips.push({
                key: `fmt:${f.id}`,
                text: `${t("plugin.contrib.formatter")} ${localize(f.title)}`,
              });
            }
            if (c.languages.length > 0) {
              chips.push({
                key: "langs",
                text: `${t("plugin.contrib.language")} ${c.languages.length}`,
              });
            }
            for (const s of c.iconSets) {
              chips.push({
                key: `icons:${s.id}`,
                text: `${t("plugin.contrib.iconSet")} ${localize(s.title)}`,
              });
            }
            return chips.length > 0 ? (
              <div className="plugin-row-contribs">
                {chips.map((ch) => (
                  <span key={ch.key} className="plugin-contrib-chip">
                    {ch.text}
                  </span>
                ))}
              </div>
            ) : null;
          })()}
          {p.error && <div className="plugin-row-err">{p.error}</div>}
          <div className="plugin-row-actions">
            {p.status === "enabled" ? (
              <button
                type="button"
                className="dbtn"
                disabled={busy}
                onClick={() =>
                  run(() => usePlugins.getState().disable(p.manifest.id))
                }
              >
                {t("plugin.disable")}
              </button>
            ) : (
              <button
                type="button"
                className="dbtn dbtn-acc"
                disabled={busy}
                onClick={() => doEnable(p)}
              >
                {t("plugin.enable")}
              </button>
            )}
            {p.source === "installed" && (
              <button
                type="button"
                className="dbtn"
                disabled={busy}
                title={t("plugin.update")}
                onClick={() =>
                  run(() => usePlugins.getState().update(p.manifest.id))
                }
              >
                <Icon name="arrow-up" size="sm" />
              </button>
            )}
            <button
              type="button"
              className="dbtn dbtn-danger"
              disabled={busy}
              title={t("plugin.remove")}
              onClick={() =>
                run(() => usePlugins.getState().remove(p.manifest.id))
              }
            >
              <Icon name="close" size="sm" />
            </button>
          </div>
        </div>
      ))}

      {rejected.length > 0 && (
        <>
          <div className="dsec">{t("plugin.rejected.section")}</div>
          {rejected.map((r) => (
            <div key={r.dir} className="plugin-rejected">
              <div className="plugin-rejected-dir">{r.dir}</div>
              <ul>
                {r.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}

      {consentFor && (
        <PluginConsentModal
          plugin={consentFor}
          onClose={() => setConsentFor(null)}
          onConsent={() => consentAndEnable(consentFor)}
        />
      )}
    </div>
  );
}
