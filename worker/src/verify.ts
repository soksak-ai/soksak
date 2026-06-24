// Cloudflare Worker — /verify/challenge + /verify (Ed25519 challenge-response).
//
// license-system-design.md "Cloudflare Worker — /verify 챌린지-응답 + Ed25519 서명"
// is authoritative for request/response shapes and assertion byte order.
//
// Two-step nonce challenge-response: the app never trusts a cached value, it asks
// the Worker for a live, signed entitlement assertion every time.
//   1. POST /verify/challenge -> single-use, short-TTL nonce keyed to app_user_id.
//   2. POST /verify -> consume nonce, gate state, Ed25519-sign the assertion.
//
// Device binding (machine_id) is the phone-link convergence: a device must be
// paired (POST /pair) and active. A deactivated or over-cap device -> not_entitled.

import { b64urlEncode, ed25519Sign } from "./crypto.js";
import {
  Assertion,
  Env,
  LicenseRecord,
  errorResponse,
  jsonResponse,
  kLicense,
  kNonce,
} from "./types.js";
import { deviceEntitled } from "./pairing.js";

// Nonce lifetime: short, single-use. Assertion freshness window.
export const NONCE_TTL_SEC = 120; // 2 min — survives user latency, well under replay risk
export const ASSERTION_TTL_SEC = 60; // assertion.expires_at = issued_at + 60s

// Access decision: grant if state in {active, past_due}; deny otherwise.
// `trialing` records are normalized to `active` by the webhook, so the persisted
// enum here is {active, past_due, paused, canceled, refunded}.
const ENTITLED_STATES = new Set<string>(["active", "past_due"]);

interface NonceEntry {
  nonce: string;
  machine_id: string | null;
  issued_at: number;
}

// ----- Canonical assertion serialization (CONTRACT §6.2, BINDING) -----
// Fixed key order: app_user_id, state, license_kind, nonce, issued_at, expires_at.
// Compact JSON (no insignificant whitespace). Built by hand so key order does NOT
// depend on JSON.stringify behavior. The Rust client reconstructs THESE bytes and
// verifies with verify_strict over the embedded public key (see convergence note).
export function canonicalAssertionBytes(a: Assertion): Uint8Array {
  const json =
    "{" +
    `"app_user_id":${JSON.stringify(a.app_user_id)},` +
    `"state":${JSON.stringify(a.state)},` +
    `"license_kind":${JSON.stringify(a.license_kind)},` +
    `"nonce":${JSON.stringify(a.nonce)},` +
    `"issued_at":${JSON.stringify(a.issued_at)},` +
    `"expires_at":${JSON.stringify(a.expires_at)}` +
    "}";
  return new TextEncoder().encode(json);
}

// ----- POST /verify/challenge (Step 1) -----
export async function handleChallenge(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", "Malformed JSON body.");
  }

  const appUserId = body?.app_user_id;
  if (typeof appUserId !== "string" || appUserId.length === 0) {
    return errorResponse(400, "invalid_request", "Missing app_user_id.");
  }

  // A license record must exist to issue a challenge.
  const record = await env.LICENSE_KV.get<LicenseRecord>(kLicense(appUserId), { type: "json" });
  if (!record) {
    return errorResponse(404, "no_license", "No license record for app_user_id.");
  }

  // 32-byte random nonce -> base64url.
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = b64urlEncode(nonceBytes);

  const now = Date.now();
  const expiresAt = new Date(now + NONCE_TTL_SEC * 1000).toISOString();

  // Bind the optional machine_id to this nonce so /verify can enforce that the
  // same device that challenged is the one verifying.
  const machineId = typeof body?.machine_id === "string" ? body.machine_id : null;

  const nonceEntry: NonceEntry = { nonce, machine_id: machineId, issued_at: now };
  // Single-use is enforced at /verify by deleting on consume; TTL bounds lifetime.
  await env.LICENSE_KV.put(kNonce(appUserId), JSON.stringify(nonceEntry), {
    expirationTtl: NONCE_TTL_SEC,
  });

  return jsonResponse({ nonce, expires_at: expiresAt });
}

// ----- POST /verify (Step 2) -----
export async function handleVerify(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", "Malformed JSON body.");
  }

  const appUserId = body?.app_user_id;
  const nonce = body?.nonce;
  if (typeof appUserId !== "string" || appUserId.length === 0) {
    return errorResponse(400, "invalid_request", "Missing app_user_id.");
  }
  if (typeof nonce !== "string" || nonce.length === 0) {
    return errorResponse(400, "invalid_request", "Missing nonce.");
  }

  // --- Consume the nonce (single-use). Read, validate, delete. ---
  const stored = await env.LICENSE_KV.get<NonceEntry>(kNonce(appUserId), { type: "json" });
  if (!stored || stored.nonce !== nonce) {
    // Unknown, expired (TTL elapsed -> null), or mismatched -> 409 nonce_invalid.
    return errorResponse(409, "nonce_invalid", "Nonce unknown, expired, or already used.");
  }
  // Delete immediately to enforce single-use. A replay of the same nonce now 409s.
  await env.LICENSE_KV.delete(kNonce(appUserId));

  // --- Device binding: the verifying machine_id must match the challenge's, and
  //     the device must be paired + active + within max_devices. ---
  const machineId = typeof body?.machine_id === "string" ? body.machine_id : null;
  if (stored.machine_id || machineId) {
    if (stored.machine_id !== machineId) {
      return errorResponse(409, "nonce_invalid", "Nonce was issued to a different device.");
    }
    // deviceEntitled returns false if the device was never paired, was deactivated
    // (kill-switch), or the license is at its device cap. A deactivated device's
    // /verify -> not_entitled, exactly as the Rust remote::auth revoke path.
    const allowed = await deviceEntitled(env, appUserId, machineId);
    if (!allowed) {
      return errorResponse(403, "not_entitled", "Device is not entitled (unpaired, deactivated, or cap reached).");
    }
  }

  // --- Load the license record and resolve state. ---
  const record = await env.LICENSE_KV.get<LicenseRecord>(kLicense(appUserId), { type: "json" });
  if (!record) {
    return errorResponse(404, "no_license", "No license record for app_user_id.");
  }

  const state = record.state;
  const licenseKind = record.license_kind;

  // Access decision: deny paused/canceled/refunded.
  if (!ENTITLED_STATES.has(state)) {
    return errorResponse(403, "not_entitled", `License state '${state}' denies access.`);
  }

  // --- Build the assertion. ---
  const nowMs = Date.now();
  const issuedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ASSERTION_TTL_SEC * 1000).toISOString();

  const assertion: Assertion = {
    app_user_id: appUserId,
    state,
    license_kind: licenseKind,
    nonce,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };

  // --- Sign the EXACT canonical bytes with the Ed25519 private key. ---
  const messageBytes = canonicalAssertionBytes(assertion);
  const sigBytes = await ed25519Sign(env.ED25519_PRIVATE_KEY_PKCS8_B64, messageBytes);
  const signature = b64urlEncode(sigBytes); // 64-byte sig -> base64url

  // Return the canonical assertion STRING directly to guarantee byte-for-byte match
  // with what was signed (the client verifies over that exact string before parsing).
  const assertionJson = new TextDecoder().decode(messageBytes);
  return new Response(`{"assertion":${assertionJson},"signature":${JSON.stringify(signature)}}`, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
