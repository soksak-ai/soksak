// 알림 라우팅 — 포커스면 인앱 배너, 비포커스면 OS 알림(extra 에 deepLink+발신 창). Tauri 플러그인은 mock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendNotification = vi.fn();
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: (...a: unknown[]) => sendNotification(...a),
  onAction: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  onOpenUrl: vi.fn(async () => {}),
  getCurrent: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "main" }),
}));

import { pushNotification } from "./notify";
import { useNotify } from "../state/notify";

beforeEach(() => {
  sendNotification.mockClear();
  useNotify.setState({ banners: [] });
});
afterEach(() => vi.restoreAllMocks());

describe("pushNotification 라우팅", () => {
  it("포커스 → 인앱 배너(OS 알림 미발송)", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await pushNotification({ title: "빌드 완료", body: "성공", deepLink: "soksak://cmd/mailbox.open?id=m1" });
    const banners = useNotify.getState().banners;
    expect(banners).toHaveLength(1);
    expect(banners[0].title).toBe("빌드 완료");
    expect(banners[0].deepLink).toBe("soksak://cmd/mailbox.open?id=m1");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("비포커스 → OS 알림(extra 에 deepLink+win), 배너 없음", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await pushNotification({ title: "테스트 실패", deepLink: "soksak://cmd/mailbox.open?id=m2" });
    expect(useNotify.getState().banners).toHaveLength(0);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const arg = sendNotification.mock.calls[0][0] as { title: string; extra: Record<string, unknown> };
    expect(arg.title).toBe("테스트 실패");
    expect(arg.extra).toEqual({ deepLink: "soksak://cmd/mailbox.open?id=m2", win: "main" });
  });

  it("tag 는 배너 id(같은 tag 재발행 시 교체)", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await pushNotification({ title: "A", tag: "build" });
    await pushNotification({ title: "B", tag: "build" });
    const banners = useNotify.getState().banners;
    expect(banners).toHaveLength(1);
    expect(banners[0].title).toBe("B");
  });
});
