// A binding change is delivered to the view — the single rule of the ctx data axis.
//
// This decision used to be hand-wired inside the host as a list of field names: root/viewId/command
// in the remount key, paneId in both update and remount, boundViewId in neither. A hand-written list
// silently omits a new field, and an omitted field shows up as "the binding changed but the screen
// is the old one".
//
// Measured (2026-07-31): a shared projection keeps the same instance across binding changes
// (instanceKey has no bound view id), so a binding switch caused neither remount nor update and the
// previous view's screen stayed on screen. What the user saw = "the same screen appears in each tab,
// then becomes correct".
//
// The seed axis asserts the opposite direction — using a value the view writes back
// (setRestoreState → restore) as a trigger makes a report → remount → re-report loop. So this pins
// down that it is NOT a trigger.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { PluginViewHost } from "./PluginViewHost";
import { useViewRegistry, type PluginViewContext } from "../plugins/viewRegistry";
import type { ContributedView } from "../plugins/spec";
import { BINDING_KEYS, VIEW_CONTEXT_AXIS } from "../plugins/viewContext";
import { viewSurfacePlacement } from "../lib/viewPark";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const DECL = {
  id: "list",
  title: { en: "L" },
  icon: "▤",
  surfaces: ["side"],
  transparent: false,
  nativeSurface: false,
} as unknown as ContributedView;

interface Log {
  mounts: PluginViewContext[];
  updates: PluginViewContext[];
}

function makeProvider(withUpdate: boolean): {
  provider: Record<string, unknown>;
  log: Log;
} {
  const log: Log = { mounts: [], updates: [] };
  const provider: Record<string, unknown> = {
    mount(_el: HTMLElement, ctx: PluginViewContext) {
      log.mounts.push({ ...ctx });
    },
    unmount() {},
  };
  if (withUpdate) {
    provider.update = (_el: HTMLElement, ctx: PluginViewContext) => {
      log.updates.push({ ...ctx });
    };
  }
  return { provider, log };
}

describe("PluginViewHost — a changed binding is delivered to the view", () => {
  let host: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    useViewRegistry.setState({ views: {}, version: 0, badges: {} });
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    host.remove();
  });

  /** Two renders differing only in boundViewId. */
  function renderWith(boundViewId: string): void {
    act(() => {
      root!.render(
        <PluginViewHost
          viewKey="p.list"
          projectId="p1"
          root="/r"
          region="left"
          boundViewId={boundViewId}
        />,
      );
    });
  }

  it("a provider that implements update is notified of a binding change with a new ctx", () => {
    const { provider, log } = makeProvider(true);
    act(() => {
      useViewRegistry.getState().register("p", DECL, provider as never);
    });
    act(() => {
      root = createRoot(host);
    });
    renderWith("v-a");
    const updatesAfterMount = log.updates.length;
    expect(log.mounts[0]?.containerGeneration).toBeGreaterThan(0);

    renderWith("v-b");

    // Contract: a changed binding is delivered to the view. The channel is update, not remount —
    // the instance is kept.
    expect(log.updates.length).toBeGreaterThan(updatesAfterMount);
    expect(log.updates[log.updates.length - 1]?.boundViewId).toBe("v-b");
    // The instance is kept — this is why a shared projection preserves structural state.
    expect(log.mounts.length).toBe(1);
  });

  it("presentation is delivered from the core current value and a subscription, not from a DOM rect", () => {
    const seen: boolean[] = [];
    let initial: boolean | null = null;
    const provider = {
      mount(_el: HTMLElement, ctx: PluginViewContext) {
        initial = ctx.presentation().visible;
        ctx.onPresentationChange((presentation) => seen.push(presentation.visible));
      },
    };
    act(() => {
      useViewRegistry.getState().register("p", DECL, provider);
      root = createRoot(host);
      root.render(
        <PluginViewHost
          viewKey="p.list"
          projectId="p1"
          root="/r"
          region="center"
          viewId="v-a"
          surfacePlacement={viewSurfacePlacement(false, false)}
        />,
      );
    });

    expect(initial).toBe(false);

    act(() => {
      root!.render(
        <PluginViewHost
          viewKey="p.list"
          projectId="p1"
          root="/r"
          region="center"
          viewId="v-a"
          surfacePlacement={viewSurfacePlacement(true, false)}
        />,
      );
    });
    expect(seen[seen.length - 1]).toBe(true);
  });

  it("a provider with no update is remounted on a binding change", () => {
    const { provider, log } = makeProvider(false);
    act(() => {
      useViewRegistry.getState().register("p", DECL, provider as never);
    });
    act(() => {
      root = createRoot(host);
    });
    renderWith("v-a");
    expect(log.mounts.length).toBe(1);

    renderWith("v-b");

    // A provider with no notification channel has one honest path left: recreate. Losing structural
    // state is correct over rendering another binding's data.
    expect(log.mounts.length).toBe(2);
    expect(log.mounts[log.mounts.length - 1]?.boundViewId).toBe("v-b");
  });

  // Axis exhaustiveness — the compiler enforces registration (satisfies), but only where tsc runs.
  // Here the oracle is **the ctx the host actually passes**: a hand-written fixture can drift from
  // the contract, and a drifted fixture passes while missing a real field.
  it("every value field of the ctx the host passes is registered on the axis", () => {
    const { provider, log } = makeProvider(false);
    act(() => {
      useViewRegistry.getState().register("p", DECL, provider as never);
    });
    act(() => {
      root = createRoot(host);
    });
    renderWith("v-a");

    const ctx = log.mounts[0] as unknown as Record<string, unknown>;
    const dataKeys = Object.keys(ctx).filter(
      (k) => typeof ctx[k] !== "function",
    );
    // Oracle liveness — with zero value fields read, this check cannot decide anything ("the two
    // faces of 0").
    expect(dataKeys.length).toBeGreaterThan(0);
    expect(BINDING_KEYS.length).toBeGreaterThan(0);

    const undeclared = dataKeys.filter((k) => !(k in VIEW_CONTEXT_AXIS));
    expect(undeclared).toEqual([]);
  });

  it("a changed seed (restore) causes neither a remount nor an update", () => {
    const { provider, log } = makeProvider(true);
    act(() => {
      useViewRegistry.getState().register("p", DECL, provider as never);
    });
    act(() => {
      root = createRoot(host);
    });
    const render = (state: unknown): void => {
      act(() => {
        root!.render(
          <PluginViewHost
            viewKey="p.list"
            projectId="p1"
            root="/r"
            region="center"
            viewId="v-a"
            restore={{ cwd: "/r", state }}
          />,
        );
      });
    };
    render({ url: "a" });
    const mounts = log.mounts.length;
    const updates = log.updates.length;

    // The feedback setRestoreState creates — the value the view reported comes back as a prop.
    render({ url: "b" });

    expect(log.mounts.length).toBe(mounts);
    expect(log.updates.length).toBe(updates);
  });
});
