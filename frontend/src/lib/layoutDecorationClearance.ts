import { moduleState } from "./moduleState";
import { presentationNowUnixUs } from "./presentationClock";

export type LayoutDecorationClearanceReceipt = Readonly<{
  transactionId: string;
  status: "pending" | "cleared" | "failed" | "cancelled";
  producer: "native-display-callback";
  railRole: string | null;
  railVisibility: string | null;
  callbackCount: number;
  clearedAtUnixUs?: number;
  failure?: string;
  sequence: number;
}>;

type State = {
  sequence: number;
  owners: Map<string, LayoutDecorationClearanceReceipt>;
  events: LayoutDecorationClearanceReceipt[];
};

const MAX_EVENTS = 64;
const state = moduleState("lib/layoutDecorationClearance#state", (): State => ({
  sequence: 0,
  owners: new Map(),
  events: [],
}));

function publish(
  transactionId: string,
  receipt: Omit<LayoutDecorationClearanceReceipt, "transactionId" | "sequence">,
): LayoutDecorationClearanceReceipt {
  state.sequence += 1;
  const next = Object.freeze({ transactionId, ...receipt, sequence: state.sequence });
  state.owners.set(transactionId, next);
  state.events.push(next);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
  return next;
}

export function beginLayoutDecorationClearance(transactionId: string): {
  publishFrame(railRole: string | null, railVisibility: string | null): LayoutDecorationClearanceReceipt;
  fail(failure: string): void;
  cancel(): void;
} {
  if (!transactionId.trim()) throw new Error("layout decoration clearance transactionId is empty");
  let callbackCount = 0;
  let terminal = false;
  publish(transactionId, {
    status: "pending",
    producer: "native-display-callback",
    railRole: null,
    railVisibility: null,
    callbackCount,
  });
  return {
    publishFrame(railRole, railVisibility) {
      if (terminal) return state.owners.get(transactionId)!;
      callbackCount += 1;
      const cleared = callbackCount >= 1
        && railRole === "absent"
        && railVisibility === "absent";
      if (cleared) terminal = true;
      return publish(transactionId, {
        status: cleared ? "cleared" : "pending",
        producer: "native-display-callback",
        railRole,
        railVisibility,
        callbackCount,
        ...(cleared ? { clearedAtUnixUs: presentationNowUnixUs() } : {}),
      });
    },
    fail(failure) {
      if (terminal) return;
      terminal = true;
      publish(transactionId, {
        status: "failed",
        producer: "native-display-callback",
        railRole: state.owners.get(transactionId)?.railRole ?? null,
        railVisibility: state.owners.get(transactionId)?.railVisibility ?? null,
        callbackCount,
        failure,
      });
    },
    cancel() {
      if (terminal) return;
      terminal = true;
      publish(transactionId, {
        status: "cancelled",
        producer: "native-display-callback",
        railRole: state.owners.get(transactionId)?.railRole ?? null,
        railVisibility: state.owners.get(transactionId)?.railVisibility ?? null,
        callbackCount,
      });
    },
  };
}

export function layoutDecorationClearanceFacts(): {
  owners: LayoutDecorationClearanceReceipt[];
  events: LayoutDecorationClearanceReceipt[];
  maxEvents: number;
} {
  return {
    owners: [...state.owners.values()].map((receipt) => ({ ...receipt })),
    events: state.events.map((receipt) => ({ ...receipt })),
    maxEvents: MAX_EVENTS,
  };
}

export function __resetLayoutDecorationClearanceForTest(): void {
  state.sequence = 0;
  state.owners.clear();
  state.events.length = 0;
}
