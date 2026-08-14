// Motion observation panel — appears only in a dev build (BuildBadge renders it only on DEV/DEBUG).
//
// Why it is put in a person's hand: these defects all exist only mid-motion — a surface strands at its old
// position and the sidebar looks doubled, a tab return flickers, a panel narrows briefly and its edge stays as
// a line. The side that catches that instant by eye and the side that reads coordinates are different, so the
// handle that stops motion must be with the person and the reading command must see the same moment. That is
// why the setting has one owner (lib/motionDebug — the ui.motion command and this panel use the same state).
//
// How to read while stopped: ui.snapshot.dom measures every exposed node at that one moment.
import { useEffect, useState } from "react";
import {
  motionDebugState,
  onMotionDebugChange,
  setMotionDebug,
} from "../lib/motionDebug";

// The axis a person reads is speed, the internal axis is a duration multiplier. Writing both as the same number
// reads backwards — duration 50x means 50 times slower, while "50x speed" means fast. The screen prints speed as
// a fraction and the state holds the duration multiplier (--motion-scale multiplies transition length, so that axis is canonical).
const SPEEDS: { label: string; scale: number }[] = [
  { label: "1×", scale: 1 },
  { label: "1/5", scale: 5 },
  { label: "1/20", scale: 20 },
  { label: "1/50", scale: 50 },
];

export function MotionDebug({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState(motionDebugState);
  useEffect(() => onMotionDebugChange(() => setState(motionDebugState())), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="motion-debug" data-node="motion-debug" role="group" aria-label="motion">
      <div className="motion-debug-row">
        <span className="motion-debug-label">{t("status.motionDebug.speed")}</span>
        {SPEEDS.map((s) => (
          <button
            key={s.scale}
            type="button"
            data-node={`motion-debug/scale/${s.scale}`}
            title={s.scale === 1 ? t("status.motionDebug.normalSpeed") : t("status.motionDebug.slower", { scale: s.scale })}
            className={state.scale === s.scale ? "on" : undefined}
            onClick={() => setMotionDebug({ scale: s.scale })}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="motion-debug-row">
        <button
          type="button"
          data-node="motion-debug/hold"
          className={state.hold ? "on" : undefined}
          onClick={() => setMotionDebug({ hold: !state.hold })}
        >
          {state.hold ? t("status.motionDebug.resume") : t("status.motionDebug.hold")}
        </button>
        <span className="motion-debug-hint">
          {state.hold ? t("status.motionDebug.held") : t("status.motionDebug.holdHint")}
        </span>
      </div>
    </div>
  );
}
