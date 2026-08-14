import { Fragment, PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";

import type { Axis, LeafNode, WorkspaceNode } from "./layout";
import { programs, views } from "./plugins";
import { claimDividerPointer, ratioFromPointer } from "./splitDrag";

type WorkspaceTreeProps = {
  node: WorkspaceNode;
  canClose: boolean;
  owners: ReadonlyMap<string, HTMLElement>;
  onClose: (id: string) => void;
  onSplit: (id: string, axis: Axis, programId: string) => void;
  onResize: (id: string, ratio: number) => void;
};

function PanelActions({ id, canClose, onClose, onSplit }: Pick<WorkspaceTreeProps, "canClose" | "onClose" | "onSplit"> & { id: string }) {
  // The add menu is a projection of the program registry. A hardcoded entry
  // here would be the core deciding which plugins deserve to appear.
  return (
    <div className="panel-actions">
      {programs.list().map((program) => (
        <Fragment key={program.id}>
          <button
            data-node={`panel/${id}/split-right/${program.id}`}
            onClick={() => onSplit(id, "row", program.id)}
            title={`split right with ${program.title}`}
          >{program.title} →</button>
          <button
            data-node={`panel/${id}/split-below/${program.id}`}
            onClick={() => onSplit(id, "column", program.id)}
            title={`split below with ${program.title}`}
          >{program.title} ↓</button>
        </Fragment>
      ))}
      <button
        className="close-panel"
        data-node={`panel/${id}/close`}
        disabled={!canClose}
        onClick={() => onClose(id)}
        title={canClose ? "close panel" : "the last panel cannot be closed"}
        aria-label={`close ${id}`}
      >×</button>
    </div>
  );
}

/**
 * The pane body: an empty container the core hands to whoever owns this program.
 *
 * A program with no registered view leaves the container empty and says so on
 * the element. Throwing here would take the whole tree down instead of one pane,
 * and a pane whose plugin is disabled is a legitimate state.
 */
function PanelBody({ leaf }: { leaf: LeafNode }) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    const program = programs.resolve(leaf.programId);
    const provider = program ? views.resolve(program.viewId) : null;
    element.dataset.viewState = provider ? "live" : "unavailable";
    if (!provider) return;

    return provider(element, { leafId: leaf.id });
  }, [leaf.id, leaf.programId]);

  return <div ref={host} className="panel-body" data-node={`panel/${leaf.id}/body`} />;
}

function SplitBranch({ node, canClose, owners, onClose, onSplit, onResize }: WorkspaceTreeProps & { node: Extract<WorkspaceNode, { kind: "split" }> }) {
  const host = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const applyPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = host.current;
    if (!element) return;
    onResize(node.id, ratioFromPointer(node.axis, element.getBoundingClientRect(), event.clientX, event.clientY));
  };

  return (
    <div ref={host} className={`split split-${node.axis}`} data-split-id={node.id}>
      <div style={{ flex: node.ratio }}><WorkspaceTree node={node.first} canClose={canClose} owners={owners} onClose={onClose} onSplit={onSplit} onResize={onResize} /></div>
      <div
        className="divider"
        role="separator"
        aria-orientation={node.axis === "row" ? "vertical" : "horizontal"}
        onPointerDown={(event) => {
          claimDividerPointer(event);
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          applyPointer(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current) {
            claimDividerPointer(event);
            applyPointer(event);
          }
        }}
        onPointerUp={(event) => {
          claimDividerPointer(event);
          dragging.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          claimDividerPointer(event);
          dragging.current = false;
        }}
        onLostPointerCapture={() => { dragging.current = false; }}
      />
      <div style={{ flex: 1 - node.ratio }}><WorkspaceTree node={node.second} canClose={canClose} owners={owners} onClose={onClose} onSplit={onSplit} onResize={onResize} /></div>
    </div>
  );
}

function LeafSlot({ id, owner }: { id: string; owner: HTMLElement }) {
  return (
    <div
      className="leaf-slot"
      data-leaf-slot={id}
      ref={(slot) => {
        if (slot && owner.parentElement !== slot) slot.append(owner);
      }}
    />
  );
}

export function WorkspaceTree({ node, canClose, owners, onClose, onSplit, onResize }: WorkspaceTreeProps) {
  if (node.kind === "split") {
    return <SplitBranch node={node} canClose={canClose} owners={owners} onClose={onClose} onSplit={onSplit} onResize={onResize} />;
  }

  return <LeafSlot id={node.id} owner={owners.get(node.id)!} />;
}

export function WorkspacePanel({ leaf, canClose, onClose, onSplit }: {
  leaf: LeafNode;
  canClose: boolean;
  onClose: (id: string) => void;
  onSplit: (id: string, axis: Axis, programId: string) => void;
}) {
  return (
    <article className="panel" data-leaf-id={leaf.id} data-node={`panel/${leaf.id}`}>
      <header className="panel-header">
        <span>{programs.resolve(leaf.programId)?.title ?? leaf.programId} · {leaf.id}</span>
        <PanelActions id={leaf.id} canClose={canClose} onClose={onClose} onSplit={onSplit} />
      </header>
      <PanelBody leaf={leaf} />
    </article>
  );
}
