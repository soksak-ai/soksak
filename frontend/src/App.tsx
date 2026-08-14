import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { nativeSurfaceDOMRuntime, startNativeSurfaceObserver } from "@soksak/wails-service-native-compositor";

import { closeLeaf, createWorkspace, leaves, resizeSplit, splitLeaf, type Axis, type Program, type WorkspaceNode } from "./layout";
import { createLeafOwnerRegistry, publishLeafLayoutCommit } from "./leafOwners";
import { WorkspacePanel, WorkspaceTree } from "./workspace";
import { commitNativeSurfaceSnapshot } from "./pluginAdapters";

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceNode>(() => createWorkspace());
  const ownerRegistry = useRef<ReturnType<typeof createLeafOwnerRegistry<HTMLElement>> | null>(null);
  if (!ownerRegistry.current) {
    ownerRegistry.current = createLeafOwnerRegistry((id) => {
      const owner = document.createElement("div");
      owner.className = "leaf-owner";
      owner.dataset.leafOwner = id;
      return owner;
    });
  }
  const currentLeaves = leaves(workspace);
  const owners = ownerRegistry.current.reconcile(currentLeaves.map((leaf) => leaf.id));

  useEffect(() => {
    const controller = startNativeSurfaceObserver(nativeSurfaceDOMRuntime(document), commitNativeSurfaceSnapshot);
    return () => controller.stop();
  }, []);

  useLayoutEffect(() => {
    document.documentElement.dataset.bootStatus = "ready";
    delete document.documentElement.dataset.bootError;
    const bootError = document.querySelector<HTMLElement>("[data-boot-error]");
    if (bootError) bootError.hidden = true;
  }, []);

  useLayoutEffect(() => {
    publishLeafLayoutCommit(owners.values());
  }, [workspace]);

  const split = (id: string, axis: Axis, program: Program) => {
    setWorkspace((current) => splitLeaf(current, id, axis, program));
  };

  const resize = (id: string, ratio: number) => {
    setWorkspace((current) => resizeSplit(current, id, ratio));
  };

  const close = (id: string) => {
    setWorkspace((current) => closeLeaf(current, id));
  };

  return (
    <main className="app-shell">
      <header className="app-titlebar">
        <strong>soksak-core 0.0.1</strong>
        <span>plugin-driven terminal + native browser workspace</span>
      </header>
      <section className="workspace" aria-label="recursive workspace">
        <WorkspaceTree
          node={workspace}
          canClose={currentLeaves.length > 1}
          owners={owners}
          onClose={close}
          onSplit={split}
          onResize={resize}
        />
        {currentLeaves.map((leaf) => createPortal(
          <WorkspacePanel
            key={leaf.id}
            leaf={leaf}
            canClose={currentLeaves.length > 1}
            onClose={close}
            onSplit={split}
          />,
          owners.get(leaf.id)!,
          leaf.id,
        ))}
      </section>
    </main>
  );
}
