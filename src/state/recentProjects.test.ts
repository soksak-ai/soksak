// 최근 프로젝트 목록 — 순수 upsert 계약(정렬·dedup·상한). 저장 배선(coreStore)과 분리 검증.
import { describe, expect, it } from "vitest";
import { upsertRecent, RECENT_CAP, type RecentProject } from "./recentProjects";

const e = (root: string, at: number, alias = ""): RecentProject => ({
  root,
  alias: alias || root.split("/").pop()!,
  lastOpenedAt: at,
});

describe("upsertRecent", () => {
  it("최근 열림 내림차순 정렬", () => {
    const out = upsertRecent([e("/a", 1), e("/b", 3)], e("/c", 2));
    expect(out.map((r) => r.root)).toEqual(["/b", "/c", "/a"]);
  });

  it("같은 root 는 갱신(dedup) — 시각·별칭 최신화", () => {
    const out = upsertRecent([e("/a", 1, "old"), e("/b", 2)], e("/a", 5, "new"));
    expect(out.map((r) => r.root)).toEqual(["/a", "/b"]);
    expect(out[0].alias).toBe("new");
    expect(out[0].lastOpenedAt).toBe(5);
    expect(out).toHaveLength(2);
  });

  it("상한 초과 시 가장 오래된 항목부터 잘린다", () => {
    const many = Array.from({ length: RECENT_CAP }, (_, i) => e(`/p${i}`, i + 10));
    const out = upsertRecent(many, e("/new", 999));
    expect(out).toHaveLength(RECENT_CAP);
    expect(out[0].root).toBe("/new");
    // 가장 오래된 /p0(at=10) 이 탈락.
    expect(out.some((r) => r.root === "/p0")).toBe(false);
  });
});
