// Phone-link security-suite category A (pairing/auth) — /pair + /device/deactivate.
// Attack-first: register a device; max_devices overrun rejected; TOFU key-mismatch
// rejected; deactivate -> subsequent /verify not_entitled; a device cannot register
// itself beyond what the license allows.

import { describe, expect, it, beforeAll } from "vitest";
import worker from "../src/index.js";
import {
  MemoryKV,
  genSigningKeypair,
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

async function pair(kv: MemoryKV, body: unknown, max?: string) {
  return worker.fetch(jsonRequest("/pair", body), envFor(kv, max));
}
async function deactivate(kv: MemoryKV, body: unknown) {
  return worker.fetch(jsonRequest("/device/deactivate", body), envFor(kv));
}
async function challenge(kv: MemoryKV, appUserId: string, machineId: string) {
  return worker.fetch(jsonRequest("/verify/challenge", { app_user_id: appUserId, machine_id: machineId }), envFor(kv));
}
async function verify(kv: MemoryKV, body: unknown) {
  return worker.fetch(jsonRequest("/verify", body), envFor(kv));
}

const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 43-char b64url-ish placeholder
const KEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

describe("/pair device registration", () => {
  it("register a device under a license -> 200 paired", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_p1", "active");
    const res = await pair(kv, { app_user_id: "usr_p1", device_id: "dev_1", public_key: KEY_A });
    expect(res.status).toBe(200);
    const out = (await res.json()) as any;
    expect(out.paired).toBe(true);
    expect(out.active_devices).toBe(1);
  });

  it("pair under a non-existent license -> 404 no_license", async () => {
    const kv = new MemoryKV();
    const res = await pair(kv, { app_user_id: "usr_ghost", device_id: "dev_1", public_key: KEY_A });
    expect(res.status).toBe(404);
  });

  it("max_devices overrun (N+1) rejected -> 403 device_limit", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_p2", "active");
    // cap = 2.
    expect((await pair(kv, { app_user_id: "usr_p2", device_id: "d1", public_key: KEY_A }, "2")).status).toBe(200);
    expect((await pair(kv, { app_user_id: "usr_p2", device_id: "d2", public_key: KEY_B }, "2")).status).toBe(200);
    // Third NEW device exceeds the cap.
    const third = await pair(kv, { app_user_id: "usr_p2", device_id: "d3", public_key: "CCC" }, "2");
    expect(third.status).toBe(403);
    expect((await third.json() as any).error).toBe("device_limit");
  });

  it("per-license max_devices overrides env default", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_p3", "active", { max_devices: 1 });
    // env default is 3, but the license caps at 1.
    expect((await pair(kv, { app_user_id: "usr_p3", device_id: "d1", public_key: KEY_A }, "3")).status).toBe(200);
    const second = await pair(kv, { app_user_id: "usr_p3", device_id: "d2", public_key: KEY_B }, "3");
    expect(second.status).toBe(403);
  });

  it("re-pairing the SAME device with the SAME key is idempotent (no new slot)", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_p4", "active");
    await pair(kv, { app_user_id: "usr_p4", device_id: "d1", public_key: KEY_A }, "1");
    // Same device, same key, cap=1 -> still allowed (idempotent), not N+1.
    const again = await pair(kv, { app_user_id: "usr_p4", device_id: "d1", public_key: KEY_A }, "1");
    expect(again.status).toBe(200);
    expect(((await again.json()) as any).active_devices).toBe(1);
  });

  it("TOFU: same device_id with a DIFFERENT key -> 409 key_mismatch (no silent swap)", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_p5", "active");
    await pair(kv, { app_user_id: "usr_p5", device_id: "d1", public_key: KEY_A });
    const swap = await pair(kv, { app_user_id: "usr_p5", device_id: "d1", public_key: KEY_B });
    expect(swap.status).toBe(409);
    expect((await swap.json() as any).error).toBe("key_mismatch");
  });

  it("a device cannot register itself beyond what the license allows (cap holds across distinct devices)", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_p6", "active");
    // cap=1: first device wins, every other distinct device is denied.
    await pair(kv, { app_user_id: "usr_p6", device_id: "d1", public_key: KEY_A }, "1");
    for (const d of ["d2", "d3", "d4"]) {
      const res = await pair(kv, { app_user_id: "usr_p6", device_id: d, public_key: KEY_B + d }, "1");
      expect(res.status).toBe(403);
    }
  });

  it("missing required fields -> 400", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_p7", "active");
    expect((await pair(kv, { app_user_id: "usr_p7", device_id: "d1" })).status).toBe(400);
    expect((await pair(kv, { app_user_id: "usr_p7", public_key: KEY_A })).status).toBe(400);
    expect((await pair(kv, { device_id: "d1", public_key: KEY_A })).status).toBe(400);
  });
});

describe("/device/deactivate kill-switch", () => {
  it("deactivate -> subsequent /verify is not_entitled", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_d1", "active");
    await pair(kv, { app_user_id: "usr_d1", device_id: "dev_x", public_key: KEY_A });

    // Before deactivation: a paired+active device verifies fine.
    const ch1 = await challenge(kv, "usr_d1", "dev_x");
    const n1 = ((await ch1.json()) as any).nonce;
    const v1 = await verify(kv, { app_user_id: "usr_d1", nonce: n1, machine_id: "dev_x" });
    expect(v1.status).toBe(200);

    // Kill-switch.
    const off = await deactivate(kv, { app_user_id: "usr_d1", device_id: "dev_x" });
    expect(off.status).toBe(200);
    expect(((await off.json()) as any).revoked).toBe(true);

    // After deactivation: the same device's /verify is denied (not_entitled),
    // even though the license itself is still active and the nonce is fresh.
    const ch2 = await challenge(kv, "usr_d1", "dev_x");
    const n2 = ((await ch2.json()) as any).nonce;
    const v2 = await verify(kv, { app_user_id: "usr_d1", nonce: n2, machine_id: "dev_x" });
    expect(v2.status).toBe(403);
    expect((await v2.json() as any).error).toBe("not_entitled");
  });

  it("deactivate then re-pair with the SAME key re-activates (verify entitled again)", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_d2", "active");
    await pair(kv, { app_user_id: "usr_d2", device_id: "dev_y", public_key: KEY_A });
    await deactivate(kv, { app_user_id: "usr_d2", device_id: "dev_y" });

    // Re-pair with the same key = re-activation path.
    const re = await pair(kv, { app_user_id: "usr_d2", device_id: "dev_y", public_key: KEY_A });
    expect(re.status).toBe(200);

    const ch = await challenge(kv, "usr_d2", "dev_y");
    const n = ((await ch.json()) as any).nonce;
    const v = await verify(kv, { app_user_id: "usr_d2", nonce: n, machine_id: "dev_y" });
    expect(v.status).toBe(200);
  });

  it("deactivating a freed slot lets a NEW device register (cap accounts active only)", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_d3", "active");
    await pair(kv, { app_user_id: "usr_d3", device_id: "d1", public_key: KEY_A }, "1");
    // cap=1 reached; deactivate d1 frees the slot.
    await deactivate(kv, { app_user_id: "usr_d3", device_id: "d1" });
    const d2 = await pair(kv, { app_user_id: "usr_d3", device_id: "d2", public_key: KEY_B }, "1");
    expect(d2.status).toBe(200);
  });

  it("deactivate an unknown device -> 404 unknown_device", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_d4", "active");
    const res = await deactivate(kv, { app_user_id: "usr_d4", device_id: "nope" });
    expect(res.status).toBe(404);
  });

  it("verify with a machine_id that was never paired -> 403 not_entitled", async () => {
    const kv = new MemoryKV();
    await seedLicense(kv, "usr_d5", "active");
    // No pairing at all; challenge+verify with a machine_id.
    const ch = await challenge(kv, "usr_d5", "unpaired_dev");
    const n = ((await ch.json()) as any).nonce;
    const v = await verify(kv, { app_user_id: "usr_d5", nonce: n, machine_id: "unpaired_dev" });
    expect(v.status).toBe(403);
    expect((await v.json() as any).error).toBe("not_entitled");
  });
});
