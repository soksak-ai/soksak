import { Fragment, useCallback, useEffect, useRef } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useSessions, type PaneNode } from "../state/sessions";
import { focusHost, getHost } from "../terminal/paneHosts";

interface PaneTreeProps {
  node: PaneNode;
  projectId: string;
  viewId: string;
  /** 이 터미널 뷰가 화면에 보이는가(프로젝트 활성 && 뷰 활성). 포커스/지표 조건. */
  active: boolean;
  focusedPaneId: string;
}

// pane 트리를 재귀 렌더. leaf 는 마운트 포인트 div(터미널은 paneHosts 레지스트리가
// 소유), split 은 react-resizable-panels Group. leaf 가 분할/닫기/탭전환으로 이동해도
// React 가 만드는 건 빈 마운트 포인트뿐 — 호스트 div 는 appendChild 로 이동해 세션 보존.
export function PaneTree({
  node,
  projectId,
  viewId,
  active,
  focusedPaneId,
}: PaneTreeProps) {
  if (node.type === "leaf") {
    return (
      <PaneLeaf
        paneId={node.id}
        projectId={projectId}
        viewId={viewId}
        focused={active && node.id === focusedPaneId}
      />
    );
  }

  const orientation = node.dir === "row" ? "horizontal" : "vertical";
  return (
    <Group orientation={orientation} className="pane-group">
      {node.children.map((child, i) => (
        <Fragment key={paneKey(child)}>
          {i > 0 && (
            <Separator className={`pane-resize-handle ${orientation}`} />
          )}
          <Panel minSize="10%" className="pane-panel">
            <PaneTree
              node={child}
              projectId={projectId}
              viewId={viewId}
              active={active}
              focusedPaneId={focusedPaneId}
            />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
}

interface PaneLeafProps {
  paneId: string;
  projectId: string;
  viewId: string;
  focused: boolean;
}

function PaneLeaf({ paneId, projectId, viewId, focused }: PaneLeafProps) {
  const setFocusedPane = useSessions((s) => s.setFocusedPane);
  const mountRef = useRef<HTMLDivElement | null>(null);

  // 마운트 포인트 ref 콜백: 호스트 div 를 이 슬롯으로 (재)이동. appendChild 는 idempotent.
  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      mountRef.current = el;
      if (el) {
        el.appendChild(getHost(paneId));
      }
    },
    [paneId],
  );

  // 레이아웃 변경으로 슬롯이 바뀌었을 수 있으니 매 렌더 후에도 보강 이동 + fit.
  useEffect(() => {
    const el = mountRef.current;
    if (el) {
      const host = getHost(paneId);
      if (host.parentElement !== el) {
        el.appendChild(host);
      }
    }
  });

  // 보이는 뷰의 포커스된 pane 이면 터미널에 포커스 + fit.
  useEffect(() => {
    if (focused) focusHost(paneId);
  }, [focused, paneId]);

  return (
    <div
      ref={attach}
      className={`pane-leaf${focused ? " focused" : ""}`}
      onMouseDownCapture={() => setFocusedPane(projectId, viewId, paneId)}
      onFocusCapture={() => setFocusedPane(projectId, viewId, paneId)}
    />
  );
}

// 안정적인 React key: leaf 는 pane id, split 은 자식 leaf id 들의 결합.
function paneKey(node: PaneNode): string {
  if (node.type === "leaf") return node.id;
  return `s:${node.children.map(paneKey).join("-")}`;
}
