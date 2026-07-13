//! PTY daemon protocol contract — the single source for everything the app and
//! `soksak-ptyd` must agree on: the protocol version, where the sockets, token,
//! and staged binary live under an identity home, the hello grammar, the message
//! set, and the `{ok, code, message, data}` reply envelope. This crate holds no
//! transport code: constants, path derivation, and serde types only. Consumers
//! depend on this crate — never copy a constant or a path rule out.
//!
//! Wire framing is NDJSON: one JSON value per line, both directions, on the
//! control socket. The stream socket speaks one NDJSON hello exchange and then
//! switches to raw PTY output bytes (daemon → client only).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

// hello 판정을 소비하는 쪽(데몬·앱)이 판정 타입과 스큐 문장을 이 크레이트 한 경로로
// 받는다 — soksak-spec-socket 이중 의존 대신 재수출(정본은 그대로 soksak-spec-socket).
pub use soksak_spec_socket::{skew_sentence, Compat, Lang};

/// Version of the ptyd wire contract. Bump rules follow the socket protocol
/// precedent (soksak-spec-socket): additive optional fields and new ops never
/// bump; a change in framing, the envelope, or the meaning of an existing
/// field does. On a breaking bump only the previous generation stays
/// serveable — no multi-generation adapters.
pub const PTYD_PROTOCOL_VERSION: u32 = 1;

/// Oldest client protocol the daemon still serves. The hello is mandatory from
/// the first release, so the floor starts at 1: a hello without a version is
/// judged as protocol 0 (`soksak_spec_socket::effective_protocol`) and rejected.
pub const PTYD_MIN_COMPATIBLE_CLIENT_PROTOCOL: u32 = 1;

/// Flow-control watermarks — the single source for both PTY backends
/// (pty.rs in-process and soksak-ptyd). The reader pauses while an attached
/// client has this many unacked bytes, and resumes at the low mark.
///
/// The high mark is the throughput ceiling: bulk output moves in
/// pause/drain cycles, so sustained rate ≈ window / ack-loop round trip.
/// The daemon leg lengthens that loop (front ack → app → control socket),
/// and the previous 100k window capped t1 at ~3 MB/s against a ~4.5 MB/s
/// in-process measurement under the same load (perf results
/// 20260711-141852 / -142405 vs the ab-local run). 1 MB covers the longer
/// loop; the low mark resumes at half-window so acks still in flight keep
/// the pipe moving. Memory cost stays bounded per pane and the front still
/// acks every 5k parsed bytes.
pub const HIGH_WATERMARK: usize = 1_000_000;
pub const LOW_WATERMARK: usize = 500_000;


// ── Identity-home path contract ──────────────────────────────────────────────
// Every path derives from the identity home (home.rs / SOKSAK_HOME). The
// daemon binary lives OUTSIDE the app bundle: the bundle is the updater's
// atomic swap unit, and a long-lived process inside it would couple session
// lifetime to bundle lifetime. All names are protocol-keyed so a breaking bump
// runs side by side with the previous generation.

/// Staged daemon binary name, protocol-keyed.
pub fn daemon_bin_name() -> String {
    format!("soksak-ptyd-p{PTYD_PROTOCOL_VERSION}")
}

/// Staged daemon binary path: `<home>/bin/soksak-ptyd-p<N>`.
pub fn staged_bin_path(home: &Path) -> PathBuf {
    home.join("bin").join(daemon_bin_name())
}

/// Runtime directory for sockets, token, and log: `<home>/run`.
pub fn run_dir(home: &Path) -> PathBuf {
    home.join("run")
}

/// Control socket (NDJSON request/response): `<home>/run/ptyd-p<N>.sock`.
pub fn control_socket_path(home: &Path) -> PathBuf {
    run_dir(home).join(format!("ptyd-p{PTYD_PROTOCOL_VERSION}.sock"))
}

/// Stream socket (hello line, then raw PTY bytes): `<home>/run/ptyd-p<N>-stream.sock`.
pub fn stream_socket_path(home: &Path) -> PathBuf {
    run_dir(home).join(format!("ptyd-p{PTYD_PROTOCOL_VERSION}-stream.sock"))
}

/// Shared-secret token file (0600): `<home>/run/ptyd-p<N>.token`.
pub fn token_path(home: &Path) -> PathBuf {
    run_dir(home).join(format!("ptyd-p{PTYD_PROTOCOL_VERSION}.token"))
}

/// Daemon log file: `<home>/run/ptyd-p<N>.log`.
pub fn log_path(home: &Path) -> PathBuf {
    run_dir(home).join(format!("ptyd-p{PTYD_PROTOCOL_VERSION}.log"))
}

// ── Sealed byte checkpoints (restore ladder rung 3, docs/RESTORE.md) ─────────
// The daemon seals each session's flattened screen paint to the app-supplied
// X25519 public key (soksak-seal SealedBox) and writes it under the identity
// home. Only the unlocked app can open one; a clean session end deletes it.
// Everything both sides must agree on lives here: the directory, the file
// name derivation, and the AAD context grammar.

/// Checkpoint directory: `<home>/pty/checkpoints`.
pub fn checkpoint_dir(home: &Path) -> PathBuf {
    home.join("pty").join("checkpoints")
}

/// Cached seal recipient key: `<home>/pty/seal.pub` (JSON
/// `{keyId, publicKey}`; the public half only — the secret lives in the
/// vault under `keyId`).
pub fn checkpoint_pubkey_path(home: &Path) -> PathBuf {
    home.join("pty").join("seal.pub")
}

// base64url of one key component — never contains the separators (`.`, `|`),
// so component-wise encoding is bijective over arbitrary inputs.
fn ckpt_component(s: &str) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    URL_SAFE_NO_PAD.encode(s)
}

/// Checkpoint file for a `(window_label, pane_id)` reattach key. Each
/// component is base64url-encoded separately — bijective, so distinct keys
/// can never collide on a lossy sanitization or a separator ambiguity.
pub fn checkpoint_path(home: &Path, window_label: &str, pane_id: &str) -> PathBuf {
    checkpoint_dir(home)
        .join(format!("ckpt-{}.{}.json", ckpt_component(window_label), ckpt_component(pane_id)))
}

/// AAD bound into every seal — rejects relocating a sealed blob to
/// another pane or key. Window and pane ride base64url-encoded (same rule as
/// the file stem) so the `|` separators are unambiguous for any input.
pub fn checkpoint_aad(window_label: &str, pane_id: &str, key_id: &str) -> Vec<u8> {
    format!(
        "soksak-pty-ckpt|{}|{}|{key_id}",
        ckpt_component(window_label),
        ckpt_component(pane_id)
    )
    .into_bytes()
}

// ── Tee subscription framing (subscribe stream) ──────────────────────────────
// A subscribe stream carries length-prefixed frames after the hello exchange —
// the attach stream stays raw (a single consumer needs no framing; a tee
// interleaves data copies with gap markers). Frame = [kind: u8][len: u32 BE]
// [payload]. The daemon frames byte copies and gap markers; it interprets no
// byte. Both sides depend on this crate for the shape.

/// Tee frame kind: a raw output copy.
pub const TEE_FRAME_DATA: u8 = 0;
/// Tee frame kind: a gap marker — bytes dropped under backpressure. Payload is
/// [`TeeGap`] JSON. A slow subscriber loses data loudly, never silently.
pub const TEE_FRAME_GAP: u8 = 1;

/// Gap marker payload: the half-open sequence range `[from_seq, to_seq)` that
/// the daemon dropped for this subscriber under backpressure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeeGap {
    pub from_seq: u64,
    pub to_seq: u64,
}

/// Encode one tee frame (kind byte + big-endian u32 length + payload) onto `out`.
pub fn encode_tee_frame(kind: u8, payload: &[u8], out: &mut Vec<u8>) {
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
}

// ── Hello ────────────────────────────────────────────────────────────────────

/// First message on every connection, both sockets. `session` is present only
/// on the stream socket — it names the session whose output this connection
/// will carry. A hello without `version` is a legacy peer and is judged as
/// protocol 0 (see [`judge_client`]), which the floor of 1 rejects.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub version: Option<u32>,
    pub token: String,
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<u64>,
    /// Attach stream only: replay the raw output ring from this sequence, then
    /// go live — the race-free warm-handoff coordinate. Absent = the mirror
    /// serialization replay (the unchanged warm path). Additive optional field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_seq: Option<u64>,
    /// Marks this stream connection a tee subscriber — a framed raw copy of the
    /// session output, never the single live attach. The daemon never blocks
    /// the live path on it. Absent/false = attach. Additive optional field.
    #[serde(default, skip_serializing_if = "is_false")]
    pub subscribe: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Compatibility verdict for a client hello, judged with the shared socket
/// grammar. One rule carries both halves: absent = 0, floor decides.
pub fn judge_client(declared: Option<u32>) -> soksak_spec_socket::Compat {
    soksak_spec_socket::evaluate_compat(
        PTYD_PROTOCOL_VERSION,
        PTYD_MIN_COMPATIBLE_CLIENT_PROTOCOL,
        soksak_spec_socket::effective_protocol(declared),
    )
}

// ── Requests ─────────────────────────────────────────────────────────────────

/// Control-socket request set. One JSON object per line, tagged by `op`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    /// Attach to the live session owning the pane, or spawn a new shell for
    /// it. The reattach key is `(window_label, pane_id)` — pane ids are only
    /// unique within their window (per-window sequential view ids), so the
    /// window label namespaces them. Both halves are stable across app
    /// restarts (workspace snapshot respawns `w-*` labels and view ids).
    /// Spawn parameters are ignored on attach.
    #[serde(rename_all = "camelCase")]
    CreateOrAttach {
        pane_id: String,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: String,
        /// Environment set on the shell (the client resolves everything —
        /// the daemon adds no knowledge of its own).
        env: Vec<(String, String)>,
        /// Environment removed from the shell (inherited-context scrubbing).
        env_remove: Vec<String>,
        /// Window that owns the pane — half of the reattach key, and the
        /// reap key of `killByWindow` when the user discards a window.
        window_label: Option<String>,
        /// Recipient X25519 public key (base64, 32B) for sealed byte
        /// checkpoints. Absent = no checkpoints for this session (fail
        /// closed: the daemon never writes plaintext screen bytes). Additive
        /// optional field — no protocol bump. On attach to a live session
        /// that has no key yet, the daemon adopts this one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkpoint_pk: Option<String>,
        /// Vault key id owning the secret half of `checkpoint_pk` — recorded
        /// in the sealed-blob header so the app opens with the right key.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkpoint_key_id: Option<String>,
    },
    /// Shell input. Base64 keeps raw bytes NDJSON-safe; input volume is small.
    #[serde(rename_all = "camelCase")]
    Write { session: u64, data_b64: String },
    Resize { session: u64, cols: u16, rows: u16 },
    /// Flow-control acknowledgement — bytes the client finished parsing.
    Ack { session: u64, bytes: u64 },
    /// Terminate the session's shell. Pane close is discard (B1 semantics).
    Kill { session: u64 },
    /// Drop the attached stream, keep the shell running.
    Detach { session: u64 },
    /// Kill every session owned by a window — the user discarded the window.
    #[serde(rename_all = "camelCase")]
    KillByWindow { window_label: String },
    ListSessions,
    /// Store an opaque sealed blob keyed by the (window, pane) session.
    /// The daemon seals `bytes_b64` with that session's recipient key and writes
    /// it atomically — content-agnostic: the meaning of the bytes is the
    /// caller's (a terminal screen paint is one such meaning; the daemon reads
    /// none of it). Requires a live session with a seal key (fail closed —
    /// the daemon never writes plaintext screen bytes). Additive op.
    #[serde(rename_all = "camelCase")]
    StoreBlob { window_label: Option<String>, pane_id: String, bytes_b64: String },
    /// Fetch the sealed blob stored for a (window, pane), if present. Returns the
    /// sealed document as written; the caller opens it with the vault. No live
    /// session needed — a surviving blob is read straight off disk. Additive op.
    #[serde(rename_all = "camelCase")]
    FetchSealed { window_label: Option<String>, pane_id: String },
    /// Foreground process-group pid of the pane's PTY (observation substrate).
    #[serde(rename_all = "camelCase")]
    PanePid { pane_id: String },
    Ping,
    Shutdown,
}

/// One live session as reported by `createOrAttach` / `listSessions`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session: u64,
    pub pane_id: String,
    pub shell_pid: u32,
    /// Monotonic spawn counter — seals the probe/attach race: two clients that
    /// both observed "no session" cannot silently adopt different shells.
    pub generation: u64,
    pub window_label: Option<String>,
}

// ── Reply envelope ───────────────────────────────────────────────────────────
// The `{ok, code, message, data}` envelope mirrors the app's message protocol.

pub fn ok_reply(data: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "ok": true, "code": "OK", "data": data })
}

pub fn err_reply(code: &str, message: &str) -> serde_json::Value {
    serde_json::json!({ "ok": false, "code": code, "message": message })
}

#[cfg(test)]
mod tests {
    use super::*;
    use soksak_spec_socket::Compat;

    // ── path contract: protocol-keyed names under the identity home ─────────

    #[test]
    fn paths_are_protocol_keyed_under_home() {
        let home = Path::new("/tmp/h");
        assert_eq!(staged_bin_path(home), home.join("bin/soksak-ptyd-p1"));
        assert_eq!(control_socket_path(home), home.join("run/ptyd-p1.sock"));
        assert_eq!(stream_socket_path(home), home.join("run/ptyd-p1-stream.sock"));
        assert_eq!(token_path(home), home.join("run/ptyd-p1.token"));
        assert_eq!(log_path(home), home.join("run/ptyd-p1.log"));
    }

    // ── checkpoint path/AAD contract: bijective stem, context-bound seal ────

    #[test]
    fn checkpoint_paths_and_aad_derive_from_the_reattach_key() {
        let home = Path::new("/tmp/h");
        assert_eq!(checkpoint_pubkey_path(home), home.join("pty/seal.pub"));
        let a = checkpoint_path(home, "w-1", "v2");
        let b = checkpoint_path(home, "w-2", "v2");
        assert!(a.starts_with(home.join("pty/checkpoints")), "{a:?}");
        assert_ne!(a, b, "different windows never share a checkpoint file");
        // 전단사: 손실 sanitize·구분자 모호성이면 충돌했을 키 쌍도 갈린다.
        assert_ne!(
            checkpoint_path(home, "w|x", "y"),
            checkpoint_path(home, "w", "x|y"),
            "stem is bijective over (window, pane)"
        );
        assert_ne!(
            checkpoint_aad("w|x", "y", "k"),
            checkpoint_aad("w", "x|y", "k"),
            "AAD is unambiguous over (window, pane)"
        );
    }

    // ── hello judgment: mandatory from the first generation ─────────────────

    #[test]
    fn hello_without_version_is_rejected() {
        assert_eq!(
            judge_client(None),
            Compat::PeerTooOld { peer: 0, floor: PTYD_MIN_COMPATIBLE_CLIENT_PROTOCOL }
        );
    }

    #[test]
    fn hello_with_current_version_is_compatible() {
        assert_eq!(judge_client(Some(PTYD_PROTOCOL_VERSION)), Compat::Compatible);
    }

    #[test]
    fn hello_from_the_future_names_our_side_stale() {
        assert_eq!(
            judge_client(Some(PTYD_PROTOCOL_VERSION + 1)),
            Compat::SelfTooOld { own: PTYD_PROTOCOL_VERSION, peer: PTYD_PROTOCOL_VERSION + 1 }
        );
    }

    // ── serde: the wire shape is part of the contract ───────────────────────

    #[test]
    fn hello_round_trips_and_stream_hello_carries_session() {
        let h = Hello {
            version: Some(1),
            token: "t".into(),
            client_id: "app-1".into(),
            session: Some(7),
            from_seq: None,
            subscribe: false,
        };
        let line = serde_json::to_string(&h).unwrap();
        assert!(line.contains("\"clientId\""), "camelCase on the wire: {line}");
        let back: Hello = serde_json::from_str(&line).unwrap();
        assert_eq!(back.session, Some(7));
        // control hello omits session, from_seq, and subscribe entirely (additive
        // optionals stay off the wire when unset — the unchanged shape).
        let c = Hello { session: None, ..h.clone() };
        let cline = serde_json::to_string(&c).unwrap();
        assert!(!cline.contains("session"), "{cline}");
        assert!(!cline.contains("fromSeq"), "{cline}");
        assert!(!cline.contains("subscribe"), "{cline}");
        // a warm-handoff attach carries fromSeq; a tee carries subscribe
        let a = Hello { from_seq: Some(42), ..h.clone() };
        assert!(serde_json::to_string(&a).unwrap().contains("\"fromSeq\":42"));
        let s = Hello { subscribe: true, ..h };
        assert!(serde_json::to_string(&s).unwrap().contains("\"subscribe\":true"));
    }

    #[test]
    fn tee_frames_encode_kind_len_payload_and_gap_round_trips() {
        let mut out = Vec::new();
        encode_tee_frame(TEE_FRAME_DATA, b"hello", &mut out);
        assert_eq!(out[0], TEE_FRAME_DATA);
        assert_eq!(&out[1..5], &5u32.to_be_bytes());
        assert_eq!(&out[5..], b"hello");
        let gap = TeeGap { from_seq: 10, to_seq: 25 };
        let payload = serde_json::to_vec(&gap).unwrap();
        let mut g = Vec::new();
        encode_tee_frame(TEE_FRAME_GAP, &payload, &mut g);
        assert_eq!(g[0], TEE_FRAME_GAP);
        let back: TeeGap = serde_json::from_slice(&g[5..]).unwrap();
        assert_eq!(back, gap);
        let line = serde_json::to_string(&gap).unwrap();
        assert!(line.contains("\"fromSeq\":10") && line.contains("\"toSeq\":25"), "{line}");
    }

    #[test]
    fn requests_round_trip_with_op_tags() {
        let reqs: Vec<Request> = vec![
            Request::CreateOrAttach {
                pane_id: "p1".into(),
                cols: 80,
                rows: 24,
                cwd: Some("/tmp".into()),
                shell: "/bin/zsh".into(),
                env: vec![("TERM".into(), "xterm-256color".into())],
                env_remove: vec!["CLAUDECODE".into()],
                window_label: Some("w-x".into()),
                checkpoint_pk: Some("cGs=".into()),
                checkpoint_key_id: Some("ptyk-1".into()),
            },
            Request::Write { session: 1, data_b64: "aGk=".into() },
            Request::Resize { session: 1, cols: 100, rows: 30 },
            Request::Ack { session: 1, bytes: 5000 },
            Request::Kill { session: 1 },
            Request::Detach { session: 1 },
            Request::KillByWindow { window_label: "w-x".into() },
            Request::ListSessions,
            Request::StoreBlob {
                window_label: Some("w-x".into()),
                pane_id: "p1".into(),
                bytes_b64: "cGFpbnQ=".into(),
            },
            Request::FetchSealed { window_label: Some("w-x".into()), pane_id: "p1".into() },
            Request::PanePid { pane_id: "p1".into() },
            Request::Ping,
            Request::Shutdown,
        ];
        for r in reqs {
            let line = serde_json::to_string(&r).unwrap();
            assert!(line.contains("\"op\""), "op tag present: {line}");
            let back: Request = serde_json::from_str(&line).unwrap();
            assert_eq!(
                serde_json::to_string(&back).unwrap(),
                line,
                "round trip is identity"
            );
        }
    }

    #[test]
    fn create_or_attach_op_is_camel_case_on_the_wire() {
        let line = serde_json::to_string(&Request::ListSessions).unwrap();
        assert!(line.contains("\"listSessions\""), "{line}");
        let line = serde_json::to_string(&Request::PanePid { pane_id: "p".into() }).unwrap();
        assert!(line.contains("\"panePid\"") && line.contains("\"paneId\""), "{line}");
        let line = serde_json::to_string(&Request::StoreBlob {
            window_label: Some("w".into()),
            pane_id: "p".into(),
            bytes_b64: "eA==".into(),
        })
        .unwrap();
        assert!(line.contains("\"storeBlob\""), "{line}");
        assert!(line.contains("\"windowLabel\"") && line.contains("\"bytesB64\""), "{line}");
        let line =
            serde_json::to_string(&Request::FetchSealed { window_label: None, pane_id: "p".into() })
                .unwrap();
        assert!(line.contains("\"fetchSealed\""), "{line}");
    }

    #[test]
    fn envelope_is_symmetric_ok_code_message_data() {
        let ok = ok_reply(serde_json::json!({"n": 1}));
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["code"], "OK");
        assert_eq!(ok["data"]["n"], 1);
        let err = err_reply("UNAUTHORIZED", "bad token");
        assert_eq!(err["ok"], false);
        assert_eq!(err["code"], "UNAUTHORIZED");
        assert_eq!(err["message"], "bad token");
    }

    #[test]
    fn session_info_serializes_camel_case() {
        let s = SessionInfo {
            session: 3,
            pane_id: "p".into(),
            shell_pid: 42,
            generation: 9,
            window_label: None,
        };
        let line = serde_json::to_string(&s).unwrap();
        assert!(line.contains("\"paneId\"") && line.contains("\"shellPid\""), "{line}");
    }
}
