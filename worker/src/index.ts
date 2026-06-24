// License Worker — router.
//
// Endpoints:
//   POST /webhooks/paddle    -> Paddle webhook: raw-body HMAC verify, idempotency,
//                               ordering, state derivation, full-refund -> revoke.
//   POST /verify/challenge   -> issue a single-use nonce keyed to app_user_id.
//   POST /verify             -> consume nonce, gate state + device, Ed25519-sign assertion.
//   POST /pair               -> register a device under a license (max_devices, TOFU pin).
//   POST /device/deactivate  -> revoke a device (kill-switch).
//
// SECURITY: the Ed25519 private key + Paddle webhook secret live ONLY in env
// (Worker secrets). Only the public key is ever exposed to the app.

import { Env, errorResponse } from "./types.js";
import { handlePaddleWebhook } from "./webhook.js";
import { handleChallenge, handleVerify } from "./verify.js";
import { handleDeactivate, handlePair } from "./pairing.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // The webhook owns its own method handling (405 inside) so it can read the
    // raw body before anything else touches the request.
    if (path === "/webhooks/paddle") {
      return handlePaddleWebhook(request, env);
    }

    if (request.method !== "POST") {
      return errorResponse(405, "invalid_request", "Method Not Allowed.");
    }

    switch (path) {
      case "/verify/challenge":
        return handleChallenge(request, env);
      case "/verify":
        return handleVerify(request, env);
      case "/pair":
        return handlePair(request, env);
      case "/device/deactivate":
        return handleDeactivate(request, env);
      default:
        return errorResponse(404, "invalid_request", "Unknown endpoint.");
    }
  },
} satisfies ExportedHandler<Env>;
