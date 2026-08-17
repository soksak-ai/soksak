import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom has no window of its own to be labelled, and a label is what separates this window's
// surfaces from another's.
vi.mock("../lib/webviewLabels", () => ({ currentWindowLabel: () => "win-a1b2c3" }));
import { startSurfaceActivationSync } from "./viewFocus";
import { useSessions } from "../state/sessions";
import { CONTENT_VIEW_EVENT } from "../lib/contentViewEvents";
import { surfaceLabelIn } from "../lib/surfaceLabels";

const WINDOW = "win-a1b2c3";

// A surface reports it was clicked, and the session follows.
//
// A view drawn on a native surface receives its own clicks and the document never sees them, so a
// click inside a browser page left the focused pane where it was — measured on the running build
// 2026-08-17, while a click on that pane's tab moved it.
//
// `content-view-activated` was the name for this in both vocabularies already, with nothing emitting
// it and nothing subscribing to it.
const VIEW = "tab-a1b2c3";
const PANE = "pan-a1b2c3";

describe("a surface that reports it was activated", () => {
  let emit: ((label: string) => void) | null = null;
  let subscribed: string | null = null;

  const subscribe = (event: string, onLabel: (label: string) => void) => {
    subscribed = event;
    emit = onLabel;
    return () => {
      emit = null;
    };
  };

  beforeEach(() => {
    emit = null;
    subscribed = null;
    useSessions.setState({
      activeId: "wsp-a1b2c3",
      workspaces: [
        {
          id: "wsp-a1b2c3",
          activeSpaceId: "spc-a1b2c3",
          spaces: [
            {
              id: "spc-a1b2c3",
              activePaneId: "pan-other",
              layout: {
                type: "leaf",
                value: {
                  id: PANE,
                  tabs: [{ id: VIEW, kind: "plugin", pluginId: "plg-a", view: "content", title: "T" }],
                  activeTabId: "tab-other",
                },
              },
            },
          ],
        },
      ] as never,
    });
  });

  it("subscribes to the name both vocabularies already carry", () => {
    startSurfaceActivationSync(subscribe);
    expect(subscribed).toBe(CONTENT_VIEW_EVENT.activated);
  });

  it("makes the clicked surface's pane the focused one and its view the active tab", () => {
    const moved: string[] = [];
    useSessions.setState({
      setActiveGroup: ((_p: string, g: string) => {
        moved.push(`pane:${g}`);
        return { ok: true as const };
      }) as never,
      setActiveView: ((_p: string, v: string) => {
        moved.push(`tab:${v}`);
        return { ok: true as const };
      }) as never,
    });
    startSurfaceActivationSync(subscribe);

    emit!(surfaceLabelIn("browser", WINDOW, VIEW));

    expect(moved).toEqual([`pane:${PANE}`, `tab:${VIEW}`]);
  });

  it("ignores a label from another window — its views are not in this session", () => {
    const moved: string[] = [];
    useSessions.setState({
      setActiveGroup: (() => {
        moved.push("pane");
        return { ok: true as const };
      }) as never,
      setActiveView: (() => {
        moved.push("tab");
        return { ok: true as const };
      }) as never,
    });
    startSurfaceActivationSync(subscribe);

    emit!(surfaceLabelIn("browser", "win-elsewhere", VIEW));

    expect(moved).toEqual([]);
  });
});
