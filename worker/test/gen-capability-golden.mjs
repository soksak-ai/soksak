// Deterministic generator for capability-golden.json — the cross-language golden
// vector. Run with `node test/gen-capability-golden.mjs`. Emits the SAME JSON that
// is checked in; regenerate only when the fixed test inputs change.
//
// The canonical bytes follow the SHIPPED Rust auth.rs::canonical_bytes layout
// (the source of truth, NOT a JSON sketch):
//   device_id.len() as u64 LE (8B) || device_id UTF-8
//   scope_tag (1B: 0=read-only, 1=write, 2=destructive)
//   nonce (32B raw)
//   issued_at as u64 LE (8B)
//   exp as u64 LE (8B)
//
// The Ed25519 seed is fixed (0x01..0x20) — TEST-ONLY, never a production key.

import { createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";

const SEED = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 1));

// RFC 8410 Ed25519 PKCS#8: fixed 16-byte prefix then the 32-byte seed.
function pkcs8FromSeed(seed) {
  const prefix = Uint8Array.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
  ]);
  return Buffer.concat([Buffer.from(prefix), Buffer.from(seed)]);
}

const pkcs8Der = pkcs8FromSeed(SEED);
const privKey = createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
const spki = createPublicKey(privKey).export({ format: "der", type: "spki" });
const rawPub = spki.subarray(spki.length - 32);

const assertion = {
  device_id: "phone-7f3a",
  scope: "read-only",
  nonce_hex: "a1".repeat(32),
  issued_at: 1_750_000_000,
  exp: 1_750_000_060,
};

const SCOPE_TAG = { "read-only": 0, write: 1, destructive: 2 };
const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

function canonicalBytes(a) {
  const id = Buffer.from(a.device_id, "utf-8");
  const nonce = Buffer.from(a.nonce_hex, "hex");
  if (nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  return Buffer.concat([
    u64le(id.length),
    id,
    Buffer.from([SCOPE_TAG[a.scope]]),
    nonce,
    u64le(a.issued_at),
    u64le(a.exp),
  ]);
}

const canon = canonicalBytes(assertion);
const sig = nodeSign(null, canon, privKey);

const golden = {
  _comment:
    "TEST-ONLY cross-language golden vector for the phone-link capability-assertion convergence. The canonical bytes are the SHIPPED Rust src-tauri/src/remote/auth.rs::canonical_bytes layout (length-prefixed binary), which is the source of truth. The Worker's canonicalCapabilityBytes() must reproduce canonical_bytes_hex; signing the seed key over those bytes must reproduce signature_hex; and the Rust verifier must verify_strict the signature with public_key_hex. The Ed25519 seed is a fixed, known, test-only value (NOT a production key). Field mapping Worker->Rust: device_id <- phone-link machine_id; scope <- DeviceScope string; nonce_hex <- raw 32-byte challenge nonce; issued_at/exp <- Unix seconds. Regenerate with worker/test/gen-capability-golden.mjs.",
  seed_hex: Buffer.from(SEED).toString("hex"),
  pkcs8_b64: Buffer.from(pkcs8Der).toString("base64"),
  public_key_hex: Buffer.from(rawPub).toString("hex"),
  assertion,
  canonical_bytes_hex: canon.toString("hex"),
  signature_hex: Buffer.from(sig).toString("hex"),
};

console.log(JSON.stringify(golden, null, 2));
