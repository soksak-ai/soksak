// Paddle Billing webhook -> Cloudflare KV license issuer.
// SECURITY-CRITICAL: signature is verified over the RAW body BEFORE any JSON.parse.
//
// Ported verbatim from license-system-design.md "Cloudflare Worker — Paddle 웹훅
// 수신 · 서명 검증 · 라이선스 발급". The four security pillars are unchanged:
//   (1) read the raw body once and HMAC over it,
//   (2) ts tolerance replay guard,
//   (3) event_id idempotency,
//   (4) occurred_at ordering guard.
// Entitlement state is derived from data.status (subscription) / transaction /
// adjustment — NOT from the event name (the event name only picks the handler).

import { hmacSha256Hex, timingSafeEqual } from "./crypto.js";
import {
  CustomData,
  Env,
  LicenseRecord,
  LicenseState,
  kEvent,
  kLicense,
  kOrder,
} from "./types.js";

// =====================================================================
// 1. Signature verification (canonical algorithm)
// =====================================================================

// Verify Paddle-Signature header against the RAW body.
// toleranceSec = 300 is a PROJECT decision (Paddle documents only 5s).
export async function verifyPaddleSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSec = 300,
): Promise<boolean> {
  if (!signatureHeader) return false;

  // Parse "ts=...;h1=...;h1=..." generically (h1 may repeat during rotation).
  let ts: string | null = null;
  const h1s: string[] = [];
  for (const part of signatureHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1);
    if (k === "ts") ts = v;
    else if (k === "h1") h1s.push(v);
  }
  if (!ts || h1s.length === 0) return false;

  // Replay protection: reject if |now - ts| exceeds tolerance.
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > toleranceSec) return false;

  // signed_payload = ts + ":" + raw_request_body  (literal colon).
  // Key = pdl_ntfset_... raw UTF-8 (NOT decoded). Output = lowercase hex.
  const expected = await hmacSha256Hex(secret, `${ts}:${rawBody}`);

  // Accept if ANY h1 matches (constant-time per candidate). Multi-h1 = rotation.
  return h1s.some((h1) => timingSafeEqual(expected, h1));
}

// =====================================================================
// 2. Webhook envelope + payload accessors
// =====================================================================

export interface WebhookEnvelope {
  event_id: string; // evt_...  (dedupe key — NEVER notification_id)
  event_type: string;
  occurred_at: string; // RFC3339; ordering guard
  notification_id?: string; // ntf_...  (delivery id, do not dedupe on this)
  data: Record<string, any>;
}

function readCustomData(data: Record<string, any>): CustomData {
  const cd = data?.custom_data;
  return cd && typeof cd === "object" ? (cd as CustomData) : {};
}

// Pick the entitlement-bearing price/product across (possibly multi-item) data.items.
function readPriceProduct(data: Record<string, any>): {
  price_id: string | null;
  product_id: string | null;
} {
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  for (const it of items) {
    const priceId = it?.price?.id ?? null;
    if (priceId) {
      const productId = it?.price?.product_id ?? it?.product?.id ?? null;
      return { price_id: priceId, product_id: productId };
    }
  }
  return { price_id: null, product_id: null };
}

// =====================================================================
// 3. State derivation
// =====================================================================

// Map a Paddle subscription data.status to our license state.
function stateFromSubscriptionStatus(status: string | undefined): LicenseState | null {
  switch (status) {
    case "trialing": // trial treated as active
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "paused":
      return "paused";
    case "canceled":
      return "canceled";
    default:
      return null; // unknown status: do not invent a state
  }
}

// Detect a FULL refund on an adjustment. Paddle has no refund.* event; refunds
// are adjustments. action === "refund" + a non-rejected status => revoke.
function isFullRefund(data: Record<string, any>): boolean {
  if (data?.action !== "refund") return false;
  const status = data?.status; // e.g. pending_approval | approved | rejected
  return status !== "rejected";
}

// =====================================================================
// 4. KV write path with idempotency + ordering guard
// =====================================================================

interface ApplyInput {
  env: Env;
  envelope: WebhookEnvelope;
  custom: CustomData;
  nextState: LicenseState;
  paddlePatch: Partial<LicenseRecord["paddle"]>;
}

async function applyLicenseTransition(input: ApplyInput): Promise<number> {
  const { env, envelope, custom, nextState, paddlePatch } = input;
  const appUserId = custom.app_user_id;
  const orderId = custom.order_id;

  // Uncorrelated payment: never mint a license without the join keys.
  if (!appUserId || !orderId) {
    return 200;
  }

  const eventKey = kEvent(envelope.event_id);
  const licenseKey = kLicense(appUserId);
  const orderKey = kOrder(orderId);

  // (1) Idempotency: already-processed event_id -> no-op. Owns duplicate-by-id.
  const seen = await env.LICENSE_KV.get(eventKey);
  if (seen !== null) {
    return 200;
  }

  // (2) Ordering guard: ignore only STRICTLY-OLDER events (use `>` not `>=` so
  //     same-instant DISTINCT events are not dropped; true dupes hit step 1).
  const existing = await env.LICENSE_KV.get<LicenseRecord>(licenseKey, { type: "json" });
  if (existing && existing.last_occurred_at > envelope.occurred_at) {
    await env.LICENSE_KV.put(eventKey, "1", { expirationTtl: 86400 });
    return 200;
  }

  // (3) Apply state transition. Merge paddle fields (only overwrite non-null).
  const nowIso = new Date().toISOString();
  const mergedPaddle = {
    customer_id: paddlePatch.customer_id ?? existing?.paddle.customer_id ?? null,
    subscription_id: paddlePatch.subscription_id ?? existing?.paddle.subscription_id ?? null,
    transaction_id: paddlePatch.transaction_id ?? existing?.paddle.transaction_id ?? null,
    price_id: paddlePatch.price_id ?? existing?.paddle.price_id ?? null,
    product_id: paddlePatch.product_id ?? existing?.paddle.product_id ?? null,
  };

  const record: LicenseRecord = {
    schema: 1,
    app_user_id: appUserId,
    order_id: orderId,
    license_kind: custom.license_kind ?? existing?.license_kind ?? "perpetual",
    state: nextState,
    max_devices: existing?.max_devices,
    paddle: mergedPaddle,
    last_event_id: envelope.event_id,
    last_occurred_at: envelope.occurred_at,
    created_at: existing?.created_at ?? nowIso,
    updated_at: nowIso,
  };

  // (4) Persist record, order index, and idempotency marker.
  await env.LICENSE_KV.put(licenseKey, JSON.stringify(record));
  await env.LICENSE_KV.put(orderKey, appUserId);
  await env.LICENSE_KV.put(eventKey, "1", { expirationTtl: 86400 });

  return 200;
}

// =====================================================================
// 5. Event routing (handler chosen by event_type; state from payload)
// =====================================================================

async function handleWebhookEvent(env: Env, envelope: WebhookEnvelope): Promise<number> {
  const { event_type: type, data } = envelope;
  const custom = readCustomData(data);
  const { price_id, product_id } = readPriceProduct(data);

  switch (type) {
    // --- One-time (perpetual) purchase ---
    case "transaction.completed": {
      return applyLicenseTransition({
        env,
        envelope,
        custom,
        nextState: "active",
        paddlePatch: {
          transaction_id: data?.id ?? null,
          customer_id: data?.customer_id ?? null,
          price_id,
          product_id,
        },
      });
    }

    // --- Subscription lifecycle: state derived from data.status ---
    case "subscription.created":
    case "subscription.activated":
    case "subscription.updated": {
      const next = stateFromSubscriptionStatus(data?.status);
      if (next === null) {
        return 200; // unknown status -> ignore safely (200), do not mutate.
      }
      return applyLicenseTransition({
        env,
        envelope,
        custom,
        nextState: next,
        paddlePatch: {
          subscription_id: data?.id ?? null,
          customer_id: data?.customer_id ?? null,
          price_id,
          product_id,
        },
      });
    }

    // --- Subscription state events (state from the event itself) ---
    case "subscription.past_due":
      return applyLicenseTransition({
        env,
        envelope,
        custom,
        nextState: "past_due",
        paddlePatch: { subscription_id: data?.id ?? null, customer_id: data?.customer_id ?? null, price_id, product_id },
      });

    case "subscription.paused":
      return applyLicenseTransition({
        env,
        envelope,
        custom,
        nextState: "paused",
        paddlePatch: { subscription_id: data?.id ?? null, customer_id: data?.customer_id ?? null, price_id, product_id },
      });

    case "subscription.canceled":
      return applyLicenseTransition({
        env,
        envelope,
        custom,
        nextState: "canceled",
        paddlePatch: { subscription_id: data?.id ?? null, customer_id: data?.customer_id ?? null, price_id, product_id },
      });

    // --- Refunds: the ONLY refund channel is adjustment.* (no refund.* event) ---
    case "adjustment.created":
    case "adjustment.updated": {
      if (!isFullRefund(data)) {
        return 200; // partial refund / credit / non-refund adjustment: keep access.
      }
      return applyLicenseTransition({
        env,
        envelope,
        custom,
        nextState: "refunded",
        paddlePatch: { customer_id: data?.customer_id ?? null },
      });
    }

    // --- Any other event: acknowledged and ignored ---
    default:
      return 200;
  }
}

// =====================================================================
// 6. Webhook entry: read raw -> verify -> parse -> route
// =====================================================================

export async function handlePaddleWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // (a) Read the RAW body exactly once, BEFORE any parsing.
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("Paddle-Signature");

  // (b) Verify signature over raw bytes. Fail closed with 401.
  const ok = await verifyPaddleSignature(rawBody, signatureHeader, env.PADDLE_WEBHOOK_SECRET);
  if (!ok) {
    return new Response("Invalid signature", { status: 401 });
  }

  // (c) Parse JSON only AFTER verification passes.
  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody) as WebhookEnvelope;
  } catch {
    return new Response("ok", { status: 200 });
  }
  if (!envelope?.event_id || !envelope?.event_type || !envelope?.occurred_at) {
    return new Response("ok", { status: 200 });
  }

  // (d) Route, dedupe, write license. Always 200 on the verified happy path.
  try {
    await handleWebhookEvent(env, envelope);
  } catch (err) {
    // Genuine transient KV failure: surface 500 to trigger Paddle redelivery.
    console.error(`handler error evt=${envelope.event_id}:`, err);
    return new Response("internal error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
}
