# license-worker

Cloudflare Worker for license issuance, Ed25519 challenge-response verification, and
phone-link device pairing. The canonical design is `docs/license-system-design.md`.

The Worker **logic** is fully testable locally (vitest + an in-memory KV mock +
Node WebCrypto). **Deployment** needs the owner's Cloudflare + Paddle accounts and is
out of scope here — see "Local vs deployment" below.

## Endpoints

| Method · Path | Purpose |
|---|---|
| `POST /webhooks/paddle` | Paddle Billing webhook. Raw-body HMAC-SHA256 verify BEFORE `JSON.parse`, replay window, multi-h1 rotation, timing-safe compare, `event_id` idempotency, `occurred_at` ordering, state from `data.status`/transaction/adjustment, full refund -> `refunded`. Uncorrelated/duplicate/unhandled -> `200` no-op. |
| `POST /verify/challenge` | Issue a single-use, short-TTL nonce keyed to `app_user_id`. |
| `POST /verify` | Consume the nonce (single-use, not-expired), gate license state + device, Ed25519-sign an assertion over canonical bytes. Entitled -> `200 {assertion, signature}`; `paused`/`canceled`/`refunded` -> `403 not_entitled`; no record -> `404 no_license`; bad nonce -> `409 nonce_invalid`. |
| `POST /pair` | Register a device under a license: TOFU public-key pinning, `max_devices` cap, scope. This is the phone-link convergence (pairing = device registration). |
| `POST /device/deactivate` | Kill-switch: revoke a device. Its subsequent `/verify` -> `not_entitled`. |

## Security boundary

- The Ed25519 **private key** (`ED25519_PRIVATE_KEY_PKCS8_B64`) and the Paddle webhook
  secret (`PADDLE_WEBHOOK_SECRET`) live ONLY in Worker secrets. The app embeds only the
  32-byte public key.
- The webhook signature is verified over the **raw request bytes**; `JSON.parse` runs
  only after the HMAC passes. Re-serializing the body (reordered keys / whitespace)
  produces a different MAC and is rejected — proven by a test.
- Every secret comparison uses constant-time `timingSafeEqual` (length check + XOR
  accumulate). No `===` on a MAC.

## Test suite

Pure local, no network, no Cloudflare. Node's `crypto.subtle` provides the same Ed25519
+ HMAC surface as the Workers runtime; KV is a `Map`-backed mock with a controllable
clock for TTL-expiry tests.

```
npm install          # or pnpm install --ignore-workspace
npx vitest run       # all suites
npx tsc --noEmit     # type check
```

Suites: `crypto`, `webhook-signature`, `webhook-idempotency`, `webhook-state`,
`verify`, `pairing`.

## Local vs deployment

**Verified locally (this deliverable):** every endpoint's request/response behavior,
the webhook signature + idempotency + ordering + state machine, the Ed25519
sign/verify round-trip with a real keypair, nonce single-use + expiry, device
pairing/cap/TOFU, and the deactivate kill-switch.

**Needs deployment (out of scope):** a real Cloudflare account + KV namespace, real
Paddle accounts (sandbox + live), `wrangler secret put` for the private key + webhook
secret, a registered Paddle webhook destination, and live KRW checkout. KV's eventual
consistency / 1-write-per-second-per-key limits are real-cluster properties not
modeled by the in-memory mock. `wrangler.toml` documents the binding/secret contract
but is intentionally NOT deployed.

## Convergence with the Rust verifier (`src-tauri/src/remote/auth.rs`)

The Worker's `/verify` issues a signed entitlement assertion. The Rust side
(`remote::auth`) verifies device capability assertions today using a **peer model**:
each device signs with its own key, and the desktop verifies with the TOFU-pinned
public key via `verify_strict` (single-use nonce, freshness, monotonic `issued_at`,
scope subset). The Worker assertion uses the same canonicalization philosophy — a
fixed key order, compact JSON, Ed25519 over the exact bytes — so the two are byte-shape
compatible by construction.

**Convergence foundation (done).** The Worker now also serializes a *capability* assertion
to the EXACT length-prefixed binary bytes of `auth.rs::canonical_bytes` (`canonicalCapabilityBytes`
in `src/verify.ts`), and a cross-language **golden vector** (`test/capability-golden.json`, mirrored
at `src-tauri/src/remote/auth/capability-golden.json`) proves a Worker-signed assertion verifies
byte-for-byte on the Rust side via `verify_strict` and grants through the full verify floor — an
additive Rust test, no floor change. `docs/license-system-design.md` §4.3 records the canonical layout.
(The entitlement assertion of Track B stays compact JSON; only the *capability* assertion was aligned.)

**Remaining — the live issuer switch.** The live Rust client still uses the peer model
(device-self-signed). Re-wiring it so the desktop verifies Worker-issued assertions with the embedded
Worker public key — and the phone fetches them — is a deliberate model change, **not yet taken**.
