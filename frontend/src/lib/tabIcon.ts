import { getRegisteredView } from "../plugins/viewRegistry";

// What a tab draws for its icon, as one answer.
//
// The tab bar decided it and no command reported it, so two tabs of the same view drawing different
// icons was visible on screen and unreadable from outside — found by eye on 2026-08-16, and nothing
// could say which of the three it was. A picture is not a verdict (EVIDENCE E1), and a surface with
// no number is unfinished (E2).
//
// One function, read by the tab bar and by `tab.list`. Two copies would be two rules about one
// pixel, and the reading would agree with itself while disagreeing with the screen (E6).
export type TabIconSource =
  /** The view reported one through setIcon — a page's own icon, for instance. */
  | "reported"
  /** The icon the plugin's manifest declares for that view. */
  | "manifest"
  /** Neither: the view is not registered, so the generic plugin glyph is drawn. */
  | "fallback";

export interface TabIcon {
  source: TabIconSource;
  /** The reported URL or the declared glyph. Empty for a fallback, which draws no value of its own. */
  value: string;
}

export function tabIconOf(tab: {
  icon?: string;
  pluginId: string;
  view: string;
}): TabIcon {
  if (tab.icon) return { source: "reported", value: tab.icon };
  const declared = getRegisteredView(`${tab.pluginId}.${tab.view}`)?.decl.icon;
  if (declared) return { source: "manifest", value: declared };
  return { source: "fallback", value: "" };
}
