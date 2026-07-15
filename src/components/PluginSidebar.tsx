// 우측 플러그인 사이드바 — 아이콘 레일(등록된 sidebar-right 뷰들 + ⚙ 관리) + 활성 뷰.
// keep-alive: 한 번 연 뷰는 숨김(display)으로 유지 — 프로젝트별 인스턴스(App.tsx 의
// terminal-pane 안에서 렌더되므로 프로젝트 전환에도 세션 유지, 앱 관례 동일).
// 관리 패널: 인증된 release 설치·동의·활성/비활성·갱신·제거·rejected 사유 — 설정 모달과
// 분리된 플러그인 전용 관리 표면.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../ui/icons/Icon";
import {
  useViewRegistry,
  viewsForPlacement,
} from "../plugins/viewRegistry";
import { usePlugins, type PluginRuntime } from "../state/plugins";
import { useRegistry } from "../state/registry";
import { installState, type RegistryEntry } from "../plugins/registry";
import { useSessions } from "../state/sessions";
import { useSettings } from "../state/settings";
import { useUi } from "../state/ui";
import { PluginViewHost } from "./PluginViewHost";
import { ViewBadge } from "./ViewBadge";
import { PluginConsentModal } from "./PluginConsentModal";
import { localize, useT } from "../i18n";
import { execute } from "../commands/registry";

const MANAGER = "manager"; // 예약 키 — 뷰 전역 키는 항상 점을 포함하므로 충돌 없음.

// memo 경계(원칙 2·3): 프로젝트 식별자만 받고 *자기가 쓰는 필드*(rightView/rightOpen/root)를
// 셀렉터로 구독한다 — project 객체 전체를 prop 으로 받으면 activeContentId 같은 무관 필드 변경(탭
// 전환)에도 정체성이 바뀌어 리렌더된다. 슬라이스 구독이면 그 필드가 실제 바뀔 때만 리렌더된다.
export const PluginSidebar = memo(function PluginSidebar({
  projectId,
}: {
  projectId: string;
}) {
  const t = useT();
  const version = useViewRegistry((s) => s.version);
  const sidebarViews = useMemo(
    () => viewsForPlacement("sidebar-right"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  const setRightView = useSessions((s) => s.setRightView);
  const rightView = useSessions(
    (s) => s.tabs.find((x) => x.id === projectId)?.rightView,
  );
  const rightOpen = useSessions(
    (s) => s.tabs.find((x) => x.id === projectId)?.rightOpen ?? false,
  );
  const root = useSessions((s) => s.tabs.find((x) => x.id === projectId)?.root);
  const rightMode = useSettings((s) => s.rightSidebarMode);
  const setRightMode = useSettings((s) => s.setRightSidebarMode);

  // 열렸는데 선택이 없거나 사라진 뷰면: 첫 등록 뷰 → 없으면 관리 패널.
  useEffect(() => {
    if (!rightOpen) return;
    const valid =
      rightView === MANAGER || sidebarViews.some((v) => v.key === rightView);
    if (rightView && valid) return;
    setRightView(projectId, sidebarViews[0]?.key ?? MANAGER);
  }, [rightOpen, projectId, rightView, sidebarViews, setRightView]);

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
            onClick={() => setRightView(projectId, key)}
          >
            {/* 플러그인 아이콘 = 매니페스트 선언 문자열(외부 계약) — 그대로 표시 */}
            {view.decl.icon}
            <ViewBadge viewKey={key} />
          </button>
        ))}
        <div className="plugin-rail-spacer" />
        {/* 밀기 — 우측 사이드바를 overlay ↔ push(영역 차지) 전환. 설정 버튼 바로 위. */}
        <button
          type="button"
          className={`icon-btn icon-btn--boxed plugin-rail-btn${rightMode === "push" ? " active" : ""}`}
          title={rightMode === "push" ? t("plugin.sidebar.overlay") : t("plugin.sidebar.push")}
          data-node="plugin-sidebar-push"
          onClick={() =>
            setRightMode(rightMode === "push" ? "overlay" : "push")
          }
        >
          <Icon name="panel-right" />
        </button>
        <button
          type="button"
          className={`icon-btn icon-btn--boxed plugin-rail-btn${rightView === MANAGER ? " active" : ""}`}
          title={t("plugin.manager")}
          data-node="plugin-manager-tab"
          onClick={() => setRightView(projectId, MANAGER)}
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
                projectId={projectId}
                root={root ?? null}
                region="right"
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
                onClick={() => setRightView(projectId, MANAGER)}
              >
                {t("plugin.manager.open")}
              </button>
            </div>
          )}
        </div>
        {/* 하단 스테이터스바 — 터미널 패널(egroup-status)과 같은 시각 언어:
            좌측 컨텍스트(프로젝트 루트), 우측 현재 뷰 제목. */}
        <div className="plugin-side-status">
          <span className="pss-left" title={root}>
            {root ?? "—"}
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

// 설치 가능 목록은 인증된 release reference만 표시한다. 이름·설명·명령은 설치된 owner
// manifest가 제공하며 registry가 복제하지 않는다.
function RegistrySection({
  busy,
  run,
  installed,
}: {
  busy: boolean;
  run: (fn: () => Promise<unknown>) => void;
  installed: Record<string, PluginRuntime>;
}) {
  const t = useT();
  const entries = useRegistry((s) => s.entries);
  const status = useRegistry((s) => s.status);
  const sorted = useMemo(
    () => [...entries].sort((a, b) => a.id.localeCompare(b.id)),
    [entries],
  );

  const stateOf = (e: RegistryEntry) =>
    installState(e, installed[e.id]?.manifest.version, installed[e.id]?.source);
  const doInstall = (e: RegistryEntry) =>
    run(() => execute("plugin.install", {
      registryId: e.registryId,
      unitId: e.unitId,
    }, {}));
  const doUpdate = (e: RegistryEntry) =>
    doInstall(e);

  return (
    <>
      <div className="dsec dsec-row">
        {t("plugin.registry.section")}
        <button
          type="button"
          className="plugin-reload"
          title={t("common.refresh")}
          disabled={busy || status === "fetching"}
          onClick={() => useRegistry.getState().refresh(true)}
        >
          <Icon name="refresh" size="sm" />
        </button>
      </div>
      {/* 이미 설치+최신(installed)은 "설치됨" 섹션에만 — 여기선 미설치(available)·업데이트(update)만
          보여 같은 플러그인이 양쪽에 2개씩 뜨는 것을 구조적으로 막는다. */}
      {(() => {
        const actionable = sorted.filter((e) => stateOf(e) !== "installed");
        if (actionable.length === 0) {
          return <div className="plugin-side-empty-sub">{t("plugin.registry.allInstalled")}</div>;
        }
        return actionable.map((e) => {
          const st = stateOf(e);
          return (
            <div key={e.id} className="plugin-row">
              <div className="plugin-row-title">
                <span className="plugin-row-name">{e.id}</span>
                <span className="plugin-row-ver">v{e.version}</span>
              </div>
              <div className="plugin-row-desc">{e.manifest.url}</div>
              <div className="plugin-row-actions">
                {st === "available" && (
                  <button type="button" className="dbtn dbtn-acc" disabled={busy} onClick={() => doInstall(e)}>
                    {t("plugin.install")}
                  </button>
                )}
                {st === "update" && (
                  <button type="button" className="dbtn" disabled={busy} onClick={() => doUpdate(e)}>
                    {t("plugin.registry.update")}
                  </button>
                )}
              </div>
            </div>
          );
        });
      })()}
    </>
  );
}

function PluginManagerPanel() {
  const t = useT();
  const plugins = usePlugins((s) => s.plugins);
  const rejected = usePlugins((s) => s.rejected);
  // 설치본 출처 구분(공식/수동) — 레지스트리 등재 id 집합. entries 가 바뀔 때만 재계산.
  const registryEntries = useRegistry((s) => s.entries);
  const officialIds = useMemo(
    () => new Set(registryEntries.map((e) => e.id)),
    [registryEntries],
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // 동의 큐 — 종속이 강력한 권한을 가지므로, 활성화에 필요한 미동의 체인(종속 먼저)을 큐로 받아
  // 동의 팝업을 연속으로 띄운다(반쪽 동의 금지). queue[0] 가 현재 팝업. pendingEnableId = 전부 동의 후
  // 활성화할 원래 대상(cascade).
  const [consentQueue, setConsentQueue] = useState<PluginRuntime[]>([]);
  const [pendingEnableId, setPendingEnableId] = useState<string | null>(null);
  const consentFor = consentQueue[0] ?? null;
  // 카드 클릭 = 검사 전용 상세 모달(동의 화면과 같은 권한·설명 정보, 동의 버튼 없음). 활성화와 무관.
  const [previewFor, setPreviewFor] = useState<PluginRuntime | null>(null);

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

  const doEnable = (p: PluginRuntime) =>
    run(async () => {
      const r = await usePlugins.getState().enable(p.manifest.id);
      if (!r.ok && r.code === "CONSENT_REQUIRED") {
        // 미동의 체인(종속 먼저)을 큐로 — 종속부터 연속 팝업. 체인 없으면 자신만.
        const chain =
          (r.data as { pendingConsent?: string[] } | undefined)?.pendingConsent ??
          [p.manifest.id];
        const all = usePlugins.getState().plugins;
        const queue = chain.map((id) => all[id]).filter(Boolean) as PluginRuntime[];
        setConsentQueue(queue.length ? queue : [p]);
        setPendingEnableId(p.manifest.id);
        return { ok: true }; // 모달로 이어짐 — 패널 에러 표시는 생략
      }
      return r;
    });

  // 현재 팝업 동의 → 큐에서 제거. 남으면 다음 팝업, 비면 원래 대상 활성화(cascade — 종속부터).
  const consentNext = () =>
    run(async () => {
      const [cur, ...rest] = consentQueue;
      if (!cur) return { ok: true };
      usePlugins.getState().grantConsent(cur.manifest.id);
      if (rest.length > 0) {
        setConsentQueue(rest);
        return { ok: true }; // 다음 종속/플러그인 동의 팝업
      }
      setConsentQueue([]);
      const target = pendingEnableId;
      setPendingEnableId(null);
      return target ? usePlugins.getState().enable(target) : { ok: true };
    });

  const cancelConsent = () => {
    setConsentQueue([]);
    setPendingEnableId(null);
  };

  const list = Object.values(plugins).sort((a, b) =>
    a.manifest.id.localeCompare(b.manifest.id),
  );

  return (
    <div className="plugin-manager">
      {msg && <div className="plugin-msg">{msg}</div>}

      <RegistrySection busy={busy} run={run} installed={plugins} />

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
        <div
          key={p.manifest.id}
          className="plugin-row"
          role="button"
          tabIndex={0}
          style={{ cursor: "pointer" }}
          title={t("plugin.detail.open")}
          data-node={`plugin/${p.manifest.id}/card`}
          onClick={() => setPreviewFor(p)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setPreviewFor(p);
            }
          }}
        >
          <div className="plugin-row-title">
            <span className="plugin-row-name">{localize(p.manifest.name)}</span>
            <span className="plugin-row-ver">v{p.manifest.version}</span>
            {p.source === "dev" && <span className="plugin-badge dev">dev</span>}
            {/* 출처: 공식 레지스트리 등재 vs 수동/서드파티(미등재). dev·template 은 별 배지라 제외. */}
            {p.source !== "dev" && !p.manifest.template && (
              <span
                className={`plugin-badge ${officialIds.has(p.manifest.id) ? "official" : "manual"}`}
              >
                {t(officialIds.has(p.manifest.id) ? "plugin.source.official" : "plugin.source.manual")}
              </span>
            )}
            {p.manifest.template ? (
              <span className="plugin-badge template">{t("plugin.template")}</span>
            ) : (
              <span className={`plugin-badge ${statusKey(p)}`}>
                {t(`plugin.status.${statusKey(p)}`)}
              </span>
            )}
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
            for (const s of c.iconSets) {
              chips.push({
                key: `icons:${s.id}`,
                text: `${t("plugin.contrib.iconSet")} ${localize(s.title)}`,
              });
            }
            for (const ev of c.events) {
              chips.push({ key: `event:${ev}`, text: `${t("plugin.contrib.event")} ${ev}` });
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
          {/* 액션 버튼은 카드 클릭(상세 모달)과 분리 — 버블 차단. */}
          <div className="plugin-row-actions" onClick={(e) => e.stopPropagation()}>
            {p.manifest.template ? (
              // 템플릿(읽기 전용) — 활성화 토글 없음. 상세(설명·기여 칩)는 위에 그대로 노출.
              <span className="plugin-row-note">{t("plugin.template.note")}</span>
            ) : p.status === "enabled" ? (
              <button
                type="button"
                className="dbtn"
                data-node={`plugin/${p.manifest.id}/disable`}
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
                data-node={`plugin/${p.manifest.id}/enable`}
                disabled={busy}
                onClick={() => doEnable(p)}
              >
                {t("plugin.enable")}
              </button>
            )}
            {/* 설정 바로가기 — configuration 선언 + 활성 시. 통합 설정 모달의 그 플러그인 패널로 딥링크. */}
            {p.status === "enabled" && (p.manifest.configuration?.length ?? 0) > 0 ? (
              <button
                type="button"
                className="dbtn"
                onClick={() => useUi.getState().setSettingsSection(p.manifest.id)}
              >
                {t("plugin.settings")}
              </button>
            ) : null}
            {/* 갱신(↑)·제거(✕) 제거 — 전체 둘러보기(재설치 경로)가 없으므로 삭제는
                무의미하고 갱신도 불필요. 활성/비활성 토글만 둔다. */}
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
          step={
            consentQueue.length > 1 || consentFor.manifest.id !== pendingEnableId
              ? {
                  isDependency: consentFor.manifest.id !== pendingEnableId,
                  remaining: consentQueue.length,
                  ofId: pendingEnableId ?? undefined,
                }
              : undefined
          }
          onClose={cancelConsent}
          onConsent={consentNext}
        />
      )}

      {/* 카드 클릭 = 검사 전용 상세(권한·설명·접근 정보). 동의 흐름과 분리 — 동의 팝업이 떠 있으면 양보. */}
      {previewFor && !consentFor && (
        <PluginConsentModal
          plugin={previewFor}
          preview
          onClose={() => setPreviewFor(null)}
          onConsent={() => setPreviewFor(null)}
        />
      )}
    </div>
  );
}
