import { moduleState } from "../lib/moduleState";

export type DropGrantKind = "file" | "image";
export interface PublicDropGrant { id: string; kind: DropGrantKind }

interface StoredDropGrant extends PublicDropGrant {
  pluginId: string;
  window: string;
  path: string;
}

const MAX_DROP_GRANTS = 128;
const grants = moduleState("plugins/dropGrants#state", () => new Map<string, StoredDropGrant>());
const imagePath = /[.](?:avif|bmp|gif|heic|heif|jpeg|jpg|png|svg|tif|tiff|webp)$/i;
const control = /[\0\r\n]/;

export function issueDropGrants(input: {
  pluginId: string;
  window: string;
  paths: readonly string[];
}): PublicDropGrant[] {
  if (!input.pluginId || !input.window) return [];
  const issued: PublicDropGrant[] = [];
  for (const path of input.paths) {
    if (typeof path !== "string" || path === "" || control.test(path)) continue;
    while (grants.size >= MAX_DROP_GRANTS) grants.delete(grants.keys().next().value as string);
    const id = `drop-${crypto.randomUUID()}`;
    const kind: DropGrantKind = imagePath.test(path) ? "image" : "file";
    grants.set(id, { id, kind, pluginId: input.pluginId, window: input.window, path });
    issued.push({ id, kind });
  }
  return issued;
}

export function redeemDropGrant(input: {
  pluginId: string;
  window: string;
  id: string;
}): { kind: DropGrantKind; path: string } | null {
  const grant = grants.get(input.id);
  if (!grant || grant.pluginId !== input.pluginId || grant.window !== input.window) return null;
  grants.delete(input.id);
  return { kind: grant.kind, path: grant.path };
}

export function __resetDropGrantsForTest(): void {
  grants.clear();
}
