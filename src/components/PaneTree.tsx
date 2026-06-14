import { Fragment, memo, useCallback, useEffect, useRef } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useSessions, type PaneNode } from "../state/sessions";
import { fitHost, focusHost, getHost } from "../terminal/paneHosts";

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
// memo 경계(원칙 2): 재귀 참조는 memo 래핑된 PaneTree(아래 const)를 가리켜야 한다 —
// 내부 함수명을 직접 부르면 memo 를 우회한다.
function PaneTreeImpl({
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
        visible={active}
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

export const PaneTree = memo(PaneTreeImpl);

interface PaneLeafProps {
  paneId: string;
  projectId: string;
  viewId: string;
  /** 이 뷰가 화면에 보이는가 — 노출 전환 시 보정 fit(숨김 중 리사이즈 스킵 보상). */
  visible: boolean;
  focused: boolean;
}

const PaneLeaf = memo(function PaneLeaf({
  paneId,
  projectId,
  viewId,
  visible,
  focused,
}: PaneLeafProps) {
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

  // 노출 전환 시 보정 fit: 숨김 동안 리사이즈가 스킵되므로(createTerminal 의
  // checkVisibility 가드) 보이게 된 순간 모든 pane 의 크기를 맞춘다.
  useEffect(() => {
    if (visible) fitHost(paneId);
  }, [visible, paneId]);

  // 보이는 뷰의 포커스된 pane 이면 터미널에 포커스 + fit. (포커스 탈취 가드는 focusHost
  // 단일 지점에 있다 — 팬 하위 텍스트 입력이 포커스면 xterm 으로 안 뺏는다.)
  useEffect(() => {
    if (focused) focusHost(paneId);
  }, [focused, paneId]);

  return (
    <div
      ref={attach}
      className={`pane-leaf${focused ? " focused" : ""}`}
      // 범용 앵커: 플러그인/도구가 paneId 로 패널 요소를 찾아 오버레이를 붙일 수 있다
      // (코어는 용도를 모른다 — claude-GUI 등이 소비하는 DOM 소켓).
      data-pane-id={paneId}
      onMouseDownCapture={() => setFocusedPane(projectId, viewId, paneId)}
      onFocusCapture={() => setFocusedPane(projectId, viewId, paneId)}
    />
  );
});

// 안정적인 React key: leaf 는 pane id, split 은 자식 leaf id 들의 결합.
function paneKey(node: PaneNode): string {
  if (node.type === "leaf") return node.id;
  return `s:${node.children.map(paneKey).join("-")}`;
}
