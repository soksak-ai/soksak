// Cross-language GOLDEN VECTOR test — the contract that proves a Worker-format-signed
// capability assertion verifies byte-for-byte on the SHIPPED Rust verifier.
//
// This is ADDITIVE: it touches NO auth.rs logic. It reads the SAME fixed vector the
// Worker test reads (worker/test/capability-golden.json, mirrored here as
// capability-golden.json) and asserts three things:
//   1. CapabilityAssertion::canonical_bytes (the source of truth) == the golden hex.
//   2. VerifyingKey::from_bytes(golden_pubkey).verify_strict(golden_bytes, golden_sig)
//      == Ok — i.e. the signature the Worker produced over canonicalCapabilityBytes
//      verifies on the Rust side. This is the convergence proof.
//   3. A one-byte-tampered signature (and a one-byte-tampered message) FAIL
//      verify_strict — the tamper-negative.
//
// The Ed25519 seed in the vector is a fixed, known, TEST-ONLY value (NOT production).

use super::*;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;

// The golden vector, embedded at compile time (test-only; never shipped at runtime).
const GOLDEN_JSON: &str = include_str!("capability-golden.json");

#[derive(Deserialize)]
struct GoldenAssertion {
    device_id: String,
    scope: String,
    nonce_hex: String,
    issued_at: u64,
    exp: u64,
}

#[derive(Deserialize)]
struct Golden {
    public_key_hex: String,
    assertion: GoldenAssertion,
    canonical_bytes_hex: String,
    signature_hex: String,
}

fn load_golden() -> Golden {
    serde_json::from_str(GOLDEN_JSON).expect("golden vector parses")
}

// Minimal hex decode (no `hex` crate dependency). Panics on malformed input — fine
// for a fixed, checked-in test fixture.
fn from_hex(s: &str) -> Vec<u8> {
    assert!(s.len() % 2 == 0, "hex length must be even");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("valid hex byte"))
        .collect()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn scope_from_str(s: &str) -> Scope {
    match s {
        "read-only" => Scope::ReadOnly,
        "write" => Scope::Write,
        "destructive" => Scope::Destructive,
        other => panic!("unknown scope in golden vector: {other}"),
    }
}

fn golden_assertion(g: &Golden) -> CapabilityAssertion {
    let nonce_vec = from_hex(&g.assertion.nonce_hex);
    let nonce: [u8; 32] = nonce_vec.as_slice().try_into().expect("nonce is 32 bytes");
    CapabilityAssertion {
        device_id: g.assertion.device_id.clone(),
        scope: scope_from_str(&g.assertion.scope),
        nonce,
        issued_at: g.assertion.issued_at,
        exp: g.assertion.exp,
    }
}

#[test]
fn golden_canonical_bytes_match_the_shipped_layout() {
    // The Worker's canonicalCapabilityBytes reproduces THESE bytes. Here we prove the
    // SHIPPED Rust canonical_bytes (the source of truth) equals the golden hex — so the
    // two sides agree on the exact signing message, byte-for-byte.
    let g = load_golden();
    let a = golden_assertion(&g);
    assert_eq!(
        to_hex(&a.canonical_bytes()),
        g.canonical_bytes_hex,
        "Rust canonical_bytes must equal the golden canonical bytes"
    );
}

#[test]
fn golden_worker_signature_verifies_strict_on_rust_side() {
    // CONVERGENCE PROOF: a signature produced by the Worker (Ed25519 over
    // canonicalCapabilityBytes, seed key from the vector) verifies with verify_strict
    // against the raw public key the Rust client would embed. This is exactly the
    // floor's path (DeviceRegistry::verify uses pinned_key.verify_strict).
    let g = load_golden();

    let pk_bytes: [u8; 32] = from_hex(&g.public_key_hex)
        .as_slice()
        .try_into()
        .expect("public key is 32 bytes");
    let vk = VerifyingKey::from_bytes(&pk_bytes).expect("golden public key is a valid Ed25519 point");

    let sig_bytes: [u8; 64] = from_hex(&g.signature_hex)
        .as_slice()
        .try_into()
        .expect("signature is 64 bytes");
    let sig = Signature::from_bytes(&sig_bytes);

    // The message is the canonical bytes the Worker signed == Rust canonical_bytes.
    let msg = from_hex(&g.canonical_bytes_hex);
    // Sanity: the locally-reconstructed assertion produces the same message.
    assert_eq!(golden_assertion(&g).canonical_bytes(), msg);

    assert!(
        vk.verify_strict(&msg, &sig).is_ok(),
        "Worker-format-signed assertion must verify_strict on the Rust side"
    );
}

#[test]
fn golden_tampered_signature_fails_verify_strict() {
    // TAMPER-NEGATIVE: flip one byte of the golden signature -> verify_strict Err.
    let g = load_golden();

    let pk_bytes: [u8; 32] = from_hex(&g.public_key_hex).as_slice().try_into().unwrap();
    let vk = VerifyingKey::from_bytes(&pk_bytes).unwrap();

    let mut sig_bytes: [u8; 64] = from_hex(&g.signature_hex).as_slice().try_into().unwrap();
    sig_bytes[0] ^= 0x01; // single-bit tamper.
    let sig = Signature::from_bytes(&sig_bytes);

    let msg = from_hex(&g.canonical_bytes_hex);
    assert!(
        vk.verify_strict(&msg, &sig).is_err(),
        "a one-byte-tampered signature must NOT verify"
    );
}

#[test]
fn golden_tampered_message_fails_verify_strict() {
    // TAMPER-NEGATIVE (message side): flip one byte of the canonical message -> the
    // untouched golden signature no longer verifies. Proves the signature binds the
    // exact bytes (no malleability in the canonical layout).
    let g = load_golden();

    let pk_bytes: [u8; 32] = from_hex(&g.public_key_hex).as_slice().try_into().unwrap();
    let vk = VerifyingKey::from_bytes(&pk_bytes).unwrap();

    let sig_bytes: [u8; 64] = from_hex(&g.signature_hex).as_slice().try_into().unwrap();
    let sig = Signature::from_bytes(&sig_bytes);

    let mut msg = from_hex(&g.canonical_bytes_hex);
    let last = msg.len() - 1;
    msg[last] ^= 0x01; // flip one byte of exp.
    assert!(
        vk.verify_strict(&msg, &sig).is_err(),
        "a one-byte-tampered message must NOT verify against the golden signature"
    );
}

#[test]
fn golden_worker_signed_assertion_grants_through_full_verify_floor() {
    // END-TO-END through the SHIPPED floor: pair the device with the golden public key,
    // then DeviceRegistry::verify the golden assertion + the Worker-produced signature.
    // The floor's verify_strict path accepts it and seals a Grant. This proves the
    // convergence holds not just at the bare verify_strict call but through the whole
    // (pairing + verify_strict + freshness + monotonic + nonce + scope) gate.
    let g = load_golden();
    let a = golden_assertion(&g);
    let sig = from_hex(&g.signature_hex);

    let pk_bytes: [u8; 32] = from_hex(&g.public_key_hex).as_slice().try_into().unwrap();

    let mut reg = DeviceRegistry::new(2);
    reg.pair(&a.device_id, &pk_bytes, Scope::ReadOnly)
        .expect("pair with the golden public key");

    // now < exp so the assertion is fresh.
    let decision = reg.verify(&a, &sig, VerifyCtx { now: a.issued_at });
    let grant = decision
        .granted()
        .expect("Worker-format-signed assertion must Grant through the full floor");
    assert_eq!(grant.scope(), Scope::ReadOnly);
    assert_eq!(grant.consumed_nonce(), a.nonce);
}
