// §6 matrix — webhook idempotency, ordering, correlation.
// Attack-first: duplicate event_id must not double-issue; out-of-order (older
// occurred_at) must no-op; an uncorrelated payment must mint NO license.

import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import {
  MemoryKV,
  makeEnv,
  paddleSignatureHeader,
  webhookRequest,
} from "./helpers.js";

const SECRET = "pdl_ntfset_idem_suite";

function event(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return JSON.stringify({
    event_id: "evt_idem_0001",
    event_type: "subscription.created",
    occurred_at: "2026-06-23T10:00:00.000000Z",
    notification_id: "ntf_idem_0001",
    data: {
      id: "sub_idem",
      status: "active",
      customer_id: "ctm_idem",
      custom_data: { app_user_id: "usr_idem", order_id: "ord_idem", license_kind: "subscription", schema: 1 },
      items: [{ price: { id: "pri_idem", product_id: "pro_idem" } }],
      ...data,
    },
    ...overrides,
  });
}

async function post(kv: MemoryKV, body: string) {
  const { env } = makeEnv({ kv, PADDLE_WEBHOOK_SECRET: SECRET });
  const sig = await paddleSignatureHeader(body, [SECRET]);
  return worker.fetch(webhookRequest(body, sig), env);
}

describe("webhook idempotency / ordering / correlation", () => {
  it("duplicate event_id -> 200 no-op (no double-issue)", async () => {
    const kv = new MemoryKV();
    const body = event();

    const r1 = await post(kv, body);
    expect(r1.status).toBe(200);
    const license1 = kv.rawGet("license:usr_idem");
    expect(license1).toBeDefined();
    const writesAfterFirst = kv.putCount;

    // Same event_id redelivered (at-least-once). Must short-circuit at idempotency.
    const r2 = await post(kv, body);
    expect(r2.status).toBe(200);
    // No additional license/order/event writes happened.
    expect(kv.putCount).toBe(writesAfterFirst);
    expect(kv.rawGet("license:usr_idem")).toBe(license1);
  });

  it("older occurred_at (out-of-order redelivery) -> 200 no-op, record unchanged", async () => {
    const kv = new MemoryKV();
    // First: a newer event sets state=active.
    await post(kv, event({ event_id: "evt_new", occurred_at: "2026-06-23T12:00:00.000000Z" }));
    const recordAfterNew = kv.rawGet("license:usr_idem");

    // Then: a STRICTLY-OLDER distinct event arrives late, trying to flip to paused.
    const older = event(
      { event_id: "evt_old", event_type: "subscription.paused", occurred_at: "2026-06-23T09:00:00.000000Z" },
      { status: "paused" },
    );
    const res = await post(kv, older);
    expect(res.status).toBe(200);
    // State must NOT regress to the older event's value.
    expect(kv.rawGet("license:usr_idem")).toBe(recordAfterNew);
    expect(JSON.parse(kv.rawGet("license:usr_idem")!).state).toBe("active");
  });

  it("same occurred_at, DISTINCT event_id -> applied (strict `>` not `>=`)", async () => {
    const kv = new MemoryKV();
    const ts = "2026-06-23T10:00:00.000000Z";
    await post(kv, event({ event_id: "evt_a", occurred_at: ts }));
    // A distinct event sharing the same occurred_at must NOT be dropped.
    const res = await post(
      kv,
      event({ event_id: "evt_b", event_type: "subscription.past_due", occurred_at: ts }, { status: "past_due" }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(kv.rawGet("license:usr_idem")!).state).toBe("past_due");
  });

  it("uncorrelated payment (missing custom_data) -> 200, NO license minted", async () => {
    const kv = new MemoryKV();
    const body = JSON.stringify({
      event_id: "evt_uncorr",
      event_type: "subscription.created",
      occurred_at: "2026-06-23T10:00:00.000000Z",
      data: { id: "sub_x", status: "active", items: [] }, // no custom_data
    });
    const res = await post(kv, body);
    expect(res.status).toBe(200);
    expect(kv.rawGet("license:undefined")).toBeUndefined();
    expect(kv.has("license:usr_idem")).toBe(false);
  });

  it("custom_data present but missing order_id -> 200, NO license minted", async () => {
    const kv = new MemoryKV();
    const body = event({}, { custom_data: { app_user_id: "usr_partial", license_kind: "subscription" } });
    const res = await post(kv, body);
    expect(res.status).toBe(200);
    expect(kv.has("license:usr_partial")).toBe(false);
  });
});
