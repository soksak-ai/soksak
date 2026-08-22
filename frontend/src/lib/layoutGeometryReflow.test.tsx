// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { onPluginEvent } from "../plugins/hooks";
import { useLayoutGeometryReflow } from "./layoutGeometryReflow";

describe("layout geometry reflow", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  afterEach(() => { if (root) act(() => root!.unmount()); root = null; });

  it("publishes once for each committed geometry signature", () => {
    const seen: (string | null)[] = [];
    const subscription = onPluginEvent("layout.reflow", (value) => seen.push(value.activeSpaceId));
    const Probe = ({ signature }: { signature: string }) => {
      useLayoutGeometryReflow(signature, "spc-a");
      return <div />;
    };
    root = createRoot(document.body.appendChild(document.createElement("div")));
    act(() => root!.render(<Probe signature="a:0,0,50,100|b:50,0,50,100" />));
    act(() => root!.render(<Probe signature="a:0,0,50,100|b:50,0,50,100" />));
    act(() => root!.render(<Probe signature="a:0,0,45,100|b:45,0,55,100" />));
    subscription.dispose();
    expect(seen).toEqual(["spc-a", "spc-a"]);
  });
});
