// 좌측 사이드바 호스트 — 파일 트리 + sidebar-left 배치 플러그인 뷰(§0-6).
// 좌측 배치 뷰가 하나도 없으면 탭 스트립 없이 지금과 시각적으로 동일(파일 트리만).
// 파일 트리는 상시 mount(상태 유지), 플러그인 뷰는 keep-alive(연 것만 누적).

import { useEffect, useMemo, useRef } from "react";
import type { TreeThemeInput } from "@pierre/trees";
import { FileTreeSidebar } from "./FileTreeSidebar";
import { PluginViewHost } from "./PluginViewHost";
import {
  useViewRegistry,
  viewsForPlacement,
} from "../plugins/viewRegistry";
import { useSessions, type ProjectTab } from "../state/sessions";
import { useT } from "../i18n";

const FILES = "files";

export function LeftSidebarHost({
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
            onClick={() => setLeftTab(project.id, FILES)}
          >
            {t("sidebar.files")}
          </button>
          {leftViews.map(({ key, view }) => (
            <button
              key={key}
              type="button"
              className={`left-host-tab${leftTab === key ? " active" : ""}`}
              title={view.decl.title}
              onClick={() => setLeftTab(project.id, key)}
            >
              {view.decl.icon} {view.decl.title}
            </button>
          ))}
        </div>
      )}
      <div
        className="left-host-body"
        style={{ display: leftTab === FILES ? "flex" : "none" }}
      >
        <FileTreeSidebar paneId={paneId} onOpenFile={onOpenFile} theme={treeTheme} />
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
            root={project.root ?? null}
          />
        </div>
      ))}
    </div>
  );
}
