// Local test harness: in-memory KV mock + Paddle signature forger + Ed25519 keygen.
// No miniflare / workerd. Pure Node WebCrypto (crypto.subtle) so tests are
// self-contained, no network, no Cloudflare.

import { webcrypto } from "node:crypto";
import type { Env } from "../src/types.js";

// Node's WebCrypto is the same surface the Worker runtime exposes. The Worker code
// references a global `crypto`; under vitest/node we ensure that global is set.
if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}

// Coerce a Uint8Array to a concrete-ArrayBuffer BufferSource (TS 5.7 generics; see
// src/crypto.ts buf()).
function buf(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

// ----- In-memory KVNamespace mock (Map-backed) -----
// Implements the subset of the KV API the Worker uses: get (text + json),
// get<T>(key, {type:"json"}), put (with optional expirationTtl), delete.
// expirationTtl is honored against a mock clock so TTL-expiry tests are deterministic.

interface StoredValue {
  value: string;
  expiresAtMs: number | null;
}

export class MemoryKV {
  private store = new Map<string, StoredValue>();
  // Mock clock for TTL. Tests can advance it to expire nonces / event markers.
  public nowMs: number = Date.now();

  // Number of writes — lets tests assert "no double-issue" on idempotency.
  public putCount = 0;

  private isExpired(v: StoredValue): boolean {
    return v.expiresAtMs !== null && this.nowMs >= v.expiresAtMs;
  }

  async get(key: string, opts?: { type?: "text" | "json" }): Promise<any> {
    const v = this.store.get(key);
    if (!v) return null;
    if (this.isExpired(v)) {
      this.store.delete(key);
      return null;
    }
    if (opts?.type === "json") {
      return JSON.parse(v.value);
    }
    return v.value;
  }

  async put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void> {
    this.putCount++;
    const expiresAtMs =
      opts?.expirationTtl != null ? this.nowMs + opts.expirationTtl * 1000 : null;
    this.store.set(key, { value, expiresAtMs });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  // Test-only helpers.
  rawGet(key: string): string | undefined {
    return this.store.get(key)?.value;
  }
  has(key: string): boolean {
    const v = this.store.get(key);
    return !!v && !this.isExpired(v);
  }
  advanceMs(ms: number): void {
    this.nowMs += ms;
  }
}

// ----- Ed25519 keypair generation for the signing path -----
// Returns { pkcs8B64 } for the Worker secret and { rawPub } (32 bytes) for the app,
// plus a CryptoKey publicKey to verify_strict-style check signatures in tests.
export async function genSigningKeypair(): Promise<{
  pkcs8B64: string;
  rawPub: Uint8Array;
  publicKey: CryptoKey;
}> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const pkcs8B64 = Buffer.from(pkcs8).toString("base64");
  return { pkcs8B64, rawPub, publicKey: kp.publicKey };
}

// Import a raw 32-byte Ed25519 public key for verification (models the app's
// embedded VerifyingKey::from_bytes + verify_strict).
export async function importRawPublicKey(rawPub: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buf(rawPub), { name: "Ed25519" }, false, ["verify"]);
}

// ----- Paddle-Signature forger -----
// Computes HMAC-SHA256 over `ts:rawBody` with the raw-UTF-8 secret, lowercase hex,
// and formats the header. Supports multi-h1 (rotation) by passing several secrets.
export async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    buf(enc.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, buf(enc.encode(message)));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function paddleSignatureHeader(
  rawBody: string,
  secrets: string[],
  ts: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const parts = [`ts=${ts}`];
  for (const s of secrets) {
    const h1 = await hmacHex(s, `${ts}:${rawBody}`);
    parts.push(`h1=${h1}`);
  }
  return parts.join(";");
}

// Build a webhook Request with a (optionally valid) Paddle-Signature header.
export function webhookRequest(rawBody: string, signatureHeader: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signatureHeader !== null) headers["Paddle-Signature"] = signatureHeader;
  return new Request("https://worker.test/webhooks/paddle", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

// JSON POST request builder for the other endpoints.
export function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://worker.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Read a Response body as a loosely-typed object (test ergonomics).
export async function readJson(res: Response): Promise<any> {
  return res.json();
}

// ----- Test Env factory -----
export function makeEnv(overrides: Partial<Env> & { kv?: MemoryKV } = {}): {
  env: Env;
  kv: MemoryKV;
} {
  const kv = overrides.kv ?? new MemoryKV();
  const env: Env = {
    LICENSE_KV: kv as unknown as KVNamespace,
    PADDLE_WEBHOOK_SECRET: overrides.PADDLE_WEBHOOK_SECRET ?? "pdl_ntfset_test_secret",
    ED25519_PRIVATE_KEY_PKCS8_B64: overrides.ED25519_PRIVATE_KEY_PKCS8_B64 ?? "",
    MAX_DEVICES: overrides.MAX_DEVICES,
  };
  return { env, kv };
}

// Seed a license record directly into the mock KV.
export async function seedLicense(
  kv: MemoryKV,
  appUserId: string,
  state: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const now = new Date().toISOString();
  await kv.put(
    `license:${appUserId}`,
    JSON.stringify({
      schema: 1,
      app_user_id: appUserId,
      order_id: "ord_seed",
      license_kind: "subscription",
      state,
      paddle: {
        customer_id: null,
        subscription_id: null,
        transaction_id: null,
        price_id: null,
        product_id: null,
      },
      last_event_id: "evt_seed",
      last_occurred_at: now,
      created_at: now,
      updated_at: now,
      ...extra,
    }),
  );
}
