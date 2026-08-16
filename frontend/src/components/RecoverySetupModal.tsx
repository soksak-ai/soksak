import { useEffect, useState } from "react";
import { useVault } from "../state/vault";
import { useOverlayActive } from "../state/ui";
import { useT } from "../i18n";

// Recovery-code setup modal. enable, rotate, and changeRecovery each return a recovery code once, and
// this modal shows it exactly once. The code cannot be re-fetched, so Escape, overlay, and close are
// blocked until the "saved" checkbox is ticked (gate). Closing clears the volatile code from the store
// (zero residue outside memory). store pending is the open state.
export function RecoverySetupModal() {
  const t = useT();
  const open = useVault((s) => s.openModal);
  const pending = useVault((s) => s.pendingCode);
  const close = useVault((s) => s.close);
  const [saved, setSaved] = useState(false);

  const showing = open === "setup" && pending !== null;
  // App mounts this component always, so an unconditional registration holds the overlay for the
  // whole session. `surfaceShown` reads that count, so every view was parked with nothing on
  // screen and nothing open — measured 2026-08-17, `state.health` answered `overlays: 2` at rest.
  useOverlayActive(showing);

  // Reset the gate on each open.
  useEffect(() => {
    if (showing) setSaved(false);
  }, [showing]);

  useEffect(() => {
    if (!showing) return;
    const onKey = (e: KeyboardEvent) => {
      // Gate — Escape does not close before the saved check (the code is shown once).
      if (e.key === "Escape") {
        e.stopPropagation();
        if (saved) close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [showing, saved, close]);

  if (!showing) return null;
  return (
    <div className="dmodal-overlay" onMouseDown={() => saved && close()}>
      <div
        className="dmodal-card dconfirm"
        data-node="modal/encrypt-setup"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dconfirm-title">{t("encrypt.setup.title")}</div>
        <div className="plugin-consent-notice">{t("encrypt.setup.desc")}</div>
        {/* The recovery code is 8 groups (39 chars) and overflows a single-line input, which truncates it.
            It is shown once, so the whole value must be visible: render it as a wrapping block and lift the
            global user-select:none so it can be selected and copied. */}
        <div
          className="dctl dctl-mono"
          data-node="modal/encrypt-setup/code"
          style={{
            height: "auto",
            whiteSpace: "normal",
            wordBreak: "break-all",
            textAlign: "center",
            lineHeight: 1.6,
            userSelect: "text",
            WebkitUserSelect: "text",
          }}
        >
          {pending.code}
        </div>
        <button
          type="button"
          className="dbtn"
          data-node="modal/encrypt-setup/copy"
          onClick={() =>
            void navigator.clipboard?.writeText(pending.code).catch(() => {})
          }
        >
          {t("encrypt.setup.copy")}
        </button>
        <label className="dctl dctl-check">
          <input
            type="checkbox"
            checked={saved}
            data-node="modal/encrypt-setup/saved"
            onChange={(e) => setSaved(e.target.checked)}
          />
          <span>{t("encrypt.setup.savedGate")}</span>
        </label>
        <div className="dconfirm-actions">
          <button
            type="button"
            className="dbtn dbtn-acc"
            data-node="modal/encrypt-setup/done"
            disabled={!saved}
            style={!saved ? { opacity: 0.4 } : undefined}
            onClick={() => close()}
          >
            {t("encrypt.setup.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
