// DOM 주소 path 계약 고정 — 왕복 항등·안정 세그먼트·불량 거부. selector 추측 0.
import { describe, expect, it } from "vitest";
import {
  formatAddress,
  isParseError,
  NODE_PATH_RE,
  parseAddress,
  type AddressParts,
} from "./address";

const ok = (s: string): AddressParts => {
  const r = parseAddress(s);
  if (isParseError(r)) throw new Error(`예상치 못한 파싱 실패: ${s} → ${r.error}`);
  return r;
};

describe("parseAddress — 구조 분해", () => {
  it("뷰 노드 전체 경로", () => {
    expect(ok("win/main/proj/myproj/content/pane/0/view/soksak-plugin-acp-studio.studio/node/submit")).toEqual({
      window: "main",
      project: "myproj",
      region: "content",
      pane: "0",
      view: "soksak-plugin-acp-studio.studio",
      node: "submit",
    });
  });
  it("생략형 — 활성 기준(win/proj/pane 생략)", () => {
    expect(ok("content/view/soksak-plugin-mailbox.inbox/node/msg/3")).toEqual({
      region: "content",
      view: "soksak-plugin-mailbox.inbox",
      node: "msg/3",
    });
  });
  it("호스트 크롬", () => {
    expect(ok("win/main/chrome/modal/consent/agree")).toEqual({
      window: "main",
      chrome: "modal/consent/agree",
    });
  });
  it("chrome 은 win 생략 가능", () => {
    expect(ok("chrome/tab/content/c1")).toEqual({ chrome: "tab/content/c1" });
  });
  it("pane active", () => {
    expect(ok("content/pane/active/view/x.y/node/n").pane).toBe("active");
  });
  it("앞뒤 슬래시 정규화", () => {
    expect(ok("/content/view/a.b/node/n/")).toEqual({
      region: "content",
      view: "a.b",
      node: "n",
    });
  });
});

describe("왕복 항등 — parse∘format", () => {
  const cases = [
    "win/main/proj/p/content/pane/0/view/a.b/node/submit",
    "content/view/x.y/node/msg/3",
    "win/w2/chrome/modal/consent/agree",
    "chrome/tab/left/files",
    "left/view/soksak-plugin-memo.panel/node/save",
  ];
  for (const c of cases) {
    it(`format(parse("${c}")) === "${c}"`, () => {
      expect(formatAddress(ok(c))).toBe(c);
    });
  }
});

describe("불량 입력 — 명확한 에러(추측 0)", () => {
  const bad = [
    "",
    "   ",
    "win", // 라벨 없음
    "win/main", // 창 뒤 경로 없음
    "content/region/middle", // region 오타는 unknown segment
    "content/pane/x", // pane idx|active 아님
    "content/view/noplugin", // view 키에 점 없음
    "content/node/", // node path 없음
    "win/BAD UPPER/content", // 라벨 대문자/공백
    "content/view/a.b/node/Bad", // node path 대문자
  ];
  for (const b of bad) {
    it(`거부: "${b}"`, () => {
      expect(isParseError(parseAddress(b))).toBe(true);
    });
  }
});

describe("NODE_PATH_RE — 노드 path 형식", () => {
  it("유효", () => {
    expect(NODE_PATH_RE.test("submit")).toBe(true);
    expect(NODE_PATH_RE.test("msg/3")).toBe(true);
    expect(NODE_PATH_RE.test("a.b/c-d/e9")).toBe(true);
  });
  it("무효", () => {
    expect(NODE_PATH_RE.test("Submit")).toBe(false); // 대문자
    expect(NODE_PATH_RE.test("/leading")).toBe(false);
    expect(NODE_PATH_RE.test("a//b")).toBe(false);
    expect(NODE_PATH_RE.test("a b")).toBe(false);
  });
});

describe("멀티윈도우 — win 세그먼트 네임스페이스", () => {
  it("다른 창은 다른 주소", () => {
    const a = ok("win/main/content/view/x.y/node/n");
    const b = ok("win/w2/content/view/x.y/node/n");
    expect(a.window).toBe("main");
    expect(b.window).toBe("w2");
    expect(formatAddress(a)).not.toBe(formatAddress(b));
  });
});
