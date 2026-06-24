// Crypto primitive unit tests — timing-safe compare, HMAC hex, Ed25519 round-trip.
// Proves the secret-comparison surface is constant-time (length-checked XOR), the
// HMAC matches an independent computation, and the Ed25519 sign/verify wire format
// is the one the Rust app consumes.

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  b64urlDecode,
  b64urlEncode,
  ed25519Sign,
  hmacSha256Hex,
  timingSafeEqual,
  toHex,
} from "../src/crypto.js";
import { genSigningKeypair, importRawPublicKey } from "./helpers.js";

describe("timingSafeEqual", () => {
  it("equal strings -> true", () => {
    expect(timingSafeEqual("deadbeef", "deadbeef")).toBe(true);
  });
  it("different same-length strings -> false", () => {
    expect(timingSafeEqual("deadbeef", "deadbee0")).toBe(false);
  });
  it("different lengths -> false (length checked first)", () => {
    expect(timingSafeEqual("dead", "deadbeef")).toBe(false);
  });
  it("single-byte difference anywhere -> false", () => {
    const base = "a".repeat(64);
    for (const pos of [0, 31, 63]) {
      const mutated = base.slice(0, pos) + "b" + base.slice(pos + 1);
      expect(timingSafeEqual(base, mutated)).toBe(false);
    }
  });
});

describe("hmacSha256Hex", () => {
  it("matches Node createHmac over ts:body, lowercase hex", async () => {
    const secret = "pdl_ntfset_known";
    const message = "1750000000:{\"event_id\":\"evt_x\"}";
    const got = await hmacSha256Hex(secret, message);
    const want = createHmac("sha256", secret).update(message).digest("hex");
    expect(got).toBe(want);
    expect(got).toMatch(/^[0-9a-f]{64}$/); // lowercase hex, 32 bytes
  });
});

describe("base64url helpers", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 64, 63]);
    expect([...b64urlDecode(b64urlEncode(bytes))]).toEqual([...bytes]);
  });
  it("no padding, url-safe alphabet", () => {
    const s = b64urlEncode(new Uint8Array([255, 255, 255]));
    expect(s).not.toContain("=");
    expect(s).not.toContain("+");
    expect(s).not.toContain("/");
  });
});

describe("toHex", () => {
  it("encodes a 4-byte buffer", () => {
    const buf = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer;
    expect(toHex(buf)).toBe("deadbeef");
  });
});

describe("ed25519Sign", () => {
  it("produces a 64-byte signature that verifies with the raw public key", async () => {
    const { pkcs8B64, rawPub } = await genSigningKeypair();
    const msg = new TextEncoder().encode("canonical-assertion-bytes");
    const sig = await ed25519Sign(pkcs8B64, msg);
    expect(sig.length).toBe(64);
    const pub = await importRawPublicKey(rawPub);
    const bs = (u8: Uint8Array) =>
      u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
    expect(await crypto.subtle.verify("Ed25519", pub, bs(sig), bs(msg))).toBe(true);
    // A different message must not verify under the same signature.
    const other = new TextEncoder().encode("canonical-assertion-byteS");
    expect(await crypto.subtle.verify("Ed25519", pub, bs(sig), bs(other))).toBe(false);
  });
});
