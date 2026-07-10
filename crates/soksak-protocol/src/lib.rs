//! Socket protocol contract — the single source for the version constants and the
//! compatibility verdict shared by the app (server) and its clients (sok, MCP,
//! remote forwarders). This crate holds no transport code: constants and pure
//! functions only. Consumers depend on this crate — never copy a constant out.

/// Version of the socket JSON-RPC contract (one-line-JSON framing, request/response
/// envelope, negotiation).
///
/// Bump rules — the common cases never bump:
/// - Do NOT bump for additive optional request or response fields: peers that do not
///   know a field ignore it.
/// - Do NOT bump for new methods: an unknown method already returns a typed error.
/// - Do NOT bump for message/hint wording changes: prose is not contract.
/// - Bump when an existing field changes type, meaning, or becomes required.
/// - Bump when the one-line-JSON framing or the `{ok, code, message, data}` envelope
///   shape changes.
/// - Bump when an existing method changes semantics such that an old peer would
///   misread the reply.
pub const SOCKET_PROTOCOL_VERSION: u32 = 1;

/// Oldest client protocol the app still serves. 0 = every legacy client: pre-hello
/// clients declare nothing and are judged as protocol 0 (see [`effective_protocol`]).
/// Never raise this floor as a side effect of a feature change — dropping released
/// clients takes an explicit relegislation commit of its own.
pub const MIN_COMPATIBLE_CLIENT_PROTOCOL: u32 = 0;

/// Oldest server protocol a client still accepts. Same raising rule as
/// [`MIN_COMPATIBLE_CLIENT_PROTOCOL`]: never raise it silently.
pub const MIN_COMPATIBLE_SERVER_PROTOCOL: u32 = 0;

/// Verdict of [`evaluate_compat`]. The direction is explicit — exactly one side is
/// stale, and the caller never has to re-derive which one from the numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compat {
    /// The peer is inside our compatibility window.
    Compatible,
    /// The peer speaks a protocol older than our floor — the peer must update.
    PeerTooOld { peer: u32, floor: u32 },
    /// The peer speaks a protocol newer than ours — our side must update.
    SelfTooOld { own: u32, peer: u32 },
}

/// Absent = 0 rule: a request without a `protocol` field is a legacy peer and is
/// judged as protocol 0. One rule carries both halves of the contract: legacy peers
/// stay inside the window for as long as the floor is 0, and raising the floor later
/// shuts them out without any new mechanism.
pub fn effective_protocol(declared: Option<u32>) -> u32 {
    declared.unwrap_or(0)
}

/// Pure compatibility verdict, judged from our side of the wire.
/// `own` = our [`SOCKET_PROTOCOL_VERSION`], `floor` = the oldest peer protocol we
/// still serve (one of the `MIN_COMPATIBLE_*` constants), `peer` = what the peer
/// declared, normalized by [`effective_protocol`].
pub fn evaluate_compat(own: u32, floor: u32, peer: u32) -> Compat {
    // RED skeleton — encodes today's behavior: every peer is accepted, no window.
    let _ = (own, floor, peer);
    Compat::Compatible
}

/// One sentence naming the stale side, both version numbers, and (optionally) the
/// concrete remedy. `self_name`/`peer_name` are the endpoint names as the reader
/// should see them (the app judging a client: self = "this app", peer = "this
/// client"). Returns None when compatible — no skew sentence exists for a healthy
/// pair.
pub fn skew_sentence(
    compat: Compat,
    self_name: &str,
    peer_name: &str,
    remedy: Option<&str>,
) -> Option<String> {
    // RED skeleton — encodes today's behavior: no skew message is ever produced.
    let _ = (compat, self_name, peer_name, remedy);
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── evaluate_compat: the four quadrants ─────────────────────────────────

    #[test]
    fn equal_versions_are_compatible() {
        assert_eq!(evaluate_compat(1, 0, 1), Compat::Compatible);
    }

    #[test]
    fn peer_inside_window_is_compatible() {
        // Legacy peer sitting exactly on the floor stays inside the window.
        assert_eq!(evaluate_compat(1, 0, 0), Compat::Compatible);
        assert_eq!(evaluate_compat(3, 1, 2), Compat::Compatible);
    }

    #[test]
    fn peer_below_floor_is_judged_peer_too_old() {
        assert_eq!(
            evaluate_compat(3, 2, 1),
            Compat::PeerTooOld { peer: 1, floor: 2 }
        );
    }

    #[test]
    fn peer_above_own_is_judged_self_too_old() {
        assert_eq!(
            evaluate_compat(1, 0, 2),
            Compat::SelfTooOld { own: 1, peer: 2 }
        );
    }

    // ── effective_protocol: absent = 0 rule ─────────────────────────────────

    #[test]
    fn absent_protocol_is_zero() {
        assert_eq!(effective_protocol(None), 0);
        assert_eq!(effective_protocol(Some(7)), 7);
    }

    // ── skew_sentence: direction, both numbers, remedy ──────────────────────

    #[test]
    fn compatible_pair_has_no_skew_sentence() {
        assert_eq!(skew_sentence(Compat::Compatible, "this app", "this client", None), None);
    }

    #[test]
    fn peer_too_old_sentence_names_peer_and_both_numbers() {
        let s = skew_sentence(
            Compat::PeerTooOld { peer: 1, floor: 2 },
            "this app",
            "this client",
            Some("rerun `sok mcp install`"),
        )
        .expect("a skewed pair must produce a sentence");
        assert!(s.contains("this client") && s.contains("this app"), "both endpoints named: {s}");
        assert!(s.contains('1') && s.contains('2'), "both version numbers present: {s}");
        assert!(s.contains("update this client"), "stale side named explicitly: {s}");
        assert!(s.contains("rerun `sok mcp install`"), "remedy included: {s}");
    }

    #[test]
    fn self_too_old_sentence_names_self_and_both_numbers() {
        let s = skew_sentence(
            Compat::SelfTooOld { own: 1, peer: 3 },
            "this app",
            "this client",
            None,
        )
        .expect("a skewed pair must produce a sentence");
        assert!(s.contains('1') && s.contains('3'), "both version numbers present: {s}");
        assert!(s.contains("update this app"), "stale side named explicitly: {s}");
    }
}
