import { useEffect, useState } from "react";
import {
  activeRequest,
  useRemoteConfirm,
  DEFAULT_CONFIRM_TTL_SECS,
} from "../state/remoteConfirm";
import { useT } from "../i18n";

// 원격 destructive confirm 창(폰-링크 안전모델) — 폰이 보낸 destructive 액션은 **항상** 데스크톱
// 사람 결정을 기다린다(계획서 RULE 0 "danger 는 항상 데스크톱 confirm"). 권위는 Rust 에 있고
// (remote::confirm), 이 창은 얇은 표현 — Approve/Deny 를 remote_confirm_resolve 로 보낼 뿐이다.
// 큐 머리(activeRequest)만 보인다 — 동시 다발 요청은 store 가 직렬화(한 번에 한 결정).
// ConfirmCloseModal 패턴 재사용(dmodal-overlay/dmodal-card/dconfirm*/dbtn) — bespoke 스타일 0.
//
// 안전: overlay 클릭·Escape 는 **취소가 아니라 Deny**(닫기 확인창과 다름 — 무결정이 곧 미실행이
// 되도록 명시 거부로 환원). 결정 없이 모달을 떠나도 Rust TTL 이 AUTO-DENY 하므로 어느 경로든
// destructive 는 실행되지 않는다.
export function RemoteConfirmModal() {
  const t = useT();
  const req = useRemoteConfirm(activeRequest);
  const resolve = useRemoteConfirm((s) => s.resolve);
  const expire = useRemoteConfirm((s) => s.expire);

  // TTL 카운트다운(Rust TTL 의 거울 표시) — 요청이 바뀔 때마다 리셋. 0 에 닿으면 머리 만료 → 다음 승급.
  const ttl = req?.ttl_secs ?? DEFAULT_CONFIRM_TTL_SECS;
  const [remaining, setRemaining] = useState(ttl);

  useEffect(() => {
    if (!req) return;
    setRemaining(req.ttl_secs ?? DEFAULT_CONFIRM_TTL_SECS);
    const id = req.request_id;
    const timer = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          // Rust 가 이미 AUTO-DENY — 표시 큐에서만 떨어뜨린다(resolve 안 보냄).
          expire(id);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [req?.request_id, expire]);

  // Deny = 명시 거부(overlay/Escape 도 Deny — 무결정이 미실행으로 환원). resolve(false) → Rust dispatch 0.
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
    // deny 는 resolve 참조에만 의존(zustand action 은 안정 참조) — req 마다 재바인딩 불요.
  }, [resolve]);

  if (!req) return null; // idle 무발자국 — 큐가 비면 아무것도 렌더 안 함.

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
