import { describe, it, expect } from "vitest";
import {
  equalSizes,
  splitLeaf,
  resizeSplitTree,
  findSplitTree,
  leavesOf,
  removeLeaf,
  insertBeside,
  serializeSplitTree,
  deserializeSplitTree,
  type SplitTree,
} from "./splitTree";

// 제네릭 split-tree — 뷰 그룹·터미널 pane 공용 단일 추상. leaf 페이로드 L 에 무관.
// 여기 테스트는 L=string(paneId 류)로 연산·직렬화 불변식을 강제한다.

let n = 0;
const newId = () => `s${++n}`;

function split<L>(
  id: string,
  dir: "row" | "col",
  sizes: number[],
  children: SplitTree<L>[],
): SplitTree<L> {
  return { type: "split", id, dir, sizes, children };
}

describe("equalSizes", () => {
  it("균등 분할, 합 1", () => {
    expect(equalSizes(2)).toEqual([0.5, 0.5]);
    expect(equalSizes(4).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
});

describe("resizeSplitTree", () => {
  it("splitId 매칭 노드의 sizes 만 교체(불변·중첩)", () => {
    const t = split("a", "row", [0.5, 0.5], [
      splitLeaf("p1"),
      split("b", "col", [0.5, 0.5], [splitLeaf("p2"), splitLeaf("p3")]),
    ]);
    const r = resizeSplitTree(t, "b", [0.7, 0.3]);
    expect(r).not.toBe(t); // 불변(새 객체)
    const inner = (r as Extract<typeof r, { type: "split" }>).children[1];
    expect((inner as Extract<typeof inner, { type: "split" }>).sizes).toEqual([0.7, 0.3]);
    // 부모는 그대로
    expect((r as Extract<typeof r, { type: "split" }>).sizes).toEqual([0.5, 0.5]);
  });

  it("children 길이와 sizes 길이 불일치면 무시", () => {
    const t = split("a", "row", [0.5, 0.5], [splitLeaf("p1"), splitLeaf("p2")]);
    expect(resizeSplitTree(t, "a", [0.3, 0.3, 0.4])).toEqual(t);
  });
});

describe("findSplitTree / leavesOf", () => {
  const t = split("a", "row", [0.5, 0.5], [
    splitLeaf("p1"),
    split("b", "col", [0.5, 0.5], [splitLeaf("p2"), splitLeaf("p3")]),
  ]);
  it("split id 존재 여부", () => {
    expect(findSplitTree(t, "b")).toBe(true);
    expect(findSplitTree(t, "zzz")).toBe(false);
  });
  it("leaf 값 순서대로 수집", () => {
    expect(leavesOf(t)).toEqual(["p1", "p2", "p3"]);
  });
});

describe("removeLeaf", () => {
  it("leaf 제거 후 자식 1개면 split 붕괴", () => {
    const t = split("a", "row", [0.5, 0.5], [splitLeaf("p1"), splitLeaf("p2")]);
    const { tree, removed } = removeLeaf(t, (v) => v === "p2");
    expect(removed).toBe("p2");
    expect(tree).toEqual(splitLeaf("p1")); // 붕괴
  });

  it("3자식에서 1개 제거 → 남은 children + sizes 균등 재정규화", () => {
    const t = split("a", "row", [0.6, 0.2, 0.2], [
      splitLeaf("p1"),
      splitLeaf("p2"),
      splitLeaf("p3"),
    ]);
    const { tree } = removeLeaf(t, (v) => v === "p2");
    const s = tree as Extract<SplitTree<string>, { type: "split" }>;
    expect(leavesOf(s)).toEqual(["p1", "p3"]);
    expect(s.sizes).toEqual([0.5, 0.5]); // count 변경 → 균등
  });

  it("전부 제거되면 null", () => {
    const t = splitLeaf("p1");
    expect(removeLeaf(t, () => true)).toEqual({ tree: null, removed: "p1" });
  });
});

describe("insertBeside", () => {
  it("leaf 분할 → 새 split(dir, before 순서, 균등 sizes)", () => {
    n = 0;
    const t = splitLeaf("p1");
    const r = insertBeside(t, (v) => v === "p1", "row", false, "p2", newId);
    expect(r).toEqual(
      split("s1", "row", [0.5, 0.5], [splitLeaf("p1"), splitLeaf("p2")]),
    );
  });

  it("before=true 면 새 leaf 가 앞", () => {
    n = 0;
    const t = splitLeaf("p1");
    const r = insertBeside(t, (v) => v === "p1", "col", true, "p2", newId);
    expect(leavesOf(r)).toEqual(["p2", "p1"]);
  });

  it("같은 dir split 의 직속 형제면 중첩 없이 삽입 + sizes 균등", () => {
    const t = split("a", "row", [0.5, 0.5], [splitLeaf("p1"), splitLeaf("p2")]);
    const r = insertBeside(t, (v) => v === "p1", "row", false, "p3", newId);
    const s = r as Extract<SplitTree<string>, { type: "split" }>;
    expect(s.id).toBe("a"); // 기존 split 유지(중첩 회피)
    expect(leavesOf(s)).toEqual(["p1", "p3", "p2"]);
    expect(s.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });
});

describe("serialize/deserialize 라운드트립", () => {
  it("구조·순서·sizes·leaf 값 보존, split id 는 재생성", () => {
    const t = split("OLD-a", "row", [0.7, 0.3], [
      splitLeaf("p1"),
      split("OLD-b", "col", [0.4, 0.6], [splitLeaf("p2"), splitLeaf("p3")]),
    ]);
    const snap = serializeSplitTree(t, (v) => v);
    // 직렬화는 split id 를 담지 않는다(재생성 대상).
    expect(JSON.stringify(snap)).not.toContain("OLD-");
    n = 100;
    const back = deserializeSplitTree(snap, (s) => s, newId);
    // 구조·순서·sizes·leaf 동일
    expect(leavesOf(back)).toEqual(["p1", "p2", "p3"]);
    const bs = back as Extract<SplitTree<string>, { type: "split" }>;
    expect(bs.dir).toBe("row");
    expect(bs.sizes).toEqual([0.7, 0.3]);
    const inner = bs.children[1] as Extract<SplitTree<string>, { type: "split" }>;
    expect(inner.sizes).toEqual([0.4, 0.6]);
    // id 는 새로 생성됨(OLD- 아님)
    expect(bs.id).not.toBe("OLD-a");
    expect(bs.id.startsWith("s")).toBe(true);
  });

  it("leaf 변환기로 페이로드 매핑(L→S, S→L)", () => {
    const t = split("a", "row", [0.5, 0.5], [splitLeaf(1), splitLeaf(2)]);
    const snap = serializeSplitTree(t, (v: number) => String(v));
    const back = deserializeSplitTree(snap, (s) => Number(s), newId);
    expect(leavesOf(back)).toEqual([1, 2]);
  });
});
