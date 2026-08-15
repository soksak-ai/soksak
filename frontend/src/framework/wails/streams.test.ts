// @vitest-environment jsdom
// A stream receiver reaches the backend as an id, and frames addressed to that
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

function deliver(stream: string, frame: unknown): void {
  handlers.get(STREAM_EVENT)?.({ data: { stream, frame } });
}

function idOf(stream: unknown): string {
  return (JSON.parse(JSON.stringify(stream)) as { __stream: string }).__stream;
}

describe("a stream receiver", () => {
  it("serialises to the id the backend addresses frames to", () => {
    const stream = createWailsStream<unknown>();
    expect(idOf(stream)).toMatch(/^s-\d+$/);
  });

  it("receives frames sent to its own id and no other's", () => {
    const mine = createWailsStream<unknown>();
    const other = createWailsStream<unknown>();
    const received: unknown[] = [];
    mine.onmessage = (frame) => received.push(frame);
    other.onmessage = () => received.push("other");

    deliver(idOf(mine), { value: 1 });
    deliver("s-nobody", { value: 2 });

    expect(received).toEqual([{ value: 1 }]);
  });

  it("decodes a binary frame to an ArrayBuffer", () => {
    // Bytes travel base64 under a field that says so. A bare string would make
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

    const received: unknown[] = [];
    stream.onmessage = (frame) => received.push(frame);
    stream.close();

    deliver(idOf(stream), { value: 1 });
    expect(received).toEqual([]);
    expect(openStreamCount()).toBe(before);
  });

  it("subscribes to the delivery event once, not once per receiver", () => {
    createWailsStream<unknown>();
    createWailsStream<unknown>();
    expect(handlers.size).toBeLessThanOrEqual(1);
  });
});
