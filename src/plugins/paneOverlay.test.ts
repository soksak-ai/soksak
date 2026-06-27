// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { mountPaneOverlay } from "./paneOverlay";

// PluginViewHost 의 실제 DOM 구조 재현(§4):
//   .plugin-view-host > .plugin-view-container[data-pane-id] (+ provider 가 replaceChildren 로 비움)
// 오버레이는 container 의 형제(=.plugin-view-host 직속)여야 provider 정리에 안 지워진다.
function makeContentHost(paneId: string): {
  host: HTMLElement;
  container: HTMLElement;
} {
  const host = document.createElement("div");
  host.className = "plugin-view-host";
  const container = document.createElement("div");
  container.className = "plugin-view-container";
  container.setAttribute("data-pane-id", paneId);
  container.setAttribute("data-view-addr", `content/view/x.${paneId}`);
  host.appendChild(container);
  document.body.appendChild(host);
  return { host, container };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("mountPaneOverlay", () => {
  test("element 를 paneId 매칭 호스트의 .plugin-view-host 에 붙인다(container 형제)", () => {
    const { host, container } = makeContentHost("v8");
    const ov = document.createElement("div");

    mountPaneOverlay(document, "v8", ov);

    // provider 가 비우는 .plugin-view-container 가 아니라 그 부모 .plugin-view-host 직속이어야 함.
    expect(ov.parentElement).toBe(host);
    expect(ov.parentElement).not.toBe(container);
  });

  test("dispose 가 element 를 제거한다", () => {
    const { host } = makeContentHost("v8");
    const ov = document.createElement("div");

    const dispose = mountPaneOverlay(document, "v8", ov);
    expect(host.contains(ov)).toBe(true);

    dispose();
    expect(host.contains(ov)).toBe(false);
  });

  test("paneId 매칭 호스트가 없으면 throw(침묵 실패 금지 — 942ae86 회귀의 root cause)", () => {
    const ov = document.createElement("div");
    expect(() => mountPaneOverlay(document, "missing", ov)).toThrow();
  });

  test("data-pane-id 앵커로만 매칭 — 사이드바(앵커 부재)는 대상이 아니다", () => {
    const host = document.createElement("div");
    host.className = "plugin-view-host";
    const container = document.createElement("div");
    container.className = "plugin-view-container";
    container.setAttribute("data-view-addr", "left/view/x.tree"); // data-pane-id 없음
    host.appendChild(container);
    document.body.appendChild(host);

    const ov = document.createElement("div");
    expect(() => mountPaneOverlay(document, "tree", ov)).toThrow();
  });
});
