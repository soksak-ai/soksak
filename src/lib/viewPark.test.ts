// 뷰 유효 가시성의 단일 진실 — 세 층(프로젝트·스페이스·탭)이 모두 참일 때만 보인다.
// RED 의 근거: 프로젝트 층이 빠져 있어, 비활성 프로젝트의 뷰가 "보인다"고 코어에 보고됐고
// 그 프로젝트의 네이티브 브라우저 webview 가 전환 후에도 화면에 남았다(실측 스냅샷).
import { describe, expect, it } from "vitest";
import { surfaceShown } from "./viewPark";

describe("뷰 유효 가시성 — 세 층 모두", () => {
  it("프로젝트가 비활성이면 스페이스·탭이 활성이어도 보이지 않는다", () => {
    expect(surfaceShown(false, true, true)).toBe(false);
  });

  it("스페이스가 비활성이면 보이지 않는다", () => {
    expect(surfaceShown(true, false, true)).toBe(false);
  });

  it("탭이 비활성이면 보이지 않는다", () => {
    expect(surfaceShown(true, true, false)).toBe(false);
  });

  it("세 층 모두 활성일 때만 보인다", () => {
    expect(surfaceShown(true, true, true)).toBe(true);
  });
});
