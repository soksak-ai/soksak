import { useEffect } from "react";
import { useCloseConfirm } from "../state/closeConfirm";
import { useT, type MsgKey } from "../i18n";

// blocking code → status.* key (human-readable). Other reasons, such as a plugin message, stay as the raw string.
const STATUS_LABEL: Record<string, MsgKey> = {
  dirty: "status.dirty",
  busy: "status.busy",
  running: "status.running",
};

// Close confirmation dialog (R6/§5) — shown only when closeConfirm.pending exists. The risk
// verdict is already made; this component shows the reasons and confirm/cancel only.
// Overlay click and Escape = cancel.
export function ConfirmCloseModal() {
  const t = useT();
  const pending = useCloseConfirm((s) => s.pending);
  const confirm = useCloseConfirm((s) => s.confirm);
  const cancel = useCloseConfirm((s) => s.cancel);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cancel]);

  if (!pending) return null;
  return (
    <div className="dmodal-overlay" onMouseDown={cancel}>
      <div
        className="dmodal-card dconfirm"
        data-node="modal/confirm-close"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dconfirm-title">{t("confirm.closeTitle")}</div>
        <ul className="dconfirm-reasons">
          {pending.reasons.map((r, i) => (
            <li key={i}>{STATUS_LABEL[r] ? t(STATUS_LABEL[r]) : r}</li>
          ))}
        </ul>
        <div className="dconfirm-actions">
          <button
            type="button"
            className="dbtn"
            data-node="modal/confirm-close/cancel"
            onClick={cancel}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="dbtn dbtn-danger"
            data-node="modal/confirm-close/confirm"
            onClick={confirm}
          >
            {t("confirm.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
