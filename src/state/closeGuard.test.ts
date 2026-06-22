import { describe, expect, it } from "vitest";
import {
  STATUS_BLOCKING,
  viewCloseReason,
  contentCloseReasons,
} from "./closeGuard";
import type { View, ViewStatus, ContentArea } from "./sessions";

// 테스트용 뷰/콘텐츠 팩토리 — status 만 다르게.
const fileView = (status?: ViewStatus, id = "v1"): View => ({
  id,
  kind: "file",
  title: "a.ts",
  path: "/a.ts",
  mode: "code",
  status,
});

const leafContent = (views: View[]): ContentArea => ({
  id: "c1",
  title: "1",
  layout: {
    type: "leaf",
    group: { id: "g1", views, activeViewId: views[0]?.id ?? "" },
  },
  activeGroupId: "g1",
});

const splitContent = (left: View[], right: View[]): ContentArea => ({
  id: "c1",
  title: "1",
  layout: {
    type: "split",
    id: "s1",
    dir: "row",
    sizes: [0.5, 0.5],
    children: [
      { type: "leaf", group: { id: "g1", views: left, activeViewId: left[0]?.id ?? "" } },
      { type: "leaf", group: { id: "g2", views: right, activeViewId: right[0]?.id ?? "" } },
    ],
  },
  activeGroupId: "g1",
});

describe("STATUS_BLOCKING 어휘(R2)", () => {
  it("blocking code 는 dirty·busy·running 셋", () => {
    expect([...STATUS_BLOCKING]).toEqual(["dirty", "busy", "running"]);
  });
});

describe("viewCloseReason — 뷰 단위 닫기 위험 판정", () => {
  it("status 미보고면 null(즉시 닫힘)", () => {
    expect(viewCloseReason(fileView(undefined))).toBeNull();
  });

  it("표시 전용 code(blocking 아님)는 null", () => {
    expect(viewCloseReason(fileView({ code: "idle" }))).toBeNull();
    expect(viewCloseReason(fileView({ code: "synced" }))).toBeNull();
  });

  it("blocking code + message 면 message 를 이유로", () => {
    expect(viewCloseReason(fileView({ code: "dirty", message: "미저장 변경" }))).toBe(
      "미저장 변경",
    );
    expect(
      viewCloseReason(fileView({ code: "running", message: "npm run dev" })),
    ).toBe("npm run dev");
  });

  it("blocking code + message 없으면 code 를 폴백 이유로", () => {
    expect(viewCloseReason(fileView({ code: "busy" }))).toBe("busy");
  });
});

describe("contentCloseReasons — 콘텐츠(분할) 단위 이유 모음", () => {
  it("빈/비-blocking 뷰만 있으면 빈 배열", () => {
    expect(contentCloseReasons(leafContent([]))).toEqual([]);
    expect(contentCloseReasons(leafContent([fileView({ code: "idle" })]))).toEqual([]);
  });

  it("blocking 뷰 1개면 그 이유 1건", () => {
    expect(
      contentCloseReasons(leafContent([fileView({ code: "dirty", message: "미저장" })])),
    ).toEqual(["미저장"]);
  });

  it("split 그리드의 여러 그룹을 모두 훑어 blocking 만 모은다", () => {
    const c = splitContent(
      [fileView({ code: "dirty", message: "L" }, "l1"), fileView({ code: "idle" }, "l2")],
      [fileView({ code: "busy", message: "R" }, "r1")],
    );
    expect(contentCloseReasons(c)).toEqual(["L", "R"]);
  });
});
