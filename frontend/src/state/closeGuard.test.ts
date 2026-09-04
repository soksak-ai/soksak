import { describe, expect, it } from "vitest";
import {
  STATUS_BLOCKING,
  viewCloseReason,
  contentCloseReasons,
} from "./closeGuard";
import type { Tab, TabStatus, Space } from "./sessions";

// Test view/content factories — only status differs.
const fileView = (status?: TabStatus, id = "tab-aaaaaa"): Tab => ({
  id,
  kind: "plugin",
  title: "a.ts",
  pluginId: "plg-editor",
  view: "content",
  status,
});

const leafContent = (tabs: Tab[]): Space => ({
  id: "spc-aaaaaa",
  title: "1",
  layout: {
    type: "leaf",
    value: { id: "pan-aaaaaa", tabs, activeTabId: tabs[0]?.id ?? "" },
  },
  activePaneId: "pan-aaaaaa",
});

const splitContent = (left: Tab[], right: Tab[]): Space => ({
  id: "spc-aaaaaa",
  title: "1",
  layout: {
    type: "split",
    id: "spl-aaaaaa",
    dir: "row",
    sizes: [0.5, 0.5],
    children: [
      { type: "leaf", value: { id: "pan-aaaaaa", tabs: left, activeTabId: left[0]?.id ?? "" } },
      { type: "leaf", value: { id: "pan-bbbbbb", tabs: right, activeTabId: right[0]?.id ?? "" } },
    ],
  },
  activePaneId: "pan-aaaaaa",
});

describe("STATUS_BLOCKING vocabulary (R2)", () => {
  it("the blocking codes are dirty, busy and running", () => {
    expect([...STATUS_BLOCKING]).toEqual(["dirty", "busy", "running"]);
  });
});

describe("viewCloseReason — close risk per view", () => {
  it("returns null when no status is reported (closes at once)", () => {
    expect(viewCloseReason(fileView(undefined))).toBeNull();
  });

  it("returns null for a display-only code (not blocking)", () => {
    expect(viewCloseReason(fileView({ code: "idle" }))).toBeNull();
    expect(viewCloseReason(fileView({ code: "synced" }))).toBeNull();
  });

  it("uses the message as the reason for a blocking code with a message", () => {
    expect(viewCloseReason(fileView({ code: "dirty", message: "unsaved changes" }))).toBe(
      "unsaved changes",
    );
    expect(
      viewCloseReason(fileView({ code: "running", message: "npm run dev" })),
    ).toBe("npm run dev");
  });

  it("falls back to the code as the reason for a blocking code with no message", () => {
    expect(viewCloseReason(fileView({ code: "busy" }))).toBe("busy");
  });
});

describe("contentCloseReasons — reasons per content (split)", () => {
  it("returns an empty array for empty or non-blocking views only", () => {
    expect(contentCloseReasons(leafContent([]))).toEqual([]);
    expect(contentCloseReasons(leafContent([fileView({ code: "idle" })]))).toEqual([]);
  });

  it("returns one reason for one blocking view", () => {
    expect(
      contentCloseReasons(leafContent([fileView({ code: "dirty", message: "unsaved" })])),
    ).toEqual(["unsaved"]);
  });

  it("walks every group of a split grid and collects the blocking ones only", () => {
    const c = splitContent(
      [fileView({ code: "dirty", message: "L" }, "l1"), fileView({ code: "idle" }, "l2")],
      [fileView({ code: "busy", message: "R" }, "r1")],
    );
    expect(contentCloseReasons(c)).toEqual(["L", "R"]);
  });
});
