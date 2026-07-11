import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PluginViewContext,
  PluginViewProvider,
} from "./viewRegistry";
import { ViewFocusCoordinator } from "./viewFocus";

const context = {
  projectId: "t1",
  root: null,
  paneId: null,
  viewId: null,
  command: null,
  restore: null,
  setBadge: () => {},
  setStatus: () => {},
  setTitle: () => {},
  setIcon: () => {},
  setRestoreState: () => {},
} satisfies PluginViewContext;

function provider(
  hooks: Partial<PluginViewProvider>,
): PluginViewProvider {
  return { mount: () => {}, ...hooks };
}

function fixture() {
  const frames: FrameRequestCallback[] = [];
  const coordinator = new ViewFocusCoordinator({
    schedule: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    onError: (error) => {
      throw error;
    },
  });
  const flushFrame = () => {
    const pending = frames.splice(0);
    for (const cb of pending) cb(performance.now());
  };
  return { coordinator, frames, flushFrame };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("view focus ownership", () => {
  it("commits the source before activation and focuses the target after the click boundary", () => {
    const { coordinator, flushFrame } = fixture();
    const source = document.createElement("section");
    const sourceInput = document.createElement("textarea");
    source.appendChild(sourceInput);
    const target = document.createElement("section");
    const targetInput = document.createElement("textarea");
    target.appendChild(targetInput);
    document.body.append(source, target);

    const order: string[] = [];
    let composing = true;
    let commits = 0;
    sourceInput.addEventListener("focusout", () => {
      if (!composing) return;
      composing = false;
      commits += 1;
    });

    coordinator.registerMountedView(
      "source",
      source,
      provider({
        prepareFocusTransfer: (ownContainer) => {
          expect(ownContainer).toBe(source);
          order.push("prepare");
          if (!composing) return;
          composing = false;
          commits += 1;
        },
      }),
      () => context,
    );
    coordinator.registerMountedView(
      "target",
      target,
      provider({
        focus: (ownContainer, _ctx, request) => {
          expect(ownContainer).toBe(target);
          order.push("focus");
          if (!request.signal.aborted) targetInput.focus();
        },
      }),
      () => context,
    );

    sourceInput.focus();
    coordinator.transferFocus("source", "target", () => {
      order.push("activate");
    });

    expect(order).toEqual(["prepare", "activate"]);
    expect(commits).toBe(1);
    expect(document.activeElement).toBe(sourceInput);

    flushFrame();

    expect(order).toEqual(["prepare", "activate", "focus"]);
    expect(commits).toBe(1);
    expect(document.activeElement).toBe(targetInput);
  });

  it("restores a repeatedly activated view even when activation state is a no-op", () => {
    const { coordinator, flushFrame } = fixture();
    const target = document.createElement("section");
    const input = document.createElement("textarea");
    const outside = document.createElement("button");
    target.appendChild(input);
    document.body.append(target, outside);
    const focus = vi.fn(() => input.focus());

    coordinator.registerMountedView(
      "target",
      target,
      provider({ focus }),
      () => context,
    );

    coordinator.transferFocus("target", "target", () => {});
    flushFrame();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);

    outside.focus();
    coordinator.transferFocus("target", "target", () => {});
    flushFrame();
    expect(focus).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(input);
  });

  it("preserves a descendant focused by the trusted click default action", () => {
    const { coordinator, flushFrame } = fixture();
    const target = document.createElement("section");
    const clickedInput = document.createElement("input");
    target.appendChild(clickedInput);
    document.body.appendChild(target);
    const focus = vi.fn();

    coordinator.registerMountedView(
      "target",
      target,
      provider({ focus }),
      () => context,
    );

    coordinator.requestFocus("target");
    clickedInput.focus();
    flushFrame();

    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(clickedInput);
  });

  it("lets only the latest request focus after delayed mount or async readiness", () => {
    const { coordinator, frames, flushFrame } = fixture();
    const a = document.createElement("section");
    const b = document.createElement("section");
    document.body.append(a, b);
    const focused: string[] = [];
    const delayedA: { run?: () => void } = {};

    coordinator.requestFocus("a");
    coordinator.requestFocus("b");
    coordinator.registerMountedView(
      "a",
      a,
      provider({ focus: () => focused.push("a") }),
      () => context,
    );
    expect(frames).toHaveLength(0);

    coordinator.registerMountedView(
      "b",
      b,
      provider({ focus: () => focused.push("b") }),
      () => context,
    );
    flushFrame();
    expect(focused).toEqual(["b"]);

    coordinator.requestFocus("a-async");
    coordinator.registerMountedView(
      "a-async",
      a,
      provider({
        focus: (_container, _ctx, request) => {
          delayedA.run = () => {
            if (!request.signal.aborted) focused.push("a-async");
          };
        },
      }),
      () => context,
    );
    flushFrame();
    coordinator.requestFocus("b");
    delayedA.run?.();
    flushFrame();

    expect(focused).toEqual(["b", "b"]);
  });
});
