import { invoke } from "../framework";
import { tmsg } from "../i18n";
import { isRateLimited, retryAfterCeilingMs, retryAfterMs } from "./registryRetryAfter";
import { moduleState } from "../lib/moduleState";
import { create } from "zustand";
import {
  parseSignedRegistryIndex,
  type CertifiedRegistryIndex,
  type RegistryCertificationResult,
  type RegistryHighWater,
  type RegistryPublicKey,
} from "../plugins/spec";
import {
  OFFICIAL_REGISTRY_ID,
  parseRegistryDescriptor,
  qualifyRegistry,
  registryCredentialSlot,
  type QualifiedRegistryEntry,
  type RegistryDescriptor,
} from "../plugins/registry";
import { OFFICIAL_REGISTRY_TRUST } from "../plugins/registryOfficialTrust";
import { createCoreSync } from "./coreSync";
import type { CoreStoreDeps } from "./coreStore";

const OFFICIAL_REMOTE_URL =
  "https://api.github.com/repos/soksak-ai/soksak-plugin-registry/contents/registry-signed.json";

export const OFFICIAL_REGISTRY_DESCRIPTOR: RegistryDescriptor = {
  id: OFFICIAL_REGISTRY_ID,
  name: "soksak official",
  indexUrl: OFFICIAL_REMOTE_URL,
  visibility: "public",
  trustedPublicKey: OFFICIAL_REGISTRY_TRUST,
};

export type RegistryStatus = "idle" | "fetching" | "live" | "uncertified" | "error";

export interface RegistryTrustRecord {
  publicKey: RegistryPublicKey;
  highWater?: RegistryHighWater;
}

export interface RegistrySourceState {
  descriptor: RegistryDescriptor;
  status: RegistryStatus;
  fetchedOnce: boolean;
  entries: QualifiedRegistryEntry[];
  certified?: CertifiedRegistryIndex;
  error?: string;
  lastFetchedAt?: number;
}

export type RegistryEventType =
  | "registry.added"
  | "registry.removed"
  | "registry.refresh.started"
  | "registry.refresh.succeeded"
  | "registry.refresh.uncertified"
  | "registry.refresh.failed";

export interface RegistryEvent {
  seq: number;
  at: number;
  type: RegistryEventType;
  registryId: string;
  detail?: string;
}

type RegistryMutationResult =
  | { ok: true; registryId: string }
  | {
      ok: false;
      code: "INVALID_PARAMS" | "ALREADY_EXISTS" | "TARGET_NOT_FOUND" | "TRUST_CONFLICT";
      message: string;
    };

export interface RegistryRefreshResult {
  registryId: string;
  status: RegistryStatus;
  error?: string;
  skipped?: boolean;
}

export interface RegistryState {
  /** Authenticated official plugin releases. */
  entries: QualifiedRegistryEntry[];
  /** Authenticated plugin, sidecar, and kit releases from every configured registry. */
  releases: QualifiedRegistryEntry[];
  descriptors: RegistryDescriptor[];
  registries: Record<string, RegistrySourceState>;
  trustRecords: Record<string, RegistryTrustRecord>;
  status: RegistryStatus;
  fetchedOnce: boolean;
  events: RegistryEvent[];
  add: (descriptor: unknown) => RegistryMutationResult;
  remove: (registryId: string) => RegistryMutationResult;
  refresh: (force?: boolean, registryId?: string) => Promise<RegistryRefreshResult[]>;
}

interface PersistedRegistries {
  descriptors: RegistryDescriptor[];
  trustRecords: Record<string, RegistryTrustRecord>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePublicKey(left: RegistryPublicKey, right: RegistryPublicKey): boolean {
  return left.algorithm === right.algorithm && left.keyId === right.keyId && left.value === right.value;
}

function parseHighWater(raw: unknown): RegistryHighWater | undefined {
  if (
    !isRecord(raw) ||
    !Number.isSafeInteger(raw.sequence) ||
    (raw.sequence as number) < 1 ||
    typeof raw.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.digest)
  ) return undefined;
  return { sequence: raw.sequence as number, digest: raw.digest };
}

function parseTrustRecord(raw: unknown): RegistryTrustRecord | null {
  if (!isRecord(raw)) return null;
  const descriptor = parseRegistryDescriptor({
    id: "trust-record",
    name: "trust record",
    indexUrl: "https://trust.invalid/index.json",
    visibility: "public",
    trustedPublicKey: raw.publicKey,
  });
  if (!descriptor) return null;
  const highWater = parseHighWater(raw.highWater);
  if (raw.highWater !== undefined && highWater === undefined) return null;
  return {
    publicKey: descriptor.trustedPublicKey,
    ...(highWater ? { highWater } : {}),
  };
}

function safePersisted(raw: unknown): PersistedRegistries {
  const value = isRecord(raw) ? raw : {};
  const rawTrust = isRecord(value.trustRecords) ? value.trustRecords : {};
  const trustRecords: Record<string, RegistryTrustRecord> = {};
  for (const [id, candidate] of Object.entries(rawTrust)) {
    const parsed = parseTrustRecord(candidate);
    if (parsed) trustRecords[id] = parsed;
  }
  const officialStored = trustRecords[OFFICIAL_REGISTRY_ID];
  trustRecords[OFFICIAL_REGISTRY_ID] = {
    publicKey: OFFICIAL_REGISTRY_TRUST,
    ...(officialStored && samePublicKey(officialStored.publicKey, OFFICIAL_REGISTRY_TRUST) && officialStored.highWater
      ? { highWater: officialStored.highWater }
      : {}),
  };

  const descriptors: RegistryDescriptor[] = [];
  const ids = new Set<string>([OFFICIAL_REGISTRY_ID]);
  if (Array.isArray(value.descriptors)) {
    for (const candidate of value.descriptors) {
      const descriptor = parseRegistryDescriptor(candidate);
      if (!descriptor || ids.has(descriptor.id)) continue;
      const pinned = trustRecords[descriptor.id];
      if (pinned && !samePublicKey(pinned.publicKey, descriptor.trustedPublicKey)) continue;
      trustRecords[descriptor.id] = pinned ?? { publicKey: descriptor.trustedPublicKey };
      ids.add(descriptor.id);
      descriptors.push(descriptor);
    }
  }
  return { descriptors, trustRecords };
}

function initialSource(descriptor: RegistryDescriptor): RegistrySourceState {
  return { descriptor, status: "idle", fetchedOnce: false, entries: [] };
}

function sourcesFor(
  descriptors: readonly RegistryDescriptor[],
  trustRecords: Readonly<Record<string, RegistryTrustRecord>>,
  current: Readonly<Record<string, RegistrySourceState>> = {},
): Record<string, RegistrySourceState> {
  const result: Record<string, RegistrySourceState> = {};
  for (const descriptor of descriptors) {
    const prior = current[descriptor.id];
    const highWater = trustRecords[descriptor.id]?.highWater;
    const priorSequence = prior?.certified?.highWater.sequence;
    result[descriptor.id] = prior &&
        samePublicKey(prior.descriptor.trustedPublicKey, descriptor.trustedPublicKey) &&
        (highWater === undefined || priorSequence === undefined || priorSequence >= highWater.sequence)
      ? { ...prior, descriptor }
      : initialSource(descriptor);
  }
  return result;
}

function projections(
  descriptors: readonly RegistryDescriptor[],
  registries: Readonly<Record<string, RegistrySourceState>>,
): Pick<RegistryState, "entries" | "releases" | "status" | "fetchedOnce"> {
  const releases = descriptors.flatMap((descriptor) => registries[descriptor.id]?.entries ?? []);
  const official = registries[OFFICIAL_REGISTRY_ID] ?? initialSource(OFFICIAL_REGISTRY_DESCRIPTOR);
  return {
    entries: official.entries.filter((entry) => entry.kind === "plugin"),
    releases,
    status: official.status,
    fetchedOnce: official.fetchedOnce,
  };
}

function persistedValue(
  descriptors: readonly RegistryDescriptor[],
  trustRecords: Readonly<Record<string, RegistryTrustRecord>>,
): PersistedRegistries {
  return {
    descriptors: descriptors.filter((descriptor) => descriptor.id !== OFFICIAL_REGISTRY_ID),
    trustRecords: Object.fromEntries(Object.entries(trustRecords).map(([id, record]) => [id, {
      publicKey: { ...record.publicKey },
      ...(record.highWater ? { highWater: { ...record.highWater } } : {}),
    }])),
  };
}

const REGISTRY_CACHE_KEY = "soksak.registries";
const registrySync = createCoreSync<PersistedRegistries>({
  key: "registries",
  lsKey: REGISTRY_CACHE_KEY,
  fallback: {
    descriptors: [],
    trustRecords: { official: { publicKey: OFFICIAL_REGISTRY_TRUST } },
  },
  apply: (raw) => {
    const persisted = safePersisted(raw);
    const descriptors = [OFFICIAL_REGISTRY_DESCRIPTOR, ...persisted.descriptors];
    useRegistry.setState((state) => {
      const registries = sourcesFor(descriptors, persisted.trustRecords, state.registries);
      return {
        descriptors,
        registries,
        trustRecords: persisted.trustRecords,
        ...projections(descriptors, registries),
      };
    });
  },
});

export const initRegistryPersistence = (deps: CoreStoreDeps): (() => void) => registrySync.init(deps);

const CREDENTIAL_PLACEHOLDER = "\u0000soksak-registry-authorization\u0000";

export function registryRequestHeaders(descriptor: RegistryDescriptor): Record<string, string> | null {
  return descriptor.id === OFFICIAL_REGISTRY_ID
    ? { accept: "application/vnd.github.raw+json" }
    : null;
}

// Registry egress is the core boundary's, never the webview's. The webview is
// CSP-isolated from external hosts, so a public index fetched with the webview
// `fetch` fails closed as "Load failed"; the host transport opens the same URL
// with no credential. A private registry substitutes its namespaced key. Both
// modes share one path so public and private cannot diverge.
async function registryHttpGet(
  descriptor: RegistryDescriptor,
  url: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  if (descriptor.visibility === "public") {
    return await invoke<{ status: number; headers: Record<string, string>; body: string }>(
      "net_http_request",
      {
        method: "GET",
        url,
        headers: registryRequestHeaders(descriptor),
        query: null,
        body: null,
        contentType: null,
        ns: null,
        secretSubst: null,
        impersonate: null,
      },
    );
  }
  const credential = registryCredentialSlot(descriptor.id);
  if (!credential) throw new Error(tmsg("msg.registry.privateIdentityInvalid"));
  return await invoke<{ status: number; headers: Record<string, string>; body: string }>(
    "net_http_request",
    {
      method: "GET",
      url,
      headers: { authorization: CREDENTIAL_PLACEHOLDER },
      query: null,
      body: null,
      contentType: null,
      ns: credential.namespace,
      secretSubst: { [CREDENTIAL_PLACEHOLDER]: credential.key },
      impersonate: null,
    },
  );
}

async function loadRegistryDocument(descriptor: RegistryDescriptor): Promise<unknown> {
  const response = await registryGetHonouringLimit(descriptor, descriptor.indexUrl);
  return JSON.parse(response.body) as unknown;
}

async function certifyRegistryNative(
  raw: unknown,
  policy: {
    expectedRegistryId: string;
    expectedKeyId: string;
    publicKey: RegistryPublicKey;
    now: number;
    highWater?: RegistryHighWater;
  },
): Promise<RegistryCertificationResult> {
  const parsed = parseSignedRegistryIndex(raw);
  if (!parsed.ok) return { ok: false, code: "INVALID_INDEX", errors: parsed.errors };
  if (parsed.value.id !== policy.expectedRegistryId || parsed.value.keyId !== policy.expectedKeyId || policy.publicKey.keyId !== policy.expectedKeyId) {
    return { ok: false, code: "TRUST_MISMATCH", errors: ["registry identity or key mismatch"] };
  }
  try {
    const receipt = await invoke<{ sequence: number; digest: string; continuity: "initial" | "unchanged" | "advance" }>(
      "registry_certify",
      {
        document: parsed.value,
        trust: { registryId: policy.expectedRegistryId, keyId: policy.expectedKeyId, publicKey: policy.publicKey.value },
        highWater: policy.highWater ?? null,
      },
    );
    if (receipt.sequence !== parsed.value.sequence) throw new Error("registry verification sequence mismatch");
    const certified: CertifiedRegistryIndex = Object.freeze({
      index: parsed.value,
      digest: receipt.digest,
      continuity: receipt.continuity,
      highWater: { sequence: receipt.sequence, digest: receipt.digest },
    });
    return { ok: true, value: certified };
  } catch (cause) {
    return { ok: false, code: "VERIFICATION_FAILED", errors: [cause instanceof Error ? cause.message : String(cause)] };
  }
}

/**
 * A GET that waits while the registry holds this build off.
 *
 * 429 is not a registry that failed; it is one holding this build off, with Retry-After naming how
 * much later. Read as a failure it reports the network's rate limit as this build's catalogue
 * being unreadable — measured 2026-08-18, official -> error (HTTP 429), 0 units, with nothing
 * wrong with the build.
 *
 * One wait, bounded: a limit longer than anyone watching a window will sit through is answered as a
 * limit rather than waited out, and it is answered in its own words so that a reader can tell it
 * from a registry that is broken.
 */
async function registryGetHonouringLimit(
  descriptor: RegistryDescriptor,
  url: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  let response = await registryHttpGet(descriptor, url);
  if (isRateLimited(response.status)) {
    const wait = retryAfterMs(response.headers, Date.now());
    if (wait !== null && wait <= retryAfterCeilingMs) {
      await new Promise((done) => setTimeout(done, wait));
      response = await registryHttpGet(descriptor, url);
    }
  }
  if (isRateLimited(response.status)) {
    const wait = retryAfterMs(response.headers, Date.now());
    throw new Error(
      wait === null
        ? tmsg("msg.registry.rateLimited")
        : tmsg("msg.registry.rateLimitedFor", { seconds: Math.ceil(wait / 1000) }),
    );
  }
  if (response.status < 200 || response.status >= 300)
    throw new Error(tmsg("msg.registry.httpStatus", { status: response.status }));
  return response;
}

/**
 * Load an arbitrary registry resource (owner manifest, conformance report) as raw
 * bytes, so the caller can verify its sha256 against the certified index. The
 * artifact archive itself is downloaded and verified natively, never here.
 */
export async function loadRegistryResourceBytes(
  registryId: string,
  url: string,
): Promise<Uint8Array> {
  const descriptor = useRegistry.getState().registries[registryId]?.descriptor;
  if (!descriptor) throw new Error(tmsg("msg.registry.notFound", { id: registryId }));
  const response = await registryGetHonouringLimit(descriptor, url);
  return new TextEncoder().encode(response.body);
}

interface RegistryRuntimeDeps {
  load: (descriptor: RegistryDescriptor) => Promise<unknown>;
  now: () => number;
}

const defaultRuntimeDeps: RegistryRuntimeDeps = { load: loadRegistryDocument, now: Date.now };
// The injection slot must survive the module-swap boundary — if only this slot resets, the injector
// treats it as already filled and does not refill it. What is left is silence, and silence is not an error.
const runtimeDepsSlot = moduleState("state/registry#runtimeDepsSlot.v", () => ({ v: defaultRuntimeDeps }));

// The fetch each registry is in the middle of. A second caller awaits this one rather than being
// answered `fetching` at once: that answer was a catalogue of nothing with no error in it, and from
// outside a busy registry read the same as an empty one (measured 2026-08-16). One fetch per
// registry either way — what changes is that everyone waits for the same one.
const inFlight = moduleState(
  "state/registry#inFlight",
  () => new Map<string, Promise<RegistryRefreshResult>>(),
);
export function setRegistryRuntimeDeps(patch: Partial<RegistryRuntimeDeps>): () => void {
  const previous = runtimeDepsSlot.v;
  runtimeDepsSlot.v = { ...runtimeDepsSlot.v, ...patch };
  return () => {
    runtimeDepsSlot.v = previous;
  };
}

function withEvent(
  events: readonly RegistryEvent[],
  type: RegistryEventType,
  registryId: string,
  at: number,
  detail?: string,
): RegistryEvent[] {
  return [...events, {
    seq: (events[events.length - 1]?.seq ?? 0) + 1,
    at,
    type,
    registryId,
    ...(detail ? { detail } : {}),
  }].slice(-100);
}

function sameHighWater(left?: RegistryHighWater, right?: RegistryHighWater): boolean {
  return left?.sequence === right?.sequence && left?.digest === right?.digest;
}

const persisted = safePersisted(registrySync.loadSync());
const initialDescriptors = [OFFICIAL_REGISTRY_DESCRIPTOR, ...persisted.descriptors];
const initialRegistries = sourcesFor(initialDescriptors, persisted.trustRecords);

// moduleState keeps the store outside the module boundary — a swap would replace registration,
// subscription, and screen state wholesale, and the injector treats it as already filled and never
// refills it (empty forever).
export const useRegistry = moduleState("state/registry#store", () =>
  create<RegistryState>((set, get) => ({
  descriptors: initialDescriptors,
  registries: initialRegistries,
  trustRecords: persisted.trustRecords,
  ...projections(initialDescriptors, initialRegistries),
  events: [],

  add: (raw) => {
    const descriptor = parseRegistryDescriptor(raw);
    if (!descriptor || descriptor.id === OFFICIAL_REGISTRY_ID) {
      return { ok: false, code: "INVALID_PARAMS", message: "invalid registry descriptor" };
    }
    if (get().registries[descriptor.id]) {
      return { ok: false, code: "ALREADY_EXISTS", message: `registry already exists: ${descriptor.id}` };
    }
    const pinned = get().trustRecords[descriptor.id];
    if (pinned && !samePublicKey(pinned.publicKey, descriptor.trustedPublicKey)) {
      return {
        ok: false,
        code: "TRUST_CONFLICT",
        message: `registry trust key is already pinned: ${descriptor.id}`,
      };
    }
    const now = runtimeDepsSlot.v.now();
    set((state) => {
      const descriptors = [...state.descriptors, descriptor];
      const trustRecords = {
        ...state.trustRecords,
        [descriptor.id]: pinned ?? { publicKey: descriptor.trustedPublicKey },
      };
      const registries = { ...state.registries, [descriptor.id]: initialSource(descriptor) };
      registrySync.save(persistedValue(descriptors, trustRecords));
      return {
        descriptors,
        registries,
        trustRecords,
        ...projections(descriptors, registries),
        events: withEvent(state.events, "registry.added", descriptor.id, now),
      };
    });
    return { ok: true, registryId: descriptor.id };
  },

  remove: (registryId) => {
    if (registryId === OFFICIAL_REGISTRY_ID) {
      return { ok: false, code: "INVALID_PARAMS", message: "official registry cannot be removed" };
    }
    if (!get().registries[registryId]) {
      return { ok: false, code: "TARGET_NOT_FOUND", message: `registry not found: ${registryId}` };
    }
    const now = runtimeDepsSlot.v.now();
    set((state) => {
      const descriptors = state.descriptors.filter((descriptor) => descriptor.id !== registryId);
      const { [registryId]: _removed, ...registries } = state.registries;
      registrySync.save(persistedValue(descriptors, state.trustRecords));
      return {
        descriptors,
        registries,
        ...projections(descriptors, registries),
        events: withEvent(state.events, "registry.removed", registryId, now),
      };
    });
    return { ok: true, registryId };
  },

  refresh: async (force = false, registryId) => {
    const selected = registryId
      ? get().descriptors.filter((descriptor) => descriptor.id === registryId)
      : get().descriptors;
    if (selected.length === 0) {
      return [{ registryId: registryId ?? "", status: "error", error: "registry not found" }];
    }
    return await Promise.all(selected.map(async (descriptor): Promise<RegistryRefreshResult> => {
      const source = get().registries[descriptor.id];
      if (!source) return { registryId: descriptor.id, status: "error", error: "registry not found" };
      const running = inFlight.get(descriptor.id);
      if (running) return await running;
      if (source.fetchedOnce && !force) {
        return { registryId: descriptor.id, status: source.status, skipped: true };
      }
      const run = (async (): Promise<RegistryRefreshResult> => {
      const startedAt = runtimeDepsSlot.v.now();
      set((state) => {
        const current = state.registries[descriptor.id];
        if (!current) return state;
        const registries = {
          ...state.registries,
          [descriptor.id]: { ...current, status: "fetching" as const, error: undefined },
        };
        return {
          registries,
          ...projections(state.descriptors, registries),
          events: withEvent(state.events, "registry.refresh.started", descriptor.id, startedAt),
        };
      });

      try {
        const raw = await runtimeDepsSlot.v.load(descriptor);
        let highWater = get().trustRecords[descriptor.id]?.highWater;
        let certified: RegistryCertificationResult;
        for (;;) {
          certified = await certifyRegistryNative(raw, {
            expectedRegistryId: descriptor.id,
            expectedKeyId: descriptor.trustedPublicKey.keyId,
            publicKey: descriptor.trustedPublicKey,
            now: runtimeDepsSlot.v.now(),
            ...(highWater ? { highWater } : {}),
          });
          const current = get();
          const liveDescriptor = current.registries[descriptor.id]?.descriptor;
          if (!liveDescriptor || !samePublicKey(liveDescriptor.trustedPublicKey, descriptor.trustedPublicKey)) {
            throw new Error(tmsg("msg.registry.descriptorChanged"));
          }
          const currentHighWater = current.trustRecords[descriptor.id]?.highWater;
          if (sameHighWater(highWater, currentHighWater)) break;
          highWater = currentHighWater;
        }
        const finishedAt = runtimeDepsSlot.v.now();
        if (!certified.ok) {
          const error = `${certified.code}: ${certified.errors.join("; ")}`;
          set((state) => {
            const current = state.registries[descriptor.id];
            if (!current) return state;
            const registries = {
              ...state.registries,
              [descriptor.id]: {
                ...current,
                status: "uncertified" as const,
                fetchedOnce: true,
                error,
                lastFetchedAt: finishedAt,
              },
            };
            return {
              registries,
              ...projections(state.descriptors, registries),
              events: withEvent(
                state.events,
                "registry.refresh.uncertified",
                descriptor.id,
                finishedAt,
                error,
              ),
            };
          });
          return { registryId: descriptor.id, status: "uncertified", error };
        }

        const beforePersist = get();
        const trustRecords = {
          ...beforePersist.trustRecords,
          [descriptor.id]: {
            publicKey: descriptor.trustedPublicKey,
            highWater: certified.value.highWater,
          },
        };
        await registrySync.saveNow(persistedValue(beforePersist.descriptors, trustRecords));
        const entries = qualifyRegistry(certified.value);
        set((state) => {
          const current = state.registries[descriptor.id];
          if (!current || !samePublicKey(current.descriptor.trustedPublicKey, descriptor.trustedPublicKey)) return state;
          const registries = {
            ...state.registries,
            [descriptor.id]: {
              ...current,
              status: "live" as const,
              fetchedOnce: true,
              entries,
              certified: certified.value,
              error: undefined,
              lastFetchedAt: finishedAt,
            },
          };
          return {
            registries,
            trustRecords,
            ...projections(state.descriptors, registries),
            events: withEvent(state.events, "registry.refresh.succeeded", descriptor.id, finishedAt),
          };
        });
        return { registryId: descriptor.id, status: "live" };
      } catch (cause) {
        const finishedAt = runtimeDepsSlot.v.now();
        const error = cause instanceof Error ? cause.message : String(cause);
        set((state) => {
          const current = state.registries[descriptor.id];
          if (!current) return state;
          const registries = {
            ...state.registries,
            [descriptor.id]: {
              ...current,
              status: "error" as const,
              fetchedOnce: true,
              error,
              lastFetchedAt: finishedAt,
            },
          };
          return {
            registries,
            ...projections(state.descriptors, registries),
            events: withEvent(state.events, "registry.refresh.failed", descriptor.id, finishedAt, error),
          };
        });
        return { registryId: descriptor.id, status: "error", error };
      }
      })();
      inFlight.set(descriptor.id, run);
      try {
        return await run;
      } finally {
        inFlight.delete(descriptor.id);
      }
    }));
  },
})),
);
