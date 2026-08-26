// No document records a location. A release directory is derived from kind, id, and version:
// published, https://github.com/<GITHUB_ORG>/<id>/releases/download/v<version>/; local store,
// <store>/<kind>s/<id>/<version>/. A file inside is addressed by its bare name, and release.json has
// the same bytes in both places. A resolver reads release.json for one release by its coordinates;
// the closure walker verifies the bytes against the reference that pins them.
import type { ReleaseCoordinates, ReleaseRead } from "./registryReleaseClosure";
import { COMPONENT_ID_RE, GITHUB_ORG, RELEASE_FILE_RE, STRICT_SEMVER_RE } from "./spec";

const KIND_DIRECTORY = { plugin: "plugins", sidecar: "sidecars" } as const;

// Every segment is validated by the grammar that produced it before it is joined into a path.
function checkSegments(id: string, version: string, file: string): void {
  if (!COMPONENT_ID_RE.test(id)) throw new Error(`release component id is invalid: ${id}`);
  if (!STRICT_SEMVER_RE.test(version)) throw new Error(`release version is invalid: ${version}`);
  if (!RELEASE_FILE_RE.test(file)) throw new Error(`release file name is invalid: ${file}`);
}

export function publishedReleaseFile(id: string, version: string, file: string): string {
  checkSegments(id, version, file);
  return `https://github.com/${GITHUB_ORG}/${id}/releases/download/v${version}/${file}`;
}

export function localReleaseFile(store: string, kind: ReleaseCoordinates["kind"], id: string, version: string, file: string): string {
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(store)) throw new Error(`release store must be absolute: ${store}`);
  checkSegments(id, version, file);
  return `${store}/${KIND_DIRECTORY[kind]}/${id}/${version}/${file}`;
}

export type ReleaseMetadataGet = (url: string) => Promise<{ status: number; body: string }>;

export function githubReleaseResolver(get: ReleaseMetadataGet): ReleaseRead {
  return async ({ id, version }) => {
    const url = publishedReleaseFile(id, version, "release.json");
    const response = await get(url);
    if (response.status === 404) throw new Error(`unresolved release ${id}@${version}: ${url}`);
    if (response.status !== 200) throw new Error(`release request failed: ${url} (${response.status})`);
    return response.body;
  };
}

export interface LocalReleaseRead { found: boolean; body?: string; size?: number; sha256?: string }
export type LocalReleaseReader = (release: { store: string } & ReleaseCoordinates) => Promise<LocalReleaseRead>;

// The host reads the store directory; a dependency absent from it is refused by its derived
// location. Nothing falls back to the published location.
export function localStoreReleaseResolver(store: string, read: LocalReleaseReader): ReleaseRead {
  return async ({ kind, id, version }) => {
    const file = localReleaseFile(store, kind, id, version, "release.json");
    const result = await read({ store, kind, id, version });
    if (!result.found || result.body === undefined) throw new Error(`unresolved release ${id}@${version}: ${file}`);
    return result.body;
  };
}
