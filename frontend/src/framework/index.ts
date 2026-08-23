// Active framework binding — the one entry point between the app and a framework.
//
// App code imports only from here: `import { invoke } from "../framework"`. Which framework is
// behind it is decided in this one place; everything else uses the contract (contract.ts) only.
//
// **The build makes the choice.** `#framework-adapter` resolves to a different leaf per
// Tauri/Electron output, and that leaf imports its own adapter only. There is no runtime-flag
// fallback that bundles both and picks one — the unselected implementation must not merely go
// unevaluated, it must be absent from the bundle graph.

import type { AppFramework, TitlebarCompositionProvision } from "./contract";
import type { EngineProvision } from "../plugins/spec";
import { selectedFramework } from "#framework-adapter";

export type {
  FrameworkEvent,
  AppFramework,
  FrameworkNotification,
  FrameworkWindowHandle,
  Stream,
  TitlebarCompositionFacet,
  TitlebarCompositionProvision,
  Unlisten,
} from "./contract";

/** Active framework. Used when putting the name into diagnostics and ledgers. */
export const framework: AppFramework = selectedFramework;

/**
 * Only the selected side installs its own parts — implementation, devices, styles.
 *
 * The bundle contains both adapters (Electron loads the same frontend), so installing on load
 * alone installs the unselected framework's parts too — measured 2026-08-03: `electron.css` was
 * present in the Tauri build as well. So installation happens **after the selection**.
 *
 * **Never call this during module evaluation.** The installing side touches app modules (plugin
 * bus, stores, DOM) and those modules import this file again — calling during evaluation hits a
 * binding not yet initialized in the circular load (measured 2026-08-03: "invoke is not a
 * function" killed all 13 test suites). Boot calls it once (main.tsx). Neither this file nor the
 * caller inspects what gets installed.
 */
/** Fix this window's label. Boot awaits it before install. */
export function resolveWindowLabel(): Promise<string> {
  return framework.resolveWindowLabel();
}

export function installFramework(): Promise<void> {
  return framework.install();
}

/** Commit the selected framework's first visible window frame after the initial DOM render. */
export function presentWindow(): Promise<void> {
  return framework.presentWindow();
}

/** Atomically remove the selected framework's native child-surface inventory. */
export function resetNativeSurfaces(): Promise<void> {
  return framework.resetNativeSurfaces();
}

/** Stop watching and destroy the selected framework's native child inventory. */
export function clearNativeSurfaces(): Promise<void> {
  return framework.clearNativeSurfaces();
}

// ── Named re-exports — call sites use these without naming a framework ─────────────
export const invoke: AppFramework["invoke"] = (cmd, args) => framework.invoke(cmd, args);
export const commandTable: AppFramework["commands"] = () => framework.commands();
export const createStream: AppFramework["createStream"] = () => framework.createStream();
export const listen: AppFramework["listen"] = (event, cb) => framework.listen(event, cb);
export const currentWindow: AppFramework["currentWindow"] = () => framework.currentWindow();
export const windowByLabel: AppFramework["windowByLabel"] = (label) => framework.windowByLabel(label);
export const appInfo = framework.app;
export const frameworkPath = framework.path;
export const dialog = framework.dialog;
export const notification = framework.notification;
export const deepLink = framework.deepLink;

/**
 * What the active framework provides — where the app checks "what is possible" without a vendor
 * name.
 *
 * Once app code uses `if (framework === "electron")` the boundary leaks at that line. Check the
 * capability instead: is there a native child layer, is the engine chromium-grade. Plugins state
 * the same axis as requirements in their manifest (engineNeeds.ts) — this is the fact on the side
 * that satisfies those requirements.
 */
export const engineProvision: EngineProvision = framework.engineProvision;

/**
 * What the active framework declares about traffic-light composition — read before the core
 * touches window chrome.
 *
 * Never call what is declared absent. Calling it and swallowing the rejection leaves no record of
 * what fails on that framework or why, only "the declaration exists and nothing happens".
 */
export const titlebarComposition: TitlebarCompositionProvision =
  framework.titlebarComposition;

/**
 * Props that mark an element as a window drag region — spread them onto the element as-is.
 *
 *   <div className="titlebar" {...dragRegion}>
 *
 * The app needs no knowledge of what gets attached. Tauri uses an attribute, Electron uses CSS.
 */
export const dragRegion = framework.dragRegion;

/**
 * Name of the framework that launched this process.
 *
 * Home is not split by framework (identity.rs `home_suffix_for_identifier`) — both use the same
 * home. So any fact written to home that answers "what is this process running right now" must
 * include this name. Without it the other side reads that fact as its own.
 */
export const frameworkName: string = framework.name;

/** Deliver an event straight to this window's subscribers — name and payload match what the framework emits. */
export const emitLocal: AppFramework["emitLocal"] = (event, payload) =>
  framework.emitLocal(event, payload);
export const pluginFileUrl: AppFramework["pluginFileUrl"] = (path) => framework.pluginFileUrl(path);
