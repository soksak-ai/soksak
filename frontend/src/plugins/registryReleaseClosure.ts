import { parseReleaseManifest, type ReleaseDocument, type ReleaseReference } from "./spec";

export interface ReleaseCoordinates { kind: "plugin" | "sidecar"; id: string; version: string }
// A resolver: the release.json text of one release addressed by kind, id, and version. The resolver
// derives the location; this module verifies the bytes against the reference that pins them.
export type ReleaseRead = (release: ReleaseCoordinates) => Promise<string>;

interface Visited { document: ReleaseDocument; body: string }
function key(reference: ReleaseReference): string { return `${reference.id}@${reference.version}`; }
async function sha256(text: string): Promise<string> { const value = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
async function verifyReference(body: string, reference: ReleaseReference): Promise<void> {
  const identity = key(reference);
  if (new TextEncoder().encode(body).byteLength !== reference.size) throw new Error(`release size mismatch: ${identity}`);
  if (await sha256(body) !== reference.sha256) throw new Error(`release digest mismatch: ${identity}`);
}
// Every release of the closure, root first, each read once. A release referenced twice is verified
// against every reference that names it; a reference with a different digest refuses by name.
export async function loadReleaseClosure(root: ReleaseReference, read: ReleaseRead, rootKind: ReleaseCoordinates["kind"] = "plugin"): Promise<ReleaseDocument[]> {
  const values: ReleaseDocument[] = []; const done = new Map<string, Visited>(); const active = new Set<string>();
  const visit = async (reference: ReleaseReference, kind: ReleaseCoordinates["kind"]) => {
    const identity = key(reference); if (active.has(identity)) throw new Error(`runtime dependency cycle: ${[...active, identity].join(" -> ")}`);
    const prior = done.get(identity);
    if (prior) {
      await verifyReference(prior.body, reference);
      if (prior.document.kind !== kind) throw new Error(`release kind mismatch: ${identity} is ${prior.document.kind}, expected ${kind}`);
      return prior.document;
    }
    active.add(identity);
    const body = await read({ kind, id: reference.id, version: reference.version });
    await verifyReference(body, reference);
    let raw: unknown; try { raw = JSON.parse(body); } catch { throw new Error(`release is not JSON: ${identity}`); }
    const parsed = parseReleaseManifest(raw); if (!parsed.ok) throw new Error(`invalid release ${identity}: ${parsed.errors.join("; ")}`);
    if (parsed.value.kind !== kind || parsed.value.id !== reference.id || parsed.value.version !== reference.version) throw new Error(`release identity mismatch: ${identity}`);
    values.push(parsed.value);
    for (const dependency of parsed.value.runtimeDependencies?.plugins ?? []) await visit(dependency, "plugin");
    for (const dependency of parsed.value.runtimeDependencies?.sidecars ?? []) await visit(dependency, "sidecar");
    active.delete(identity); done.set(identity, { document: parsed.value, body }); return parsed.value;
  };
  await visit(root, rootKind); return values;
}
