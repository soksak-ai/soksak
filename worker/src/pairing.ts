// Cloudflare Worker — /pair + /device/deactivate (phone-link device registration).
//
// This is the phone-link convergence: pairing = device registration under a license.
// It models src-tauri/src/remote/auth.rs `DeviceRegistry` semantics on KV:
//   - TOFU key pinning: the same device_id re-pairing with a DIFFERENT public key
//     is rejected (key_mismatch) — no silent key swap.
//   - max_devices: a NEW device beyond the cap is rejected (N+1 reject). Re-pairing
//     an existing device (same key) is idempotent and does not consume a new slot.
//   - revoke (deactivate): a kill-switch. A deactivated device's /verify -> not_entitled
//     even with a valid signature / fresh nonce (mirrors DeviceState::Revoked).
//
// The signed /verify assertion key set/order is NEVER touched here — device state is
// a gate that blocks assertion issuance, it is not part of the assertion bytes.

import {
  DeviceEntry,
  DeviceRegistry,
  DeviceScope,
  Env,
  LicenseRecord,
  errorResponse,
  jsonResponse,
  kDevices,
  kLicense,
} from "./types.js";

const VALID_SCOPES: ReadonlySet<string> = new Set<string>(["read-only", "write", "destructive"]);

// Resolve the device cap: per-license max_devices wins; else env.MAX_DEVICES; else 3.
function resolveMaxDevices(env: Env, record: LicenseRecord | null): number {
  if (record && typeof record.max_devices === "number" && record.max_devices > 0) {
    return record.max_devices;
  }
  const fromEnv = Number(env.MAX_DEVICES ?? 3) || 3;
  return fromEnv;
}

function loadRegistry(raw: DeviceRegistry | null): DeviceRegistry {
  if (raw && raw.devices && typeof raw.devices === "object") return raw;
  return { devices: {} };
}

function countActive(reg: DeviceRegistry): number {
  return Object.values(reg.devices).filter((d) => d.state === "active").length;
}

// ----- Shared by /verify: is this device entitled right now? -----
// Returns true only if the device is registered AND active. Unknown device,
// deactivated device -> false. (The device-cap is enforced at /pair, but we also
// re-check active state here so a deactivation takes effect on the next /verify.)
export async function deviceEntitled(
  env: Env,
  appUserId: string,
  deviceId: string,
): Promise<boolean> {
  const reg = loadRegistry(
    await env.LICENSE_KV.get<DeviceRegistry>(kDevices(appUserId), { type: "json" }),
  );
  const entry = reg.devices[deviceId];
  return !!entry && entry.state === "active";
}

// ----- POST /pair -----
// Body: { app_user_id, device_id, public_key (base64url 32-byte), scope? }
// Registers (or idempotently re-activates) a device under a license, enforcing
// max_devices and TOFU key pinning.
export async function handlePair(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", "Malformed JSON body.");
  }

  const appUserId = body?.app_user_id;
  const deviceId = body?.device_id;
  const publicKey = body?.public_key;
  if (typeof appUserId !== "string" || appUserId.length === 0) {
    return errorResponse(400, "invalid_request", "Missing app_user_id.");
  }
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    return errorResponse(400, "invalid_request", "Missing device_id.");
  }
  if (typeof publicKey !== "string" || publicKey.length === 0) {
    return errorResponse(400, "invalid_request", "Missing public_key.");
  }
  const scope: DeviceScope =
    typeof body?.scope === "string" && VALID_SCOPES.has(body.scope)
      ? (body.scope as DeviceScope)
      : "read-only"; // default = least privilege (phone default is read-only).

  // A license must exist to bind a device to it.
  const record = await env.LICENSE_KV.get<LicenseRecord>(kLicense(appUserId), { type: "json" });
  if (!record) {
    return errorResponse(404, "no_license", "No license record for app_user_id.");
  }

  const reg = loadRegistry(
    await env.LICENSE_KV.get<DeviceRegistry>(kDevices(appUserId), { type: "json" }),
  );
  const maxDevices = resolveMaxDevices(env, record);
  const now = new Date().toISOString();
  const existing = reg.devices[deviceId];

  if (existing) {
    // TOFU: a different key for the same device_id is a silent-swap attempt. Reject.
    if (existing.pinned_key !== publicKey) {
      return errorResponse(409, "key_mismatch", "device_id is pinned to a different public key.");
    }
    // Same key: idempotent re-pair. Refresh scope + last_seen + re-activate (a
    // revoked device may be re-paired with its SAME key — the re-activation path).
    existing.scope = scope;
    existing.state = "active";
    existing.last_seen = now;
  } else {
    // New device: enforce the cap on ACTIVE devices (N+1 reject).
    if (countActive(reg) >= maxDevices) {
      return errorResponse(403, "device_limit", `Device limit reached (max_devices=${maxDevices}).`);
    }
    const entry: DeviceEntry = {
      pinned_key: publicKey,
      scope,
      state: "active",
      first_seen: now,
      last_seen: now,
    };
    reg.devices[deviceId] = entry;
  }

  await env.LICENSE_KV.put(kDevices(appUserId), JSON.stringify(reg));

  return jsonResponse({
    paired: true,
    device_id: deviceId,
    scope,
    active_devices: countActive(reg),
    max_devices: maxDevices,
  });
}

// ----- POST /device/deactivate -----
// Body: { app_user_id, device_id }
// Kill-switch: marks the device revoked. Its subsequent /verify -> not_entitled.
// Unknown device_id -> 404 (nothing to revoke). Idempotent on an already-revoked
// device (returns revoked: true).
export async function handleDeactivate(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "invalid_request", "Malformed JSON body.");
  }

  const appUserId = body?.app_user_id;
  const deviceId = body?.device_id;
  if (typeof appUserId !== "string" || appUserId.length === 0) {
    return errorResponse(400, "invalid_request", "Missing app_user_id.");
  }
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    return errorResponse(400, "invalid_request", "Missing device_id.");
  }

  const reg = loadRegistry(
    await env.LICENSE_KV.get<DeviceRegistry>(kDevices(appUserId), { type: "json" }),
  );
  const entry = reg.devices[deviceId];
  if (!entry) {
    return errorResponse(404, "unknown_device", "No such device for this license.");
  }

  entry.state = "revoked";
  entry.last_seen = new Date().toISOString();
  await env.LICENSE_KV.put(kDevices(appUserId), JSON.stringify(reg));

  return jsonResponse({
    revoked: true,
    device_id: deviceId,
    active_devices: countActive(reg),
  });
}
