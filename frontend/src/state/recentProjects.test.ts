// Recent project list — pure upsert contract (ordering, dedup, cap). Verified apart from the coreStore persistence wiring.
import { describe, expect, it } from "vitest";
import { upsertRecent, RECENT_CAP, type RecentProject } from "./recentProjects";

const e = (root: string, at: number, alias = ""): RecentProject => ({
  root,
  alias: alias || root.split("/").pop()!,
  lastOpenedAt: at,
});

describe("upsertRecent", () => {
  it("sorted by last opened, descending", () => {
    const out = upsertRecent([e("/a", 1), e("/b", 3)], e("/c", 2));
    expect(out.map((r) => r.root)).toEqual(["/b", "/c", "/a"]);
  });

  it("the same root is updated (dedup) — time and alias refreshed", () => {
    const out = upsertRecent([e("/a", 1, "old"), e("/b", 2)], e("/a", 5, "new"));
    expect(out.map((r) => r.root)).toEqual(["/a", "/b"]);
    expect(out[0].alias).toBe("new");
    expect(out[0].lastOpenedAt).toBe(5);
    expect(out).toHaveLength(2);
  });

  it("over the cap, the oldest entry is dropped first", () => {
    const many = Array.from({ length: RECENT_CAP }, (_, i) => e(`/p${i}`, i + 10));
    const out = upsertRecent(many, e("/new", 999));
    expect(out).toHaveLength(RECENT_CAP);
    expect(out[0].root).toBe("/new");
    // The oldest entry /p0 (at=10) is dropped.
    expect(out.some((r) => r.root === "/p0")).toBe(false);
  });
});
