// 노드 스캔 — 플러그인 뷰 컨테이너 안에서 data-node 로 노출된 DOM 요소를 절대 주소로 수집한다.
// 스캔 루트 = PluginViewHost 의 .plugin-view-container(단일 진실). 호스트 크롬도 같은 data-node 규칙.
//
// 노출 = 명시(data-node 속성). 미노출 요소는 수집되지 않음 → 주소 트리 부재 → 접근 시 NOT_EXPOSED.
// 동적 목록은 data-node="<id>/<key>". Shadow DOM(erd)은 querySelectorAll 이 경계를 못 뚫으므로 재귀 순회.

import { NODE_PATH_RE } from "../commands/address";
import { nodeConformance } from "./conformance";

export interface ScannedNode {
  address: string; // 절대 주소(baseAddress + "/node/" + nodePath)
  nodePath: string; // data-node 값
  el: HTMLElement; // 실제 요소(resolve 시 직접 사용)
}

// root 하위(Shadow DOM 포함)의 [data-node] 요소를 전부 모은다. light DOM querySelectorAll + 각 shadowRoot 재귀.
function collectDataNodes(root: ParentNode): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (node: ParentNode) => {
    for (const el of node.querySelectorAll<HTMLElement>("[data-node]")) {
      out.push(el);
    }
    // shadowRoot 재귀 — querySelectorAll 은 경계를 못 뚫는다. 모든 자식의 shadowRoot 를 순회.
    for (const el of node.querySelectorAll<HTMLElement>("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
    if ((node as Element).shadowRoot) walk((node as Element).shadowRoot!);
  };
  walk(root);
  return out;
}

// container 안의 노출 노드를 절대 주소로. baseAddress = 이 뷰의 주소(.../view/<pluginId.viewId>).
// path 불량(NODE_PATH_RE 위반)은 onWarn 으로 보고하고 건너뛴다(침묵 실패 금지 §0-3).
export function scanNodes(
  container: ParentNode,
  baseAddress: string,
  onWarn?: (msg: string) => void,
  declaredNodeIds?: readonly string[],
): ScannedNode[] {
  const seen = new Set<string>();
  const out: ScannedNode[] = [];
  for (const el of collectDataNodes(container)) {
    const nodePath = el.dataset.node ?? "";
    if (!NODE_PATH_RE.test(nodePath)) {
      onWarn?.(`data-node path 불량(무시): "${nodePath}" @ ${baseAddress}`);
      continue;
    }
    if (seen.has(nodePath)) {
      onWarn?.(`data-node 중복(무시): "${nodePath}" @ ${baseAddress}`);
      continue;
    }
    seen.add(nodePath);
    out.push({ address: `${baseAddress}/node/${nodePath}`, nodePath, el });
  }
  // [conformance] 선언(contributes.nodes) ≡ 배선(data-node) — declaredNodeIds 줄 때만 진단.
  // nodes 는 register API 가 없어 게이트 못 하므로 경고로 양방향 불일치를 드러낸다(은폐 0).
  if (declaredNodeIds) {
    const { missing, orphan } = nodeConformance(
      declaredNodeIds,
      out.map((n) => n.nodePath),
    );
    if (missing.length)
      onWarn?.(`declared-but-not-wired: [${missing.join(",")}] @ ${baseAddress}`);
    if (orphan.length)
      onWarn?.(`wired-but-not-declared: [${orphan.join(",")}] @ ${baseAddress}`);
  }
  return out;
}
