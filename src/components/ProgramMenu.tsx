import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Program } from "../state/sessions";
import { useProgramRegistry } from "../plugins/programRegistry";
import { programPathSegments } from "../plugins/spec";
import { useSuppressBrowser } from "../state/ui";
import { Icon } from "../ui/icons/Icon";
import { useT } from "../i18n";

// 프로그램 선택 메뉴 — 항목은 100% 플러그인 등록분(programRegistry, 내장 없음
// §2.6). path("/" 구분 카테고리 경로)가 같은 항목은 다단 서브메뉴 트리로
// 묶인다(예: "에이전트" ▸ Claude·Codex, "에이전트/실험" ▸ …). 컨텐츠 + 와
// 분할 탭바 + 가 동일하게 사용.
//   - body 포털: 그룹 셀(스태킹 컨텍스트) 안에서 fixed+z-index 는 형제 셀에 덮인다 —
//     포털로 모든 스태킹/클리핑을 벗어나 항상 위.
//   - 닫힘 = 외부 pointerdown(캡처) + Escape. mouseLeave 닫힘은 폐기(스쳐도 닫혀
//     불안정했고, 메뉴에 마우스가 한 번도 안 들어오면 영영 안 닫혔다).
//   - 떠 있는 동안 브라우저 webview 를 숨긴다(네이티브 레이어가 DOM 메뉴를 가리므로).

// 메뉴 트리 노드 — 등록 순서 유지(카테고리의 위치 = 첫 항목의 위치).
interface MenuNode {
  items: { id: string; title: string }[];
  subs: Map<string, MenuNode>; // 카테고리 세그먼트 → 하위
  order: ({ kind: "item"; idx: number } | { kind: "sub"; name: string })[];
}

function emptyNode(): MenuNode {
  return { items: [], subs: new Map(), order: [] };
}

function insert(
  node: MenuNode,
  segs: string[],
  item: { id: string; title: string },
): void {
  if (segs.length === 0) {
    node.order.push({ kind: "item", idx: node.items.length });
    node.items.push(item);
    return;
  }
  const [head, ...rest] = segs;
  if (!node.subs.has(head)) {
    node.subs.set(head, emptyNode());
    node.order.push({ kind: "sub", name: head });
  }
  insert(node.subs.get(head)!, rest, item);
}

function MenuLevel({
  node,
  onPick,
}: {
  node: MenuNode;
  onPick: (program: Program) => void;
}) {
  return (
    <>
      {node.order.map((o) =>
        o.kind === "item" ? (
          <div
            key={node.items[o.idx].id}
            className="ctab-menu-item"
            onClick={() => onPick(node.items[o.idx].id)}
          >
            {node.items[o.idx].title}
          </div>
        ) : (
          <div key={`sub:${o.name}`} className="ctab-menu-item has-sub">
            <span>{o.name}</span>
            <span className="ctab-menu-caret icon-inline">
              <Icon name="chevron-right" size="sm" />
            </span>
            <div className="ctab-submenu">
              <MenuLevel node={node.subs.get(o.name)!} onPick={onPick} />
            </div>
          </div>
        ),
      )}
    </>
  );
}

export function ProgramMenu({
  pos,
  onPick,
  onClose,
}: {
  pos: { left: number; top: number };
  onPick: (program: Program) => void;
  onClose: () => void;
}) {
  const t = useT();
  useSuppressBrowser();
  const menuRef = useRef<HTMLDivElement>(null);
  // 등록/해제 신호 구독 — 플러그인 활성 전환이 열린 메뉴에도 반영된다.
  useProgramRegistry((s) => s.version);
  const { programs, order } = useProgramRegistry.getState();

  useEffect(() => {
    // 캡처 단계 — 다른 핸들러의 stopPropagation 에도 닫힘 보장. 메뉴를 연 클릭은
    // 이 effect 부착 전에 끝나므로 즉시 닫힘 없음.
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  const root = emptyNode();
  for (const id of order) {
    const p = programs[id];
    if (!p) continue;
    insert(
      root,
      p.decl.path ? programPathSegments(p.decl.path) : [],
      { id, title: p.decl.title },
    );
  }

  return createPortal(
    <div
      ref={menuRef}
      className="ctab-menu"
      style={{ left: pos.left, top: pos.top }}
    >
      {order.length === 0 ? (
        <div className="ctab-menu-empty">{t("program.empty")}</div>
      ) : (
        <MenuLevel node={root} onPick={onPick} />
      )}
    </div>,
    document.body,
  );
}
