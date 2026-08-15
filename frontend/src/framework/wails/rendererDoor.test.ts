import { describe, expect, it, vi } from "vitest";

import {
  RENDERER_DECLARE_EVENT,
  RENDERER_RECEIPT_EVENT,
  RENDERER_WITHDRAW_EVENT,
  installRendererDoor,
  type RendererDeclaration,
  type RendererDoorOptions,
} from "./rendererDoor";

interface Emitted {
  event: string;
  payload: unknown;
}

function door(overrides: Partial<RendererDoorOptions> = {}) {
  const emitted: Emitted[] = [];
  const order: string[] = [];
  const listeners = new Map<string, (declaration: RendererDeclaration) => void>();
  const reported: RendererDeclaration[] = [];
  let hide: (() => void) | undefined;

  const options: RendererDoorOptions = {
    names: () => ["ui.tree", "state.tree"],
    emit: (event, payload) => {
      order.push(`emit:${event}`);
      emitted.push({ event, payload });
    },
    listen: async (event, handler) => {
      order.push(`listen:${event}`);
      listeners.set(event, handler);
    },
    onPageHide: (run) => {
      hide = run;
    },
    report: (declaration) => reported.push(declaration),
    ...overrides,
  };

  return {
    options,
    emitted,
    order,
    reported,
    receive: (declaration: RendererDeclaration) => listeners.get(RENDERER_RECEIPT_EVENT)?.(declaration),
    pageHide: () => hide?.(),
  };
}

const declaration: RendererDeclaration = {
  window: "main",
  held: ["ui.tree"],
  refused: [{ name: "state.tree", reason: "this process serves state.tree itself" }],
};

describe("renderer door", () => {
  it("declares the names this window answers", async () => {
    const bench = door();
    await installRendererDoor(bench.options);

    expect(bench.emitted).toContainEqual({
      event: RENDERER_DECLARE_EVENT,
      payload: { names: ["ui.tree", "state.tree"] },
    });
  });

  it("never names its own window", async () => {
    // The framework stamps the sending window onto the event. A page that named
    // itself could name another page and take over its commands.
    const bench = door();
    await installRendererDoor(bench.options);

    const declared = bench.emitted.find((one) => one.event === RENDERER_DECLARE_EVENT);
    expect(Object.keys(declared?.payload as Record<string, unknown>)).toEqual(["names"]);
  });

  it("listens for the receipt before declaring", async () => {
    // The receipt is dispatched as soon as the declaration is read. A listener
    // installed afterwards misses it, and the refusals in it are then silence.
    const bench = door();
    await installRendererDoor(bench.options);

    expect(bench.order).toEqual([
      `listen:${RENDERER_RECEIPT_EVENT}`,
      `emit:${RENDERER_DECLARE_EVENT}`,
    ]);
  });

  it("reports the receipt, refusals and all", async () => {
    const bench = door();
    await installRendererDoor(bench.options);
    bench.receive(declaration);

    expect(bench.reported).toEqual([declaration]);
    expect(bench.reported[0].refused[0].reason).toContain("state.tree");
  });

  it("withdraws when the page goes away", async () => {
    // A reload arrives here too: the page that comes back declares again, and
    // the names this one no longer serves must stop answering meanwhile.
    const bench = door();
    await installRendererDoor(bench.options);
    expect(bench.emitted.some((one) => one.event === RENDERER_WITHDRAW_EVENT)).toBe(false);

    bench.pageHide();

    expect(bench.emitted).toContainEqual({ event: RENDERER_WITHDRAW_EVENT, payload: {} });
  });

  it("reads the catalogue at declaration time, not at install time", async () => {
    // The command host finishes registering plugin commands after boot hands
    // this the catalogue reader. Reading it eagerly would declare the core
    // commands and silently drop every plugin one.
    const names = vi.fn(() => ["ui.tree"]);
    const bench = door({ names });
    expect(names).not.toHaveBeenCalled();

    await installRendererDoor(bench.options);

    expect(names).toHaveBeenCalledTimes(1);
  });
});
