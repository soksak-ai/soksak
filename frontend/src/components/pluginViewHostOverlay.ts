import { moduleState } from "../lib/moduleState";

export type PluginViewHostOverlayReason =
  | "none"
  | "registry-loading"
  | "registry-missing"
  | "presentation-error";

export type PluginViewHostOverlayInput = Readonly<{
  viewKey: string;
  viewId: string | null;
  containerGeneration: number;
  registryPresent: boolean;
  bootPhase: string;
  overlayReason: PluginViewHostOverlayReason;
  error: string | null;
}>;

export type PluginViewHostOverlayReceipt = PluginViewHostOverlayInput & Readonly<{
  sequence: number;
}>;

const identityKey = ({ viewKey, viewId, containerGeneration }: Readonly<{
  viewKey: string;
  viewId: string | null;
  containerGeneration: number;
}>) => `${viewKey}\u0000${viewId ?? ""}\u0000${containerGeneration}`;

export function overlayReasonOf(input: Readonly<{
  registryPresent: boolean;
  bootPhase: string;
  error: string | null;
}>): PluginViewHostOverlayReason {
  if (!input.registryPresent) return input.bootPhase === "ready" ? "registry-missing" : "registry-loading";
  return input.error === null ? "none" : "presentation-error";
}

export class PluginViewHostOverlayLedger {
  #sequence = 0;
  #current = new Map<string, PluginViewHostOverlayReceipt>();
  #events: PluginViewHostOverlayReceipt[] = [];

  constructor(readonly maxEvents = 64) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new TypeError("overlay maxEvents must be positive");
  }

  report(input: PluginViewHostOverlayInput): PluginViewHostOverlayReceipt {
    const receipt = structuredClone({ ...input, sequence: ++this.#sequence });
    this.#current.set(identityKey(input), receipt);
    this.#events.push(receipt);
    if (this.#events.length > this.maxEvents) this.#events.splice(0, this.#events.length - this.maxEvents);
    return structuredClone(receipt);
  }

  remove(identity: Readonly<{ viewKey: string; viewId: string | null; containerGeneration: number }>): void {
    this.#current.delete(identityKey(identity));
  }

  status() {
    return {
      current: [...this.#current.values()].map((receipt) => structuredClone(receipt)),
      events: this.#events.map((receipt) => structuredClone(receipt)),
      maxEvents: this.maxEvents,
    };
  }
}

const ledger = moduleState(
  "components/PluginViewHost#overlayLedger",
  () => new PluginViewHostOverlayLedger(),
);

export const publishPluginViewHostOverlay = (input: PluginViewHostOverlayInput) => ledger.report(input);
export const removePluginViewHostOverlay = (
  identity: Readonly<{ viewKey: string; viewId: string | null; containerGeneration: number }>,
) => ledger.remove(identity);
export const pluginViewHostOverlayStatus = () => ledger.status();
