//! Plugin service wire contract — the single source for everything the app and
//! a plugin service binary must agree on: the protocol version, the contract
//! id, the stdio NDJSON frame set, the closed error-code enum, the bind-ledger
//! types and path derivation, the supervision constants, and the reference
//! `serve` harness (the sidecar-side serve loop, PS17). The wire has one source,
//! read from both ends — the core frames with the types here, the sidecar serves
//! with [`serve`]. Consumers depend on this crate — never copy a constant out.
//!
//! Behavioral and coupling law: docs/PLUGIN-SERVICE.md (PS clauses). Wire
//! framing is NDJSON over stdio: one JSON value per line, both directions.
//! The first service line is `hello`; the core answers `ready` (PS5).
//! The manifest-side mirror of [`service_contract_requirement`] lives in
//! `@soksak-ai/plugin-spec` (service.ts) — the service.test.ts / lib.rs test
//! pair pins both sides to the same literal.

mod serve;
pub use serve::{serve, serve_stdio, Emit, OpCtx, Outcome, ServiceHandler};

use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize};
use soksak_spec_contract::{
    is_service_contract_id, ContractProviderRef, ContractRequirement,
};

// hello 판정을 소비하는 쪽(서비스·앱)이 판정 타입과 스큐 문장을 이 크레이트 한 경로로
// 받는다 — soksak-spec-socket 이중 의존 대신 재수출(정본은 그대로 soksak-spec-socket).
pub use soksak_spec_socket::{skew_sentence, Compat, Lang};

/// Version of the plugin service wire contract. Bump rules follow the socket
/// protocol precedent (soksak-spec-socket): additive optional fields and new
/// frame kinds never bump; a change in framing, the envelope, or the meaning
/// of an existing field does. A breaking change requires a new contract version
/// and matching conformance fixtures (PS16).
pub const SERVICE_PROTOCOL_VERSION: u32 = 1;

/// Oldest service protocol the core still binds. The hello is mandatory from
/// the first release: a hello without a version is judged as protocol 0 and
/// rejected (PS5).
pub const SERVICE_MIN_COMPATIBLE_PROTOCOL: u32 = 1;

/// Service-domain constants. Generic contract grammar and compatibility are owned
/// by the public `soksak-spec-contract` crate.
pub const SERVICE_CONTRACT_ID: &str = "soksak-spec-service";
pub const SERVICE_CONTRACT_VERSION: &str = "0.0.1";
pub const SERVICE_CONTRACT_RANGE: &str = "0.0.1";

pub fn service_contract_provider() -> ContractProviderRef {
    ContractProviderRef::new(SERVICE_CONTRACT_ID, SERVICE_CONTRACT_VERSION)
        .expect("service provider constant is valid")
}

pub fn service_contract_requirement() -> ContractRequirement {
    ContractRequirement::new(SERVICE_CONTRACT_ID, SERVICE_CONTRACT_RANGE)
        .expect("service requirement constant is valid")
}

/// One NDJSON line never exceeds this many bytes, either direction (PS5).
/// An oversized or unparseable line is a protocol fault — the restart path,
/// never a silent skip.
pub const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

/// The argv the core passes when spawning the resident binary: `<bin> serve`.
/// Part of the wire contract — the same binary keeps its standalone
/// subcommands (repo-internal harnesses), and `serve` selects the resident
/// protocol peer.
pub const SERVE_ARG: &str = "serve";

/// Crash respawn backoff schedule in seconds, then the cap (PS10). A
/// deterministic immediate exit (death before `ready`) takes no retries.
pub const RESTART_BACKOFF_SECS: [u64; 5] = [1, 2, 4, 8, 16];

/// Grace between `shutdown` and SIGKILL (PS10).
pub const SHUTDOWN_GRACE_MS: u64 = 5_000;

/// Default req deadline when neither the caller nor a schedule declares one.
/// Progress `ev` frames extend the deadline up to the zombie backstop (PS12).
pub const DEFAULT_REQ_TIMEOUT_MS: u64 = 10_000;

/// Compatibility verdict for a service hello, judged with the shared socket
/// grammar. One rule carries both halves: absent = 0, floor decides.
pub fn judge_hello(declared: Option<u32>) -> soksak_spec_socket::Compat {
    soksak_spec_socket::evaluate_compat(
        SERVICE_PROTOCOL_VERSION,
        SERVICE_MIN_COMPATIBLE_PROTOCOL,
        soksak_spec_socket::effective_protocol(declared),
    )
}

// ── Identity-home path contract ──────────────────────────────────────────────

/// Bind ledger path: `<home>/run/services-p<N>.json` (PS9). The ledger is a
/// core-owned derived file — the app rewrites it on every enablement, consent,
/// or install transition, and the core reads it at boot. It carries the
/// already-judged subset of the manifest; the single manifest judge stays
/// `@soksak-ai/plugin-spec`. Protocol-keyed so a breaking bump runs side by
/// side with the previous generation.
pub fn ledger_path(home: &Path) -> PathBuf {
    home.join("run")
        .join(format!("services-p{SERVICE_PROTOCOL_VERSION}.json"))
}

/// Service log file: `<home>/run/service-<plugin>-p<N>.log`.
pub fn log_path(home: &Path, plugin: &str) -> PathBuf {
    home.join("run")
        .join(format!("service-{plugin}-p{SERVICE_PROTOCOL_VERSION}.log"))
}

// ── Bind ledger ──────────────────────────────────────────────────────────────

/// The bind ledger — every plugin service the core must bind (PS9).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct BindLedger {
    /// Ledger schema version (independent of the wire version).
    pub version: u32,
    pub services: Vec<ServiceBinding>,
}

/// One bound plugin service — the already-judged subset of its manifest.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBinding {
    /// Plugin id — the schedule owner stamp and the command namespace.
    pub plugin: String,
    /// `sidecars[]` entry naming the resident binary (PS9 — distribution and
    /// staging inherit the sidecar law).
    pub sidecar: String,
    /// Consumer requirement declared by the manifest. The binary hello carries
    /// exact provider evidence and must satisfy this range (PS5).
    pub interface: ContractRequirement,
    /// The manifest's `bind:"service"` command names, sorted — the hello
    /// `ops[]` must equal this set exactly, both directions (PS3).
    pub ops: Vec<String>,
    /// Bus topics the core bridges and pushes (PS15).
    #[serde(default)]
    pub subscribe: Vec<String>,
    /// Declared schedules — the core stamps `owner`, registers at bind, pokes
    /// once, cancels by owner at unbind (PS14).
    #[serde(default)]
    pub schedules: Vec<LedgerSchedule>,
    /// Secret NAMES to resolve from the vault and inject into the spawn
    /// environment (PS9). Never values — the ledger is a plain file and
    /// secrets never cross stdio or disk in the clear.
    #[serde(default)]
    pub secrets: Vec<String>,
    /// The plugin declared the `secrets` permission — it reads the vault. The
    /// core injects the plugin's `env:`-prefixed vault keys into the spawn
    /// environment (dynamic, user-configured — never manifest-hardcoded, PS9)
    /// and drain-restarts the service on a vault change (PS10). Derived from the
    /// permission, not a separate field, so the manifest never restates it.
    #[serde(default)]
    pub vault_env: bool,
    /// Plugin ids this service may call in a mediated `cmd` (PS13, C3 ladder) —
    /// the manifest `dependencies` declaration. The core refuses an outbound
    /// call to a plugin outside this set; core commands and self are exempt.
    #[serde(default)]
    pub dependencies: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawServiceBinding {
    plugin: String,
    sidecar: String,
    interface: ContractRequirement,
    ops: Vec<String>,
    #[serde(default)]
    subscribe: Vec<String>,
    #[serde(default)]
    schedules: Vec<LedgerSchedule>,
    #[serde(default)]
    secrets: Vec<String>,
    #[serde(default)]
    vault_env: bool,
    #[serde(default)]
    dependencies: Vec<String>,
}

impl<'de> Deserialize<'de> for ServiceBinding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawServiceBinding::deserialize(deserializer)?;
        if !is_service_contract_id(raw.interface.id()) {
            return Err(serde::de::Error::custom(
                "service binding interface id must use the soksak-spec-service namespace",
            ));
        }
        Ok(Self {
            plugin: raw.plugin,
            sidecar: raw.sidecar,
            interface: raw.interface,
            ops: raw.ops,
            subscribe: raw.subscribe,
            schedules: raw.schedules,
            secrets: raw.secrets,
            vault_env: raw.vault_env,
            dependencies: raw.dependencies,
        })
    }
}

/// One declared schedule (mirror of `contributes.schedules` after judgment).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSchedule {
    pub name: String,
    /// Bare command name (the registry name is `plugin.<plugin>.<command>`).
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
    pub trigger: LedgerTrigger,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zombie_backstop_ms: Option<u64>,
}

/// Trigger variants — exactly one, mirroring the manifest grammar
/// (`{reconcile:true} | {everyMs} | {cron}`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum LedgerTrigger {
    Reconcile {
        reconcile: bool,
    },
    Every {
        #[serde(rename = "everyMs")]
        every_ms: u64,
    },
    Cron {
        cron: String,
    },
}

/// Set equality between a hello `ops[]` and the ledger's declared ops —
/// bidirectional declared ≡ actual (PS3). Order-blind, duplicate-hostile.
pub fn ops_match(hello_ops: &[String], declared_ops: &[String]) -> bool {
    let mut a: Vec<&String> = hello_ops.iter().collect();
    let mut b: Vec<&String> = declared_ops.iter().collect();
    a.sort();
    b.sort();
    a.dedup();
    b.dedup();
    a.len() == hello_ops.len() && b.len() == declared_ops.len() && a == b
}

// ── Frames ───────────────────────────────────────────────────────────────────
// One JSON object per line, tagged by `t`. `ServiceOut` is what the service
// writes to stdout; `ServiceIn` is what the core writes to its stdin.

/// First service frame. `interface` is exact provider evidence; the consumer
/// requirement lives in [`ServiceBinding`].
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub version: Option<u32>,
    pub interface: ContractProviderRef,
    pub ops: Vec<String>,
    #[serde(default)]
    pub subscribe: Vec<String>,
    pub pid: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawHello {
    version: Option<u32>,
    interface: ContractProviderRef,
    ops: Vec<String>,
    #[serde(default)]
    subscribe: Vec<String>,
    pid: u32,
}

impl<'de> Deserialize<'de> for Hello {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawHello::deserialize(deserializer)?;
        if !is_service_contract_id(raw.interface.id()) {
            return Err(serde::de::Error::custom(
                "service hello interface id must use the soksak-spec-service namespace",
            ));
        }
        Ok(Self {
            version: raw.version,
            interface: raw.interface,
            ops: raw.ops,
            subscribe: raw.subscribe,
            pid: raw.pid,
        })
    }
}

/// Service → core frames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ServiceOut {
    /// First line after spawn (PS5). The core verifies protocol compatibility,
    /// the interface id against the manifest declaration, and `ops[]` against
    /// the ledger set — any mismatch refuses the bind (PS3).
    Hello(Hello),
    /// Command result — the envelope is the message seam (PS7): `message` and
    /// `hints` are first-class here, owned by the command implementation.
    #[serde(rename_all = "camelCase")]
    Res {
        id: u64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hints: Option<Vec<Hint>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
    },
    /// Progress tied to a running req — maps to standard `command.progress`
    /// and extends the req deadline up to the zombie backstop (PS7, PS12).
    Ev {
        id: u64,
        kind: String,
        payload: serde_json::Value,
    },
    /// Standalone activity — maps to the activity hub (PS8).
    Act {
        kind: String,
        payload: serde_json::Value,
    },
    /// Mediated outbound call (PS13). The core gates it with the full inbound
    /// gate set and stamps origin/parent itself — `under` is advisory context,
    /// never trusted identity.
    Cmd {
        id: u64,
        method: String,
        params: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        under: Option<String>,
    },
}

/// Core → service frames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ServiceIn {
    /// Hello accepted — the service may start receiving reqs (PS5).
    Ready,
    /// Command execution. `key` is the core-issued idempotency key — the
    /// service deduplicates by key and replays the cached res (PS12).
    #[serde(rename_all = "camelCase")]
    Req {
        id: u64,
        op: String,
        params: serde_json::Value,
        key: String,
        ctx: ReqCtx,
    },
    /// Reply to a mediated `cmd` call — the standard response envelope,
    /// relayed opaquely (PS13).
    CmdRes {
        id: u64,
        envelope: serde_json::Value,
    },
    /// Subscribed bus event — bridged, seq-deduplicated, delivered once (PS15).
    Push {
        topic: String,
        seq: u64,
        payload: serde_json::Value,
    },
    /// Drain and exit: finish in-flight ops, refuse new work, then exit.
    /// SIGKILL follows after [`SHUTDOWN_GRACE_MS`] (PS10).
    Shutdown,
}

/// Execution context the core stamps on every req (PS13 — identity is
/// core-stamped, never self-reported).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReqCtx {
    /// "schedule" | "socket" | "window" | ... — the originating channel.
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Deadline for this req in ms; progress `ev` frames extend it (PS12).
    pub deadline_ms: u64,
}

/// Follow-up command suggestion — a possibility, not an order
/// (MESSAGE-PROTOCOL hint semantics, delivered over the wire by PS7).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Hint {
    pub cmd: String,
    pub why: String,
}

// ── Error codes ──────────────────────────────────────────────────────────────

/// Closed error-code set for service `res.code` (PS5). The core maps any code
/// outside this enum to `INTERNAL` and never leaks a raw service string past
/// the envelope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrCode {
    InvalidParams,
    UnknownOp,
    Conflict,
    Draining,
    Timeout,
    Unavailable,
    Internal,
}

impl ErrCode {
    pub const ALL: [ErrCode; 7] = [
        ErrCode::InvalidParams,
        ErrCode::UnknownOp,
        ErrCode::Conflict,
        ErrCode::Draining,
        ErrCode::Timeout,
        ErrCode::Unavailable,
        ErrCode::Internal,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            ErrCode::InvalidParams => "INVALID_PARAMS",
            ErrCode::UnknownOp => "UNKNOWN_OP",
            ErrCode::Conflict => "CONFLICT",
            ErrCode::Draining => "DRAINING",
            ErrCode::Timeout => "TIMEOUT",
            ErrCode::Unavailable => "UNAVAILABLE",
            ErrCode::Internal => "INTERNAL",
        }
    }

    /// Parse a wire code. `None` = outside the closed set — the core maps it
    /// to [`ErrCode::Internal`] (PS5).
    pub fn parse(s: &str) -> Option<ErrCode> {
        ErrCode::ALL.iter().copied().find(|c| c.as_str() == s)
    }

    /// The clamp the core applies to every service-reported code (PS5).
    pub fn clamp(s: &str) -> ErrCode {
        ErrCode::parse(s).unwrap_or(ErrCode::Internal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soksak_spec_socket::Compat;

    // ── path contract: protocol-keyed names under the identity home ─────────

    #[test]
    fn paths_are_protocol_keyed_under_home() {
        let home = Path::new("/tmp/h");
        assert_eq!(ledger_path(home), home.join("run/services-p1.json"));
        assert_eq!(
            log_path(home, "soksak-plugin-x"),
            home.join("run/service-soksak-plugin-x-p1.log")
        );
    }

    // ── hello judgment: mandatory from the first generation (PS5) ───────────

    #[test]
    fn hello_without_version_is_rejected() {
        assert_eq!(
            judge_hello(None),
            Compat::PeerTooOld {
                peer: 0,
                floor: SERVICE_MIN_COMPATIBLE_PROTOCOL
            }
        );
    }

    #[test]
    fn hello_with_current_version_is_compatible() {
        assert_eq!(
            judge_hello(Some(SERVICE_PROTOCOL_VERSION)),
            Compat::Compatible
        );
    }

    #[test]
    fn hello_from_the_future_names_our_side_stale() {
        assert_eq!(
            judge_hello(Some(SERVICE_PROTOCOL_VERSION + 1)),
            Compat::SelfTooOld {
                own: SERVICE_PROTOCOL_VERSION,
                peer: SERVICE_PROTOCOL_VERSION + 1
            }
        );
    }

    // ── contract id: PS6 — never a token the C1 plugin-id scanner sanctions ─

    #[test]
    fn interface_id_follows_naming_and_avoids_the_plugin_id_grammar() {
        assert_eq!(SERVICE_CONTRACT_ID, "soksak-spec-service");
        assert_eq!(SERVICE_CONTRACT_VERSION, "0.0.1");
        assert_eq!(SERVICE_CONTRACT_RANGE, "0.0.1");
        assert!(
            !SERVICE_CONTRACT_ID.starts_with("soksak-plugin-"),
            "PS6: the C1 scan flags soksak-plugin-* tokens in core source"
        );
        assert!(
            SERVICE_CONTRACT_ID.starts_with("soksak-spec-"),
            "NAMING §8: a contract id begins with soksak-spec-"
        );
    }

    #[test]
    fn generic_contract_grammar_is_not_owned_or_reexported_by_the_service_crate() {
        let source = include_str!("lib.rs");
        let lines = source.lines().map(str::trim).collect::<Vec<_>>();
        assert!(!lines
            .iter()
            .any(|line| line.starts_with("pub struct ContractRequirement")));
        assert!(!lines
            .iter()
            .any(|line| line.starts_with("pub struct ContractProviderRef")));
        assert!(!lines
            .iter()
            .any(|line| line.starts_with("pub use soksak_spec_contract")));
    }

    // ── ops equality: bidirectional declared ≡ actual (PS3) ─────────────────

    #[test]
    fn ops_match_is_order_blind_and_duplicate_hostile() {
        let declared = vec!["next".to_string(), "run".to_string()];
        assert!(ops_match(&["run".into(), "next".into()], &declared));
        assert!(
            !ops_match(&["run".into()], &declared),
            "missing op = mismatch"
        );
        assert!(
            !ops_match(&["run".into(), "next".into(), "extra".into()], &declared),
            "undeclared op = mismatch"
        );
        assert!(
            !ops_match(&["run".into(), "run".into()], &["run".into()]),
            "duplicates never pass as coverage"
        );
        assert!(
            ops_match(&[], &[]),
            "an empty set only matches an empty set"
        );
    }

    // ── frames: the wire shape is part of the contract (PS5) ────────────────

    #[test]
    fn service_out_frames_round_trip_with_t_tags() {
        let frames: Vec<ServiceOut> = vec![
            ServiceOut::Hello(Hello {
                version: Some(1),
                interface: service_contract_provider(),
                ops: vec!["run".into()],
                subscribe: vec!["bus:kanban:changed".into()],
                pid: 42,
            }),
            ServiceOut::Res {
                id: 7,
                ok: true,
                code: None,
                message: Some("done".into()),
                hints: Some(vec![Hint {
                    cmd: "plugin.x.next".into(),
                    why: "continue".into(),
                }]),
                data: Some(serde_json::json!({"n": 1})),
            },
            ServiceOut::Ev {
                id: 7,
                kind: "progress".into(),
                payload: serde_json::json!({"pct": 50}),
            },
            ServiceOut::Act {
                kind: "service.tick".into(),
                payload: serde_json::json!({}),
            },
            ServiceOut::Cmd {
                id: 9,
                method: "plugin.other.node.add".into(),
                params: serde_json::json!({"title": "x"}),
                under: Some("run#7".into()),
            },
        ];
        for f in frames {
            let line = serde_json::to_string(&f).unwrap();
            assert!(line.contains("\"t\""), "t tag present: {line}");
            let back: ServiceOut = serde_json::from_str(&line).unwrap();
            assert_eq!(
                serde_json::to_string(&back).unwrap(),
                line,
                "round trip is identity"
            );
        }
    }

    #[test]
    fn service_in_frames_round_trip_with_t_tags() {
        let frames: Vec<ServiceIn> = vec![
            ServiceIn::Ready,
            ServiceIn::Req {
                id: 7,
                op: "run".into(),
                params: serde_json::json!({"doc": "a.json"}),
                key: "idem-1".into(),
                ctx: ReqCtx {
                    origin: "schedule".into(),
                    parent: None,
                    deadline_ms: 30_000,
                },
            },
            ServiceIn::CmdRes {
                id: 9,
                envelope: serde_json::json!({"ok": true, "code": "OK"}),
            },
            ServiceIn::Push {
                topic: "bus:kanban:changed".into(),
                seq: 12,
                payload: serde_json::json!({}),
            },
            ServiceIn::Shutdown,
        ];
        for f in frames {
            let line = serde_json::to_string(&f).unwrap();
            assert!(line.contains("\"t\""), "t tag present: {line}");
            let back: ServiceIn = serde_json::from_str(&line).unwrap();
            assert_eq!(
                serde_json::to_string(&back).unwrap(),
                line,
                "round trip is identity"
            );
        }
    }

    #[test]
    fn req_ctx_and_hello_are_camel_case_on_the_wire() {
        let req = ServiceIn::Req {
            id: 1,
            op: "run".into(),
            params: serde_json::json!({}),
            key: "k".into(),
            ctx: ReqCtx {
                origin: "socket".into(),
                parent: None,
                deadline_ms: 5,
            },
        };
        let line = serde_json::to_string(&req).unwrap();
        assert!(line.contains("\"deadlineMs\""), "{line}");
        let hello = ServiceOut::Hello(Hello {
            version: Some(1),
            interface: service_contract_provider(),
            ops: vec![],
            subscribe: vec![],
            pid: 1,
        });
        let line = serde_json::to_string(&hello).unwrap();
        assert!(line.contains("\"hello\""), "camelCase t tag: {line}");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&line).unwrap(),
            serde_json::json!({
                "t": "hello",
                "version": 1,
                "interface": { "id": "soksak-spec-service", "version": "0.0.1" },
                "ops": [],
                "subscribe": [],
                "pid": 1,
            })
        );
        assert!(serde_json::from_str::<ServiceOut>(
            r#"{"t":"hello","version":1,"interface":"soksak-spec-service@0.0.1","ops":[],"pid":1}"#,
        )
        .is_err());
    }

    // ── error codes: a closed set with an INTERNAL clamp (PS5) ──────────────

    #[test]
    fn err_codes_are_a_closed_set_with_internal_clamp() {
        for c in ErrCode::ALL {
            assert_eq!(ErrCode::parse(c.as_str()), Some(c), "round trip {c:?}");
        }
        assert_eq!(ErrCode::parse("SOMETHING_ELSE"), None);
        assert_eq!(ErrCode::clamp("SOMETHING_ELSE"), ErrCode::Internal);
        assert_eq!(ErrCode::clamp("TIMEOUT"), ErrCode::Timeout);
    }

    // ── ledger: round trip + trigger variants (PS9, PS14) ───────────────────

    #[test]
    fn ledger_round_trips_with_every_trigger_variant() {
        let ledger = BindLedger {
            version: 1,
            services: vec![ServiceBinding {
                plugin: "soksak-plugin-x".into(),
                sidecar: "x".into(),
                interface: service_contract_requirement(),
                ops: vec!["run".into()],
                subscribe: vec!["bus:kanban:changed".into()],
                schedules: vec![
                    LedgerSchedule {
                        name: "reconcile".into(),
                        command: "run".into(),
                        params: None,
                        trigger: LedgerTrigger::Reconcile { reconcile: true },
                        timeout_ms: Some(1_800_000),
                        zombie_backstop_ms: None,
                    },
                    LedgerSchedule {
                        name: "hourly".into(),
                        command: "run".into(),
                        params: Some(serde_json::json!({"mode": "sweep"})),
                        trigger: LedgerTrigger::Every {
                            every_ms: 3_600_000,
                        },
                        timeout_ms: None,
                        zombie_backstop_ms: None,
                    },
                    LedgerSchedule {
                        name: "nightly".into(),
                        command: "run".into(),
                        params: None,
                        trigger: LedgerTrigger::Cron {
                            cron: "0 3 * * *".into(),
                        },
                        timeout_ms: None,
                        zombie_backstop_ms: None,
                    },
                ],
                secrets: vec!["ANTHROPIC_API_KEY".into()],
                vault_env: true,
                dependencies: vec!["kanban".into()],
            }],
        };
        let text = serde_json::to_string_pretty(&ledger).unwrap();
        assert!(
            text.contains("\"everyMs\""),
            "camelCase trigger key: {text}"
        );
        let back: BindLedger = serde_json::from_str(&text).unwrap();
        assert_eq!(back, ledger);
    }

    #[test]
    fn ledger_defaults_tolerate_absent_optional_lists() {
        let minimal = r#"{"version":1,"services":[{"plugin":"p","sidecar":"s",
            "interface":{"id":"soksak-spec-service","range":"0.0.1"},"ops":["run"]}]}"#;
        let back: BindLedger = serde_json::from_str(minimal).unwrap();
        assert_eq!(back.services[0].subscribe, Vec::<String>::new());
        assert_eq!(back.services[0].schedules, Vec::<LedgerSchedule>::new());
        assert_eq!(back.services[0].secrets, Vec::<String>::new());
    }

    #[test]
    fn legacy_string_interface_is_not_a_service_binding_wire_shape() {
        let legacy = r#"{"version":1,"services":[{"plugin":"p","sidecar":"s",
            "interface":"soksak-spec-service@0.0.1","ops":["run"]}]}"#;
        assert!(serde_json::from_str::<BindLedger>(legacy).is_err());
    }

    // ── supervision constants (PS10, PS12) ──────────────────────────────────

    #[test]
    fn supervision_constants_hold_the_legislated_values() {
        assert_eq!(RESTART_BACKOFF_SECS, [1, 2, 4, 8, 16]);
        assert_eq!(MAX_LINE_BYTES, 4 * 1024 * 1024);
        assert!(SHUTDOWN_GRACE_MS > 0);
        assert!(DEFAULT_REQ_TIMEOUT_MS > 0);
    }
}
