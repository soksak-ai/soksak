// 헤더 액션 레지스트리 계약 테스트 — 등록/교체/해지/구독(statusBarItems 와 동형).
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHeaderAction, getHeaderActions, subscribeHeaderActions } from "./headerActions";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) d();
});
const add = (a: Parameters<typeof registerHeaderAction>[0]) => {
  const d = registerHeaderAction(a);
  cleanup.push(d);
  return d;
};

describe("headerActions 레지스트리", () => {
  it("등록 순서대로 getHeaderActions", () => {
    add({ id: "a", label: "A", onClick() {} });
    add({ id: "b", label: "B", onClick() {} });
    expect(getHeaderActions().map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("같은 id 재등록은 교체(중복 없음)", () => {
    add({ id: "a", label: "A", onClick() {} });
    add({ id: "a", label: "A2", onClick() {} });
    const r = getHeaderActions().filter((x) => x.id === "a");
    expect(r).toHaveLength(1);
    expect(r[0].label).toBe("A2");
  });

  it("해지 함수 → 제거", () => {
    const d = add({ id: "a", label: "A", onClick() {} });
    d();
    expect(getHeaderActions().some((x) => x.id === "a")).toBe(false);
  });

  it("subscribe → 등록 시 통지", () => {
    const cb = vi.fn();
    cleanup.push(subscribeHeaderActions(cb));
    add({ id: "a", label: "A", onClick() {} });
    expect(cb).toHaveBeenCalled();
  });
});
