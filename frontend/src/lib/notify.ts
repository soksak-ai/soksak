// A notification is an object of the same grade as push (user constraint). Rich payload
// (title/body/icon/image/sound/deepLink/actions).
// Focused: in-app banner (NotifyHost). Unfocused: OS notification (mobile-style push) — same payload for both.
// Activation (click, action, external soksak://) routes through the deepLink resolver (permission and danger gates kept).

import { moduleState } from "../lib/moduleState";
import { currentWindow, deepLink, notification } from "../framework";
import { useNotify, type NotifyAction } from "../state/notify";
import { playSound } from "../ui/sound";
import { resolveDeepLink } from "./deepLink";

export interface NotificationInput {
  title: string;
  body?: string;
  icon?: string;
  image?: string;
  sound?: string;
  deepLink?: string; // soksak://cmd/... — activated on click
  tag?: string; // dedupe/replace key
  actions?: NotifyAction[];
  data?: Record<string, unknown>;
}

// Outside the hot-swap boundary — a fresh value drops both the "already done" memory and the lazy initialization,
// and the filler does not fill again.
const ms = moduleState("lib/notify#state", () => ({
  seq: 0,
}));
// Publish a notification — in-app banner when focused, OS notification otherwise. Sound is common
// to both (best-effort). Sender side once only (the cross-window watch side must not re-fire — mailbox convention).
export async function pushNotification(n: NotificationInput): Promise<void> {
  const id = n.tag ?? `ntf-${Date.now()}-${ms.seq++}`;
  if (n.sound) void playSound(n.sound);

  const focused = typeof document !== "undefined" && document.hasFocus();
  if (focused) {
    useNotify.getState().show({
      id,
      title: n.title,
      body: n.body,
      icon: n.icon,
      image: n.image,
      deepLink: n.deepLink,
      actions: n.actions,
    });
    return;
  }
  await osNotify(n);
}

async function osNotify(n: NotificationInput): Promise<void> {
  try {
    const label = currentWindow().label;
    let granted = await notification.isPermissionGranted();
    if (!granted) granted = (await notification.requestPermission()) === "granted";
    if (!granted) return;
    // Pass deepLink plus the sending window label in extra → onAction (click) routes exactly (prevents multi-window duplicates).
    notification.send({
      title: n.title,
      body: n.body,
      extra: { deepLink: n.deepLink ?? null, win: label },
    } as Parameters<typeof notification.send>[0]);
  } catch (e) {
    console.warn("OS notification send failed:", e);
  }
}

// Once at app start — routes OS notification clicks (onAction), external deep links (onOpenUrl) and
// cold-start entry through deepLink. Call after the plugin host (command registry) is ready (after initPluginHost).
export async function initNotify(): Promise<void> {
  const label = currentWindow().label;
  try {
    await notification.onAction((notif) => {
      const extra = (notif as { extra?: Record<string, unknown> }).extra;
      // Prevents duplicate handling across windows — only the sending window handles it. If that window is closed the click is lost (the message is retained).
      if (extra?.win && extra.win !== label) return;
      const dl = extra?.deepLink;
      if (typeof dl === "string") void resolveDeepLink(dl);
    });
  } catch (e) {
    console.warn("notification onAction registration failed:", e);
  }
  try {
    await deepLink.onOpenUrl((urls) => {
      for (const u of urls) void resolveDeepLink(u);
    });
  } catch (e) {
    console.warn("deep link onOpenUrl registration failed:", e);
  }
  try {
    const initial = await deepLink.current();
    if (initial) for (const u of initial) void resolveDeepLink(u);
  } catch {
    // No cold-start entry — normal.
  }
}
