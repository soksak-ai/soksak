export const leafLayoutCommitEvent = "workspace:leaf-layout-commit";

export function createLeafOwnerRegistry<T>(create: (id: string) => T) {
  const owners = new Map<string, T>();

  return {
    get(id: string) {
      return owners.get(id);
    },
    reconcile(ids: readonly string[]) {
      const desired = new Set(ids);
      for (const id of owners.keys()) {
        if (!desired.has(id)) owners.delete(id);
      }
      for (const id of ids) {
        if (!owners.has(id)) owners.set(id, create(id));
      }
      return new Map(ids.map((id) => [id, owners.get(id)!]));
    },
  };
}

export function publishLeafLayoutCommit(owners: Iterable<EventTarget>): void {
  for (const owner of owners) owner.dispatchEvent(new Event(leafLayoutCommitEvent));
}
