// Renders plugin header actions in flex order, left of the titlebar's right control group (sidebar, dark mode,
// settings). Subscribes to the registry (headerActions) to react to register/unregister/update. Each button is
// exposed as data-node(titlebar/<id>) so ui.tree and ui.input.click can drive and verify it (host chrome node).

import { useEffect, useState } from "react";
import { getHeaderActions, subscribeHeaderActions } from "./headerActions";

export function PluginHeaderActions() {
  const [actions, setActions] = useState(getHeaderActions);
  useEffect(
    () => subscribeHeaderActions(() => setActions([...getHeaderActions()])),
    [],
  );
  return (
    <>
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          className={`icon-btn${a.active ? " active" : ""}`}
          title={a.title}
          aria-label={a.title ?? a.label}
          data-node={`titlebar/${a.id.replace(/:/g, "/")}`}
          onClick={a.onClick}
        >
          {a.icon ? (
            // Outline icon — same geometry as the core Icon (md 14px, currentColor stroke, round caps).
            // The body comes from a trusted source (a plugin already has code execution rights — full-trust model).
            <svg
              viewBox="0 0 24 24"
              width={14}
              height={14}
              aria-hidden
              focusable={false}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dangerouslySetInnerHTML={{ __html: a.icon }}
            />
          ) : (
            a.label
          )}
        </button>
      ))}
    </>
  );
}
