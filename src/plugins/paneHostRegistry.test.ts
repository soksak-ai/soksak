import { describe, expect, test } from "vitest";
import { registerPaneHost, getPaneHost } from "./paneHostRegistry";

// element 참조만 검증 — DOM 불요. {} 캐스팅으로 동일성(===)만 본다.
const ref = (): HTMLElement => ({}) as HTMLElement;

describe("paneHostRegistry", () => {
  test("등록한 paneId 의 element 를 직접 반환한다(셀렉터 없이)", () => {
    const el = ref();
    registerPaneHost("reg-a", el);
    expect(getPaneHost("reg-a")).toBe(el);
  });

  test("미등록 paneId 는 undefined", () => {
    expect(getPaneHost("reg-none")).toBeUndefined();
  });

  test("dispose 가 등록을 해지한다", () => {
    const el = ref();
    const off = registerPaneHost("reg-b", el);
    off();
    expect(getPaneHost("reg-b")).toBeUndefined();
  });

  test("같은 paneId 재등록 = 최신 element 로 교체", () => {
    const a = ref();
    const b = ref();
    registerPaneHost("reg-c", a);
    registerPaneHost("reg-c", b);
    expect(getPaneHost("reg-c")).toBe(b);
  });

  test("교체 후 옛 dispose 는 새 등록을 지우지 않는다(생명주기 race 안전)", () => {
    const a = ref();
    const b = ref();
    const offA = registerPaneHost("reg-d", a);
    registerPaneHost("reg-d", b);
    offA(); // a 의 해지 — 이미 b 로 교체됐으므로 무효여야 한다
    expect(getPaneHost("reg-d")).toBe(b);
  });
});
