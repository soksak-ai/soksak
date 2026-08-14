// Setup modal gate — the one-time recovery code must be shown, and done (close) stays locked until the "saved it" confirmation.
// The code is never issued again; if this gate breaks, the user closes without writing it down and loses the sealed data.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { RecoverySetupModal } from "./RecoverySetupModal";
import { useVault } from "../state/vault";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("RecoverySetupModal — one-time recovery code gate", () => {
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

  it("renders nothing when there is no pending code (closed)", () => {
    act(() => {
      root = createRoot(host);
      root.render(<RecoverySetupModal />);
    });
    expect(host.querySelector('[data-node="modal/encrypt-setup"]')).toBeNull();
  });

  it("shows the recovery code and keeps the done button locked until the save is confirmed (the gate)", () => {
    act(() => {
      useVault.getState().showSetup("TEST-CODE-ABCD-1234", "setup");
    });
    act(() => {
      root = createRoot(host);
      root.render(<RecoverySetupModal />);
    });
    // The code renders as a wrapping block (not an input), so nothing is clipped — check the whole string via textContent.
    const code = host.querySelector('[data-node="modal/encrypt-setup/code"]');
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe("TEST-CODE-ABCD-1234");

    const done = host.querySelector(
      '[data-node="modal/encrypt-setup/done"]',
    ) as HTMLButtonElement;
    expect(done.disabled).toBe(true);

    // Check "saved it" → the done button unlocks.
    const check = host.querySelector(
      '.dctl-check input[type="checkbox"]',
    ) as HTMLInputElement;
    act(() => {
      check.click();
    });
    expect(done.disabled).toBe(false);
  });
});
