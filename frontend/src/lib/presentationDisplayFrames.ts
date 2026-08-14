import { moduleState } from "./moduleState";

export type PresentationDisplayFrame = Readonly<{
  traceId: string;
  producer: "native-display-link";
  clock: string;
  sourceGeneration: number;
  frameSequence: number;
  presentationRevision: number;
  presentedAtUnixMs: number;
}>;

type Listener = (frame: PresentationDisplayFrame) => void;

const MAX_PRESENTATION_DISPLAY_FRAMES = 64;
const state = moduleState("lib/presentationDisplayFrames#state", () => ({
  events: [] as PresentationDisplayFrame[],
  listeners: new Set<Listener>(),
}));

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Framework adapters publish only producer-owned display callback receipts here. */
export function publishPresentationDisplayFrame(input: PresentationDisplayFrame): void {
  if (typeof input.traceId !== "string" || input.traceId.trim() === ""
      || input.producer !== "native-display-link"
      || typeof input.clock !== "string" || input.clock.trim() === ""
      || !positiveInteger(input.sourceGeneration)
      || !Number.isSafeInteger(input.frameSequence) || input.frameSequence < 0
      || !positiveInteger(input.presentationRevision)
      || !Number.isFinite(input.presentedAtUnixMs)) {
    throw new Error(`presentation display frame identity is not valid: ${JSON.stringify(input)}`);
  }
  const frame = Object.freeze({ ...input });
  state.events.push(frame);
  if (state.events.length > MAX_PRESENTATION_DISPLAY_FRAMES) {
    state.events.splice(0, state.events.length - MAX_PRESENTATION_DISPLAY_FRAMES);
  }
  for (const listener of state.listeners) listener(frame);
}

export function onPresentationDisplayFrame(listener: Listener): () => void {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function presentationDisplayFrameFacts(traceId?: string): PresentationDisplayFrame[] {
  return state.events
    .filter((event) => traceId === undefined || event.traceId === traceId)
    .map((event) => ({ ...event }));
}

export function __resetPresentationDisplayFramesForTest(): void {
  state.events.splice(0);
  state.listeners.clear();
}
