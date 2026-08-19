import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = readFileSync(resolve(import.meta.dirname, "../App.tsx"), "utf8");

describe("the rail width grip is public DOM", () => {
  it("has the canonical address used by a human-equivalent held-pointer drag", () => {
    const grip = app.match(/<div\s+className="sidebar-resizer"[\s\S]*?\/>/)?.[0] ?? "";
    expect(grip).toContain('data-node="sidebar/rail/resizer"');
    expect(grip).toContain("onMouseDown={startResize}");
  });
});
