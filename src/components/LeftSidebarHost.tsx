// 좌측 사이드바 호스트 — 파일 트리 + sidebar-left 배치 플러그인 뷰(§0-6).
// 좌측 배치 뷰가 하나도 없으면 탭 스트립 없이 지금과 시각적으로 동일(파일 트리만).
// 파일 트리는 상시 mount(상태 유지), 플러그인 뷰는 keep-alive(연 것만 누적).

import { memo, useEffect, useMemo, useRef } from "react";
import type { TreeThemeInput } from "@pierre/trees";
import { FileTreeSidebar } from "./FileTreeSidebar";
import { PluginViewHost } from "./PluginViewHost";
import { ViewBadge } from "./ViewBadge";
import {
  useViewRegistry,
  viewsForPlacement,
} from "../plugins/viewRegistry";
import { useSessions, type ProjectTab } from "../state/sessions";
import { localize, useT } from "../i18n";

const FILES = "files";

// memo 경계(원칙 2): onOpenFile 은 ProjectPane 의 안정 콜백이어야 한다.
export const LeftSidebarHost = memo(function LeftSidebarHost({
  project,
  paneId,
  onOpenFile,
  treeTheme,
}: {
  project: ProjectTab;
  paneId: string;
  onOpenFile: (path: string) => void;
  treeTheme: TreeThemeInput;
}) {
  const t = useT();
  const version = useViewRegistry((s) => s.version);
  const leftViews = useMemo(
    () => viewsForPlacement("sidebar-left"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  // 파일 트리 하단 상시 슬롯(범용) — 첫 등록 뷰만 호스팅(예: 마스코트).
  const footerViews = useMemo(
    () => viewsForPlacement("sidebar-footer"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  const setLeftTab = useSessions((s) => s.setLeftTab);
  const leftTab = project.leftTab;

  // 선택된 플러그인 뷰가 사라지면(비활성/제거) 파일 트리로 복귀.
  useEffect(() => {
    if (leftTab !== FILES && !leftViews.some((v) => v.key === leftTab)) {
      setLeftTab(project.id, FILES);
    }
  }, [leftTab, leftViews, project.id, setLeftTab]);

  // keep-alive: 이 프로젝트에서 연 좌측 플러그인 뷰 누적.
  const openedRef = useRef<Set<string>>(new Set());
  if (leftTab !== FILES) openedRef.current.add(leftTab);
  const opened = [...openedRef.current].filter((k) =>
    leftViews.some((v) => v.key === k),
  );

  return (
    <div className="left-host">
      {leftViews.length > 0 && (
        <div className="left-host-tabs">
          <button
            type="button"
            className={`left-host-tab${leftTab === FILES ? " active" : ""}`}
            data-node="tab/left/files"
            onClick={() => setLeftTab(project.id, FILES)}
          >
            {t("sidebar.files")}
          </button>
          {leftViews.map(({ key, view }) => (
            <button
              key={key}
              type="button"
              className={`left-host-tab${leftTab === key ? " active" : ""}`}
              data-node={`tab/left/${key}`}
              title={localize(view.decl.title)}
              onClick={() => setLeftTab(project.id, key)}
            >
              {view.decl.icon} {localize(view.decl.title)}
              <ViewBadge viewKey={key} />
            </button>
          ))}
        </div>
      )}
      <div
        className="left-host-body left-host-body-files"
        style={{ display: leftTab === FILES ? "flex" : "none" }}
      >
        <FileTreeSidebar
            paneId={paneId}
            projectRoot={project.root}
            onOpenFile={onOpenFile}
            theme={treeTheme}
          />
        {footerViews.length > 0 && (
          <div className="left-host-footer">
            <PluginViewHost
              viewKey={footerViews[0].key}
              projectId={project.id}
              root={project.root}
              region="left"
              paneId={paneId}
            />
          </div>
        )}
      </div>
      {opened.map((k) => (
        <div
          key={k}
          className="left-host-body"
          style={{ display: leftTab === k ? "flex" : "none" }}
        >
          <PluginViewHost
            viewKey={k}
            projectId={project.id}
            root={project.root}
            region="left"
            paneId={paneId}
          />
        </div>
      ))}
    </div>
  );
});
