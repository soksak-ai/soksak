import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { mountTerminal } from "@soksak/soksak-plugin-terminal-xterm";
import { nativeBrowserAttributes, normalizeBrowserURL } from "@soksak/soksak-plugin-browser-native";
import type { Axis, Program, WorkspaceNode } from "./layout";
import type { LeafNode } from "./layout";
import { terminalBinding, terminalEvents } from "./pluginAdapters";
import { claimDividerPointer, ratioFromPointer } from "./splitDrag";

type WorkspaceTreeProps = {
  node: WorkspaceNode;
  canClose: boolean;
  owners: ReadonlyMap<string, HTMLElement>;
  onClose: (id: string) => void;
  onSplit: (id: string, axis: Axis, program: Program) => void;
  onResize: (id: string, ratio: number) => void;
};

function PanelActions({ id, canClose, onClose, onSplit }: Pick<WorkspaceTreeProps, "canClose" | "onClose" | "onSplit"> & { id: string }) {
  return (
    <div className="panel-actions">
      <button onClick={() => onSplit(id, "row", "terminal")} title="split right with terminal">T→</button>
      <button onClick={() => onSplit(id, "column", "terminal")} title="split below with terminal">T↓</button>
      <button onClick={() => onSplit(id, "row", "browser")} title="split right with browser">B→</button>
      <button onClick={() => onSplit(id, "column", "browser")} title="split below with browser">B↓</button>
      <button
        className="close-panel"
        disabled={!canClose}
        onClick={() => onClose(id)}
        title={canClose ? "close panel" : "the last panel cannot be closed"}
        aria-label={`close ${id}`}
      >×</button>
    </div>
  );
}

function TerminalPanel({ id }: { id: string }) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;

    return mountTerminal(element, id, terminalBinding, terminalEvents);
  }, [id]);

  return <div ref={host} className="terminal-host" data-terminal-id={id} />;
}

function BrowserPanel({ id }: { id: string }) {
  const [draft, setDraft] = useState("https://example.com");
  const [url, setURL] = useState("https://example.com");

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const target = normalizeBrowserURL(draft);
    setDraft(target);
    setURL(target);
  };

  return (
    <div className="browser-panel">
      <form className="browser-bar" onSubmit={navigate}>
        <input aria-label="browser address" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="submit">Go</button>
      </form>
      <div className="native-browser-host" {...nativeBrowserAttributes({ id, generation: 1, url, layer: 10 })} />
      <div className="browser-classification">soksak-plugin-browser-native · declarative surface</div>
    </div>
  );
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
  onSplit: (id: string, axis: Axis, program: Program) => void;
}) {
  return (
    <article className="panel" data-leaf-id={leaf.id}>
      <header className="panel-header">
        <span>{leaf.program} · {leaf.id}</span>
        <PanelActions id={leaf.id} canClose={canClose} onClose={onClose} onSplit={onSplit} />
      </header>
      <div className="panel-body">
        {leaf.program === "terminal" ? <TerminalPanel id={leaf.id} /> : <BrowserPanel id={leaf.id} />}
      </div>
    </article>
  );
}
