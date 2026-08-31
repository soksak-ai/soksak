export type ResizeGesturePhase = "idle" | "started" | "moving" | "ended";
export interface ResizeGestureFacts { phase: ResizeGesturePhase; gutter: string | null; moveCount: number; applyCount: number; computedSizes: number[] | null; appliedSizes: number[] | null; startX: number | null; startY: number | null; lastX: number | null; lastY: number | null; }
let facts: ResizeGestureFacts = { phase: "idle", gutter: null, moveCount: 0, applyCount: 0, computedSizes: null, appliedSizes: null, startX: null, startY: null, lastX: null, lastY: null };
export const resizeGestureFacts = (): ResizeGestureFacts => ({ ...facts });
export function beginResizeGesture(gutter: string, x: number, y: number): void { facts = { phase: "started", gutter, moveCount: 0, applyCount: 0, computedSizes: null, appliedSizes: null, startX: x, startY: y, lastX: x, lastY: y }; }
export function moveResizeGesture(x: number, y: number): void { if (facts.phase === "idle" || facts.phase === "ended") return; facts = { ...facts, phase: "moving", moveCount: facts.moveCount + 1, lastX: x, lastY: y }; }
export function computedResizeSizes(sizes: number[]): void { if (facts.phase === "idle" || facts.phase === "ended") return; facts = { ...facts, computedSizes: [...sizes] }; }
export function appliedResizeSizes(sizes: number[]): void { if (facts.phase === "idle") return; facts = { ...facts, applyCount: facts.applyCount + 1, appliedSizes: [...sizes] }; }
export function endResizeGesture(): void { if (facts.phase === "idle") return; facts = { ...facts, phase: "ended" }; }
