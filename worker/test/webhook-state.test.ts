// §6 matrix — webhook state derivation.
// State comes from data.status (subscription) / transaction / adjustment, NOT the
// event name. trialing -> active; past_due/paused/canceled mapped; full refund -> revoked.

import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import {
  MemoryKV,
  makeEnv,
  paddleSignatureHeader,
  webhookRequest,
} from "./helpers.js";

const SECRET = "pdl_ntfset_state_suite";

async function post(kv: MemoryKV, body: string) {
  const { env } = makeEnv({ kv, PADDLE_WEBHOOK_SECRET: SECRET });
  const sig = await paddleSignatureHeader(body, [SECRET]);
  return worker.fetch(webhookRequest(body, sig), env);
}

function subEvent(
  eventId: string,
  eventType: string,
  status: string,
  occurredAt: string,
  user = "usr_state",
) {
  return JSON.stringify({
    event_id: eventId,
    event_type: eventType,
    occurred_at: occurredAt,
    data: {
      id: "sub_state",
      status,
      customer_id: "ctm_state",
      custom_data: { app_user_id: user, order_id: "ord_state", license_kind: "subscription", schema: 1 },
      items: [{ price: { id: "pri_state", product_id: "pro_state" } }],
    },
  });
}

function state(kv: MemoryKV, user = "usr_state"): string {
  return JSON.parse(kv.rawGet(`license:${user}`)!).state;
}

describe("webhook state derivation", () => {
  it("subscription.created trialing -> active (trial normalized)", async () => {
    const kv = new MemoryKV();
    await post(kv, subEvent("evt_s1", "subscription.created", "trialing", "2026-06-23T10:00:00Z"));
    expect(state(kv)).toBe("active");
  });

  it("subscription.created active -> active", async () => {
    const kv = new MemoryKV();
    await post(kv, subEvent("evt_s2", "subscription.created", "active", "2026-06-23T10:00:00Z"));
    expect(state(kv)).toBe("active");
  });

  it("past_due status -> past_due", async () => {
    const kv = new MemoryKV();
    await post(kv, subEvent("evt_s3", "subscription.updated", "past_due", "2026-06-23T10:00:00Z"));
    expect(state(kv)).toBe("past_due");
  });

  it("paused status -> paused", async () => {
    const kv = new MemoryKV();
    await post(kv, subEvent("evt_s4", "subscription.updated", "paused", "2026-06-23T10:00:00Z"));
    expect(state(kv)).toBe("paused");
  });

  it("canceled status -> canceled", async () => {
    const kv = new MemoryKV();
    await post(kv, subEvent("evt_s5", "subscription.canceled", "canceled", "2026-06-23T10:00:00Z"));
    expect(state(kv)).toBe("canceled");
  });

  it("unknown status -> 200 no-op, no record mutation", async () => {
    const kv = new MemoryKV();
    await post(kv, subEvent("evt_seed", "subscription.created", "active", "2026-06-23T10:00:00Z"));
    const before = kv.rawGet("license:usr_state");
    const res = await post(kv, subEvent("evt_unknown", "subscription.updated", "gibberish", "2026-06-23T11:00:00Z"));
    expect(res.status).toBe(200);
    expect(kv.rawGet("license:usr_state")).toBe(before); // unchanged
  });

  it("transaction.completed (perpetual) -> active", async () => {
    const kv = new MemoryKV();
    const body = JSON.stringify({
      event_id: "evt_txn",
      event_type: "transaction.completed",
      occurred_at: "2026-06-23T10:00:00Z",
      data: {
        id: "txn_001",
        customer_id: "ctm_txn",
        custom_data: { app_user_id: "usr_perp", order_id: "ord_perp", license_kind: "perpetual", schema: 1 },
        items: [{ price: { id: "pri_perp", product_id: "pro_perp" } }],
      },
    });
    await post(kv, body);
    const rec = JSON.parse(kv.rawGet("license:usr_perp")!);
    expect(rec.state).toBe("active");
    expect(rec.license_kind).toBe("perpetual");
    expect(rec.paddle.transaction_id).toBe("txn_001");
  });

  it("adjustment full refund (action=refund, status=approved) -> refunded (revoked)", async () => {
    const kv = new MemoryKV();
    // Seed an active subscription first.
    await post(kv, subEvent("evt_seed2", "subscription.created", "active", "2026-06-23T10:00:00Z", "usr_refund"));
    expect(state(kv, "usr_refund")).toBe("active");

    const refund = JSON.stringify({
      event_id: "evt_adj",
      event_type: "adjustment.created",
      occurred_at: "2026-06-23T12:00:00Z",
      data: {
        id: "adj_001",
        action: "refund",
        status: "approved",
        customer_id: "ctm_refund",
        custom_data: { app_user_id: "usr_refund", order_id: "ord_state", license_kind: "subscription", schema: 1 },
      },
    });
    const res = await post(kv, refund);
    expect(res.status).toBe(200);
    expect(state(kv, "usr_refund")).toBe("refunded");
  });

  it("adjustment REJECTED refund -> 200 no-op (access kept)", async () => {
    const kv = new MemoryKV();
    await post(kv, subEvent("evt_seed3", "subscription.created", "active", "2026-06-23T10:00:00Z", "usr_keep"));
    const before = kv.rawGet("license:usr_keep");
    const rejected = JSON.stringify({
      event_id: "evt_adj_rej",
      event_type: "adjustment.created",
      occurred_at: "2026-06-23T12:00:00Z",
      data: {
        id: "adj_rej",
        action: "refund",
        status: "rejected",
        custom_data: { app_user_id: "usr_keep", order_id: "ord_state", license_kind: "subscription", schema: 1 },
      },
    });
    const res = await post(kv, rejected);
    expect(res.status).toBe(200);
    expect(kv.rawGet("license:usr_keep")).toBe(before); // still active, unchanged
  });

  it("non-refund adjustment (action=credit) -> 200 no-op", async () => {
    const kv = new MemoryKV();
    await post(kv, subEvent("evt_seed4", "subscription.created", "active", "2026-06-23T10:00:00Z", "usr_credit"));
    const before = kv.rawGet("license:usr_credit");
    const credit = JSON.stringify({
      event_id: "evt_credit",
      event_type: "adjustment.updated",
      occurred_at: "2026-06-23T12:00:00Z",
      data: {
        id: "adj_credit",
        action: "credit",
        status: "approved",
        custom_data: { app_user_id: "usr_credit", order_id: "ord_state", license_kind: "subscription", schema: 1 },
      },
    });
    await post(kv, credit);
    expect(kv.rawGet("license:usr_credit")).toBe(before);
  });

  it("unhandled event type -> 200 no-op", async () => {
    const kv = new MemoryKV();
    const body = JSON.stringify({
      event_id: "evt_misc",
      event_type: "customer.updated",
      occurred_at: "2026-06-23T10:00:00Z",
      data: { id: "ctm_x" },
    });
    const res = await post(kv, body);
    expect(res.status).toBe(200);
    expect(kv.putCount).toBe(0); // nothing written
  });
});
