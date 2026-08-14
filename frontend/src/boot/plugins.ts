// The composition root: the one file that names what exists.
//
// Everything above it routes by opaque id. That is why adding a plugin costs
// the core zero lines — the cost lands here, on one screen, by design.
import { mountTerminal } from "@soksak/soksak-plugin-terminal-xterm";
import {
  createNativeBrowserCommands,
  nativeBrowserAttributes,
  normalizeBrowserURL,
} from "@soksak/soksak-plugin-browser-native";

import { terminalHost } from "./terminalHost";
import { commands, programs, views, type ViewProvider } from "../plugins";
import * as BrowserService from "../../bindings/github.com/soksak/soksak-plugin-browser-native/service";

const TERMINAL_VIEW = "terminal.xterm";
const BROWSER_VIEW = "browser.native";

const terminalView: ViewProvider = (host, context) =>
  mountTerminal(host, context.leafId, terminalHost.binding, terminalHost.events);

const browserView: ViewProvider = (host, context) => {
  const panel = document.createElement("div");
  panel.className = "browser-panel";

  const bar = document.createElement("form");
  bar.className = "browser-bar";

  const address = document.createElement("input");
  address.setAttribute("aria-label", "browser address");
  address.value = "https://example.com";

  const go = document.createElement("button");
  go.type = "submit";
  go.textContent = "Go";

  const surface = document.createElement("div");
  surface.className = "native-browser-host";

  // The surface is declared, never positioned. The compositor reads this
  // declaration and owns the native frame; writing coordinates here would make
  // two authorities for one rectangle and one of them always lags.
  const declare = (url: string) => {
    const attributes = nativeBrowserAttributes({ id: context.leafId, generation: 1, url, layer: 10 });
    for (const [name, value] of Object.entries(attributes)) surface.setAttribute(name, value);
  };

  bar.addEventListener("submit", (event) => {
    event.preventDefault();
    address.value = normalizeBrowserURL(address.value);
    declare(address.value);
  });

  declare(address.value);
  bar.append(address, go);
  panel.append(bar, surface);
  host.append(panel);

  return () => panel.remove();
};

/** Register every plugin this build ships with. */
export function registerPlugins(): void {
  views.register(TERMINAL_VIEW, terminalView);
  programs.register({ id: "terminal", title: "Terminal", viewId: TERMINAL_VIEW });
  commands.register({
    name: "terminal.status",
    owner: "plugin",
    run: () => terminalHost.status(),
  });

  const browser = createNativeBrowserCommands({
    navigate: (id, generation, url) => BrowserService.Navigate(id, generation, url),
    status: () => BrowserService.Status(),
  });

  views.register(BROWSER_VIEW, browserView);
  programs.register({ id: "browser", title: "Browser", viewId: BROWSER_VIEW });
  commands.register({
    name: "browser.navigate",
    owner: "plugin",
    run: async (args) => {
      const { id, generation, url } = (args ?? {}) as { id?: string; generation?: number; url?: string };
      if (!id || !url) throw new Error("browser.navigate requires id and url");
      return browser.navigate(id, generation ?? 1, url);
    },
  });
  commands.register({ name: "browser.status", owner: "plugin", run: () => browser.status() });
}
