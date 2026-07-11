// 플러그인 뷰 단일 호스트 — 배치(우측/좌측 사이드바·콘텐츠) 불문 동일 컴포넌트(§0-6).
// provider.mount/unmount 는 try/catch 경계(§0-4): mount 실패는 에러 카드, provider
// 부재(플러그인 비활성/제거)는 플레이스홀더. 잔존 DOM 은 호스트가 정리한다.

import { memo, useEffect, useRef, useState } from "react";
import {
  getRegisteredView,
  useViewRegistry,
  type PluginViewContext,
} from "../plugins/viewRegistry";
import { formatAddress, type Region } from "../commands/address";
import { viewHostAnchors } from "../plugins/viewHostAnchors";
import { registerMountedViewFocus } from "../plugins/viewFocus";
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
  restore = null,
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
  // 복원 seam(B3) — 재시작 복원 마운트면 관찰됐던 런타임(cwd·state). 새 뷰는 미지정(null).
  restore?: { cwd: string | null; state: unknown } | null;
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
  // provider 가 라이브 update 를 구현하면 paneId 변경을 remount 대신 update 로 전달한다(아래 deps 참조).
  const supportsUpdate = typeof reg?.provider.update === "function";

  // 최신 ctx 를 ref 로 보관 — mount/update effect 가 deps 를 늘리지 않고 최신값을 읽는다.
  const ctxRef = useRef<PluginViewContext | null>(null);
  ctxRef.current = {
    projectId,
    root,
    paneId,
    viewId: viewId ?? null,
    command: command ?? null,
    restore: restore ?? null,
    // 이 창의 그 뷰 탭 배지(per-window — 창마다 자체 store). 데이터 변경 시 플러그인이 재계산.
    setBadge: (badge) => useViewRegistry.getState().setViewBadge(viewKey, badge),
    // status 보고(R1) — 콘텐츠 배치(viewId 有)만 sessions view.status 로. 사이드바는 no-op.
    setStatus: (status) =>
      viewId
        ? void useSessions.getState().setViewStatus(projectId, viewId, status)
        : undefined,
    // 탭 제목 동적 갱신 — 콘텐츠 배치(viewId 有)만. 사이드바는 no-op.
    setTitle: (title) =>
      viewId
        ? useSessions.getState().setViewTitle(projectId, viewId, title)
        : undefined,
    // 탭 아이콘(콘텐츠 사실 — 파비콘 등) — 콘텐츠 배치만. 빈 값 = 해제.
    setIcon: (icon) =>
      viewId
        ? useSessions.getState().setViewIcon(projectId, viewId, icon)
        : undefined,
    // 플러그인 관찰 상태(B3) — 뷰 레코드로 영속(뷰와 수명 동기). 콘텐츠 배치만.
    setRestoreState: (state) =>
      viewId
        ? useSessions.getState().setViewRuntime(projectId, viewId, { state })
        : undefined,
  };

  // 구조 mount/unmount. paneId 는 *update 를 구현한 provider 면 deps 에서 제외*(별도 effect 가 푸시) —
  // 탭 전환마다 바뀌는 추종 pane 으로 뷰를 통째 재생성하지 않기 위함. 미구현 provider 는 paneId 를
  // 포함해 기존대로 remount(하위호환). projectId/root/viewKey 등 구조 변경엔 항상 remount.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !reg) return;
    setError(null);
    try {
      reg.provider.mount(el, ctxRef.current!);
    } catch (e) {
      console.error(`플러그인 뷰 mount 실패(${viewKey}):`, e);
      setError(String(e));
      el.replaceChildren(); // 부분 렌더 잔재 제거
      return;
    }
    const unregisterFocus = viewId
      ? registerMountedViewFocus(
          viewId,
          el,
          reg.provider,
          () => ctxRef.current!,
        )
      : null;
    return () => {
      // Abort deferred focus before provider teardown so a stale async mount can
      // never focus after this container has ceased to own the view.
      unregisterFocus?.();
      try {
        reg.provider.unmount?.(el);
      } catch (e) {
        console.error(`플러그인 뷰 unmount 실패(${viewKey}):`, e);
      }
      el.replaceChildren(); // unmount 미구현 provider 대비 — 호스트가 정리 보장
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reg, projectId, root, viewKey, viewId, command, supportsUpdate ? "" : paneId]);

  // paneId 라이브 갱신 — 마운트된 뷰에 새 ctx 푸시(remount 없이). update 미구현이면 위 effect 가
  // paneId 를 deps 에 포함해 remount 하므로 여기선 no-op. mount 직후에도 1회 도나 update 는 멱등.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !reg || !supportsUpdate) return;
    try {
      reg.provider.update!(el, ctxRef.current!);
    } catch (e) {
      console.error(`플러그인 뷰 update 실패(${viewKey}):`, e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, supportsUpdate, reg]);

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
        {...viewHostAnchors(viewAddr, viewId)}
        ref={containerRef}
        style={overlay ? { display: "none" } : undefined}
      />
      {overlay}
    </div>
  );
});
