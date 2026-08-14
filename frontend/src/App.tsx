import { useState } from "react";

import { closeLeaf, createWorkspace, leaves, resizeSplit, splitLeaf, type Axis, type Program, type WorkspaceNode } from "./layout";
import { WorkspaceTree } from "./workspace";

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceNode>(() => createWorkspace());

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
        <strong>Wails 3 Beta compositor spike</strong>
        <span>recursive terminal + browser workspace</span>
      </header>
      <section className="workspace" aria-label="recursive workspace">
        <WorkspaceTree
          node={workspace}
          canClose={leaves(workspace).length > 1}
          onClose={close}
          onSplit={split}
          onResize={resize}
        />
      </section>
    </main>
  );
}
