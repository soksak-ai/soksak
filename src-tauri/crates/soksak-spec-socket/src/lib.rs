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
    if peer < floor {
        return Compat::PeerTooOld { peer, floor };
    }
    if peer > own {
        return Compat::SelfTooOld { own, peer };
    }
    Compat::Compatible
}

/// One sentence naming the stale side, both version numbers, and (optionally) the
/// concrete remedy — this is a human surface, so it renders in `lang`. The grammar
/// (both languages) lives here, in one place. `self_name`/`peer_name`/`remedy` are
/// contextual nouns the caller supplies already resolved to `lang` (the app judging
/// a client: self = "the app"/"앱", peer = "the client"/"클라이언트"), because the
/// remedy is a caller concern — the protocol crate holds no transport instructions.
/// Returns None when compatible — no skew sentence exists for a healthy pair.
pub fn skew_sentence(
    compat: Compat,
    self_name: &str,
    peer_name: &str,
    remedy: Option<&str>,
    lang: Lang,
) -> Option<String> {
    let (core, stale) = match (lang, compat) {
        (_, Compat::Compatible) => return None,
        (Lang::En, Compat::PeerTooOld { peer, floor }) => (
            format!("{peer_name} speaks socket protocol {peer} but {self_name} accepts {floor} at the oldest"),
            format!("update {peer_name}"),
        ),
        (Lang::En, Compat::SelfTooOld { own, peer }) => (
            format!("{peer_name} speaks socket protocol {peer} but {self_name} speaks up to {own}"),
            format!("update {self_name}"),
        ),
        (Lang::Ko, Compat::PeerTooOld { peer, floor }) => (
            format!("{peer_name} 이(가) 소켓 프로토콜 {peer} 을(를) 쓰지만 {self_name} 은(는) 최소 {floor} 까지만 받습니다"),
            format!("{peer_name} 을(를) 업데이트하세요"),
        ),
        (Lang::Ko, Compat::SelfTooOld { own, peer }) => (
            format!("{peer_name} 이(가) 소켓 프로토콜 {peer} 을(를) 쓰지만 {self_name} 은(는) 최대 {own} 까지 씁니다"),
            format!("{self_name} 을(를) 업데이트하세요"),
        ),
    };
    // 조립(구분기호·괄호·마침표)은 언어 중립 — 두 언어가 같은 골격을 쓴다.
    Some(match remedy {
        Some(r) => format!("{core} — {stale} ({r})."),
        None => format!("{core} — {stale}."),
    })
}

/// The person's language for a human-facing sentence. The protocol crate holds
/// this so the skew sentence can render in one language without a second source.
/// LLM-facing text, logs, and identifiers stay English and never take a `Lang`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Ko,
}

impl Lang {
    /// One place interprets a language tag. The Korean family (`ko`, `ko_KR.UTF-8`,
    /// `KO`) resolves to Korean; every other or absent tag resolves to English.
    /// The primary subtag alone decides — the tag is cut at the first BCP-47/POSIX
    /// separator (`-`, `_`, `.`) and the leading segment is matched whole, so a tag
    /// that merely starts with the letters `ko` (Konkani `kok`, Kosraean `kos`) is
    /// not Korean. The caller owns the absent-tag default: a POSIX env with no `LANG`
    /// yields `""` → English (the CLI default), while the app resolves an absent
    /// setting to Korean on its own before reaching here.
    pub fn from_tag(tag: &str) -> Lang {
        let normalized = tag.trim().to_ascii_lowercase();
        let primary = normalized
            .split(['-', '_', '.'])
            .next()
            .unwrap_or("");
        if primary == "ko" {
            Lang::Ko
        } else {
            Lang::En
        }
    }
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

    // ── compatibility floors sit at or below our own protocol ────────────────

    // A floor above our own protocol is unactionable: evaluate_compat would hand a
    // peer that already speaks our exact version a `PeerTooOld` verdict pointing at a
    // build older than the one it runs — an instruction it cannot follow. This guards
    // a relegislation typo that raises a MIN_COMPATIBLE_* past SOCKET_PROTOCOL_VERSION.
    #[test]
    fn compatibility_floor_never_exceeds_own_protocol() {
        assert!(
            MIN_COMPATIBLE_CLIENT_PROTOCOL <= SOCKET_PROTOCOL_VERSION,
            "client floor {MIN_COMPATIBLE_CLIENT_PROTOCOL} exceeds own protocol {SOCKET_PROTOCOL_VERSION}",
        );
        assert!(
            MIN_COMPATIBLE_SERVER_PROTOCOL <= SOCKET_PROTOCOL_VERSION,
            "server floor {MIN_COMPATIBLE_SERVER_PROTOCOL} exceeds own protocol {SOCKET_PROTOCOL_VERSION}",
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
        assert_eq!(
            skew_sentence(Compat::Compatible, "this app", "this client", None, Lang::En),
            None
        );
        // 언어와 무관하게 건강한 쌍엔 스큐 문장이 없다.
        assert_eq!(
            skew_sentence(Compat::Compatible, "this app", "this client", None, Lang::Ko),
            None
        );
    }

    #[test]
    fn peer_too_old_sentence_names_peer_and_both_numbers() {
        let s = skew_sentence(
            Compat::PeerTooOld { peer: 1, floor: 2 },
            "this app",
            "this client",
            Some("rerun `sok mcp install`"),
            Lang::En,
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
            Lang::En,
        )
        .expect("a skewed pair must produce a sentence");
        assert!(s.contains('1') && s.contains('3'), "both version numbers present: {s}");
        assert!(s.contains("update this app"), "stale side named explicitly: {s}");
    }

    // 사람 표면: 같은 판정을 ko 로 렌더하면 한국어 골격이 나오고 영어 골격은 새지 않는다.
    // 판 숫자와 caller 명사는 언어 독립 — 문장 골격만 해소된다.
    #[test]
    fn skew_sentence_renders_korean_grammar() {
        let s = skew_sentence(
            Compat::SelfTooOld { own: 1, peer: 3 },
            "앱",
            "클라이언트",
            Some("이 클라이언트가 함께 배포된 앱 빌드를 설치하세요"),
            Lang::Ko,
        )
        .expect("a skewed pair must produce a sentence");
        assert!(s.contains("소켓 프로토콜"), "한국어 골격: {s}");
        assert!(s.contains("업데이트하세요"), "낡은 쪽을 한국어로 명시: {s}");
        assert!(!s.contains("speaks socket protocol"), "영어 골격이 새면 안 된다: {s}");
        assert!(s.contains('1') && s.contains('3'), "판 숫자는 언어 독립: {s}");
        assert!(s.contains("앱") && s.contains("클라이언트"), "caller 명사 유지: {s}");
    }

    // ── Lang::from_tag: one place interprets a language tag ──────────────────

    #[test]
    fn from_tag_maps_korean_family_to_ko_else_en() {
        // Settings values are the bare tags the frontend persists.
        assert_eq!(Lang::from_tag("ko"), Lang::Ko);
        assert_eq!(Lang::from_tag("en"), Lang::En);
        // POSIX locale envs (LANG/LC_ALL) carry a territory and encoding.
        assert_eq!(Lang::from_tag("ko_KR.UTF-8"), Lang::Ko);
        assert_eq!(Lang::from_tag("en_US.UTF-8"), Lang::En);
        // Case-insensitive on the language subtag.
        assert_eq!(Lang::from_tag("KO"), Lang::Ko);
        // Absent or foreign tags fall to English — the CLI default when no LANG is set.
        assert_eq!(Lang::from_tag(""), Lang::En);
        assert_eq!(Lang::from_tag("ja_JP.UTF-8"), Lang::En);
    }

    // Only the primary subtag decides — a tag that merely begins with the letters `ko`
    // (Konkani `kok`, Kosraean `kos`) is a different language and resolves to English.
    // A prefix match would hand every `ko*` language the Korean rendering.
    #[test]
    fn from_tag_matches_primary_subtag_not_prefix() {
        assert_eq!(Lang::from_tag("kok"), Lang::En);
        assert_eq!(Lang::from_tag("kok_IN.UTF-8"), Lang::En);
        assert_eq!(Lang::from_tag("kok-Latn"), Lang::En);
        assert_eq!(Lang::from_tag("kos"), Lang::En);
        // The genuine Korean family still resolves, boundary by boundary.
        assert_eq!(Lang::from_tag("ko"), Lang::Ko);
        assert_eq!(Lang::from_tag("ko-KR"), Lang::Ko);
        assert_eq!(Lang::from_tag("ko_KR.UTF-8"), Lang::Ko);
    }
}
