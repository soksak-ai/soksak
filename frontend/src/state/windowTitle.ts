// Native window title = active workspace name — the in-app title bar is custom and does not draw this
// value, but the Dock window list, Mission Control, and Cmd+` window switching show the NSWindow
// title. Without updating it, every window shows the same conf title and none can be told apart
// (measured — three "soksak-dev" entries in the Dock).
// The app name is not appended: those surfaces are already under the app icon/group, so it is pure
// duplication (macOS convention is the document name alone). Only a window with no workspace (empty
// exception state) falls back to the app name (getName — the real name per identity).
// Updated on every active-workspace switch, rename, and tab add/remove (sessions subscription).

import { appInfo, currentWindow } from "../framework";
import { useSessions } from "./sessions";

export async function initWindowTitle(): Promise<void> {
  const win = currentWindow();
  const base = (await appInfo.name().catch(() => "")) || "soksak";
  let last = "";
  const apply = () => {
    const s = useSessions.getState();
    const t = s.workspaces.find((x) => x.id === s.activeId);
    const next = t ? t.title : base;
    if (next === last) return; // sessions is a high-frequency store — IPC only on a real change
    last = next;
    void win.setTitle(next).catch(() => {});
  };
  useSessions.subscribe(apply);
  apply();
}
