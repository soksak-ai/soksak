import { Fragment, useCallback, useEffect, useRef } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useSessions, type PaneNode } from "../state/sessions";
import { focusHost, getHost } from "../terminal/paneHosts";

interface PaneTreeProps {
  node: PaneNode;
  tabId: string;
  /** 이 탭이 활성 탭인가(포커스/지표 표시 조건). */
  activeTab: boolean;
  focusedPaneId: string;
}

// pane 트리를 재귀 렌더. leaf 는 마운트 포인트 div(터미널은 paneHosts 레지스트리가
// 소유), split 은 react-resizable-panels Group.
//
// 핵심: leaf 가 분할/닫기/탭전환으로 트리의 다른 위치(Group 내부 깊은 곳)로 옮겨가도
// React 가 만드는 것은 빈 마운트 포인트 div 뿐이다. 실제 터미널 호스트 div 는
// 레지스트리에 캐시돼 파괴되지 않고, appendChild 로 현재 슬롯으로 이동한다 →
// xterm canvas·WebGL·PTY 세션 보존.
export function PaneTree({
  node,
  tabId,
  activeTab,
  focusedPaneId,
}: PaneTreeProps) {
  if (node.type === "leaf") {
    return (
      <PaneLeaf
        paneId={node.id}
        tabId={tabId}
        focused={activeTab && node.id === focusedPaneId}
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
              tabId={tabId}
              activeTab={activeTab}
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
  tabId: string;
  focused: boolean;
}

function PaneLeaf({ paneId, tabId, focused }: PaneLeafProps) {
  const setFocusedPane = useSessions((s) => s.setFocusedPane);
  const mountRef = useRef<HTMLDivElement | null>(null);

  // 마운트 포인트 ref 콜백: 호스트 div 를 이 슬롯으로 (재)이동.
  // appendChild 는 이미 자식이면 no-op 이동이라 매 렌더마다 호출해도 안전(idempotent).
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
        el.appendChild(host); // 부모가 바뀌면 이동(부모 변경 → ResizeObserver 발화).
      }
    }
  });

  // 활성 탭의 포커스된 pane 이면 터미널에 포커스 + fit.
  useEffect(() => {
    if (focused) focusHost(paneId);
  }, [focused, paneId]);

  return (
    <div
      ref={attach}
      className={`pane-leaf${focused ? " focused" : ""}`}
      onMouseDownCapture={() => setFocusedPane(tabId, paneId)}
      onFocusCapture={() => setFocusedPane(tabId, paneId)}
    />
  );
}

// 안정적인 React key: leaf 는 pane id, split 은 자식 leaf id 들의 결합.
function paneKey(node: PaneNode): string {
  if (node.type === "leaf") return node.id;
  return `s:${node.children.map(paneKey).join("-")}`;
}
