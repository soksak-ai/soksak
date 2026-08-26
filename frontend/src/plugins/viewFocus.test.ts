import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PluginViewContext,
  PluginViewProvider,
} from "./viewRegistry";
import { ViewFocusCoordinator } from "./viewFocus";

const context = {
  projectId: "wsp-aaaaaa",
  root: null,
  paneId: null,
  viewId: null,
  boundViewId: null,
  command: null,
  restore: null,
  presentation: () => ({ visible: true, dim: 0 }),
  onPresentationChange: () => () => {},
  requestFocus: () => {},
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
  it("hands over a React generation swap on the same viewId atomically and ignores the late cleanup", () => {
    const { coordinator, flushFrame } = fixture();
    const previous = document.createElement("section");
    const next = document.createElement("section");
    const nextInput = document.createElement("input");
    next.append(nextInput);
    document.body.append(previous, next);
    const nextFocus = vi.fn(() => nextInput.focus());

    const releasePrevious = coordinator.registerMountedView(
      "same-view",
      previous,
      provider({ focus: vi.fn() }),
      () => context,
    );
    const releaseNext = coordinator.registerMountedView(
      "same-view",
      next,
      provider({ focus: nextFocus }),
      () => context,
    );

    // A late React cleanup of the previous effect must not erase the new generation's ownership.
    releasePrevious();
    coordinator.requestFocus("same-view");
    flushFrame();
    expect(nextFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(nextInput);
    expect(coordinator.snapshot()).toMatchObject({ mounted: true, delivered: true });

    releaseNext();
    expect(coordinator.snapshot().mounted).toBe(false);
  });

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
    const setFocused = vi.fn();

    coordinator.registerMountedView(
      "target",
      target,
      provider({ focus, setFocused }),
      () => context,
    );

    coordinator.requestFocus("target");
    expect(setFocused).toHaveBeenLastCalledWith(target, context, true);
    clickedInput.focus();
    flushFrame();

    expect(focus).not.toHaveBeenCalled();
    expect(setFocused).toHaveBeenCalledOnce();
    expect(setFocused).toHaveBeenLastCalledWith(target, context, true);
    expect(document.activeElement).toBe(clickedInput);
  });

  it("publishes focus ownership independently from keyboard focus execution", () => {
    const { coordinator, flushFrame } = fixture();
    const source = document.createElement("section");
    const target = document.createElement("section");
    document.body.append(source, target);
    const sourceFocused = vi.fn();
    const targetFocused = vi.fn();
    coordinator.registerMountedView(
      "source",
      source,
      provider({ setFocused: sourceFocused }),
      () => context,
    );
    coordinator.registerMountedView(
      "target",
      target,
      provider({ setFocused: targetFocused }),
      () => context,
    );

    coordinator.transferFocus("source", "target", () => {});
    expect(sourceFocused).toHaveBeenLastCalledWith(source, context, false);
    expect(targetFocused).toHaveBeenLastCalledWith(target, context, true);
    flushFrame();
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

describe("delivery lands or reports", () => {
  it("a delivery that did not land is retried once on the next frame and lands", () => {
    const { coordinator, flushFrame } = fixture();
    const container = document.createElement("div");
    const input = document.createElement("input");
    container.append(input);
    document.body.append(container);
    let calls = 0;
    coordinator.registerMountedView(
      "tab-aaaaaa",
      container,
      provider({
        focus: () => {
          calls += 1;
          if (calls >= 2) input.focus(); // the first call is before readiness and does nothing — measured ghostty non-landing signature
        },
      }),
      () => context,
    );
    coordinator.requestFocus("tab-aaaaaa");
    flushFrame(); // first delivery — does not land
    expect(document.activeElement).not.toBe(input);
    flushFrame(); // retry — must land
    expect(document.activeElement).toBe(input);
    expect(coordinator.snapshot().delivered).toBe(true);
  });

  it("reports which view still did not land after the retries — no silence", () => {
    const errors: unknown[] = [];
    const frames: FrameRequestCallback[] = [];
    const coordinator = new ViewFocusCoordinator({
      schedule: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      onError: (error) => errors.push(error),
    });
    const flushFrame = () => {
      const pending = frames.splice(0);
      for (const cb of pending) cb(performance.now());
    };
    const container = document.createElement("div");
    document.body.append(container);
    coordinator.registerMountedView(
      "tab-iiiiii",
      container,
      provider({ focus: () => {} }), // never lands
      () => context,
    );
    coordinator.requestFocus("tab-iiiiii");
    for (let i = 0; i < 31; i += 1) flushFrame(); // up to the finite retry cap
    expect(errors.length).toBe(1);
    expect(String(errors[0])).toContain("tab-iiiiii");
  });
});

describe("readiness window", () => {
  it("exposes an event-driven finite wait for actual input landing", async () => {
    const { coordinator, flushFrame } = fixture();
    const container = document.createElement("section");
    const input = document.createElement("textarea");
    container.append(input);
    document.body.append(container);
    coordinator.registerMountedView(
      "tab-aaaaaa",
      container,
      provider({ focus: () => input.focus() }),
      () => context,
    );
    coordinator.requestFocus("tab-aaaaaa");
    const settled = coordinator.awaitSettled(1000);
    flushFrame();
    await expect(settled).resolves.toBe(true);
  });

  it("never accepts an already-settled previous view for a named target", async () => {
    const { coordinator, flushFrame } = fixture();
    for (const id of ["tab-old", "tab-new"]) {
      const container = document.createElement("section");
      const input = document.createElement("textarea");
      container.append(input);
      document.body.append(container);
      coordinator.registerMountedView(id, container, provider({ focus: () => input.focus() }), () => context);
    }
    coordinator.requestFocus("tab-old");
    flushFrame();
    const targetSettled = coordinator.awaitSettled(1000, "tab-new");
    coordinator.requestFocus("tab-new");
    flushFrame();
    await expect(targetSettled).resolves.toBe(true);
  });

  it("the finite retries cover the warm restore window (ready several frames later) — it lands on the fifth frame", () => {
    const { coordinator, flushFrame } = fixture();
    const container = document.createElement("div");
    const input = document.createElement("input");
    container.append(input);
    document.body.append(container);
    let calls = 0;
    coordinator.registerMountedView(
      "tab-aaaaaa",
      container,
      provider({
        focus: () => {
          calls += 1;
          if (calls >= 5) input.focus(); // the measured window in which the engine reattaches over several frames right after a reload
        },
      }),
      () => context,
    );
    coordinator.requestFocus("tab-aaaaaa");
    for (let i = 0; i < 5; i += 1) flushFrame();
    expect(document.activeElement).toBe(input);
    expect(coordinator.snapshot().delivered).toBe(true);
  });

  it("when a layout move drops focus after delivery, redeliverIfLost delivers the same intent again", () => {
    // Measured defect (after sidebar binding): a bind click reorders the projection, changing React key
    // order and reparenting the DOM, so the browser drops the focus inside it to body. The coordinator
    // had delivered=true and did not refocus — "delivered" is not "settled". Redelivery after the move
    // completes is part of the coordinator's job.
    const { coordinator, flushFrame } = fixture();
    const container = document.createElement("section");
    const input = document.createElement("textarea");
    container.append(input);
    document.body.append(container);
    let calls = 0;
    coordinator.registerMountedView(
      "tab-aaaaaa",
      container,
      provider({
        focus: () => {
          calls += 1;
          input.focus();
        },
      }),
      () => context,
    );
    coordinator.requestFocus("tab-aaaaaa");
    flushFrame();
    expect(document.activeElement).toBe(input);
    // Equivalent to the DOM move in a projection reorder — remove+insert drops focus to body.
    container.remove();
    document.body.append(container);
    expect(document.activeElement).not.toBe(input);
    coordinator.redeliverIfLost();
    flushFrame();
    expect(calls).toBe(2);
    expect(document.activeElement).toBe(input);
  });

  it("redeliverIfLost keeps a settled delivery and does not touch an intended focus", () => {
    const { coordinator, frames, flushFrame } = fixture();
    const container = document.createElement("section");
    const input = document.createElement("textarea");
    container.append(input);
    document.body.append(container);
    let calls = 0;
    coordinator.registerMountedView(
      "tab-aaaaaa",
      container,
      provider({
        focus: () => {
          calls += 1;
          input.focus();
        },
      }),
      () => context,
    );
    coordinator.requestFocus("tab-aaaaaa");
    flushFrame();
    expect(calls).toBe(1);
    // Still settled — no redelivery.
    coordinator.redeliverIfLost();
    flushFrame();
    expect(calls).toBe(1);
    // The user deliberately focused elsewhere (not body) — do not steal it.
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    coordinator.redeliverIfLost();
    expect(frames.length).toBe(0);
    expect(document.activeElement).toBe(outside);
  });
});

describe("close intent", () => {
  it("awaits the mounted provider before a view is permanently removed", async () => {
    const { coordinator } = fixture();
    const container = document.createElement("section");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const closeView = vi.fn(async () => pending);
    coordinator.registerMountedView("view-a", container, provider({ closeView } as never), () => context);
    const closing = (coordinator as unknown as { closeView(viewId: string): Promise<void> }).closeView("view-a");

    await Promise.resolve();
    expect(closeView).toHaveBeenCalledWith(container, context);
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
  });

  it("lets a mounted view consume the close", () => {
    const { coordinator } = fixture();
    const container = document.createElement("section");
    const closeIntent = vi.fn((): "handled" | "pass" => "handled");
    coordinator.registerMountedView("view-a", container, provider({ closeIntent }), () => context);
    expect(coordinator.closeIntent("view-a")).toBe("handled");
    expect(closeIntent).toHaveBeenCalledWith(container, context);
  });

  it("passes when the hook is absent, the view is unmounted, or the hook threw", () => {
    const { coordinator } = fixture();
    coordinator.registerMountedView("plain", document.createElement("section"), provider({}), () => context);
    expect(coordinator.closeIntent("plain")).toBe("pass");
    expect(coordinator.closeIntent("missing")).toBe("pass");
    const failing = new ViewFocusCoordinator({ onError: () => {} });
    failing.registerMountedView(
      "broken",
      document.createElement("section"),
      provider({ closeIntent: () => { throw new Error("no"); } }),
      () => context,
    );
    expect(failing.closeIntent("broken")).toBe("pass");
  });
});
