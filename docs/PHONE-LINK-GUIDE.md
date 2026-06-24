# Phone-Link — implementation guide & status

Manual companion to `docs/PHONE-LINK.md` (the security contract / threat→test
matrix). This document is the "what we need to know" reference: requirements,
what was built, how it works, how to run and verify it, and what remains.

- Branch landed on `main` via merge commit (`Merge feat/phone-link: remote-control security and transport stack`).
- Status: security + transport + protocol core **complete and live-validated**. Mobile app, the Cloudflare Worker convergence, and real two-network device testing are NOT done (they need external environment — see §6).
- All code is additive under `src-tauri/src/remote/` + a frontend modal under `src/`. **Off by default** — the running app is unaffected unless explicitly enabled.

---

## 1. Requirements (why this exists)

**Use case.** Drive a desktop that has no public IP and sits behind CGNAT (inbound
blocked) from a phone, over the internet: control the desktop's `command` / `dom`
/ `status` surface (the same surface `docs/AI-CONTROL.md` exposes locally), and
tunnel local dev servers (`localhost:PORT`) to the phone.

**Security mandate (RULE 0 — non-negotiable).** The moment a connection is
unauthenticated, an assertion is unverified, or a relay can read the payload,
everything is lost. Therefore:
- **Authenticate before connect, fail-closed.** An unpaired / unknown device key
  produces no channel at all (refusal is non-establishment, not a soft deny).
- **Capture-resistant E2E.** Ephemeral key exchange per session (X25519 ECDHE) +
  AEAD (ChaCha20-Poly1305) with forward secrecy — a later static-key leak cannot
  decrypt past traffic. Any relay sees only opaque ciphertext.
- **No bypass.** No unauthenticated fallback, no debug backdoor, no local-trust
  exception. Defense in depth: breaking one layer must not collapse the whole.

**Constraints.**
- Off by default; transport-agnostic (the security is in the bridge, the transport
  is swappable).
- The desktop holds the confirm authority for destructive actions; the phone can
  never self-escalate (pairing, the tunnel port allowlist, and the danger gate are
  all desktop-owned).
- The core stays generic — a "mutually-authenticated encrypted remote device"
  capability, not phone-specific.

---

## 2. What was built (work content)

15 commits on `feat/phone-link`, each RED→GREEN and independently verified:

| # | commit | delivers |
|---|--------|----------|
| 1 | `faefdda` | Ed25519 device auth/authz floor — pairing (TOFU pin, max_devices, revoke), capability-assertion verify (verify_strict, single-use nonce, freshness, monotonic issued_at, scope ⊆ granted), fail-closed; the gate is woven into the type system (a NOP-patch of the nonce step fails to compile). |
| 2 | `f40da4c` | Noise KK E2E floor (`snow`, Noise_KK_25519_ChaChaPoly_BLAKE2s) — mutual static-key auth, PFS, AEAD; no plaintext/downgrade path. |
| 3 | `8ae1389` | `SecureSession` — composes the two floors: 2-gate defense-in-depth + device-identity binding (channel peer ≡ assertion device). |
| 4 | `b3f74c6` | transport-agnostic `serve_connection(stream)` + length framing + loopback-only (127.0.0.1) TCP listener. |
| 5 | `98477b8` | destructive desktop-confirm authority — parks pending a desktop human decision (event-driven `oneshot`, no polling), TTL auto-deny, token built by the adapter (phone cannot forge it). |
| 6 | `ba100e9` | iroh QUIC P2P + relay transport tier (reuses `serve_connection`; node-id is address, not auth). |
| 7 | `7ba5770` | reusable initiator client `remote::client` + the `sok-phone` CLI. |
| 8 | `d237d63` | `docs/PHONE-LINK.md` security contract. |
| 9 | `8352aeb` | dev-server reverse-proxy tunnel (loopback-only + desktop port allowlist = SSRF 0). |
| 10 | `76bb854` | adversarial proptest hardening of every wire parser (35 properties; no robustness bug found). |
| 11 | `51ab211` | desktop confirm modal (frontend, `RemoteConfirmModal`) + serial queue. |
| 12 | `492308e` | headless desktop-owned pairing config + the first live-app E2E (found & fixed 2 real bugs). |
| 13 | `89f945c` | multi-frame response chunking (large responses round-trip). |
| 14 | `448ee5c` | adversarial cross-cutting audit coverage (chunking × confirm/tunnel, state machine). |
| 15 | `2c67854` | key-file 0600-at-creation hardening (closes a write→chmod window). |

---

## 3. Architecture & feature definitions

### Two-layer model (defense in depth)
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
                            request_command → route()   (command / dom / status)   |   tunnel → 127.0.0.1:allowlisted-port
```
A valid channel authorizes nothing on its own — every frame carries its own
signed, scoped, single-use assertion.

### Module map (`src-tauri/src/remote/`)
| module | role |
|--------|------|
| `auth.rs` | Ed25519 pairing + capability-assertion verify (authorization) |
| `noise.rs` | Noise_KK channel (authentication + confidentiality + PFS) |
| `session.rs` | `SecureSession` (compose the gates) + the chunking codec |
| `transport.rs` | transport-agnostic `serve_connection` / `serve_tunnel` + framing |
| `tcp.rs` | loopback-only TCP listener |
| `confirm.rs` | destructive desktop-confirm authority (pending registry + resolve) |
| `iroh.rs` | iroh QUIC P2P + relay tier |
| `client.rs` | reusable initiator (the half a phone embeds) + `sok-phone` |
| `tunnel.rs` | dev-server reverse-proxy (allowlist + loopback-only) |
| `pairing.rs` | headless desktop-owned pairing config + persisted desktop key |
| `bridge.rs` | off-by-default app glue (enable flags, `request_command` dispatch, Tauri confirm cmds) |

Frontend: `src/components/RemoteConfirmModal.tsx` + `src/state/remoteConfirm*.ts`.

### Features
- **Remote command/dom/status** — a paired device calls any registry command, dom op, or status query; results return over the encrypted channel.
- **Dev-server tunnel** — reverse-proxy a desktop `localhost:PORT` (allowlisted) to the phone.
- **Two transports** — loopback TCP (same-host/LAN) and iroh QUIC (P2P + relay, CGNAT).
- **Desktop confirm authority** — destructive actions require a desktop human decision; the phone cannot bypass or disable it.
- **Pairing** — desktop-owned config pins device keys; the phone cannot self-pair.
- **Chunking** — responses larger than one Noise frame (65535) are chunked and reassembled, bounded at 8 MB.

---

## 4. How it works (usage)

### Enablement (all off by default; desktop-owned)
| env | effect |
|-----|--------|
| `SOKSAK_REMOTE_TCP=1` | bind the loopback (127.0.0.1) TCP listener |
| `SOKSAK_REMOTE_TCP_PORT=<n>` | TCP port (0 = OS-assigned) |
| `SOKSAK_REMOTE_IROH=1` | start the iroh endpoint (P2P + relay) |
| `SOKSAK_REMOTE_TUNNEL=1` | enable the dev-server tunnel listener |
| `SOKSAK_REMOTE_TUNNEL_PORTS="3000,5173"` | desktop-owned tunnel port allowlist (empty ⇒ all tunnels refused) |
| `SOKSAK_REMOTE_DESKTOP_KEY_PATH=<file>` | where the stable desktop static key is persisted (default: app config dir) |
| `SOKSAK_REMOTE_PAIRED_DEVICES_JSON=<json>` / `SOKSAK_REMOTE_PAIRED_DEVICES=<file>` | the paired-device registry: `[{device_id, x25519_pub, ed25519_pub, granted_scope}]` |

When no enable flag is set, nothing binds.

### Pairing flow (headless, the QR equivalent)
1. The desktop persists a **stable static key** (so the phone can pin it across restarts) and exposes its public key (logged at bridge start).
2. The phone generates its identity — `sok-phone pair` prints `{device_id, ed25519_public, x25519_public}`.
3. The desktop operator adds that bundle (+ a `granted_scope`, default read-only) to the paired-devices config. **Pins come only from this desktop-owned config — the phone cannot add itself (anti-escalation).**

### Request flow
phone `connect` (Noise KK initiator, pinning the desktop static key — wrong key ⇒ no session) → per call: build + Ed25519-sign a `{device_id, scope, fresh nonce, issued_at, exp}` assertion → frame `{assertion, signature, request}` → encrypt → send → desktop verifies (both gates) → `request_command → route()` → response chunked back → client reassembles & decrypts.

### Confirm flow (destructive)
A destructive grant is **parked**; the desktop emits `remote-confirm-request`; the `RemoteConfirmModal` shows device + command + danger; the human approves/denies (or TTL auto-denies); on approve the adapter builds the `DesktopConfirmToken` itself and dispatches; on deny/timeout nothing runs.

### Tunnel flow
A tunnel is a session whose post-auth mode proxies raw bytes to `127.0.0.1:<allowlisted port>`. A non-allowlisted port is refused before any `connect` (SSRF 0).

### CLI
`sok-phone pair` (print this device's bundle) · `sok-phone call <addr> <desktop-id> <desktop-static-hex> <command> '<json>'` · `sok-phone tunnel <addr> <desktop-id> <desktop-static-hex> <port>`.

---

## 5. Verification (what was tested)

- **Tests**: 263 Rust tests across the remote modules + 560 frontend tests (incl. the modal). Every floor was RED→GREEN; each defense was independently verified by NOP-patching it (attack passes = RED) and restoring (blocked = GREEN).
- **Adversarial fuzz** (`76bb854`): 35 proptest properties over every wire parser (length framing, frame codec, assertion/signature parse, Noise decrypt, tunnel first-frame, client recv, out-of-order state) — panic-free, bounded, graceful Err; **no robustness bug found**.
- **Adversarial audit** (`448ee5c`): a skeptical full-stack review against 9 cross-cutting hypotheses (chunking×confirm, chunking×tunnel, state-machine holes, fail-closed completeness, TOCTOU/scope, info leak, nonce/replay, amplification/DoS, pairing config) — **no security hole found**; each disproved with a cited guard or a new test.
- **Live E2E** (`492308e`, `89f945c`) against the real running app and `route()`:
  - `state.commands` → the real 244,880-byte / 371-command catalog round-trips chunked, byte-perfect (previously capped).
  - `ui.tree` → real 155-node dom tree (single-frame fast path).
  - An unpaired identity → handshake fails, 0 access (fail-closed, reproduced by hand).
  - A destructive command → the real desktop confirm modal appears (device `phone-e2e-dx`) → approve dispatches, deny does not.
- **2 real bugs found live and fixed** (RED→GREEN), which the in-process injected-dispatch tests had missed:
  1. Two sessions of the same device reused the same nonce sequence → `NonceReplay` → fixed with a per-session random salt.
  2. A `route()` response larger than one Noise frame produced an empty/undecodable frame → fixed by response chunking (and a hard 8 MB cap with a clean error beyond it).

---

## 6. TODO (frontier — what remains, and why it's not done)

These need an external environment / decision and were deliberately not faked:

- **P3 — mobile app**: a Tauri mobile client embedding `remote::client` + a mirror UI. Needs the mobile toolchain (Xcode / Android SDK) and store signing.
- **P4 — Cloudflare Worker convergence**: fold pairing/revocation into the licensing infrastructure (`docs/license-system-design.md`: Ed25519 challenge-response, `machine_id`, `max_devices`, `deactivate`). The Worker code + local test suite are buildable autonomously; **deployment** needs the user's Cloudflare/Paddle accounts, and **switching the assertion issuer** from device-self-signed to Worker-issued is an integration that re-wires the verified client (a deliberate decision, not yet taken).
- **Live-app E2E with a real pairing UI**: pairing is currently a headless desktop-owned config; a QR/approve UI is the productized form.
- **Real cross-network testing**: actual NAT hole-punching, relay failover, mDNS discovery, and the spoken-command E2E need two real devices on separate networks.
- **Multi-frame REQUEST chunking**: responses are chunked; requests are single-frame (assertions are small, so this is currently sufficient — a pathological huge request would be rejected, not chunked).

Open hardening note (low severity, not a RULE-0 break): `client.rs::fresh_nonce` overwrites 1 of 8 salt bytes with a marker, leaving 56 bits of salt entropy — still collision-resistant; could move to full entropy. (The key-file chmod window was fixed in `2c67854`.)

---

## 7. Notes / gotchas

- **iroh is pinned `=0.91.2`**: 0.95.x pulls `ed25519-dalek 3.0.0-pre.1` (a prerelease) which fails to compile; 0.91.2 resolves stable `ed25519-dalek 2.2.0`, unified with `remote::auth`. iroh adds ~163 transitive crates.
- **Key storage**: the desktop static private key is persisted 0600 (owner-only, from creation) in a phone-unreachable desktop-owned directory. Private keys are redacted in all `Debug`/logs; only the desktop's public key is logged (for pairing display).
- **Off-by-default safety**: with no enable flag, no listener binds and the app behaves exactly as before.
- **The dispatch seam is `ipc.rs::request_command` → `route()`** (unchanged); the network adapter reuses it.
- **Disk**: the iroh dependency tree is large; keep to incremental builds.
- The security contract / threat→test matrix lives in `docs/PHONE-LINK.md`.
