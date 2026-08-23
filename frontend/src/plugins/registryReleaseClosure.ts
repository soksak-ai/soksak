import { parseReleaseManifest, type ReleaseDocument, type ReleaseReference } from "./spec";

export type ReleaseMetadataGet = (url: string) => Promise<{ status: number; body: string }>;
function key(reference: ReleaseReference): string { return `${reference.id}@${reference.version}`; }
async function sha256(text: string): Promise<string> { const value = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
export async function loadReleaseClosure(root: ReleaseReference, get: ReleaseMetadataGet): Promise<ReleaseDocument[]> {
  const values: ReleaseDocument[] = []; const done = new Map<string, ReleaseDocument>(); const active = new Set<string>();
  const visit = async (reference: ReleaseReference, expected: "plugin" | "sidecar") => {
    const identity = key(reference); if (active.has(identity)) throw new Error(`runtime dependency cycle: ${[...active, identity].join(" -> ")}`);
    const prior = done.get(identity); if (prior) return prior; active.add(identity);
    const response = await get(reference.url); if (response.status !== 200) throw new Error(`release request failed: ${reference.url} (${response.status})`);
    const size = new TextEncoder().encode(response.body).byteLength; if (size !== reference.size) throw new Error(`release size mismatch: ${identity}`);
    if (await sha256(response.body) !== reference.sha256) throw new Error(`release digest mismatch: ${identity}`);
    let raw: unknown; try { raw = JSON.parse(response.body); } catch { throw new Error(`release is not JSON: ${identity}`); }
    const parsed = parseReleaseManifest(raw); if (!parsed.ok) throw new Error(`invalid release ${identity}: ${parsed.errors.join("; ")}`);
    if (parsed.value.kind !== expected || parsed.value.id !== reference.id || parsed.value.version !== reference.version) throw new Error(`release identity mismatch: ${identity}`);
    values.push(parsed.value);
    for (const dependency of parsed.value.runtimeDependencies?.plugins ?? []) await visit(dependency, "plugin");
    for (const dependency of parsed.value.runtimeDependencies?.sidecars ?? []) await visit(dependency, "sidecar");
    active.delete(identity); done.set(identity, parsed.value); return parsed.value;
  };
  await visit(root, "plugin"); return values;
}
