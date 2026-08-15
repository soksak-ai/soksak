// Content view implementation for this framework.
//
// On this host native child webviews are **created by DOM declaration.** When a document node has
// data-native-surface, the next inventory commit creates that surface, and when the node is gone
// the same commit removes it. So this host has no per-label open/close commands — such a command
// is a second writer, and the next commit reverts it to the declaration.
//
// Of the methods here, the only one this build performs is waiting for settlement. The rest reject
// with their name. A silent no-op would leave the caller believing it opened something while the
// screen shows nothing.
import { tmsg } from "../../i18n";
import type { ContentViewHost } from "../../lib/contentViews";

import { nativeSurfacesSettled } from "./nativeSurfaces";

function unsupported(method: string): never {
  throw new Error(tmsg("framework.contentView.unsupported", { method }));
}

export const wailsContentViewHost: ContentViewHost = {
  // Visibility is owned by the declaration — a view with a surface changes data-native-visible on
  // its own node and the next commit applies it. Pushing again here makes two writers.
  // For a view with no surface (a plugin view inside the document) this call has nothing to do.
  visible: async () => {},
  // Position is declared too. There is nothing to match, so there is no mismatch.
  bounds: async () => true,
  // Until the declared surfaces are reflected in a real frame — reads one compositor receipt only.
  presentationSettled: async () => {
    await nativeSurfacesSettled();
  },
  chromePresentationSettled: async () => {
    await nativeSurfacesSettled();
  },

  open: async (label) => unsupported(`open(${label})`),
  close: async (label) => unsupported(`close(${label})`),
  list: async () => unsupported("list()"),
  alive: async (label) => unsupported(`alive(${label})`),
  navigate: async (label) => unsupported(`navigate(${label})`),
  history: async (label) => unsupported(`history(${label})`),
  stop: async (label) => unsupported(`stop(${label})`),
  reload: async (label) => unsupported(`reload(${label})`),
  zoom: async (label) => unsupported(`zoom(${label})`),
  devtools: async (label) => unsupported(`devtools(${label})`),
  evalJs: async (label) => unsupported(`evalJs(${label})`),
  injectScript: (label) => unsupported(`injectScript(${label})`),
  openWindow: async () => unsupported("openWindow()"),
  sendInput: async (label) => unsupported(`sendInput(${label})`),
  inputState: async (label) => unsupported(`inputState(${label})`),
  wheel: async (label) => unsupported(`wheel(${label})`),
  captureFull: async (label) => unsupported(`captureFull(${label})`),
  typeText: async (label) => unsupported(`typeText(${label})`),
  markText: async (label) => unsupported(`markText(${label})`),
  sendKey: async (label) => unsupported(`sendKey(${label})`),
};
