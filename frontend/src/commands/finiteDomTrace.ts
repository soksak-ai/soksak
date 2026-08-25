import {
  compareStackingPaths,
  stackingPathOf,
  type StackingComputedStyle,
  type StackingPathEntry,
} from "../lib/stackingOrder";
import { nodeIdentityOf } from "./domNodeIdentity";

export type DomTraceTarget = { address: string; el: Element };

export type DomAnimationSample = {
  name: string;
  playState: AnimationPlayState;
  startTime: number | null;
  currentTime: number | null;
  progress: number | null;
};

export type DomTraceSample = {
  captureFrame: number;
  frameTime: number;
  unixMs: number;
  nodes: Array<{
    address: string;
    nodeIdentity: string;
    connected: boolean;
    rect: { x: number; y: number; w: number; h: number };
    dataset: Record<string, string>;
    style: { display: string; visibility: string; opacity: string };
    animations: DomAnimationSample[];
    stacking: StackingPathEntry[];
  }>;
  intersections: Array<{
    addresses: [string, string];
    rect: { x: number; y: number; w: number; h: number };
    point: { x: number; y: number };
    hitStack: string[];
    hitTopmostAddress: string | null;
    paintTopmostAddress: string | null;
  }>;
};

function intersection(
  left: { x: number; y: number; w: number; h: number },
  right: { x: number; y: number; w: number; h: number },
) {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const edgeX = Math.min(left.x + left.w, right.x + right.w);
  const edgeY = Math.min(left.y + left.h, right.y + right.h);
  return { x, y, w: Math.max(0, edgeX - x), h: Math.max(0, edgeY - y) };
}

/**
 * Reads several public DOM nodes on the exact frame event where the capture plugin reported a
 * finished save. No separate rAF/timer clock, so it does not stall for an occluded window, and
 * PNG fNNNN always maps 1:1 to sample.captureFrame.
 */
export function createFiniteDomTraceSampler(
  targets: readonly DomTraceTarget[],
): { sample(captureFrame: number, frameTime?: number): void; samples(): DomTraceSample[] } {
  const samples: DomTraceSample[] = [];
  const identities = new WeakMap<Element, string>();
  let identitySequence = 0;
  const identify = (node: Element) => {
    const target = targets.find(({ el }) => el === node);
    if (target) return target.address;
    let identity = identities.get(node);
    if (!identity) {
      identitySequence += 1;
      identity = `dom-trace/${identitySequence}`;
      identities.set(node, identity);
    }
    return identity;
  };
  return {
    sample(captureFrame, frameTime = performance.now()) {
      const nodes = targets.map(({ address, el }) => {
        const rect = el.getBoundingClientRect();
        const computed = getComputedStyle(el);
        const dataset = "dataset" in el
          ? Object.fromEntries(Object.entries((el as HTMLElement).dataset)) as Record<string, string>
          : {};
        const animations = typeof el.getAnimations === "function"
          ? el.getAnimations().map((animation) => {
              const css = animation as CSSAnimation;
              const timing = animation.effect?.getComputedTiming();
              return {
                name: css.animationName ?? "",
                playState: animation.playState,
                startTime: typeof animation.startTime === "number" ? animation.startTime : null,
                currentTime: typeof animation.currentTime === "number" ? animation.currentTime : null,
                progress: typeof timing?.progress === "number" ? timing.progress : null,
              };
            })
          : [];
        return {
          address,
          nodeIdentity: nodeIdentityOf(el),
          connected: el.isConnected,
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          dataset,
          style: {
            display: computed.display,
            visibility: computed.visibility,
            opacity: computed.opacity,
          },
          animations,
          stacking: stackingPathOf(el, {
            getStyle: (node) => getComputedStyle(node) as unknown as Partial<StackingComputedStyle>,
            identify,
          }),
        };
      });
      const intersections: DomTraceSample["intersections"] = [];
      for (let left = 0; left < nodes.length; left += 1) {
        for (let right = left + 1; right < nodes.length; right += 1) {
          const rect = intersection(nodes[left].rect, nodes[right].rect);
          if (!(rect.w > 0 && rect.h > 0)) continue;
          const point = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
          const hitStack: string[] = [];
          for (const hit of document.elementsFromPoint(point.x, point.y)) {
            for (const target of targets) {
              if ((target.el === hit || target.el.contains(hit))
                  && !hitStack.includes(target.address)) {
                hitStack.push(target.address);
              }
            }
          }
          const paintOrder = compareStackingPaths(nodes[left].stacking, nodes[right].stacking);
          intersections.push({
            addresses: [nodes[left].address, nodes[right].address],
            rect,
            point,
            hitStack,
            hitTopmostAddress: hitStack[0] ?? null,
            paintTopmostAddress: paintOrder === 1
              ? nodes[left].address
              : paintOrder === -1 ? nodes[right].address : null,
          });
        }
      }
      samples.push({
        captureFrame,
        frameTime,
        unixMs: performance.timeOrigin + frameTime,
        nodes,
        intersections,
      });
    },
    samples: () => samples.slice(),
  };
}
