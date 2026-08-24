export function scopedStorage(storage: Storage, identity: string): Storage {
  if (!identity) throw new Error("storage identity is required");
  const prefix = `soksak:${identity}:`;
  const keys = () => {
    const found: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) found.push(key.slice(prefix.length));
    }
    return found.sort();
  };
  return {
    get length() { return keys().length; },
    key: (index) => keys()[index] ?? null,
    getItem: (key) => storage.getItem(prefix + key),
    setItem: (key, value) => storage.setItem(prefix + key, value),
    removeItem: (key) => storage.removeItem(prefix + key),
    clear: () => keys().forEach((key) => storage.removeItem(prefix + key)),
  };
}
