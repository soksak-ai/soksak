// Shared types + KV key helpers + HTTP response helpers.
// KV schema follows license-system-design.md §4.1 / "CONTRACT §5".

export interface Env {
  LICENSE_KV: KVNamespace;
  // pdl_ntfset_... per-destination webhook HMAC key (raw UTF-8).
  PADDLE_WEBHOOK_SECRET: string;
  // base64 PKCS#8 Ed25519 private key for /verify assertion signing.
  ED25519_PRIVATE_KEY_PKCS8_B64: string;
  // EXTENSION: device cap fallback when a license omits max_devices. Default 3.
  MAX_DEVICES?: string;
}

// ---- License record (KV schema) ----

export type LicenseState = "active" | "past_due" | "paused" | "canceled" | "refunded";
export type LicenseKind = "perpetual" | "subscription";

export interface LicenseRecord {
  schema: 1;
  app_user_id: string;
  order_id: string;
  license_kind: LicenseKind;
  state: LicenseState;
  // EXTENSION: per-license device cap. Optional; falls back to env.MAX_DEVICES.
  max_devices?: number;
  paddle: {
    customer_id: string | null;
    subscription_id: string | null;
    transaction_id: string | null;
    price_id: string | null;
    product_id: string | null;
  };
  last_event_id: string;
  last_occurred_at: string; // RFC3339; ordering guard
  created_at: string;
  updated_at: string;
}

// custom_data shape set at checkout.
export interface CustomData {
  app_user_id?: string;
  order_id?: string;
  license_kind?: LicenseKind;
  schema?: number;
}

// ---- The signed assertion (CONTRACT §6.2 canonical key order, BINDING) ----
// Fixed key order: app_user_id, state, license_kind, nonce, issued_at, expires_at.
export interface Assertion {
  app_user_id: string;
  state: LicenseState;
  license_kind: LicenseKind;
  nonce: string;
  issued_at: string; // RFC3339
  expires_at: string; // RFC3339
}

// ---- Device-binding registry (EXTENSION — phone-link convergence) ----
// Stored under device:{app_user_id}. Models the Rust remote::auth DeviceRegistry:
// TOFU-pinned per-device public key, granted scope, active|revoked state.
export type DeviceScope = "read-only" | "write" | "destructive";

export interface DeviceEntry {
  // TOFU-pinned device public key (base64url, 32-byte Ed25519). Never silently swapped.
  pinned_key: string;
  scope: DeviceScope;
  state: "active" | "revoked";
  first_seen: string;
  last_seen: string;
}

export interface DeviceRegistry {
  // keyed by device_id
  devices: Record<string, DeviceEntry>;
}

// ---- KV key helpers ----
export const kLicense = (appUserId: string) => `license:${appUserId}`;
export const kOrder = (orderId: string) => `order:${orderId}`;
export const kEvent = (eventId: string) => `event:${eventId}`;
export const kNonce = (appUserId: string) => `verify-nonce:${appUserId}`;
export const kDevices = (appUserId: string) => `device:${appUserId}`;

// ---- HTTP helpers ----
export function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// CONTRACT §6.3 error envelope: { error: code, message }.
export function errorResponse(httpStatus: number, code: string, message: string): Response {
  return jsonResponse({ error: code, message }, httpStatus);
}
