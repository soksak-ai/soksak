import { describe, expect, it, vi } from "vitest";

import { createNativeBrowserFramePublisher, nativeBrowserFrameFact } from "./nativeBrowserFrame";

describe("native browser frame publisher", () => {
  it("publishes every layout commit with a strictly increasing sequence", () => {
    const apply = vi.fn();
    const publisher = createNativeBrowserFramePublisher(apply);
    const initial = { x: 500, y: 100, width: 500, height: 600 };
    const dragged = { x: 800, y: 100, width: 200, height: 600 };

    publisher.publish(initial);
    publisher.publish(dragged);

    expect(apply.mock.calls).toEqual([[1, initial], [2, dragged]]);
  });

  it("exposes requested and native-applied frame equality", () => {
    expect(nativeBrowserFrameFact({
      sequence: 9,
      accepted: true,
      requested: { x: 10, y: 20, width: 300, height: 400 },
      applied: { x: 10, y: 20, width: 300, height: 400 },
    })).toEqual({
      sequence: 9,
      accepted: true,
      requested: "10,20,300x400",
      applied: "10,20,300x400",
      matched: true,
    });
  });
});
