// Cross-language GOLDEN VECTOR — the contract test for the phone-link
// capability-assertion convergence. RED before the Worker emits the Rust
// canonical-bytes layout; GREEN once canonicalCapabilityBytes() reproduces it.
//
// The SHIPPED Rust src-tauri/src/remote/auth.rs::canonical_bytes is the source of
// truth (length-prefixed binary, NOT the earlier JSON sketch). This test pins the
// Worker to those EXACT bytes + signature. The mirrored Rust test
// (src-tauri/src/remote/auth/golden_tests.rs) reads the SAME vector and proves a
// Worker-format-signed assertion verify_strict's on the Rust side.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalCapabilityBytes, CapabilityAssertion } from "../src/verify.js";
import { ed25519Sign } from "../src/crypto.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(join(here, "capability-golden.json"), "utf-8")) as {
  pkcs8_b64: string;
  public_key_hex: string;
  assertion: {
    device_id: string;
    scope: "read-only" | "write" | "destructive";
    nonce_hex: string;
    issued_at: number;
    exp: number;
  };
  canonical_bytes_hex: string;
  signature_hex: string;
};

function hexToBytes(hex: string): Uint8Array {
  const u8 = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u8.length; i++) u8[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u8;
}

function bytesToHex(u8: Uint8Array): string {
  return [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Coerce a Uint8Array to a concrete ArrayBuffer (TS 5.7 SharedArrayBuffer guard).
function ab(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

// Build the Worker-side CapabilityAssertion from the golden inputs.
function goldenAssertion(): CapabilityAssertion {
  return {
    device_id: golden.assertion.device_id,
    scope: golden.assertion.scope,
    nonce: hexToBytes(golden.assertion.nonce_hex),
    issued_at: golden.assertion.issued_at,
    exp: golden.assertion.exp,
  };
}

describe("capability-assertion convergence (Rust auth.rs::canonical_bytes layout)", () => {
  it("canonicalCapabilityBytes reproduces the golden canonical bytes BYTE-FOR-BYTE", () => {
    const bytes = canonicalCapabilityBytes(goldenAssertion());
    expect(bytesToHex(bytes)).toBe(golden.canonical_bytes_hex);
  });

  it("Ed25519 signature over the canonical bytes reproduces the golden signature", async () => {
    const bytes = canonicalCapabilityBytes(goldenAssertion());
    const sig = await ed25519Sign(golden.pkcs8_b64, bytes);
    expect(bytesToHex(sig)).toBe(golden.signature_hex);
  });

  it("the golden signature verifies with the raw public key over the golden bytes (verify_strict-compatible)", async () => {
    const pub = await crypto.subtle.importKey(
      "raw",
      ab(hexToBytes(golden.public_key_hex)),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "Ed25519",
      pub,
      ab(hexToBytes(golden.signature_hex)),
      ab(hexToBytes(golden.canonical_bytes_hex)),
    );
    expect(ok).toBe(true);
  });

  it("a one-byte-tampered assertion does NOT match the golden bytes", () => {
    const a = goldenAssertion();
    a.issued_at = golden.assertion.issued_at + 1; // flip one second
    const bytes = canonicalCapabilityBytes(a);
    expect(bytesToHex(bytes)).not.toBe(golden.canonical_bytes_hex);
  });
});
