# Phone-Link — remote control security contract (정본)

Status: security/transport core complete on branch `feat/phone-link` (not merged, not pushed).
Scope: a phone (or any paired device) remotely drives a CGNAT desktop's `command`/`dom`/`status`
surface, and tunnels local dev servers, over a mutually-authenticated end-to-end-encrypted channel.

This document is the canonical contract: the threat model, the layered defenses, and the exact
test that proves each defense. It complements `docs/AI-CONTROL.md` (the local control surface this
feature exposes remotely). Source plan: `~/.claude/plans/polished-launching-toast.md`.

> Security floor (never weakened — RULE 0): the moment a connection is unauthenticated, an
> assertion is unverified, or a relay can read the payload, everything is lost. There is no
> unauthenticated fallback, no debug backdoor, no local-trust exception.

---

## 1. Where it lives

Everything is additive Rust in the core under `src-tauri/src/remote/` (off by default — the
running app is unaffected unless explicitly enabled). The local `command`/`dom`/`status` dispatch
seam it reuses is `ipc.rs::request_command` → `route()` (unchanged).

| Module | Role | Tests |
|--------|------|-------|
| `auth.rs`    | Ed25519 device pairing + capability-assertion verify (authorization) | 41 |
| `noise.rs`   | Noise_KK_25519_ChaChaPoly_BLAKE2s channel (authentication + confidentiality + PFS) | 31 |
| `session.rs` | `SecureSession` — composes the two gates per frame | 31 |
| `transport.rs` | transport-agnostic `serve_connection(stream)` + length framing | 29 |
| `tcp.rs`     | loopback-only (127.0.0.1) TCP listener | 4 |
| `confirm.rs` | destructive desktop-confirm authority (event-driven, no poll) | 11 |
| `iroh.rs`    | iroh QUIC P2P + relay transport tier | 6 |
| `client.rs`  | reusable initiator (the half a phone embeds) + `sok-phone` CLI | 13 |
| `bridge.rs`  | off-by-default app glue (enable flags, `request_command` dispatch, Tauri confirm cmds) | — |

Total: **166 RED→GREEN tests**, all green; the floors were each verified independently by
NOP-patching a defense (attack passes = RED) and restoring (blocked = GREEN).

---

## 2. The two-layer model (defense in depth)

Two independent gates. Breaking either alone grants nothing.

```
phone ──TCP/iroh stream──▶ [GATE 1: Noise_KK]  mutual static-key auth + ChaCha20-Poly1305 + PFS
                                   │  (unpaired/unknown key ⇒ no channel ever forms)
                                   ▼
                            [GATE 2: Ed25519 assertion]  per-frame: verify_strict, single-use
                                   │   nonce, freshness, monotonic issued_at, scope ⊆ granted
                                   ▼
                            [device-identity binding]  channel peer ≡ assertion.device_id
                                   ▼
                            [danger]  destructive ⇒ desktop human confirm (phone cannot bypass)
                                   ▼
                            request_command → route()   (command / dom / status)
```

- **Channel authentication ≠ action authorization.** A perfectly valid Noise channel still
  authorizes nothing — every frame carries its own signed, scoped, single-use assertion.
- Two key types per device, pinned at pairing: an **X25519 static** key (Noise channel) and an
  **Ed25519 identity** key (assertions). The transport address (iroh node-id) is neither — a
  correct node-id with unpinned device keys still fails the Noise handshake.

---

## 3. Threat → defense → test

Every row: the attack, the defense, and the test name proving it (run with
`cargo test -p soksak-dev --lib remote::<module>`). RED was demonstrated by removing the defense.

### Pairing / authorization (`remote::auth`)
| Attack | Defense | Test |
|--------|---------|------|
| Unpaired device sends a command | fail-closed; rechecked every call | `a_forged_assertion_wrong_key_denied`, unknown-device denied |
| Forged assertion (wrong/other key) | `verify_strict` against the pinned key | `a_forged_assertion_wrong_key_denied`, `a_tampered_payload_denied` |
| Weak / small-order key | `from_bytes` Result + `is_weak()` guard | `c_weak_small_order_key_rejected_at_pairing` |
| Replay (reused nonce / whole assertion) | single-use nonce ledger | `replay_reused_nonce_denied`, `replay_whole_prior_assertion_denied` |
| Clock rollback (older `issued_at`) | non-decreasing monotonic watermark | `clock_rollback_older_issued_at_denied` |
| Expired assertion | `now < exp` freshness | `expiry_expired_assertion_denied` |
| Stolen phone / refund after revoke | device `revoke`, rechecked every call | `f_revoked_device_denied_even_with_valid_sig_and_fresh_nonce`, `f_revoke_rechecked_every_call_not_just_connect` |
| `max_devices` overrun | binding cap | `max_devices_n_plus_one_rejected` |
| TOFU key swap | re-pair same id, different key refused | `tofu_repair_same_id_different_key_rejected` |
| Scope escalation (read-only → destructive) | `scope ⊆ granted`, enforced per call | `c_readonly_requesting_destructive_denied`, `c_scope_rechecked_per_call_not_just_entry` |
| Gate NOP-patch (bypass one check) | **woven gate** — `NonceProof` (private ctor) moved by value into `Grant::seal`; deleting the nonce step fails to compile (E0308) | `g_nonce_consume_is_the_only_proof_source`, `g_every_failure_fails_closed_no_silent_grant` |

### Channel / confidentiality (`remote::noise`)
| Attack | Defense | Test |
|--------|---------|------|
| Unknown/unpinned static key | KK handshake never constructs a channel | `unpinned_remote_initiate_refused_no_channel`, `wrong_static_key_handshake_fails_no_channel` |
| Revoked peer | `resolve_pinned` PeerRevoked | `revoked_peer_handshake_refused_no_channel` |
| Tamper (byte flip / forged tag / truncation / injection) | AEAD auth → decrypt Err, never garbage | `tampered_ciphertext_byte_flip`, `tampered_auth_tag`, `truncated_ciphertext`, `injected_random_ciphertext` |
| Replay / out-of-order message | Noise nonce sequencing | `replay_captured_message`, `out_of_order_message_rejected_by_sequencing` |
| Downgrade to plaintext / weaker pattern | one fixed pattern; no plaintext channel ctor | `no_downgrade_only_kk_pattern_pinned`, `no_plaintext_path_channel_only_from_finished_handshake` |
| Relay reads payload | E2E — ciphertext contains no plaintext | `relay_sees_no_plaintext_zero_knowledge` |
| Future static-key leak decrypts past traffic | PFS — session keys from ephemeral `ee`, zeroized | `pfs_a_*`, `pfs_b_*`, `pfs_c_static_key_alone_cannot_decrypt_session`, `pfs_static_private_zeroized_on_drop` |

### Composed session + transport (`remote::session`, `remote::transport`, `remote::tcp`, `remote::iroh`)
| Attack | Defense | Test |
|--------|---------|------|
| Valid channel ⇒ assumed authorized | second gate independent — frame still needs a valid assertion | `gate2_valid_channel_forged_assertion_denied`, `defense_in_depth_channel_bypassed_still_needs_authz` |
| Cross-device assertion smuggling | channel peer ≡ assertion.device_id | `device_binding_cross_device_assertion_rejected_dispatch_not_called` |
| Dispatch without a Grant | `dispatch` requires `AuthorizedAction` (only from a `Grant`) | `woven_dispatch_unreachable_without_grant` |
| Arbitrary host:port pivot (SSRF) | dispatch routes only registry commands; never raw host:port | `dispatch_routes_only_registry_commands_no_raw_host_port_forward` |
| External exposure / DNS rebinding | bind 127.0.0.1 only (never 0.0.0.0) | `listener_binds_loopback_only_never_wildcard`, `bind_is_loopback_only_not_wildcard` |
| Oversized / malformed frame | length cap (65535) → graceful close, no panic | `oversized_length_prefix_rejected_gracefully_no_panic` |
| Transport-layer trust (iroh node-id ≠ auth) | node-id is address only; Noise+auth still required | `correct_node_id_with_wrong_device_key_fails_zero_dispatch` |
| Pre-handshake data | no dispatch before the handshake completes | `pre_handshake_bytes_never_dispatched` |
| One connection affecting another | per-connection isolation; mid-session revoke | `two_concurrent_clients_isolated_one_revoked_other_unaffected` |

### Destructive desktop-confirm authority (`remote::confirm`)
| Attack | Defense | Test |
|--------|---------|------|
| Phone runs a destructive command directly | parks pending a desktop human decision; never auto-dispatched | `anti_escalation_destructive_always_parks_no_auto_grant_flag` |
| Phone forges its own confirm | the `DesktopConfirmToken` is built by the adapter from the parked Grant's `(device, bound_nonce)`; private ctor; phone has no resolve path | `phone_cannot_self_approve_no_frame_resolves_own_confirm` |
| Confirm denied / timed out still runs | deny / TTL auto-deny ⇒ no dispatch | `confirm_deny_no_dispatch_client_gets_denied`, `confirm_timeout_auto_denies_no_dispatch` |
| Polling for the decision | event-driven `oneshot` + `select!`, woken on resolve | `event_first_resolve_wakes_promptly_not_poll` |
| Token reuse across requests | token bound to exact `(device, nonce)` | `confirm_token_bound_to_exact_device_nonce_not_reusable` |

### Client (initiator) (`remote::client`)
| Property | Test |
|----------|------|
| Wrong desktop key ⇒ no session (fail-closed, mirror) | `wrong_desktop_key_handshake_fails_no_session` |
| Read-only phone destructive call ⇒ denied | `readonly_phone_destructive_call_denied_scope_no_dispatch` |
| Destructive confirm approve/deny/timeout, event-driven | `destructive_confirm_approve_client_gets_result_event_driven` (+ deny/timeout) |
| Fresh nonce + monotonic issued_at per call (never self-trips replay) | `sequential_calls_fresh_nonce_monotonic_issued_at_all_succeed` |

---

## 4. Pairing & enablement

Pairing pins, per `device_id`, the phone's **two public keys** (X25519 + Ed25519); the phone pins
the desktop's static key (and iroh node-id as the dial address). The exchange medium is a QR
bundle (the desktop shows it; the phone scans) — TOFU. The bundle shape (from `sok-phone pair`):

```json
{ "device_id": "phone-max", "ed25519_public": "…", "x25519_public": "…" }
```

The bridge is **off by default**. Enable explicitly (loopback TCP and/or iroh):

- `SOKSAK_REMOTE_TCP=1` — loopback (127.0.0.1) listener. LAN/same-host.
- `SOKSAK_REMOTE_IROH=1` — iroh QUIC endpoint (P2P + relay) for cross-network/CGNAT.

When neither is set, nothing binds.

---

## 5. Transport tiers

`serve_connection(stream)` is transport-agnostic — our Noise E2E rides **on top of** whatever
carries the bytes, so a relay only ever moves opaque ciphertext.

1. **iroh** (Rust-first): QUIC P2P with hole-punching + relay fallback for CGNAT, LAN fast-path
   via local discovery. Pinned `iroh = "=0.91.2"` (0.95.x pulls an `ed25519-dalek 3.0.0-pre.1`
   prerelease that fails to build; 0.91.2 resolves stable `ed25519-dalek 2.2.0`, unified with
   `remote::auth`). `iroh.rs` feeds each accepted bi-stream into `serve_connection` unchanged.
2. **loopback TCP** (`tcp.rs`): same-host / LAN, the simplest tier.
3. Go yamux relay and a cloudflared plugin are documented fallbacks in the plan (not built).

---

## 6. Frontier (needs the user's environment — not built)

The protocol core is complete and verified in-process. The remaining pieces require real
infrastructure or the live app, and are intentionally left for that context (no faked verification):

- **Live-app E2E** — enabling the bridge in the running app and proving a paired client drives the
  real `route()` (`state.commands` / `ui.tree`). Needs the app rebuilt+running on this branch.
- **Desktop confirm modal (TS)** — thin presentation calling `remote_confirm_resolve`; the Rust
  authority is done, the webview UI is not.
- **P3 mobile app** — a Tauri mobile client embedding `remote::client` + a mirror UI; needs mobile
  tooling and store signing.
- **P4 Cloudflare Worker convergence** — fold pairing/revocation into the license infrastructure
  (`docs/license-system-design.md`: Ed25519 challenge-response, `machine_id`, `max_devices`,
  `deactivate`). Needs the user's Cloudflare/Paddle setup.
- **Real cross-network verification** — actual NAT hole-punching, relay failover, mDNS discovery,
  and the spoken-command E2E ("close the left pane, make the terminal big") need two real devices
  on separate networks.
