// Stream receiver — passed as a command argument and receives frames.
//
// Some things arrive many times, not once: shell bytes, a child process's stdout,
// sidecar events. A response value cannot deliver those — they arrive after the response.
//
// A receiver takes one id, and argument serialization keeps only that id. The backend
// tags frames with that id and sends them on a single event (core/control/stream.go is
// the sole owner of that shape). A new event name per feature becomes an undeclared
// event, and the front rejects it by name — measured 2026-08-15, terminal:output was
// rejected that way.
import { Events } from "@wailsio/runtime";

import type { Stream } from "../contract";

/** The event the backend puts frames on. Same string as control.StreamEvent on the Go side. */
export const STREAM_EVENT = "stream";

/** Shape of a binary frame. A base64 string in this field separates it from a text frame. */
interface StreamBytes {
  bytes: string;
}

interface StreamFrame {
  stream: string;
  frame: unknown;
}

const receivers = new Map<string, (frame: unknown) => void>();
let subscribed = false;

/** RFC 4648 lowercase base32 (N1). The alphabet has no 0 or 1, so no body character is confused
 *  with o or l. */
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_BODY_LENGTH = 6;

/**
 * Mints a receiver id — `stm-` plus six base32 characters, the N1 format of docs/tech/NAMING.md.
 *
 * Not a counter. A counter restarts at 1 in each window and on each reload, so two receivers take
 * one name. core/control/stream.go routes frames by this id and does not check its shape, so the
 * misrouted frames read as a receiver that produces nothing.
 *
 * crypto.getRandomValues, not Math.random: a weak or seeded generator repeats, and a repeat here
 * routes one receiver's frames to another. Five bits per character spread the value evenly over
 * all 32 letters of the alphabet.
 */
function mintId(): string {
  const buffer = new Uint8Array(ID_BODY_LENGTH);
  globalThis.crypto.getRandomValues(buffer);
  let body = "";
  for (const byte of buffer) body += ID_ALPHABET[byte & 31];
  return `stm-${body}`;
}

function bytesOf(value: unknown): ArrayBuffer | null {
  const encoded = (value as StreamBytes | null)?.bytes;
  if (typeof encoded !== "string") return null;
  const raw = atob(encoded);
  const buffer = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) buffer[index] = raw.charCodeAt(index);
  return buffer.buffer;
}

/**
 * Starts frame delivery for this window — one event subscription.
 *
 * Subscribing per receiver grows the subscription count with the session count, and a subscription
 * that was never removed keeps receiving frames of a closed session. One table splits them by id.
 */
function subscribe(): void {
  if (subscribed) return;
  subscribed = true;
  Events.On(STREAM_EVENT, (received: { data: unknown }) => {
    const delivery = received.data as StreamFrame | null;
    if (!delivery || typeof delivery.stream !== "string") return;
    const receiver = receivers.get(delivery.stream);
    if (!receiver) return;
    // A binary frame becomes an ArrayBuffer, anything else passes through as-is. The sender marks
    // which one with a field — a receiver guessing from the string gets text frames wrong.
    const bytes = bytesOf(delivery.frame);
    receiver(bytes ?? delivery.frame);
  });
}

/**
 * One receiver. `toJSON` keeps only the id during argument serialization — a function cannot cross
 * the boundary.
 *
 * `close()` removes it. Without that the table grows with the session count, and frames of a closed
 * session go to a dead callback.
 */
export function createWailsStream<T>(): Stream<T> & { close(): void } {
  subscribe();
  const id = mintId();
  const stream = {
    onmessage: (() => {}) as (message: T) => void,
    toJSON: () => ({ __stream: id }),
    close: () => {
      receivers.delete(id);
    },
  };
  receivers.set(id, (frame) => stream.onmessage(frame as T));
  return stream;
}

/** Number of receivers currently waiting for frames — where diagnostics read a leak. */
export function openStreamCount(): number {
  return receivers.size;
}
