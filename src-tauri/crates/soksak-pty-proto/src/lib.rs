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
// 받는다 — soksak-protocol 이중 의존 대신 재수출(정본은 그대로 soksak-protocol).
pub use soksak_protocol::{skew_sentence, Compat, Lang};

/// Version of the ptyd wire contract. Bump rules follow the socket protocol
/// precedent (soksak-protocol): additive optional fields and new ops never
/// bump; a change in framing, the envelope, or the meaning of an existing
/// field does. On a breaking bump only the previous generation stays
/// serveable — no multi-generation adapters.
pub const PTYD_PROTOCOL_VERSION: u32 = 1;

/// Oldest client protocol the daemon still serves. The hello is mandatory from
/// the first release, so the floor starts at 1: a hello without a version is
/// judged as protocol 0 (`soksak_protocol::effective_protocol`) and rejected.
pub const PTYD_MIN_COMPATIBLE_CLIENT_PROTOCOL: u32 = 1;

/// Flow-control watermarks — the same values the in-process PTY path uses
/// (pty.rs). The daemon pauses its PTY reader while an attached client has
/// this many unacked bytes, and resumes at the low mark.
pub const HIGH_WATERMARK: usize = 100_000;
pub const LOW_WATERMARK: usize = 5_000;

/// Detached scrollback ring capacity per session (bytes). While no client is
/// attached the daemon keeps the most recent output here; on attach it is
/// replayed ahead of live bytes. Older bytes fall off — byte checkpoints are a
/// later rung of the restore ladder (docs/RESTORE.md).
pub const RING_CAPACITY: usize = 1_048_576;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<u64>,
}

/// Compatibility verdict for a client hello, judged with the shared socket
/// grammar. One rule carries both halves: absent = 0, floor decides.
pub fn judge_client(declared: Option<u32>) -> soksak_protocol::Compat {
    soksak_protocol::evaluate_compat(
        PTYD_PROTOCOL_VERSION,
        PTYD_MIN_COMPATIBLE_CLIENT_PROTOCOL,
        soksak_protocol::effective_protocol(declared),
    )
}

// ── Requests ─────────────────────────────────────────────────────────────────

/// Control-socket request set. One JSON object per line, tagged by `op`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    /// Attach to the live session owning `pane_id`, or spawn a new shell for
    /// it. The pane id is the reattach key — it is stable across app restarts
    /// (workspace snapshot). Spawn parameters are ignored on attach.
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
        /// Window that owns the pane — `killByWindow` reaps by this key when
        /// a window is discarded by the user.
        window_label: Option<String>,
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
    /// Base64 of the current scrollback ring, without attaching.
    GetSnapshot { session: u64 },
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
    use soksak_protocol::Compat;

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
        };
        let line = serde_json::to_string(&h).unwrap();
        assert!(line.contains("\"clientId\""), "camelCase on the wire: {line}");
        let back: Hello = serde_json::from_str(&line).unwrap();
        assert_eq!(back.session, Some(7));
        // control hello omits session entirely
        let c = Hello { session: None, ..h };
        assert!(!serde_json::to_string(&c).unwrap().contains("session"));
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
            },
            Request::Write { session: 1, data_b64: "aGk=".into() },
            Request::Resize { session: 1, cols: 100, rows: 30 },
            Request::Ack { session: 1, bytes: 5000 },
            Request::Kill { session: 1 },
            Request::Detach { session: 1 },
            Request::KillByWindow { window_label: "w-x".into() },
            Request::ListSessions,
            Request::GetSnapshot { session: 1 },
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
