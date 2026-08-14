// Header action registry contract test — register/replace/dispose/subscribe (same shape as statusBarItems).
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

describe("headerActions registry", () => {
  it("returns actions in registration order", () => {
    add({ id: "a", label: "A", onClick() {} });
    add({ id: "b", label: "B", onClick() {} });
    expect(getHeaderActions().map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("re-registering the same id replaces it, no duplicate", () => {
    add({ id: "a", label: "A", onClick() {} });
    add({ id: "a", label: "A2", onClick() {} });
    const r = getHeaderActions().filter((x) => x.id === "a");
    expect(r).toHaveLength(1);
    expect(r[0].label).toBe("A2");
  });

  it("the dispose function removes the action", () => {
    const d = add({ id: "a", label: "A", onClick() {} });
    d();
    expect(getHeaderActions().some((x) => x.id === "a")).toBe(false);
  });

  it("notifies subscribers on registration", () => {
    const cb = vi.fn();
    cleanup.push(subscribeHeaderActions(cb));
    add({ id: "a", label: "A", onClick() {} });
    expect(cb).toHaveBeenCalled();
  });
});
