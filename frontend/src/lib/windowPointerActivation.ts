import { listenThisWindow } from "./windowEvents";
import { activateExposedInputTarget } from "./viewActivation";

export interface NativePointerEdge {
  sequence: number;
  phase: "down" | "up";
  source: "system" | "contract-injection";
  x: number;
  y: number;
  atUnixMs: number;
  window: string;
}

export interface WindowPointerActivationState {
  sequence: number;
  phase: "down" | "up";
  source: "system" | "contract-injection";
  x: number;
  y: number;
  atUnixMs: number;
  targetNode: string | null;
  domDelivered: boolean;
  fallbackPending: boolean;
  fallbackApplied: boolean;
}

interface DomEdge {
  phase: "down" | "up";
  x: number;
  y: number;
  atUnixMs: number;
}

const MATCH_MS = 80;
const MATCH_PX = 1;

function sameEdge(native: NativePointerEdge, dom: DomEdge): boolean {
  return native.phase === dom.phase
    && Math.abs(native.x - dom.x) <= MATCH_PX
    && Math.abs(native.y - dom.y) <= MATCH_PX
    && Math.abs(native.atUnixMs - dom.atUnixMs) <= MATCH_MS;
}

export class WindowPointerActivationCoordinator {
  private readonly dom: DomEdge[] = [];
  private pending: { edge: NativePointerEdge; target: Element | null; domDelivered: boolean } | null = null;
  private last: WindowPointerActivationState | null = null;

  constructor(
    private readonly hit: (x: number, y: number) => Element | null,
    private readonly activate: (target: Element | null) => boolean,
    private readonly schedule: (apply: () => void) => void = (apply) => apply(),
  ) {}

  observeDom(edge: DomEdge): void {
    this.dom.push(edge);
    if (this.dom.length > 16) this.dom.shift();
    if (this.pending && sameEdge(this.pending.edge, edge)) this.pending.domDelivered = true;
  }

  observeNative(edge: NativePointerEdge): void {
    if (edge.phase === "down") {
      this.pending = {
        edge,
        target: this.hit(edge.x, edge.y),
        domDelivered: this.dom.some((item) => sameEdge(edge, item)),
      };
      this.last = this.stateOf(edge, this.pending.target, this.pending.domDelivered, false, false);
      return;
    }
    const pending = this.pending?.edge.sequence === edge.sequence ? this.pending : null;
    const domDelivered = Boolean(pending?.domDelivered || this.dom.some((item) => sameEdge(edge, item)));
    const target = pending?.target ?? this.hit(edge.x, edge.y);
    this.last = this.stateOf(edge, target, domDelivered, !domDelivered, false);
    if (!domDelivered) {
      const apply = () => {
        const fallbackApplied = this.activate(target);
        if (this.last?.sequence === edge.sequence) {
          this.last = this.stateOf(edge, target, false, false, fallbackApplied);
        }
      };
      if (edge.source === "contract-injection") queueMicrotask(apply);
      else this.schedule(apply);
    }
    this.pending = null;
  }

  snapshot(): WindowPointerActivationState | null {
    return this.last ? { ...this.last } : null;
  }

  private stateOf(
    edge: NativePointerEdge,
    target: Element | null,
    domDelivered: boolean,
    fallbackPending: boolean,
    fallbackApplied: boolean,
  ): WindowPointerActivationState {
    return {
      sequence: edge.sequence,
      phase: edge.phase,
      source: edge.source,
      x: edge.x,
      y: edge.y,
      atUnixMs: edge.atUnixMs,
      targetNode: target instanceof Element
        ? target.closest<HTMLElement>("[data-node]")?.dataset.node ?? null
        : null,
      domDelivered,
      fallbackPending,
      fallbackApplied,
    };
  }
}

let coordinator: WindowPointerActivationCoordinator | null = null;

function domUnixMs(event: MouseEvent): number {
  return event.timeStamp > 1_000_000_000_000
    ? event.timeStamp
    : performance.timeOrigin + event.timeStamp;
}

export function startWindowPointerActivation(): () => void {
  coordinator = new WindowPointerActivationCoordinator(
    (x, y) => document.elementFromPoint(x, y),
    activateExposedInputTarget,
    (apply) => { requestAnimationFrame(() => apply()); },
  );
  const onDown = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    coordinator?.observeDom({ phase: "down", x: event.clientX, y: event.clientY, atUnixMs: domUnixMs(event) });
  };
  const onUp = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    coordinator?.observeDom({ phase: "up", x: event.clientX, y: event.clientY, atUnixMs: domUnixMs(event) });
  };
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("mouseup", onUp, true);
  const off = listenThisWindow<NativePointerEdge>("window.input.pointer", (event) => {
    coordinator?.observeNative(event.payload);
  });
  return () => {
    off();
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("mouseup", onUp, true);
    coordinator = null;
  };
}

export function windowPointerActivationState(): WindowPointerActivationState | null {
  return coordinator?.snapshot() ?? null;
}
