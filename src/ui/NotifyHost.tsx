// 인앱 알림 배너 호스트 — 앱 루트에 1회 렌더(App.tsx). 포커스 상태 알림이 우상단에 쌓이고,
// 본문/액션 클릭 시 딥링크로 라우팅(권한·danger 게이트 유지), 일정 시간 후 자동 소멸.

import { memo, useEffect } from "react";
import { useNotify, type NotifyBanner } from "../state/notify";
import { resolveDeepLink } from "../lib/deepLink";

const AUTO_DISMISS_MS = 6000;

function BannerCard({ b }: { b: NotifyBanner }) {
  const dismiss = useNotify((s) => s.dismiss);

  useEffect(() => {
    const t = setTimeout(() => dismiss(b.id), AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [b.id, dismiss]);

  const go = (deepLink?: string) => {
    if (deepLink) void resolveDeepLink(deepLink);
    dismiss(b.id);
  };

  return (
    <div className="notify-banner" role="alert">
      <button
        type="button"
        className="notify-banner-main"
        onClick={() => go(b.deepLink)}
        title={b.deepLink ? "열기" : undefined}
      >
        {b.image && <img className="notify-banner-image" src={b.image} alt="" />}
        <span className="notify-banner-text">
          <span className="notify-banner-title">
            {b.icon ? `${b.icon} ` : ""}
            {b.title}
          </span>
          {b.body && <span className="notify-banner-body">{b.body}</span>}
        </span>
      </button>
      {b.actions && b.actions.length > 0 && (
        <div className="notify-banner-actions">
          {b.actions.map((a, i) => (
            <button
              key={i}
              type="button"
              className="notify-banner-action"
              onClick={() => go(a.deepLink)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="notify-banner-close"
        aria-label="닫기"
        onClick={() => dismiss(b.id)}
      >
        ×
      </button>
    </div>
  );
}

export const NotifyHost = memo(function NotifyHost() {
  const banners = useNotify((s) => s.banners);
  if (banners.length === 0) return null;
  return (
    <div className="notify-host">
      {banners.map((b) => (
        <BannerCard key={b.id} b={b} />
      ))}
    </div>
  );
});
