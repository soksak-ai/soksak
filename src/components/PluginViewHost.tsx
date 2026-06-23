// 플러그인 뷰 단일 호스트 — 배치(우측/좌측 사이드바·콘텐츠) 불문 동일 컴포넌트(§0-6).
// provider.mount/unmount 는 try/catch 경계(§0-4): mount 실패는 에러 카드, provider
// 부재(플러그인 비활성/제거)는 플레이스홀더. 잔존 DOM 은 호스트가 정리한다.

import { memo, useEffect, useRef, useState } from "react";
import {
  getRegisteredView,
  useViewRegistry,
} from "../plugins/viewRegistry";
import { formatAddress, type Region } from "../commands/address";
import { useSessions } from "../state/sessions";
import { useT } from "../i18n";

// memo 경계(원칙 2).
export const PluginViewHost = memo(function PluginViewHost({
  viewKey,
  projectId,
  root,
  region,
  paneId = null,
  viewId = null,
  command = null,
}: {
  viewKey: string; // "<pluginId>.<viewId>"
  projectId: string;
  root: string | null;
  region: Region; // left|content|right — 컨테이너 절대 주소의 영역 세그먼트
  // 이 뷰가 추종할 터미널 pane(cwd 추종 대상). 미지정=null(계약 A13/S7). 사이드바 호스트가 cwdPaneOf 전달.
  paneId?: string | null;
  // 콘텐츠 배치면 sessions view.id(status 보고 대상), 사이드바면 null(close guard 무관 → setStatus no-op).
  viewId?: string | null;
  // 이 뷰가 마운트 시 받을 자동 실행 명령(에이전트 프로그램 — 터미널 뷰가 PTY 로 실행). 없으면 null.
  command?: string | null;
}) {
  // 이 뷰 컨테이너의 절대 주소(노드 스캔의 baseAddress). project 는 경로(슬래시 충돌)라 활성 기준 생략 —
  // <region>/view/<viewKey>. win 생략=현재 창. 안정 세그먼트(region·qualifiedViewId)라 멱등. ui.tree 가 읽는다.
  const viewAddr = formatAddress({ region, view: viewKey });
  const t = useT();
  // version 구독 → 등록/해제 시 재평가. RegisteredView 객체는 변경 없으면 동일 참조
  // (zustand spread) — 무관한 version 증가로는 remount 되지 않는다.
  useViewRegistry((s) => s.version);
  const reg = getRegisteredView(viewKey);
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !reg) return;
    setError(null);
    try {
      reg.provider.mount(el, {
        projectId,
        root,
        paneId,
        viewId: viewId ?? null,
        command: command ?? null,
        // 이 창의 그 뷰 탭 배지(per-window — 창마다 자체 store). 데이터 변경 시 플러그인이 재계산.
        setBadge: (badge) =>
          useViewRegistry.getState().setViewBadge(viewKey, badge),
        // status 보고(R1) — 콘텐츠 배치(viewId 有)만 sessions view.status 로. 사이드바는 no-op.
        setStatus: (status) =>
          viewId
            ? void useSessions
                .getState()
                .setViewStatus(projectId, viewId, status)
            : undefined,
        // 탭 제목 동적 갱신 — 콘텐츠 배치(viewId 有)만. 사이드바는 no-op.
        setTitle: (title) =>
          viewId
            ? useSessions.getState().setViewTitle(projectId, viewId, title)
            : undefined,
      });
    } catch (e) {
      console.error(`플러그인 뷰 mount 실패(${viewKey}):`, e);
      setError(String(e));
      el.replaceChildren(); // 부분 렌더 잔재 제거
      return;
    }
    return () => {
      try {
        reg.provider.unmount?.(el);
      } catch (e) {
        console.error(`플러그인 뷰 unmount 실패(${viewKey}):`, e);
      }
      el.replaceChildren(); // unmount 미구현 provider 대비 — 호스트가 정리 보장
    };
  }, [reg, projectId, root, paneId, viewKey, viewId, command]);

  // 컨테이너는 항상 렌더(ref 유지) — 에러/부재는 위에 겹쳐 보여 재등록 시 복구 가능.
  const overlay = !reg ? (
    <div className="plugin-view-empty">{t("plugin.view.missing")}</div>
  ) : error ? (
    <div className="plugin-view-error">
      <div className="plugin-view-error-title">{t("plugin.view.error")}</div>
      <div className="plugin-view-error-msg">{error}</div>
    </div>
  ) : null;

  return (
    <div className="plugin-view-host">
      <div
        className={`plugin-view-container${reg?.decl.transparent ? " transparent" : ""}`}
        data-view-addr={viewAddr}
        ref={containerRef}
        style={overlay ? { display: "none" } : undefined}
      />
      {overlay}
    </div>
  );
});
