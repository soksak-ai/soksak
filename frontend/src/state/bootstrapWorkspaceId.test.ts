// The first workspace has an identifier the issuer produced.
//
// docs/tech/NAMING.md N1: every identifier in this product is three letters, a
// dash, and six characters of RFC 4648 lowercase base32, and identifiers are
// not counters. N4 uses "t1" as its own example of a shape the product must
// never produce, because code that reads a prefix is never run against it.
//
// Measured 2026-08-16 on the running application: state.tree answered
// `"id": "t1"` for the workspace holding every pane and space, beside
// pan-axhgio, spc-tbsgmi and tab-2trqyu. The boot path passed the literal
// rather than asking the issuer, so the one entity a session is built around
// was the one entity outside the rule.
import { beforeEach, expect, it } from "vitest";

import { ID_PREFIX } from "./ids";
import { useSessions } from "./sessions";

// N1, as the issuer writes it.
const N1 = /^[a-z]{3}-[a-z2-7]{6}$/;

beforeEach(() => {
  useSessions.setState({ workspaces: [], activeId: "" });
});

it("issues the first workspace an N1 identifier", () => {
  useSessions.getState().bootstrapFirstWorkspace("/workspaces/workspace1");
  const { workspaces, activeId } = useSessions.getState();

  expect(workspaces).toHaveLength(1);
  const id = workspaces[0]!.id;
  expect(id).toMatch(N1);
  expect(id.startsWith(ID_PREFIX.workspace)).toBe(true);
  // The active id and the workspace's own are one value. Two spellings would
  // leave the session pointing at a workspace that is not in the list.
  expect(activeId).toBe(id);
});

it("does not repeat across boots", () => {
  useSessions.getState().bootstrapFirstWorkspace("/workspaces/workspace1");
  const first = useSessions.getState().workspaces[0]!.id;

  useSessions.setState({ workspaces: [], activeId: "" });
  useSessions.getState().bootstrapFirstWorkspace("/workspaces/workspace1");
  const second = useSessions.getState().workspaces[0]!.id;

  // A counter answers the same value every launch, so a saved address means a
  // different workspace after a restart.
  expect(second).not.toBe(first);
});
