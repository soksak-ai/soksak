// 좌측 사이드바 호스트 — sidebar-left 배치 플러그인 뷰의 순수 프레임(계약 docs/SIDEBAR.md S1–S6).
// 코어는 탭 스트립·본문 슬롯·푸터 슬롯만 그린다(콘텐츠 0 — A1/S1). 좌측 뷰가 하나도 없으면 빈 프레임(S3).
// 활성 탭은 keep-alive(연 것만 mount 유지), 활성 뷰가 사라지면 첫 뷰로(없으면 none) 폴백(S5).
// 파일 트리는 코어가 아니라 플러그인(soksak-plugin-files)이 sidebar-left 뷰로 제공한다(레거시 락인 제거).

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { PluginViewHost } from "./PluginViewHost";
import { ViewBadge } from "./ViewBadge";
import { useViewRegistry, viewsForPlacement } from "../plugins/viewRegistry";
import { useSessions, type ProjectTab } from "../state/sessions";
import { useViewLabels, resolveViewLabel } from "../state/viewLabels";
import { isComposingEnter } from "../lib/imeKeys";
import { localize } from "../i18n";

// memo 경계(원칙 2).
export const LeftSidebarHost = memo(function LeftSidebarHost({
  project,
  paneId,
}: {
  project: ProjectTab;
  paneId: string;
}) {
  const version = useViewRegistry((s) => s.version);
  const leftViews = useMemo(
    () => viewsForPlacement("sidebar-left"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  // 사이드바 하단 상시 슬롯(범용) — 첫 등록 뷰만 호스팅(예: 마스코트).
  const footerViews = useMemo(
    () => viewsForPlacement("sidebar-footer"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  const setLeftTab = useSessions((s) => s.setLeftTab);
  const leftTab = project.leftTab;
  // 탭 라벨 오버라이드(B1) — 더블클릭 인라인 편집. 빈 값 = manifest 폴백.
  const labelVersion = useViewLabels((s) => s.labels);
  const setLabel = useViewLabels((s) => s.setLabel);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  // 활성 탭이 등록된 좌측 뷰가 아니면 첫 뷰(없으면 "")로 폴백 — 댕글링 선택 금지(S5).
  const valid = leftViews.some((v) => v.key === leftTab);
  const active = valid ? leftTab : (leftViews[0]?.key ?? "");
  useEffect(() => {
    if (leftTab !== active) setLeftTab(project.id, active);
  }, [leftTab, active, project.id, setLeftTab]);

  // keep-alive: 이 프로젝트에서 연 좌측 뷰 누적(등록된 것만 유지).
  const openedRef = useRef<Set<string>>(new Set());
  if (active) openedRef.current.add(active);
  const opened = [...openedRef.current].filter((k) =>
    leftViews.some((v) => v.key === k),
  );

  return (
    <div className="left-host">
      {/* 탭 스트립은 항상 그린다(콘텐츠·우측 사이드바와 일관) — 좌측 뷰가 0개면 빈 바(프레임).
          탭 = 등록된 sidebar-left 뷰 1개당 1개. 플러그인 활성화 시 자동으로 탭이 채워진다(S2). */}
      <div className="left-host-tabs">
        {leftViews.map(({ key, view }) => {
          const fallback = localize(view.decl.title);
          const label = resolveViewLabel(key, fallback);
          void labelVersion; // 라벨 변경 시 리렌더 트리거(구독)
          if (editingKey === key) {
            return (
              <input
                key={key}
                className="left-host-tab-rename"
                data-node={`tab/left/${key}/rename`}
                defaultValue={label}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  setLabel(key, e.target.value === fallback ? "" : e.target.value);
                  setEditingKey(null);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (isComposingEnter(e)) return;
                  if (e.key === "Enter") {
                    const v = e.currentTarget.value;
                    setLabel(key, v === fallback ? "" : v);
                    setEditingKey(null);
                  } else if (e.key === "Escape") setEditingKey(null);
                }}
              />
            );
          }
          return (
            <button
              key={key}
              type="button"
              className={`left-host-tab${active === key ? " active" : ""}`}
              data-node={`tab/left/${key}`}
              title={label}
              onClick={() => setLeftTab(project.id, key)}
              onDoubleClick={() => setEditingKey(key)}
            >
              {view.decl.icon} {label}
              <ViewBadge viewKey={key} />
            </button>
          );
        })}
      </div>
      {opened.map((k) => (
        <div
          key={k}
          className="left-host-body"
          style={{ display: active === k ? "flex" : "none" }}
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
  );
});
