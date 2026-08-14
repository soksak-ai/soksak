import { usePlugins } from "../state/plugins";

/** Parsed plugin manifests are the public ownership declaration for native child surfaces. */
export function ownsNativeSurfaceFromManifests(pluginId: string, viewId: string): boolean {
  const runtime = usePlugins.getState().plugins[pluginId];
  if (!runtime) return false;
  return runtime.manifest.contributes.views.some((view) =>
    view.id === viewId && view.nativeSurface === true);
}
