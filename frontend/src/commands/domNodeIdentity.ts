import { moduleState } from "../lib/moduleState";

const identities = moduleState("commands/domNodeIdentity#state", () => ({
  byElement: new WeakMap<Element, string>(),
}));

export function nodeIdentityOf(element: Element): string {
  const existing = identities.byElement.get(element);
  if (existing) return existing;
  const identity = crypto.randomUUID();
  identities.byElement.set(element, identity);
  return identity;
}
