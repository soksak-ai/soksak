// §6 matrix — webhook signature verification.
// Attack-first: a valid signature is accepted; everything else (bad sig, stale ts,
// tampered body, garbage header, re-serialized body) is rejected with 401.

import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import {
  makeEnv,
  paddleSignatureHeader,
  webhookRequest,
} from "./helpers.js";

const SECRET = "pdl_ntfset_signature_suite";

// A contract-shaped subscription.created payload. Envelope fields at TOP LEVEL.
const BODY = JSON.stringify({
  event_id: "evt_sig_0001",
  event_type: "subscription.created",
  occurred_at: "2026-06-23T10:00:00.000000Z",
  notification_id: "ntf_sig_0001",
  data: {
    id: "sub_sig_0001",
    status: "trialing",
    customer_id: "ctm_sig_0001",
    custom_data: { app_user_id: "usr_sig", order_id: "ord_sig", license_kind: "subscription", schema: 1 },
    items: [{ price: { id: "pri_sig", product_id: "pro_sig" } }],
  },
});

function env(secret = SECRET) {
  return makeEnv({ PADDLE_WEBHOOK_SECRET: secret });
}

describe("webhook signature", () => {
  it("valid signature -> 200 accepted", async () => {
    const { env: e } = env();
    const sig = await paddleSignatureHeader(BODY, [SECRET]);
    const res = await worker.fetch(webhookRequest(BODY, sig), e);
    expect(res.status).toBe(200);
  });

  it("bad signature (wrong secret) -> 401", async () => {
    const { env: e } = env();
    const sig = await paddleSignatureHeader(BODY, ["pdl_ntfset_WRONG"]);
    const res = await worker.fetch(webhookRequest(BODY, sig), e);
    expect(res.status).toBe(401);
  });

  it("stale ts (replay window exceeded) -> 401", async () => {
    const { env: e } = env();
    const staleTs = Math.floor(Date.now() / 1000) - 400; // > 300s tolerance
    const sig = await paddleSignatureHeader(BODY, [SECRET], staleTs);
    const res = await worker.fetch(webhookRequest(BODY, sig), e);
    expect(res.status).toBe(401);
  });

  it("future ts beyond tolerance -> 401 (Math.abs guards both directions)", async () => {
    const { env: e } = env();
    const futureTs = Math.floor(Date.now() / 1000) + 400;
    const sig = await paddleSignatureHeader(BODY, [SECRET], futureTs);
    const res = await worker.fetch(webhookRequest(BODY, sig), e);
    expect(res.status).toBe(401);
  });

  it("multi-h1 rotation (one of several h1 matches) -> 200", async () => {
    const { env: e } = env();
    // Header carries h1 for OLD_SECRET (no longer current) AND the live SECRET.
    const sig = await paddleSignatureHeader(BODY, ["pdl_ntfset_OLD", SECRET]);
    const res = await worker.fetch(webhookRequest(BODY, sig), e);
    expect(res.status).toBe(200);
  });

  it("multi-h1 where NONE match -> 401", async () => {
    const { env: e } = env();
    const sig = await paddleSignatureHeader(BODY, ["pdl_ntfset_OLD", "pdl_ntfset_OTHER"]);
    const res = await worker.fetch(webhookRequest(BODY, sig), e);
    expect(res.status).toBe(401);
  });

  it("tampered body (sig computed over original) -> 401", async () => {
    const { env: e } = env();
    const sig = await paddleSignatureHeader(BODY, [SECRET]);
    const tampered = BODY.replace("usr_sig", "usr_attacker");
    const res = await worker.fetch(webhookRequest(tampered, sig), e);
    expect(res.status).toBe(401);
  });

  it("missing Paddle-Signature header -> 401", async () => {
    const { env: e } = env();
    const res = await worker.fetch(webhookRequest(BODY, null), e);
    expect(res.status).toBe(401);
  });

  it("garbage header (no ts/h1) -> 401", async () => {
    const { env: e } = env();
    const res = await worker.fetch(webhookRequest(BODY, "garbage;not=valid"), e);
    expect(res.status).toBe(401);
  });

  it("header with ts but no h1 -> 401", async () => {
    const { env: e } = env();
    const ts = Math.floor(Date.now() / 1000);
    const res = await worker.fetch(webhookRequest(BODY, `ts=${ts}`), e);
    expect(res.status).toBe(401);
  });

  it("non-numeric ts -> 401", async () => {
    const { env: e } = env();
    const h1 = (await paddleSignatureHeader(BODY, [SECRET])).split("h1=")[1];
    const res = await worker.fetch(webhookRequest(BODY, `ts=notanumber;h1=${h1}`), e);
    expect(res.status).toBe(401);
  });

  it("raw-body-before-parse: a re-serialized (reordered/reformatted) body fails", async () => {
    // Proves the Worker verifies the RAW bytes, not a re-encoded JSON. The signature
    // is over BODY; we re-serialize the SAME object with different key order/spacing.
    const { env: e } = env();
    const sig = await paddleSignatureHeader(BODY, [SECRET]);
    const parsed = JSON.parse(BODY);
    // JSON.stringify with indentation = different bytes, same semantic content.
    const reserialized = JSON.stringify(parsed, null, 2);
    expect(reserialized).not.toBe(BODY); // sanity: bytes differ
    const res = await worker.fetch(webhookRequest(reserialized, sig), e);
    expect(res.status).toBe(401);
  });
});
