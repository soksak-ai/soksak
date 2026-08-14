export type SerializedProviderError = Readonly<{
  kind: "error" | "object" | "string" | "unknown";
  name?: string;
  code?: string;
  message: string;
  data?: unknown;
  receipt?: unknown;
}>;

function cloneFact(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return String(value);
  }
}

export function serializePresentationProviderError(value: unknown): SerializedProviderError {
  if (value instanceof Error) {
    const owned = value as Error & { code?: unknown; data?: unknown; receipt?: unknown };
    return {
      kind: "error",
      name: value.name,
      ...(typeof owned.code === "string" ? { code: owned.code } : {}),
      message: value.message,
      ...(owned.data !== undefined ? { data: cloneFact(owned.data) } : {}),
      ...(owned.receipt !== undefined ? { receipt: cloneFact(owned.receipt) } : {}),
    };
  }
  if (typeof value === "string") return { kind: "string", message: value };
  if (value && typeof value === "object") {
    const owned = value as { name?: unknown; code?: unknown; message?: unknown; data?: unknown; receipt?: unknown };
    return {
      kind: "object",
      ...(typeof owned.name === "string" ? { name: owned.name } : {}),
      ...(typeof owned.code === "string" ? { code: owned.code } : {}),
      message: typeof owned.message === "string" ? owned.message : String(value),
      ...(owned.data !== undefined ? { data: cloneFact(owned.data) } : {}),
      ...(owned.receipt !== undefined ? { receipt: cloneFact(owned.receipt) } : {}),
    };
  }
  return { kind: "unknown", message: String(value) };
}

export type PresentationBarrierSuccess = Readonly<{
  owner: "content" | "view";
  status: "settled";
  elapsedMs: number;
  labels: readonly string[];
  details?: unknown;
}>;

export type LayoutSettlementFailureReceipt = Readonly<{
  command: "ui.layout.wait-settled";
  barrier: "content" | "view";
  elapsedMs: number;
  labels: readonly string[];
  providerError: SerializedProviderError;
  status: unknown;
}>;

export class LayoutSettlementFailure extends Error {
  readonly code = "PRESENTATION_PROVIDER_FAILED" as const;

  constructor(readonly receipt: LayoutSettlementFailureReceipt) {
    super(`${receipt.barrier} presentation barrier failed: ${receipt.providerError.message}`);
    this.name = "LayoutSettlementFailure";
  }
}

export class LayoutSettlementTimeout extends Error {
  readonly code = "TIMEOUT" as const;
  constructor(readonly status: unknown, timeoutMs: number) {
    super(`layout transaction did not close within ${timeoutMs}ms: ${JSON.stringify(status)}`);
    this.name = "LayoutSettlementTimeout";
  }
}
