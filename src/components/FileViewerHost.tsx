// 파일 콘텐츠 호스트 — kind:"file" 뷰를 등록된 파일 뷰어 플러그인에 라우팅(계약 A1/A13).
// resolveFileViewer(path) 로 확장자 매칭 provider 를 찾아 마운트한다. 코어는 렌더 엔진을 모른다 —
// 콘텐츠 슬롯만 제공(PluginViewHost 와 동형). 매칭 뷰어가 없으면 빈 상태(순수 스켈레톤 — 플러그인 미설치).
// setDirty 는 코어 탭(미저장 표시)에 보고하는 유일한 역채널.

import { memo, useEffect, useRef, useState } from "react";
import {
  resolveFileViewer,
  useFileViewerRegistry,
} from "../plugins/fileViewerRegistry";
import { useSessions } from "../state/sessions";
import { useT } from "../i18n";

// memo 경계(원칙 2).
export const FileViewerHost = memo(function FileViewerHost({
  path,
  projectId,
  root,
  viewId,
}: {
  path: string;
  projectId: string;
  root: string | null;
  viewId: string;
}) {
  const t = useT();
  // version 구독 → 파일 뷰어 등록/해제(플러그인 활성/비활성) 시 재평가·재마운트.
  useFileViewerRegistry((s) => s.version);
  const reg = resolveFileViewer(path);
  const setFileDirty = useSessions((s) => s.setFileDirty);
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !reg) return;
    setError(null);
    try {
      reg.provider.mount(el, {
        viewId,
        path,
        projectId,
        root,
        setDirty: (dirty) => setFileDirty(projectId, viewId, dirty),
      });
    } catch (e) {
      console.error(`파일 뷰어 mount 실패(${path}):`, e);
      setError(String(e));
      el.replaceChildren();
      return;
    }
    return () => {
      try {
        reg.provider.unmount?.(el);
      } catch (e) {
        console.error(`파일 뷰어 unmount 실패(${path}):`, e);
      }
      el.replaceChildren();
    };
  }, [reg, path, projectId, root, viewId, setFileDirty]);

  // 매칭 뷰어 없음(파일 뷰어 플러그인 미설치/비활성) → 빈 상태 안내. 에러는 겹쳐 표시.
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
