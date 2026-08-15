import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { onPluginEvent } from "../plugins/hooks";
import { useAppChromeLayoutReflow } from "./appChromeLayoutReflow";

let host: HTMLDivElement;
let root: Root;

function Probe({ geometry, activeSpaceId }: { geometry: string; activeSpaceId: string | null }) {
  useAppChromeLayoutReflow(geometry, activeSpaceId);
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("publishes a reflow right after the commit when app chrome geometry outside WorkspaceSurface changes, such as the workspace tab position", () => {
  const seen: Array<string | null> = [];
  const off = onPluginEvent("layout.reflow", (payload) => seen.push(payload.activeSpaceId));
  try {
    act(() => root.render(<Probe geometry="top" activeSpaceId="spc-1" />));
    expect(seen).toEqual(["spc-1"]);

    // A plain re-render with the same geometry is not an event.
    act(() => root.render(<Probe geometry="top" activeSpaceId="spc-1" />));
    expect(seen).toEqual(["spc-1"]);

    act(() => root.render(<Probe geometry="left" activeSpaceId="spc-1" />));
    expect(seen).toEqual(["spc-1", "spc-1"]);
  } finally {
    off.dispose();
  }
});
