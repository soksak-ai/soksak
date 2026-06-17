// 플러그인 뷰 단일 호스트 — 배치(우측/좌측 사이드바·콘텐츠) 불문 동일 컴포넌트(§0-6).
// provider.mount/unmount 는 try/catch 경계(§0-4): mount 실패는 에러 카드, provider
// 부재(플러그인 비활성/제거)는 플레이스홀더. 잔존 DOM 은 호스트가 정리한다.

import { memo, useEffect, useRef, useState } from "react";
import {
  getRegisteredView,
  useViewRegistry,
} from "../plugins/viewRegistry";
import { useT } from "../i18n";

// memo 경계(원칙 2).
export const PluginViewHost = memo(function PluginViewHost({
  viewKey,
  projectId,
  root,
}: {
  viewKey: string; // "<pluginId>.<viewId>"
  projectId: string;
  root: string | null;
}) {
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
        // 이 창의 그 뷰 탭 배지(per-window — 창마다 자체 store). 데이터 변경 시 플러그인이 재계산.
        setBadge: (badge) =>
          useViewRegistry.getState().setViewBadge(viewKey, badge),
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
  }, [reg, projectId, root, viewKey]);

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
        className="plugin-view-container"
        ref={containerRef}
        style={overlay ? { display: "none" } : undefined}
      />
      {overlay}
    </div>
  );
});
