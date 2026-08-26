// @vitest-environment jsdom
// A stream receiver arrives at the backend as an id, and frames addressed to that
// id reach it back.
//
// The adapter used to answer { onmessage: () => {} } — an object that
// serialises to {} and never delivers. Every command that produces frames
// rather than one answer went silent on this host: shell bytes, a child
// process's stdout, a sidecar's events. Nothing failed; nothing arrived.
import { describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (received: { data: unknown }) => void>();

vi.mock("@wailsio/runtime", () => ({
  Events: {
    On: (event: string, handler: (received: { data: unknown }) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  },
}));

import { STREAM_EVENT, createWailsStream, openStreamCount } from "./streams";

/** N1 identifier format — three letters, then six RFC 4648 lowercase base32 characters. */
const RECEIVER_ID = /^stm-[a-z2-7]{6}$/;
/** RFC 4648 lowercase base32 — the alphabet the body is drawn from. */
// The alphabet itself, not a copy: a coverage check against a second spelling would pass while
// the issuer used a different one.
import { ALPHABET } from "../../state/ids";
/** Receivers minted per statistical test. */
const COUNT = 256;

function deliver(stream: string, frame: unknown): void {
  handlers.get(STREAM_EVENT)?.({ data: { stream, frame } });
}

function idOf(stream: unknown): string {
  return (JSON.parse(JSON.stringify(stream)) as { __stream: string }).__stream;
}

describe("a stream receiver", () => {
  it("serialises to the id the backend addresses frames to", () => {
    const stream = createWailsStream<unknown>();
    expect(idOf(stream)).toMatch(RECEIVER_ID);
  });

  it("receives frames sent to its own id and no other's", () => {
    const mine = createWailsStream<unknown>();
    const other = createWailsStream<unknown>();
    const received: unknown[] = [];
    mine.onmessage = (frame) => received.push(frame);
    other.onmessage = () => received.push("other");

    deliver(idOf(mine), { value: 1 });
    deliver("stm-nobody", { value: 2 });

    expect(received).toEqual([{ value: 1 }]);
  });

  it("delivers frames that arrive before the handler is installed", () => {
    const stream = createWailsStream<unknown>();
    deliver(idOf(stream), { sequence: 1 });
    deliver(idOf(stream), { sequence: 2 });
    const received: unknown[] = [];
    stream.onmessage = (frame) => received.push(frame);
    expect(received).toEqual([{ sequence: 1 }, { sequence: 2 }]);
  });

  it("decodes a binary frame to an ArrayBuffer", () => {
    // Bytes travel base64 under a field named for it. A bare string would make
    // this side guess whether a text frame is text or base64, and it guesses
    // wrong for one of them.
    const stream = createWailsStream<ArrayBuffer>();
    let received: ArrayBuffer | null = null;
    stream.onmessage = (frame) => { received = frame; };

    deliver(idOf(stream), { bytes: btoa("hi") });

    expect(received).not.toBeNull();
    expect(new TextDecoder().decode(new Uint8Array(received!))).toBe("hi");
  });

  it("passes a non-binary frame through unchanged", () => {
    const stream = createWailsStream<unknown>();
    let received: unknown = null;
    stream.onmessage = (frame) => { received = frame; };

    deliver(idOf(stream), { url: "https://example.com" });

    expect(received).toEqual({ url: "https://example.com" });
  });

  it("stops receiving once closed, and the table shrinks", () => {
    // Without this the table grows with every session and frames for a closed
    // one keep reaching a dead callback.
    const before = openStreamCount();
    const stream = createWailsStream<unknown>();
    expect(openStreamCount()).toBe(before + 1);
    expect(document.documentElement.dataset.openStreamReceivers).toBe(String(before + 1));

    const received: unknown[] = [];
    stream.onmessage = (frame) => received.push(frame);
    stream.close();

    deliver(idOf(stream), { value: 1 });
    expect(received).toEqual([]);
    expect(openStreamCount()).toBe(before);
    expect(document.documentElement.dataset.openStreamReceivers).toBe(String(before));
  });

  it("subscribes to the delivery event once, not once per receiver", () => {
    createWailsStream<unknown>();
    createWailsStream<unknown>();
    expect(handlers.size).toBeLessThanOrEqual(1);
  });
});

// N1 (docs/tech/NAMING.md): `<three letters>-<six base32 characters>`, and an identifier is not a
// counter. The Go router (core/control/stream.go) routes frames by this id and does not check its
// shape, so two receivers under one name deliver one receiver's frames to the other and the loss
// reads as a backend that produces nothing.
describe("the receiver id follows N1", () => {
  it("has a three-letter prefix and a six-character base32 body", () => {
    const ids = Array.from({ length: 32 }, () => {
      const stream = createWailsStream<unknown>();
      const id = idOf(stream);
      stream.close();
      return id;
    });
    expect(ids.filter((id) => !RECEIVER_ID.test(id))).toEqual([]);
  });

  it("mints 256 receivers without a repeat", () => {
    // 32^6 values, so 256 ids collide with probability 256*255/2 / 32^6 = 3e-5. A larger count
    // raises that bound into flake territory without testing anything more.
    const ids = new Set<string>();
    for (let index = 0; index < COUNT; index++) {
      const stream = createWailsStream<unknown>();
      ids.add(idOf(stream));
      stream.close();
    }
    expect(ids.size).toBe(COUNT);
  });

  it("uses all 32 letters of the base32 alphabet — a narrower body is a narrower value space", () => {
    // 256 ids give 1536 body characters. One letter absent from a uniform draw has probability
    // (31/32)^1536, about 1e-21, so a missing letter is a biased generator, not a run of luck.
    const seen = new Set<string>();
    for (let index = 0; index < COUNT; index++) {
      const stream = createWailsStream<unknown>();
      for (const character of idOf(stream).slice(4)) seen.add(character);
      stream.close();
    }
    expect([...ALPHABET].filter((letter) => !seen.has(letter))).toEqual([]);
  });

  it("does not restart after a reload — a reloaded window would name a new receiver the old name", async () => {
    // Two fresh module instances, each asked for its first receiver. A counter
    // reseeds with the module, so both answer the same name while the backend
    // still routes frames to the receiver of the first instance.
    //
    // Compared at the same position on purpose. Taking one id from this
    // already-warm module and one from a reloaded instance compares a late
    // counter value against an early one, and those differ under a counter too —
    // the assertion would pass against the defect it exists to catch.
    const restore = handlers.get(STREAM_EVENT);
    try {
      const firstOfInstance = async () => {
        vi.resetModules();
        const reloaded = await import("./streams");
        const receiver = reloaded.createWailsStream<unknown>();
        const id = idOf(receiver);
        receiver.close();
        return id;
      };

      const before = await firstOfInstance();
      const after = await firstOfInstance();

      expect(before).toMatch(RECEIVER_ID);
      expect(after).toMatch(RECEIVER_ID);
      expect(after).not.toBe(before);
    } finally {
      if (restore) handlers.set(STREAM_EVENT, restore);
    }
  });
});
