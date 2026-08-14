import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { TerminalService } from "../bindings/local/soksak-wails3beta";
import { Service as NativeBrowserService } from "../bindings/local/soksak-wails3beta/nativebrowser";
import type { Axis, Program, WorkspaceNode } from "./layout";
import { createNativeBrowserFramePublisher, type NativeBrowserFrame } from "./nativeBrowserFrame";
import { claimDividerPointer, ratioFromPointer } from "./splitDrag";
import { createTerminalMountScheduler, isRenderableTerminalHost } from "./terminalMount";

type TerminalHandle = { id: string; generation: number };
type BrowserHandle = { id: string; generation: number };

type WorkspaceTreeProps = {
  node: WorkspaceNode;
  canClose: boolean;
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

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      theme: { background: "#0b0d10", foreground: "#d7e0ea", cursor: "#ff9f6e" },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);

    const scheduler = createTerminalMountScheduler(requestAnimationFrame);
    let handle: TerminalHandle | null = null;
    let disposed = false;

    const resize = () => {
	  if (!isRenderableTerminalHost(element)) return;
      fit.fit();
      if (handle && terminal.cols > 0 && terminal.rows > 0) {
        void TerminalService.Resize(handle.id, handle.generation, terminal.cols, terminal.rows);
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    const offOutput = Events.On("terminal:output", (event) => {
      if (handle && event.data.id === handle.id && event.data.generation === handle.generation) {
        terminal.write(event.data.data);
      }
    });
    const input = terminal.onData((data) => {
      if (handle) void TerminalService.Write(handle.id, handle.generation, data);
    });

    scheduler.afterPaint(() => {
      if (!isRenderableTerminalHost(element)) return;
      fit.fit();
      void TerminalService.Open(id, terminal.cols || 80, terminal.rows || 24).then((opened) => {
        if (disposed) {
          void TerminalService.Close(opened.id, opened.generation);
          return;
        }
        handle = opened;
        resize();
      });
    });

    return () => {
      disposed = true;
      scheduler.dispose();
      input.dispose();
      offOutput();
      observer.disconnect();
      if (handle) void TerminalService.Close(handle.id, handle.generation);
      terminal.dispose();
    };
  }, [id]);

  return <div ref={host} className="terminal-host" data-terminal-id={id} />;
}

function browserFrame(element: HTMLElement): NativeBrowserFrame | null {
  const rect = element.getBoundingClientRect();
  if (!element.isConnected || rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function BrowserPanel({ id }: { id: string }) {
  const [draft, setDraft] = useState("https://example.com");
  const host = useRef<HTMLDivElement | null>(null);
  const handle = useRef<BrowserHandle | null>(null);
  const latest = useRef<{ sequence: number; frame: NativeBrowserFrame } | null>(null);
  const publisher = useRef<ReturnType<typeof createNativeBrowserFramePublisher> | null>(null);
  if (!publisher.current) {
    publisher.current = createNativeBrowserFramePublisher((sequence, frame) => {
      latest.current = { sequence, frame };
      if (handle.current) void NativeBrowserService.SetFrame(handle.current, sequence, frame);
    });
  }

  const reportLayoutFrame = () => {
    const element = host.current;
    if (!element) return;
    const next = browserFrame(element);
    if (next) publisher.current?.publish(next);
  };

  useLayoutEffect(reportLayoutFrame);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;

    const observer = new ResizeObserver(reportLayoutFrame);
    observer.observe(element);

    requestAnimationFrame(() => {
      if (disposed) return;
      reportLayoutFrame();
      if (!latest.current) return;
      void NativeBrowserService.Open(id, draft, latest.current.sequence, latest.current.frame).then((receipt) => {
        if (disposed) {
          void NativeBrowserService.Close(receipt.handle);
          return;
        }
        handle.current = receipt.handle;
        reportLayoutFrame();
      });
    });

    return () => {
      disposed = true;
      observer.disconnect();
      if (handle.current) void NativeBrowserService.Close(handle.current);
      handle.current = null;
    };
  }, [id]);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const target = /^https?:\/\//i.test(draft) ? draft : `https://${draft}`;
    setDraft(target);
    if (handle.current) void NativeBrowserService.Navigate(handle.current, target);
  };

  return (
    <div className="browser-panel">
      <form className="browser-bar" onSubmit={navigate}>
        <input aria-label="browser address" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <button type="submit">Go</button>
      </form>
      <div ref={host} className="native-browser-host" data-native-browser-id={id} />
      <div className="browser-classification">native WKWebView child surface</div>
    </div>
  );
}

function SplitBranch({ node, canClose, onClose, onSplit, onResize }: WorkspaceTreeProps & { node: Extract<WorkspaceNode, { kind: "split" }> }) {
  const host = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const applyPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = host.current;
    if (!element) return;
    onResize(node.id, ratioFromPointer(node.axis, element.getBoundingClientRect(), event.clientX, event.clientY));
  };

  return (
    <div ref={host} className={`split split-${node.axis}`} data-split-id={node.id}>
      <div style={{ flex: node.ratio }}><WorkspaceTree node={node.first} canClose={canClose} onClose={onClose} onSplit={onSplit} onResize={onResize} /></div>
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
      <div style={{ flex: 1 - node.ratio }}><WorkspaceTree node={node.second} canClose={canClose} onClose={onClose} onSplit={onSplit} onResize={onResize} /></div>
    </div>
  );
}

export function WorkspaceTree({ node, canClose, onClose, onSplit, onResize }: WorkspaceTreeProps) {
  if (node.kind === "split") {
    return <SplitBranch node={node} canClose={canClose} onClose={onClose} onSplit={onSplit} onResize={onResize} />;
  }

  return (
    <article className="panel" data-leaf-id={node.id}>
      <header className="panel-header">
        <span>{node.program} · {node.id}</span>
        <PanelActions id={node.id} canClose={canClose} onClose={onClose} onSplit={onSplit} />
      </header>
      <div className="panel-body">
        {node.program === "terminal" ? <TerminalPanel id={node.id} /> : <BrowserPanel id={node.id} />}
      </div>
    </article>
  );
}
