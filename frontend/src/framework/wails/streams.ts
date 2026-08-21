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
import { ID_PREFIX, randomBody } from "../../state/ids";

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

/**
 * Mints a receiver id — the stream receiver prefix and an N1 body.
 *
 * Not a counter. A counter restarts at 1 in each window and on each reload, so two receivers take
 * one name, and the frames go to whichever holds it — the other reads as a receiver that produces
 * nothing. core/control/stream.go refuses an id outside this shape as of 2026-08-16, so a
 * malformed one is named at the boundary rather than routed.
 *
 * The body comes from the issuer rather than from a copy here. Two generators are two definitions
 * of one format, and they agree until one is edited.
 */
function mintId(): string {
  return `${ID_PREFIX.streamReceiver}${randomBody()}`;
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
  let handler: ((message: T) => void) | null = null;
  const pending: T[] = [];
  const stream = {
    get onmessage(): (message: T) => void {
      return handler ?? (() => {});
    },
    set onmessage(next: (message: T) => void) {
      handler = next;
      for (const frame of pending.splice(0)) next(frame);
    },
    toJSON: () => ({ __stream: id }),
    close: () => {
      pending.length = 0;
      handler = null;
      receivers.delete(id);
    },
  };
  receivers.set(id, (frame) => {
    const value = frame as T;
    if (handler) handler(value);
    else pending.push(value);
  });
  return stream;
}

/** Number of receivers currently waiting for frames — where diagnostics read a leak. */
export function openStreamCount(): number {
  return receivers.size;
}
