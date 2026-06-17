// 알림 = 푸시 동급 1급 객체(사용자 제약). 리치 페이로드(제목/본문/아이콘/이미지/소리/딥링크/액션).
// 포커스 시 인앱 배너(NotifyHost), 비포커스 시 OS 알림(모바일식 푸시) — 둘 다 동일 페이로드.
// 활성화(클릭/액션/외부 soksak://) 는 deepLink 해석기로 라우팅(권한·danger 게이트 유지).

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
  onAction,
} from "@tauri-apps/plugin-notification";
import { onOpenUrl, getCurrent } from "@tauri-apps/plugin-deep-link";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useNotify, type NotifyAction } from "../state/notify";
import { playSound } from "../ui/sound";
import { resolveDeepLink } from "./deepLink";

export interface NotificationInput {
  title: string;
  body?: string;
  icon?: string;
  image?: string;
  sound?: string;
  deepLink?: string; // soksak://cmd/... — 클릭 시 활성화
  tag?: string; // 중복 제거/교체 키
  actions?: NotifyAction[];
  data?: Record<string, unknown>;
}

let seq = 0;

// 알림 발행 — 포커스면 인앱 배너, 아니면 OS 알림. 소리는 양쪽 공통(best-effort). 송신측 1회만
// (크로스윈도우 watch 측은 재발화 금지 — 메일함 규약).
export async function pushNotification(n: NotificationInput): Promise<void> {
  const id = n.tag ?? `ntf-${Date.now()}-${seq++}`;
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
    const label = getCurrentWebviewWindow().label;
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    // extra 로 deepLink+발신 창 라벨 전달 → onAction(클릭)이 정확히 라우팅(멀티윈도우 중복 방지).
    sendNotification({
      title: n.title,
      body: n.body,
      extra: { deepLink: n.deepLink ?? null, win: label },
    } as Parameters<typeof sendNotification>[0]);
  } catch (e) {
    console.warn("OS 알림 발송 실패:", e);
  }
}

// 앱 시작 1회 — OS 알림 클릭(onAction)·외부 딥링크(onOpenUrl)·콜드스타트 진입을 deepLink 로 라우팅.
// 플러그인 호스트(command 레지스트리) 준비 후 호출해야 한다(initPluginHost 다음).
export async function initNotify(): Promise<void> {
  const label = getCurrentWebviewWindow().label;
  try {
    await onAction((notif) => {
      const extra = (notif as { extra?: Record<string, unknown> }).extra;
      // 멀티윈도우 중복 처리 방지 — 발신 창만 처리. 그 창이 닫혔으면 클릭 유실(메시지는 보관됨).
      if (extra?.win && extra.win !== label) return;
      const dl = extra?.deepLink;
      if (typeof dl === "string") void resolveDeepLink(dl);
    });
  } catch (e) {
    console.warn("알림 onAction 등록 실패:", e);
  }
  try {
    await onOpenUrl((urls) => {
      for (const u of urls) void resolveDeepLink(u);
    });
  } catch (e) {
    console.warn("딥링크 onOpenUrl 등록 실패:", e);
  }
  try {
    const initial = await getCurrent();
    if (initial) for (const u of initial) void resolveDeepLink(u);
  } catch {
    // 콜드스타트 진입 없음 — 정상.
  }
}
