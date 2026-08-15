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
import * as CompositorService from "../../../bindings/github.com/soksak/wails-service-native-compositor/service";
import { tmsg } from "../../i18n";
import type { ContentViewHost } from "../../lib/contentViews";

import { nativeSurfacesSettled } from "./nativeSurfaces";

function unsupported(method: string): never {
  throw new Error(tmsg("framework.contentView.unsupported", { method }));
}

/**
 * Sends one verb to a surface.
 *
 * A declaration places a surface and rebuilds it, which covers the page a pane opens with. It
 * cannot express going back or reloading — both leave the declared url exactly as it was — so those
 * travel as messages instead.
 *
 * The message is closed to everything it passes through. This names the surface and the verb; the
 * compositor checks the surface is in the applied inventory and forwards without reading; the
 * backend for that kind reads it. So this file names no plugin and no browser engine, and a second
 * surface kind arrives with no edit here.
 */
async function drive(label: string, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await CompositorService.Deliver(label, message)) as Record<string, unknown>;
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
  navigate: async (label, url) => void (await drive(label, { verb: "navigate", url })),
  // A step of zero is not a direction. Sending it would ask the surface for a verb nobody answers,
  // and the refusal would name the surface rather than the call that was wrong.
  history: async (label, delta) => {
    if (delta === 0) throw new Error(`history(${label}): a step of 0 is neither back nor forward`);
    await drive(label, { verb: "history", delta });
  },
  stop: async (label) => {
    await drive(label, { verb: "stop" });
  },
  pageState: async (label) => drive(label, { verb: "state" }),
  reload: async (label) => void (await drive(label, { verb: "reload" })),
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
