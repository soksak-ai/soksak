import { describe, expect, it } from "vitest";
import { shouldTouch, TOUCH_THROTTLE_MS } from "./autoLock";

// [단계③] 활동 통지 스로틀 — 마지막 통지 후 THROTTLE 경과 시에만 백엔드 secret_touch 를 친다(스팸 방지).
describe("autoLock shouldTouch", () => {
  it("첫 활동(lastTouch=0)은 통지", () => {
    expect(shouldTouch(0, TOUCH_THROTTLE_MS)).toBe(true);
  });

  it("THROTTLE 미만이면 억제, 이상이면 통지", () => {
    const last = 100_000;
    expect(shouldTouch(last, last + TOUCH_THROTTLE_MS - 1)).toBe(false);
    expect(shouldTouch(last, last + TOUCH_THROTTLE_MS)).toBe(true);
    expect(shouldTouch(last, last + TOUCH_THROTTLE_MS + 5_000)).toBe(true);
  });
});
