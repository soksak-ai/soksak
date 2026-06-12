import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rafThrottle } from "./rafThrottle";

// rAF 를 수동 제어: 콜백을 모아 두고 frame() 으로 한 프레임을 진행시킨다.
let queue: FrameRequestCallback[] = [];
let nextId = 1;

beforeEach(() => {
  queue = [];
  nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push(cb);
    return nextId++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    // 테스트 단순화: id 매칭 대신 전체 비움(rafThrottle 은 동시에 1개만 예약).
    void id;
    queue = [];
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function frame() {
  const cbs = queue;
  queue = [];
  for (const cb of cbs) cb(performance.now());
}

describe("rafThrottle", () => {
  it("한 프레임 안의 다중 호출을 마지막 인자 1회로 합친다", () => {
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t(1);
    t(2);
    t(3);
    expect(fn).not.toHaveBeenCalled();
    frame();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });

  it("프레임마다 최대 1회 실행된다", () => {
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t("a");
    frame();
    t("b");
    t("c");
    frame();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, "a");
    expect(fn).toHaveBeenNthCalledWith(2, "c");
  });

  it("flush() 는 대기 중인 호출을 즉시 실행한다(마지막 값 커밋)", () => {
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t(1);
    t(2);
    t.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(2);
    frame(); // 이후 프레임에서 중복 실행 없음
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("대기 없는 flush() 는 아무것도 하지 않는다", () => {
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel() 은 대기 중인 호출을 버린다", () => {
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t(1);
    t.cancel();
    frame();
    expect(fn).not.toHaveBeenCalled();
    t.flush(); // cancel 후 flush 도 no-op
    expect(fn).not.toHaveBeenCalled();
  });

  it("실행 후 다시 호출하면 새 프레임에 예약된다", () => {
    const fn = vi.fn();
    const t = rafThrottle(fn);
    t(1);
    frame();
    t(2);
    frame();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
