// The file view container needs an address anchor too — without one, the exposed nodes inside leak into chrome.
//
// RED evidence (live measurement, 2026-07-26): in a window with 3 file views open, address.unique of ui.verify
// caught `chrome/mode-code ×3`. FileViewerHost had no data-view-addr, so the nodes exposed by the file viewer
// plugin were missed by the view container scan and collected through the chrome fallback — one duplicate
// address per file view. PluginViewHost already blocked this defect through viewHostAnchors.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileViewerHost } from "./FileViewerHost";
import { useFileViewerRegistry } from "../plugins/fileViewerRegistry";

// Verify through the real path — a registered, mounting viewer is the condition the defect occurred under.
let unregister: (() => void) | null = null;
beforeEach(() => {
  unregister = useFileViewerRegistry
    .getState()
    .register(
      "test-viewer",
      { id: "md", extensions: ["md"] },
      { mount: (el) => el.appendChild(document.createElement("span")) },
    );
});

let roots: Root[] = [];
let hosts: HTMLElement[] = [];
function mount(node: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  roots.push(root);
  hosts.push(host);
  return host;
}
afterEach(() => {
  for (const r of roots) act(() => r.unmount());
  for (const h of hosts) h.remove();
  roots = [];
  hosts = [];
  unregister?.();
  unregister = null;
});

describe("FileViewerHost address anchors", () => {
  it("the container exposes an address anchor that includes the tab axis", () => {
    const host = mount(
      <FileViewerHost path="/x/a.md" projectId="wsp-aaaaaa" root="/x" viewId="tab-cccccc" />,
    );
    const el = host.querySelector(".tab-viewer");
    expect(el?.getAttribute("data-view-addr")).toMatch(/\/tab\/tab-cccccc$/);
  });

  it("two file views have different baseAddresses — the condition for nodes not leaking into the chrome", () => {
    const a = mount(
      <FileViewerHost path="/x/a.md" projectId="wsp-aaaaaa" root="/x" viewId="tab-aaaaaa" />,
    );
    const b = mount(
      <FileViewerHost path="/x/b.md" projectId="wsp-aaaaaa" root="/x" viewId="tab-bbbbbb" />,
    );
    const addrA = a.querySelector(".tab-viewer")?.getAttribute("data-view-addr");
    const addrB = b.querySelector(".tab-viewer")?.getAttribute("data-view-addr");
    expect(addrA).toBeTruthy();
    expect(addrA).not.toBe(addrB);
  });
});
