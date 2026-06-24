// Crypto primitives — Web Crypto only (crypto.subtle). No Node Buffer, no npm
// ed25519/hmac library. Runs identically on Cloudflare Workers and Node 18+
// (the local test suite uses Node's WebCrypto), so the tests are self-contained.

// Coerce a Uint8Array to a BufferSource backed by a plain ArrayBuffer. TS 5.7+
// types Uint8Array as Uint8Array<ArrayBufferLike>, which the WebCrypto lib (which
// wants ArrayBufferView<ArrayBuffer>) rejects when SharedArrayBuffer is possible.
// Slicing the underlying buffer yields a concrete ArrayBuffer.
function buf(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

// Hex-encode an ArrayBuffer (Workers-native; no Node Buffer dependency).
export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string compare over equal-length hex strings.
// SECURITY: Workers has no crypto.timingSafeEqual, so we length-check then XOR-
// accumulate. Used for EVERY secret comparison (HMAC h1, nonce). Never `===` a MAC.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// base64url (no padding) encode of raw bytes.
export function b64urlEncode(u8: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// base64url (no padding) decode to raw bytes.
export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// Standard base64 (with padding) -> Uint8Array. Used for the PKCS#8 secret.
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// HMAC-SHA256 over `message`, key = raw UTF-8 bytes of `secret` (NOT decoded).
// Returns lowercase hex (NOT base64).
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    buf(enc.encode(secret)), // pdl_ntfset_... as raw UTF-8; the prefix is part of the key.
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, buf(enc.encode(message)));
  return toHex(mac);
}

// ----- Ed25519 signing key import (PKCS#8 base64 -> CryptoKey) -----
//
// The private key is a Worker secret (ED25519_PRIVATE_KEY_PKCS8_B64), test-injected
// in the suite. Only the public key is ever exposed (GET /pubkey / embedded in app).
// Imported once per isolate and memoized; the secret never leaves the Worker.
let _signingKeyCache: { b64: string; promise: Promise<CryptoKey> } | null = null;

export function importSigningKey(pkcs8B64: string): Promise<CryptoKey> {
  if (_signingKeyCache && _signingKeyCache.b64 === pkcs8B64) {
    return _signingKeyCache.promise;
  }
  const pkcs8 = b64ToBytes(pkcs8B64);
  const promise = crypto.subtle.importKey(
    "pkcs8",
    buf(pkcs8),
    { name: "Ed25519" },
    false, // non-extractable
    ["sign"],
  );
  _signingKeyCache = { b64: pkcs8B64, promise };
  return promise;
}

// Sign canonical bytes with the Ed25519 private key. Returns the raw 64-byte sig.
export async function ed25519Sign(pkcs8B64: string, message: Uint8Array): Promise<Uint8Array> {
  const key = await importSigningKey(pkcs8B64);
  const sig = await crypto.subtle.sign("Ed25519", key, buf(message));
  return new Uint8Array(sig);
}
