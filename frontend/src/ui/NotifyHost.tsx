// In-app notification banner host — rendered once at the app root (App.tsx). Focus-state
// notifications stack at the top right; a body or action click routes the deep link (permission
// and danger gates kept), and each banner auto-dismisses after a delay.

import { memo, useEffect } from "react";
import { useNotify, type NotifyBanner } from "../state/notify";
import { resolveDeepLink } from "../lib/deepLink";
import { useT } from "../i18n";

const AUTO_DISMISS_MS = 6000;

function BannerCard({ b }: { b: NotifyBanner }) {
  const dismiss = useNotify((s) => s.dismiss);
  const t = useT();

  useEffect(() => {
    const timer = setTimeout(() => dismiss(b.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
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
        title={b.deepLink ? t("common.open") : undefined}
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
        aria-label={t("common.close")}
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
    <div className="notifications">
      {banners.map((b) => (
        <BannerCard key={b.id} b={b} />
      ))}
    </div>
  );
});
