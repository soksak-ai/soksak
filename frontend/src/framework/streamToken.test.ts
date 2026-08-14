// A stream token **crosses the boundary**, so it must be serializable.
//
// Measured (2026-07-29): putting an enumerable `onmessage` accessor on the token killed invoke at the
// boundary with "An object could not be cloned". Structured clone copies by **reading** enumerable own
// properties, and that getter returns a function, and a function is not cloneable.
//
// The symptom was not the error message but "the terminal does not appear" — the command never reached the
// server, so no request remained in the ledger either. So this test runs the clone itself: checking the shape alone misses it again.

import { describe, expect, it } from "vitest";

/** Same shape as the token the adapter builds — non-enumerable accessor plus enumerable token string. */
function makeToken(id: string) {
  let sink: (m: unknown) => void = () => {};
  const token: Record<string, unknown> = { __frameworkStream: id };
  Object.defineProperty(token, "onmessage", {
    enumerable: false,
    configurable: true,
    get: () => sink,
    set: (fn: (m: unknown) => void) => {
      sink = fn;
    },
  });
  return token;
}

describe("stream token — a value that crosses the boundary", () => {
  it("passes structured clone — without it the command does not arrive at the server", () => {
    const t = makeToken("s1");
    (t as { onmessage: unknown }).onmessage = () => {};
    const cloned = structuredClone({ cols: 80, onOutput: t }) as {
      onOutput: Record<string, unknown>;
    };
    expect(cloned.onOutput.__frameworkStream).toBe("s1");
    expect("onmessage" in cloned.onOutput).toBe(false);
  });

  it("an enumerable accessor breaks the clone — that is the basis for this rule", () => {
    let sink: unknown = () => {};
    const bad: Record<string, unknown> = { __frameworkStream: "s2" };
    Object.defineProperty(bad, "onmessage", {
      enumerable: true,
      get: () => sink,
      set: (fn: unknown) => {
        sink = fn;
      },
    });
    expect(() => structuredClone({ onOutput: bad })).toThrow();
  });

  it("onmessage stays readable and writable — hiding it is not removing it", () => {
    const t = makeToken("s3") as { onmessage: (m: unknown) => void };
    const seen: unknown[] = [];
    t.onmessage = (m) => seen.push(m);
    t.onmessage("hi");
    expect(seen).toEqual(["hi"]);
  });
});
