import { useEffect } from "react";
import { useCloseConfirm } from "../state/closeConfirm";
import { useT, type MsgKey } from "../i18n";

// blocking code → status.* 키(사람 표시). 플러그인이 보낸 message 등 그 외 이유는 문자열 그대로.
const STATUS_LABEL: Record<string, MsgKey> = {
  dirty: "status.dirty",
  busy: "status.busy",
  running: "status.running",
};

// 닫기 확인창(R6/§5) — closeConfirm.pending 이 있을 때만 뜬다. 위험 판정은 이미 끝났고
// 여기선 이유 표시 + 확인/취소만 한다. overlay 클릭·Escape = 취소.
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
