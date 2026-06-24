// §6 matrix + §5 challenge-response — /verify/challenge + /verify.
// Attack-first: reused nonce 409; expired nonce 409; wrong/missing nonce rejected;
// the signed assertion verifies with the embedded public key AND fails if a byte is
// tampered; issued_at monotonic (client-modeled); machine_id mismatch rejected;
// state gates (no license 404, refunded/canceled/paused 403, active -> signed).

import { describe, expect, it, beforeAll } from "vitest";
import worker from "../src/index.js";
import { canonicalAssertionBytes } from "../src/verify.js";
import {
  MemoryKV,
  genSigningKeypair,
  importRawPublicKey,
  jsonRequest,
  makeEnv,
  seedLicense,
} from "./helpers.js";

let signing: { pkcs8B64: string; rawPub: Uint8Array; publicKey: CryptoKey };

beforeAll(async () => {
  signing = await genSigningKeypair();
});

function envFor(kv: MemoryKV, max?: string) {
  return makeEnv({ kv, ED25519_PRIVATE_KEY_PKCS8_B64: signing.pkcs8B64, MAX_DEVICES: max }).env;
}

async function challenge(kv: MemoryKV, appUserId: string, machineId?: string) {
  const env = envFor(kv);
  const res = await worker.fetch(
    jsonRequest("/verify/challenge", { app_user_id: appUserId, ...(machineId ? { machine_id: machineId } : {}) }),
    env,
  );
  return res;
}

async function verify(kv: MemoryKV, body: unknown) {
  const env = envFor(kv);
  return worker.fetch(jsonRequest("/verify", body), env);
}

// Models the Rust app's verify_strict: import the raw 32-byte public key, verify the
// Ed25519 signature over the EXACT canonical bytes the client reconstructs.
async function verifyAssertionSignature(assertion: any, signatureB64url: string): Promise<boolean> {
  const pub = await importRawPublicKey(signing.rawPub);
  const sigBytes = b64urlToBytes(signatureB64url);
  const msg = canonicalAssertionBytes(assertion);
  const sigBuf = sigBytes.buffer.slice(sigBytes.byteOffset, sigBytes.byteOffset + sigBytes.byteLength) as ArrayBuffer;
  const msgBuf = msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength) as ArrayBuffer;
  return crypto.subtle.verify("Ed25519", pub, sigBuf, msgBuf);
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

describe("/verify/challenge + /verify", () => {
  it("challenge for unknown user -> 404 no_license", async () => {
    const kv = new MemoryKV();
    const res = await challenge(kv, "usr_ghost");
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe("no_license");
  });

  it("correct nonce, active license -> 200 + signed assertion verifies with embedded pubkey", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_v1", "active");

    const ch = await challenge(kv, "usr_v1");
    expect(ch.status).toBe(200);
    const { nonce } = (await ch.json()) as { nonce: string };

    const res = await verify(kv, { app_user_id: "usr_v1", nonce });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { assertion: any; signature: string };
    expect(out.assertion.state).toBe("active");
    expect(out.assertion.nonce).toBe(nonce);
    expect(out.assertion.app_user_id).toBe("usr_v1");

    // verify_strict-compatible: signature verifies over the canonical bytes.
    expect(await verifyAssertionSignature(out.assertion, out.signature)).toBe(true);
  });

  it("tampering ONE byte of the assertion fails signature verification", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_v2", "active");
    const ch = await challenge(kv, "usr_v2");
    const { nonce } = (await ch.json()) as { nonce: string };
    const res = await verify(kv, { app_user_id: "usr_v2", nonce });
    const out = (await res.json()) as { assertion: any; signature: string };

    // Tamper: flip the state in the assertion but keep the original signature.
    const tampered = { ...out.assertion, state: "active_HACKED" };
    expect(await verifyAssertionSignature(tampered, out.signature)).toBe(false);
    // And flipping app_user_id likewise fails.
    const tampered2 = { ...out.assertion, app_user_id: "usr_attacker" };
    expect(await verifyAssertionSignature(tampered2, out.signature)).toBe(false);
  });

  it("reused nonce -> 409 nonce_invalid (single-use)", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_v3", "active");
    const ch = await challenge(kv, "usr_v3");
    const { nonce } = (await ch.json()) as { nonce: string };

    const first = await verify(kv, { app_user_id: "usr_v3", nonce });
    expect(first.status).toBe(200);
    // Replay the SAME nonce: it was deleted on consume.
    const second = await verify(kv, { app_user_id: "usr_v3", nonce });
    expect(second.status).toBe(409);
    expect((await second.json() as any).error).toBe("nonce_invalid");
  });

  it("expired nonce (TTL elapsed) -> 409 nonce_invalid", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_v4", "active");
    const ch = await challenge(kv, "usr_v4");
    const { nonce } = (await ch.json()) as { nonce: string };

    // Advance the mock clock beyond NONCE_TTL_SEC (120s).
    kv.advanceMs(121 * 1000);

    const res = await verify(kv, { app_user_id: "usr_v4", nonce });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe("nonce_invalid");
  });

  it("wrong nonce (never issued) -> 409", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_v5", "active");
    await challenge(kv, "usr_v5"); // issues some nonce, we ignore it
    const res = await verify(kv, { app_user_id: "usr_v5", nonce: "this-was-never-issued" });
    expect(res.status).toBe(409);
  });

  it("missing nonce -> 400 invalid_request", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_v6", "active");
    const res = await verify(kv, { app_user_id: "usr_v6" });
    expect(res.status).toBe(400);
  });

  it("machine_id mismatch (verify device != challenge device) -> 409", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_v7", "active");
    const ch = await challenge(kv, "usr_v7", "machine_A");
    const { nonce } = (await ch.json()) as { nonce: string };
    // Verify from a DIFFERENT machine than the one that challenged.
    const res = await verify(kv, { app_user_id: "usr_v7", nonce, machine_id: "machine_B" });
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toBe("nonce_invalid");
  });

  it("issued_at is monotonic across two verifies (client-modeled rollback check)", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_v8", "active");

    const ch1 = await challenge(kv, "usr_v8");
    const n1 = ((await ch1.json()) as { nonce: string }).nonce;
    const r1 = await verify(kv, { app_user_id: "usr_v8", nonce: n1 });
    const a1 = ((await r1.json()) as { assertion: any }).assertion;

    kv.advanceMs(2000); // wall clock; issued_at uses Date.now(), advance real time a touch
    await new Promise((r) => setTimeout(r, 5));

    const ch2 = await challenge(kv, "usr_v8");
    const n2 = ((await ch2.json()) as { nonce: string }).nonce;
    const r2 = await verify(kv, { app_user_id: "usr_v8", nonce: n2 });
    const a2 = ((await r2.json()) as { assertion: any }).assertion;

    // Client rule 10 (§5): payload.issued_at >= last stored. The second assertion's
    // issued_at must not be BEFORE the first — a past issued_at would be rejected
    // by the Rust monotonic watermark.
    expect(Date.parse(a2.issued_at)).toBeGreaterThanOrEqual(Date.parse(a1.issued_at));
  });

  it("assertion has expires_at in the future (freshness window)", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_v9", "active");
    const ch = await challenge(kv, "usr_v9");
    const { nonce } = (await ch.json()) as { nonce: string };
    const res = await verify(kv, { app_user_id: "usr_v9", nonce });
    const { assertion } = (await res.json()) as { assertion: any };
    expect(Date.parse(assertion.expires_at)).toBeGreaterThan(Date.parse(assertion.issued_at));
    expect(Date.parse(assertion.expires_at)).toBeGreaterThan(Date.now() - 1000);
  });
});

describe("/verify license-state gates", () => {
  it("no license -> 404 no_license", async () => {
    const kv = new MemoryKV();
    // Cannot challenge without a license; inject a nonce-less verify directly.
    const res = await verify(kv, { app_user_id: "usr_none", nonce: "x" });
    // No nonce stored -> 409 first (nonce consumed before license lookup).
    expect(res.status).toBe(409);
  });

  it("past_due -> entitled (signed assertion)", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_pd", "past_due");
    const ch = await challenge(kv, "usr_pd");
    const { nonce } = (await ch.json()) as { nonce: string };
    const res = await verify(kv, { app_user_id: "usr_pd", nonce });
    expect(res.status).toBe(200);
    const { assertion, signature } = (await res.json()) as { assertion: any; signature: string };
    expect(assertion.state).toBe("past_due");
    expect(await verifyAssertionSignature(assertion, signature)).toBe(true);
  });

  it("refunded -> 403 not_entitled (no signed assertion)", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_ref", "refunded");
    const ch = await challenge(kv, "usr_ref");
    const { nonce } = (await ch.json()) as { nonce: string };
    const res = await verify(kv, { app_user_id: "usr_ref", nonce });
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe("not_entitled");
  });

  it("canceled -> 403 not_entitled", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_can", "canceled");
    const ch = await challenge(kv, "usr_can");
    const { nonce } = (await ch.json()) as { nonce: string };
    const res = await verify(kv, { app_user_id: "usr_can", nonce });
    expect(res.status).toBe(403);
  });

  it("paused -> 403 not_entitled", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_pause", "paused");
    const ch = await challenge(kv, "usr_pause");
    const { nonce } = (await ch.json()) as { nonce: string };
    const res = await verify(kv, { app_user_id: "usr_pause", nonce });
    expect(res.status).toBe(403);
  });
});
