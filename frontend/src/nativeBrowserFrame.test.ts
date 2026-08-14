import { describe, expect, it, vi } from "vitest";

import { createNativeBrowserFramePublisher } from "./nativeBrowserFrame";

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
});
