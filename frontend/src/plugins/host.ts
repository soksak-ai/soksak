// Plugin host initialization — once at app start(main.tsx).
// Order: subscribe event hooks → fix the app version(basis of the minAppVersion check) → scan + reactivate.

import { appInfo, invoke } from "../framework";
import { currentWindowLabel } from "../lib/webviewLabels";
import { safeListenReady } from "../lib/safeListen";
import { startPluginHooks } from "./hooks";
import { wireNativeRegistryInstall } from "./registryInstallRuntimeNative";
import { usePlugins } from "../state/plugins";
import { useRegistry } from "../state/registry";
import { createEnvironmentEventHandler, setEnvironmentEventHandler, type EnvironmentChange } from "../state/environmentEvents";

let stopEnvironmentEvents = () => {};
let stopEnvironmentReconciliation = () => {};

export async function initPluginHost(): Promise<void> {
  // Point where this window's plugin runtime starts anew. Children spawned by a previous runtime(window still
  // alive but the frontend re-mounted — webview reload, HMR during development, crash recovery) remain with no
  // owner: window-destroy reclamation runs only when the window dies, and the window did not die. At this point
  // nothing has been spawned yet, so every child registered under this window is by definition left by the
  // previous runtime(detached sidecars are excluded).
  // **Pass the label explicitly.** Expecting the framework to inject the window confines this reclamation to the
  // process that holds the window, which forces a re-implementation per framework. The command that takes a label
  // already exists(process_reclaim_by_window) — the gap was the call shape, not the capability.
  // Skip the call when the label is unknown: an empty label can reclaim another window's children.
  const label = currentWindowLabel();
  if (label) {
    try {
      await invoke("process_reclaim_by_window", { window: label });
    } catch (e) {
      console.warn("previous runtime child reclaim failed:", e);
    }
  }
  startPluginHooks();
  // Install the certified archive-extraction handler so plugin.install resolves a
  // real native installer instead of INSTALL_RUNTIME_UNAVAILABLE.
  wireNativeRegistryInstall();
  try {
    // core build identity — used for the app updater channel verdict. Independent of whether plugin development is possible.
    usePlugins.setState({ release: await invoke<boolean>("app_is_release") });
  } catch (e) {
    console.warn("release verdict read failed (staying false):", e);
  }
  try {
    usePlugins.setState({ appVersion: await appInfo.version() });
  } catch (e) {
    // An unconfirmed version skips the minAppVersion check(warning) — reload logs it.
    console.warn("app version read failed:", e);
  }
  try {
    stopEnvironmentEvents();
    stopEnvironmentReconciliation();
    const queued: EnvironmentChange[] = [];
    let onChange: ReturnType<typeof createEnvironmentEventHandler> | null = null;
    stopEnvironmentEvents = await safeListenReady<EnvironmentChange>("environment.changed", (event) => {
      if (onChange === null) queued.push(event.payload);
      else void onChange(event.payload).catch((error) => {
        console.error("plugin environment reload failed:", error);
      });
    });
    const environment = await invoke<{ revision: number }>("environment_get");
    await usePlugins.getState().reload();
    onChange = createEnvironmentEventHandler(
      () => usePlugins.getState().reload(),
      environment.revision,
    );
    stopEnvironmentReconciliation = setEnvironmentEventHandler(onChange);
    for (const change of queued) await onChange(change);
  } catch (e) {
    console.error("initial plugin load failed:", e);
  }
  // Refresh the installable list remotely once per session(on failure the snapshot is used — not blocking).
  void useRegistry.getState().refresh();
}
