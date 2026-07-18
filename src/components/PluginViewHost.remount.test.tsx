// PluginViewHost 컨테이너 세대 격리 — 구조 remount(등록 해제→재등록, 예: plugin.reload)는
// 항상 새 컨테이너 DOM 노드를 발급해야 한다. attachShadow 는 비가역이라 재활용 노드는 이전
// 세대의 shadow root(와 불완전한 provider.unmount 가 남긴 잔재)를 다음 마운트에 물려준다 —
// 세대 격리가 그 유입을 구조적으로 차단한다.
import { describe, it, expect, beforeEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { PluginViewHost } from "./PluginViewHost";
import { useViewRegistry } from "../plugins/viewRegistry";
import type { ContributedView } from "../plugins/spec";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const DECL = {
  id: "canvas",
  title: { en: "T" },
  icon: "▤",
  placements: ["content"],
  defaultPlacement: "content",
  transparent: false,
  nativeSurface: false,
} as unknown as ContributedView;

function resetRegistry() {
  useViewRegistry.setState({ views: {}, version: 0, badges: {} });
}

describe("PluginViewHost — 컨테이너 세대 격리", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetRegistry();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("재등록(plugin.reload) 후 provider 는 shadow root 없는 새 컨테이너를 받는다", () => {
    const containers: HTMLElement[] = [];
    const shadowAtMount: boolean[] = [];
    const provider = {
      mount(el: HTMLElement) {
        containers.push(el);
        shadowAtMount.push(el.shadowRoot != null);
        // 실제 뷰 플러그인의 사용 패턴 — shadow root 는 노드에 비가역으로 남는다.
        if (!el.shadowRoot) el.attachShadow({ mode: "open" });
      },
      unmount() {},
    };

    let unregister: () => void;
    act(() => {
      unregister = useViewRegistry
        .getState()
        .register("test-plugin", DECL, provider);
    });
    act(() => {
      root = createRoot(host);
      root.render(
        <PluginViewHost
          viewKey="test-plugin.canvas"
          projectId="p1"
          root={null}
          region="content"
        />,
      );
    });
    expect(containers.length).toBe(1);
    expect(containers[0].shadowRoot).not.toBeNull();

    // plugin.reload 등가: 해제 → 재등록. 호스트는 remount 한다.
    act(() => {
      unregister();
    });
    act(() => {
      useViewRegistry.getState().register("test-plugin", DECL, provider);
    });

    expect(containers.length).toBe(2);
    // 계약: 새 세대는 새 DOM 노드 — mount 진입 시점에 이전 세대의 shadow root 가 없어야 한다.
    expect(containers[1]).not.toBe(containers[0]);
    expect(shadowAtMount).toEqual([false, false]);

    act(() => {
      root.unmount();
    });
  });
});
