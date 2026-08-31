/**
 * Fixed vertical space inside a pane before and after its public native
 * surface. The surface declaration is the public DOM contract; plugin
 * implementation details are intentionally not inspected.
 */
export function paneChromeExtentPx(
  container: HTMLElement,
  fallbackPx: number,
  insetPx: number = 0,
): number {
  let extent = Math.max(0, fallbackPx) + Math.max(0, insetPx) * 2;
  const surfaces: HTMLElement[] = [];
  const surfaceHosts: HTMLElement[] = [];
  const publicChrome: HTMLElement[] = [];
  const scan = (root: ParentNode): void => {
    surfaces.push(
      ...root.querySelectorAll<HTMLElement>(
        "[data-native-surface][data-native-surface-id]",
      ),
    );
    surfaceHosts.push(
      ...root.querySelectorAll<HTMLElement>("[data-node='surface']"),
    );
    publicChrome.push(
      ...root.querySelectorAll<HTMLElement>("[data-node='chrome']"),
    );
    for (const element of root.querySelectorAll<HTMLElement>("*")) {
      if (element.shadowRoot) scan(element.shadowRoot);
    }
  };
  scan(container);
  const ownerPane = (element: HTMLElement): HTMLElement | null => {
    let owner: HTMLElement | null = element.closest("[data-pane]");
    let root = element.getRootNode();
    while (!owner) {
      if (!(root instanceof ShadowRoot)) break;
      owner = root.host as HTMLElement;
      while (owner && !owner.matches("[data-pane]")) owner = owner.parentElement;
      root = owner?.getRootNode() ?? document;
    }
    return owner;
  };
  for (const host of surfaceHosts) {
    const pane = ownerPane(host);
    if (!pane) continue;
    const paneRect = pane.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    if (paneRect.height <= 0 || hostRect.height <= 0) continue;
    const hostRoot = host.getRootNode();
    const chromeNodes = new Set([
      ...host.querySelectorAll<HTMLElement>("[data-node='chrome']"),
      ...(host.parentElement?.querySelectorAll<HTMLElement>("[data-node='chrome']") ?? []),
      ...(hostRoot instanceof ShadowRoot
        ? hostRoot.querySelectorAll<HTMLElement>("[data-node='chrome']")
        : []),
    ]);
    const chromeHeight = [...chromeNodes]
      .reduce((sum, chrome) => sum + Math.max(0, chrome.getBoundingClientRect().height), 0);
    const globalChromeHeight = publicChrome.reduce(
      (max, chrome) => Math.max(max, chrome.getBoundingClientRect().height),
      0,
    );
    extent = Math.max(
      extent,
      hostRect.top - paneRect.top + Math.max(chromeHeight, globalChromeHeight) +
        paneRect.bottom - hostRect.bottom,
    );
  }
  for (const surface of surfaces) {
    const owner = ownerPane(surface);
    if (!owner) continue;
    const paneRect = owner.getBoundingClientRect();
    const surfaceRect = surface.getBoundingClientRect();
    if (paneRect.height <= 0 || surfaceRect.height <= 0) continue;
    extent = Math.max(
      extent,
      surfaceRect.top - paneRect.top + paneRect.bottom - surfaceRect.bottom,
    );
  }
  return extent;
}
