// @vitest-environment jsdom
import { expect, it } from "vitest";

import { captureAfterPresentation } from "./capturePresentation";

it("captures after every visible renderer acknowledges and always restores ordering", async () => {
  const order: string[] = [];
  let captureOrdered: boolean | null = null;
  const visible = document.createElement("div");
  visible.dataset.contentVisible = "true";
  document.body.append(visible);
  let target: EventTarget | null = null;
  const listener = (event: Event) => {
    target = event.target;
    const detail = (event as CustomEvent<{ waitUntil(promise: Promise<void>): void }>).detail;
    detail.waitUntil(Promise.resolve().then(() => { order.push("renderer"); }));
  };
  window.addEventListener("soksak:capture-prepare", listener);
  try {
    const result = await captureAfterPresentation(
      window,
      async () => { order.push("present"); return { ordered: true }; },
      async (presentation) => {
        captureOrdered = presentation.ordered;
        order.push("capture");
        return 7;
      },
      async () => { order.push("restore"); },
    );
    expect(result).toBe(7);
    expect(order).toEqual(["present", "renderer", "capture", "restore"]);
    expect(captureOrdered).toBe(true);
    expect(target).toBe(visible);
  } finally {
    window.removeEventListener("soksak:capture-prepare", listener);
    visible.remove();
  }
});
