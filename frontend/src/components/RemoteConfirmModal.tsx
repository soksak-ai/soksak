import { useEffect, useState } from "react";
import { useOverlayActive } from "../state/ui";
import {
  activeRequest,
  useRemoteConfirm,
  DEFAULT_CONFIRM_TTL_SECS,
} from "../state/remoteConfirm";
import { useT } from "../i18n";

// Remote destructive confirm dialog (phone-link safety model) — a destructive action sent from the
// phone **always** waits for a human decision on the desktop (plan RULE 0 "danger is always a
// desktop confirm"). Authority is in the core (remote::confirm); this dialog is a thin presentation
// — it only sends Approve/Deny through remote_confirm_resolve.
// Only the queue head (activeRequest) is shown — concurrent requests are serialized by the store
// (one decision at a time).
// Reuses the ConfirmCloseModal pattern (dmodal-overlay/dmodal-card/dconfirm*/dbtn) — 0 bespoke styles.
//
// Safety: an overlay click or Escape is **Deny, not cancel** (unlike the close-confirm dialog —
// reduced to an explicit refusal so that no decision means no execution). Leaving the modal without
// a decision still AUTO-DENYs via the core TTL, so no path executes the destructive action.
export function RemoteConfirmModal() {
  const t = useT();
  const req = useRemoteConfirm(activeRequest);
  const resolve = useRemoteConfirm((s) => s.resolve);
  const expire = useRemoteConfirm((s) => s.expire);
  // The input gate, and the fourth layer of `surfaceShown` — a native surface is composited above
  // the document and no z-index puts it under this card.
  useOverlayActive(!!req);

  // TTL countdown (mirror display of the core TTL) — reset whenever the request changes. At 0 the head expires → next one promoted.
  const ttl = req?.ttl_secs ?? DEFAULT_CONFIRM_TTL_SECS;
  const [remaining, setRemaining] = useState(ttl);

  useEffect(() => {
    if (!req) return;
    setRemaining(req.ttl_secs ?? DEFAULT_CONFIRM_TTL_SECS);
    const id = req.request_id;
    const timer = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          // The core already AUTO-DENYed — drop from the display queue only (no resolve sent).
          expire(id);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [req?.request_id, expire]);

  // Deny = explicit refusal (overlay and Escape are Deny too — no decision reduces to no execution). resolve(false) → 0 core dispatch.
  const deny = () => resolve(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        deny();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // deny depends on the resolve reference only (a zustand action is a stable reference) — no rebinding per req.
  }, [resolve]);

  if (!req) return null; // Idle adds no DOM — an empty queue renders nothing.

  return (
    <div className="dmodal-overlay" onMouseDown={deny}>
      <div
        className="dmodal-card dconfirm dremote-confirm"
        data-node="remote-confirm"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dconfirm-title dremote-confirm-title">
          <span className="dremote-confirm-danger" aria-hidden="true">
            ⚠
          </span>
          {t("remoteConfirm.title")}
        </div>
        <div className="dremote-confirm-rows">
          <div className="dremote-confirm-row">
            <span className="dremote-confirm-label">
              {t("remoteConfirm.device")}
            </span>
            <span className="dremote-confirm-value" data-node="remote-confirm/device">
              {req.device_id}
            </span>
          </div>
          <div className="dremote-confirm-row">
            <span className="dremote-confirm-label">
              {t("remoteConfirm.command")}
            </span>
            <span
              className="dremote-confirm-value dremote-confirm-mono"
              data-node="remote-confirm/command"
            >
              {req.command}
              {req.params ? (
                <span className="dremote-confirm-params"> {req.params}</span>
              ) : null}
            </span>
          </div>
        </div>
        <div className="dremote-confirm-notice">
          {t("remoteConfirm.autoDeny", { secs: remaining })}
        </div>
        <div className="dconfirm-actions">
          <button
            type="button"
            className="dbtn dbtn-danger"
            data-node="remote-confirm/deny"
            onClick={deny}
          >
            {t("remoteConfirm.deny")}
          </button>
          <button
            type="button"
            className="dbtn dbtn-acc"
            data-node="remote-confirm/approve"
            onClick={() => resolve(true)}
          >
            {t("remoteConfirm.approve")}
          </button>
        </div>
      </div>
    </div>
  );
}
