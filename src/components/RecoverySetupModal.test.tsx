// 셋업 모달 게이트 — 1회성 복구코드는 반드시 표시되고, "저장했음" 확인 전엔 완료(닫기)가 잠겨야 한다.
// 코드는 다시 못 얻으므로 이 게이트가 무너지면 사용자가 코드를 못 적고 닫아 봉인 데이터를 잃는다.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { RecoverySetupModal } from "./RecoverySetupModal";
import { useVault } from "../state/vault";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("RecoverySetupModal — 1회성 복구코드 게이트", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useVault.setState({ openModal: null, pendingCode: null, targetScope: "" });
    host = document.createElement("div");
    document.body.appendChild(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useVault.setState({ openModal: null, pendingCode: null, targetScope: "" });
  });

  it("pending 없으면 렌더하지 않는다(닫힘)", () => {
    act(() => {
      root = createRoot(host);
      root.render(<RecoverySetupModal />);
    });
    expect(host.querySelector('[data-node="modal/encrypt-setup"]')).toBeNull();
  });

  it("복구코드를 표시하고, 저장 확인 전엔 완료 버튼이 잠긴다(게이트)", () => {
    act(() => {
      useVault.getState().showSetup("TEST-CODE-ABCD-1234", "setup");
    });
    act(() => {
      root = createRoot(host);
      root.render(<RecoverySetupModal />);
    });
    // 코드는 줄바꿈 블록(input 아님)이라 전체가 잘리지 않고 보여야 한다 — textContent 로 전량 확인.
    const code = host.querySelector('[data-node="modal/encrypt-setup/code"]');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe("TEST-CODE-ABCD-1234");

    const done = host.querySelector(
      '[data-node="modal/encrypt-setup/done"]',
    ) as HTMLButtonElement;
    expect(done.disabled).toBe(true);

    // "저장했음" 체크 → 완료 버튼 열림.
    const check = host.querySelector(
      '.dctl-check input[type="checkbox"]',
    ) as HTMLInputElement;
    act(() => {
      check.click();
    });
    expect(done.disabled).toBe(false);
  });
});
