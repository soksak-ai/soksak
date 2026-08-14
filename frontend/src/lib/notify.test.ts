// Notification routing — in-app banner when focused, OS notification when not (extra: deepLink +
// sending window). Mock the shell at one boundary (../framework); a test that names the vendor
// forces a framework swap to rewrite the test too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendNotification = vi.fn();
vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  notification: {
    isPermissionGranted: vi.fn(async () => true),
    requestPermission: vi.fn(async () => "granted"),
    send: (...a: unknown[]) => sendNotification(...a),
    onAction: vi.fn(async () => () => {}),
  },
  deepLink: {
    onOpenUrl: vi.fn(async () => () => {}),
    current: vi.fn(async () => null),
  },
  currentWindow: () => ({ label: "main" }),
}));

import { pushNotification } from "./notify";
import { useNotify } from "../state/notify";

beforeEach(() => {
  sendNotification.mockClear();
  useNotify.setState({ banners: [] });
});
afterEach(() => vi.restoreAllMocks());

describe("pushNotification routing", () => {
  it("focused: an in-app banner, and no OS notification", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await pushNotification({ title: "Build finished", body: "succeeded", deepLink: "soksak://cmd/mailbox.open?id=m1" });
    const banners = useNotify.getState().banners;
    expect(banners).toHaveLength(1);
    expect(banners[0].title).toBe("Build finished");
    expect(banners[0].deepLink).toBe("soksak://cmd/mailbox.open?id=m1");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("unfocused: an OS notification with deepLink and win in extra, and no banner", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await pushNotification({ title: "Test failed", deepLink: "soksak://cmd/mailbox.open?id=m2" });
    expect(useNotify.getState().banners).toHaveLength(0);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const arg = sendNotification.mock.calls[0][0] as { title: string; extra: Record<string, unknown> };
    expect(arg.title).toBe("Test failed");
    expect(arg.extra).toEqual({ deepLink: "soksak://cmd/mailbox.open?id=m2", win: "main" });
  });

  it("tag is the banner id — the same tag replaces the banner", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    await pushNotification({ title: "A", tag: "build" });
    await pushNotification({ title: "B", tag: "build" });
    const banners = useNotify.getState().banners;
    expect(banners).toHaveLength(1);
    expect(banners[0].title).toBe("B");
  });
});
