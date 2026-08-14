import { afterEach, describe, expect, it } from "vitest";
import { usePlugins } from "../state/plugins";
import { useViewRegistry } from "../plugins/viewRegistry";
import { ownsNativeSurfaceFromManifests } from "./nativeSurfaceOwnership";

describe("native surface ownership manifest predicate", () => {
  afterEach(() => {
    usePlugins.setState({ plugins: {} });
    useViewRegistry.setState({ views: {}, version: 0, badges: {} });
  });

  it("determines the manifest nativeSurface declaration even when the runtime view registry is empty", () => {
    usePlugins.setState({ plugins: { "engine-a": { manifest: {
      id: "engine-a",
      contributes: { views: [
        { id: "content", nativeSurface: true },
        { id: "canvas", nativeSurface: false },
      ] },
    } } as any } });
    expect(useViewRegistry.getState().views).toEqual({});
    expect(ownsNativeSurfaceFromManifests("engine-a", "content")).toBe(true);
    expect(ownsNativeSurfaceFromManifests("engine-a", "canvas")).toBe(false);
    expect(ownsNativeSurfaceFromManifests("engine-a", "missing")).toBe(false);
    expect(ownsNativeSurfaceFromManifests("missing", "content")).toBe(false);
  });
});
