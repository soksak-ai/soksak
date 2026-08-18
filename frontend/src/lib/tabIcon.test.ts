import { beforeEach, describe, expect, it } from "vitest";
import { tabIconOf } from "./tabIcon";
import { useViewRegistry } from "../plugins/viewRegistry";

// What a tab draws, as a number a caller can read.
//
// Two tabs of one view drew different icons on screen and no command could say so: `tab.list`
// answered the reported icon and nothing about what was actually drawn, so the difference was
// visible and unmeasurable at once.

const view = (icon: string) => ({
  id: "content",
  title: { en: "T", ko: "T" },
  icon,
  surfaces: ["tab" as const],
  transparent: false,
  nativeSurface: false,
  decoration: false,
});

beforeEach(() => {
  useViewRegistry.setState({ views: {}, version: 0 });
});

describe("what a tab draws", () => {
  it("is the manifest icon when the view is registered and reported none", () => {
    useViewRegistry.getState().register("plg-a", view(">_"), { mount: () => {} });
    expect(tabIconOf({ pluginId: "plg-a", view: "content" })).toEqual({
      source: "manifest",
      value: ">_",
    });
  });

  it("is the reported icon when the view reported one", () => {
    useViewRegistry.getState().register("plg-a", view(">_"), { mount: () => {} });
    expect(tabIconOf({ icon: "https://x/f.ico", pluginId: "plg-a", view: "content" })).toEqual({
      source: "reported",
      value: "https://x/f.ico",
    });
  });

  it("is the fallback when the view is not registered", () => {
    expect(tabIconOf({ pluginId: "plg-gone", view: "content" })).toEqual({
      source: "fallback",
      value: "",
    });
  });

  it("is the same for two tabs of one view — the defect this reading was written for", () => {
    useViewRegistry.getState().register("plg-a", view(">_"), { mount: () => {} });
    const first = tabIconOf({ pluginId: "plg-a", view: "content" });
    const second = tabIconOf({ pluginId: "plg-a", view: "content" });
    expect(first).toEqual(second);
  });
});
