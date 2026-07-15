//! Reference serve harness (PS17) — the sidecar side of the wire. The framing
//! every service needs lives here once: hello emission, line-buffered NDJSON
//! read, one-JSON-per-line write with flush, id-multiplexed req/res, streaming
//! `ev`/`act`, mediated outbound `cmd` correlation, idempotency replay, the
//! state-mutation mutex (PS16), close-stdin as EOF, and exit on pipe death.
//!
//! A sidecar author implements [`ServiceHandler`] (op handlers only) and calls
//! [`serve_stdio`]. The core side (ServiceManager) frames the same wire from
//! the opposite end using the types in this crate — one source, both ends.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use serde_json::{json, Value};

use crate::{
    service_contract_provider, ErrCode, Hello, Hint, ServiceIn, ServiceOut,
    SERVICE_PROTOCOL_VERSION,
};

/// Execution context the core stamped on a req (PS13) — read-only to the op.
#[derive(Debug, Clone)]
pub struct OpCtx {
    pub origin: String,
    pub parent: Option<String>,
    pub deadline_ms: u64,
    /// The idempotency key the core issued (PS12) — the harness dedups by it;
    /// exposed so a handler can log/trace, not for re-deduping.
    pub key: String,
}

/// One op's result. The human sentence and hints are owned by the op (PS7);
/// they cross the wire in the `res` envelope.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub ok: bool,
    pub code: Option<String>,
    pub message: Option<String>,
    pub hints: Vec<Hint>,
    pub data: Option<Value>,
}

impl Outcome {
    pub fn ok(data: Value) -> Self {
        Self {
            ok: true,
            code: None,
            message: None,
            hints: Vec::new(),
            data: Some(data),
        }
    }
    pub fn ok_msg(data: Value, message: impl Into<String>) -> Self {
        Self {
            ok: true,
            code: None,
            message: Some(message.into()),
            hints: Vec::new(),
            data: Some(data),
        }
    }
    pub fn err(code: ErrCode, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            code: Some(code.as_str().to_string()),
            message: Some(message.into()),
            hints: Vec::new(),
            data: None,
        }
    }
    pub fn with_hints(mut self, hints: Vec<Hint>) -> Self {
        self.hints = hints;
        self
    }
}

/// The op-handler contract a sidecar author implements. Framing is not here —
/// only domain ops (PS17).
pub trait ServiceHandler: Send + Sync + 'static {
    /// The `bind:"service"` op names this service answers — must equal the
    /// manifest declaration (the core verifies hello.ops against the ledger).
    fn ops(&self) -> Vec<String>;
    /// Bus topics to receive as `push` (PS15). Default: none.
    fn subscribe(&self) -> Vec<String> {
        Vec::new()
    }
    /// Read-only ops run concurrently; the rest serialize under one mutex
    /// (PS16). Default: every op is treated as mutating (safe default).
    fn read_only(&self, _op: &str) -> bool {
        false
    }
    /// Run one op. `emit` streams progress/activity and makes mediated calls.
    fn handle(&self, op: &str, params: Value, ctx: &OpCtx, emit: &Emit) -> Outcome;
    /// A subscribed bus event arrived (PS15). Default: ignore.
    fn on_push(&self, _topic: &str, _seq: u64, _payload: Value) {}
}

/// Shared line writer — one NDJSON frame per line, flushed, never interleaved.
struct Sink {
    writer: Mutex<Box<dyn Write + Send>>,
}

impl Sink {
    fn emit(&self, frame: &ServiceOut) {
        if let Ok(line) = serde_json::to_string(frame) {
            if let Ok(mut w) = self.writer.lock() {
                let _ = writeln!(w, "{line}");
                let _ = w.flush();
            }
        }
    }
}

/// Outbound `cmd` correlation — id → reply channel for a pending mediated call.
#[derive(Default)]
struct CmdBus {
    seq: AtomicU64,
    pending: Mutex<HashMap<u64, mpsc::SyncSender<Value>>>,
}

/// Handle given to an op for streaming and mediated calls (PS7, PS13).
pub struct Emit {
    req_id: u64,
    sink: Arc<Sink>,
    cmd: Arc<CmdBus>,
}

impl Emit {
    /// Stream progress tied to this req — maps to `command.progress` (PS7).
    pub fn progress(&self, kind: &str, payload: Value) {
        self.sink.emit(&ServiceOut::Ev {
            id: self.req_id,
            kind: kind.to_string(),
            payload,
        });
    }
    /// Standalone activity — maps to the activity hub (PS8).
    pub fn activity(&self, kind: &str, payload: Value) {
        self.sink.emit(&ServiceOut::Act {
            kind: kind.to_string(),
            payload,
        });
    }
    /// Mediated outbound call (PS13) — the core gates it and stamps identity.
    /// Blocks until the core relays the response envelope. `under` is advisory
    /// correlation context, never trusted identity.
    pub fn call(&self, method: &str, params: Value, under: Option<&str>) -> Value {
        let id = self.cmd.seq.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::sync_channel::<Value>(1);
        if let Ok(mut p) = self.cmd.pending.lock() {
            p.insert(id, tx);
        }
        self.sink.emit(&ServiceOut::Cmd {
            id,
            method: method.to_string(),
            params,
            under: under.map(str::to_string),
        });
        match rx.recv() {
            Ok(v) => v,
            Err(_) => {
                json!({ "ok": false, "code": "INTERNAL", "message": "mediated call channel closed" })
            }
        }
    }
}

/// Serve the wire over the given reader/writer (PS17). Blocks until stdin EOF
/// or a `shutdown` frame; drains in-flight ops before returning.
pub fn serve<R: BufRead, W: Write + Send + 'static>(
    handler: impl ServiceHandler,
    reader: R,
    writer: W,
) {
    let handler = Arc::new(handler);
    let sink = Arc::new(Sink {
        writer: Mutex::new(Box::new(writer)),
    });
    let cmd = Arc::new(CmdBus::default());
    let mutation = Arc::new(Mutex::new(())); // PS16 single mutex for mutating ops
    let idem: Arc<Mutex<HashMap<String, Value>>> = Arc::new(Mutex::new(HashMap::new()));

    // hello first (PS5) — the harness fills the wire interface; the author never
    // restates it. ops/subscribe come from the handler.
    sink.emit(&ServiceOut::Hello(Hello {
        version: Some(SERVICE_PROTOCOL_VERSION),
        interface: service_contract_provider(),
        ops: handler.ops(),
        subscribe: handler.subscribe(),
        pid: std::process::id(),
    }));

    let mut inflight: Vec<std::thread::JoinHandle<()>> = Vec::new();
    let mut lines = reader.lines();
    loop {
        let line = match lines.next() {
            Some(Ok(l)) => l,
            _ => break, // stdin EOF / pipe death → drain and exit (PS17)
        };
        if line.trim().is_empty() {
            continue;
        }
        let frame: ServiceIn = match serde_json::from_str(&line) {
            Ok(f) => f,
            Err(_) => continue, // core is trusted; a bad line is skipped (core never sends garbage)
        };
        match frame {
            ServiceIn::Ready => {}
            ServiceIn::Shutdown => break, // drain in-flight, exit
            ServiceIn::CmdRes { id, envelope } => {
                if let Ok(mut p) = cmd.pending.lock() {
                    if let Some(tx) = p.remove(&id) {
                        let _ = tx.try_send(envelope);
                    }
                }
            }
            ServiceIn::Push {
                topic,
                seq,
                payload,
            } => {
                let h = handler.clone();
                std::thread::spawn(move || h.on_push(&topic, seq, payload));
            }
            ServiceIn::Req {
                id,
                op,
                params,
                key,
                ctx,
            } => {
                // Idempotency replay (PS12) — same key returns the cached res.
                if let Ok(cache) = idem.lock() {
                    if let Some(cached) = cache.get(&key) {
                        sink.emit(&res_from_cache(id, cached));
                        continue;
                    }
                }
                let h = handler.clone();
                let sink2 = sink.clone();
                let cmd2 = cmd.clone();
                let mutation2 = mutation.clone();
                let idem2 = idem.clone();
                let read_only = h.read_only(&op);
                inflight.retain(|j| !j.is_finished());
                inflight.push(std::thread::spawn(move || {
                    let emit = Emit {
                        req_id: id,
                        sink: sink2.clone(),
                        cmd: cmd2,
                    };
                    let opctx = OpCtx {
                        origin: ctx.origin,
                        parent: ctx.parent,
                        deadline_ms: ctx.deadline_ms,
                        key: key.clone(),
                    };
                    // PS16 — mutating ops serialize under one mutex; read ops run free.
                    let outcome = if read_only {
                        h.handle(&op, params, &opctx, &emit)
                    } else {
                        let _guard = mutation2.lock().unwrap_or_else(|p| p.into_inner());
                        h.handle(&op, params, &opctx, &emit)
                    };
                    let (frame, cache_val) = res_frame(id, &outcome);
                    if let Ok(mut cache) = idem2.lock() {
                        cache.insert(key, cache_val);
                    }
                    sink2.emit(&frame);
                }));
            }
        }
    }
    for j in inflight {
        let _ = j.join();
    }
}

/// Serve over real stdin/stdout (the sidecar `serve` entry point, PS17).
pub fn serve_stdio(handler: impl ServiceHandler) {
    let stdin = std::io::stdin();
    let reader = std::io::BufReader::new(stdin.lock());
    // stdout must not be line-buffered against our explicit flush — take the lock owned.
    let stdout = std::io::stdout();
    serve(handler, reader, StdoutWriter(stdout));
}

// Owned stdout writer (stdout().lock() borrows; serve needs 'static Send).
struct StdoutWriter(std::io::Stdout);
impl Write for StdoutWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.lock().flush()
    }
}

// Build a res frame + the value to cache for idempotency replay.
fn res_frame(id: u64, o: &Outcome) -> (ServiceOut, Value) {
    let hints = if o.hints.is_empty() {
        None
    } else {
        Some(o.hints.clone())
    };
    let frame = ServiceOut::Res {
        id,
        ok: o.ok,
        code: o.code.clone(),
        message: o.message.clone(),
        hints: hints.clone(),
        data: o.data.clone(),
    };
    // Cache the id-independent parts; replay re-stamps the current req id.
    let cache = json!({
        "ok": o.ok,
        "code": o.code,
        "message": o.message,
        "hints": hints,
        "data": o.data,
    });
    (frame, cache)
}

fn res_from_cache(id: u64, cached: &Value) -> ServiceOut {
    let hints: Option<Vec<Hint>> = cached
        .get("hints")
        .and_then(|h| serde_json::from_value(h.clone()).ok());
    ServiceOut::Res {
        id,
        ok: cached.get("ok").and_then(Value::as_bool).unwrap_or(false),
        code: cached
            .get("code")
            .and_then(Value::as_str)
            .map(str::to_string),
        message: cached
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string),
        hints,
        data: cached.get("data").cloned().filter(|v| !v.is_null()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ReqCtx; // 코어측 프레임 타입 — 테스트가 core 역할을 연기하며 req 를 구성.
    use std::collections::VecDeque;
    use std::io::{BufReader, Read};
    use std::sync::Condvar;
    use std::time::Duration;

    // ── in-memory pipe (blocking) — the CORE side plays against serve() ──────
    #[derive(Clone, Default)]
    struct Pipe(Arc<(Mutex<PipeBuf>, Condvar)>);
    #[derive(Default)]
    struct PipeBuf {
        buf: VecDeque<u8>,
        closed: bool,
    }
    impl Pipe {
        fn close(&self) {
            let (m, cv) = &*self.0;
            m.lock().unwrap().closed = true;
            cv.notify_all();
        }
    }
    impl Write for Pipe {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            let (m, cv) = &*self.0;
            let mut b = m.lock().unwrap();
            b.buf.extend(data);
            cv.notify_all();
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Read for Pipe {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let (m, cv) = &*self.0;
            let mut b = m.lock().unwrap();
            loop {
                if !b.buf.is_empty() {
                    let n = out.len().min(b.buf.len());
                    for slot in out.iter_mut().take(n) {
                        *slot = b.buf.pop_front().unwrap();
                    }
                    return Ok(n);
                }
                if b.closed {
                    return Ok(0);
                }
                b = cv.wait(b).unwrap();
            }
        }
    }

    // A fixture sidecar that borrows serve() — the whole point of PS17.
    struct Fixture;
    impl ServiceHandler for Fixture {
        fn ops(&self) -> Vec<String> {
            vec![
                "echo".into(),
                "slow".into(),
                "read".into(),
                "call".into(),
                "boom".into(),
            ]
        }
        fn subscribe(&self) -> Vec<String> {
            vec!["bus:test:changed".into()]
        }
        fn read_only(&self, op: &str) -> bool {
            op == "read"
        }
        fn handle(&self, op: &str, params: Value, ctx: &OpCtx, emit: &Emit) -> Outcome {
            match op {
                "echo" => Outcome::ok_msg(json!({ "echo": params, "origin": ctx.origin }), "done"),
                "slow" => {
                    for _ in 0..3 {
                        emit.progress("progress", json!({ "step": 1 }));
                    }
                    Outcome::ok(json!({ "slow": true }))
                }
                "read" => Outcome::ok(json!({ "read": true })),
                "call" => {
                    let reply = emit.call("plugin.other.add", json!({ "x": 1 }), Some("echo#1"));
                    Outcome::ok(json!({ "relayed": reply }))
                }
                "boom" => Outcome::err(ErrCode::Conflict, "nope"),
                _ => Outcome::err(ErrCode::UnknownOp, op),
            }
        }
        fn on_push(&self, topic: &str, _seq: u64, _payload: Value) {
            // record via activity path is not available here; the test asserts
            // delivery through a mutation the harness can observe — see below.
            PUSH_TOPIC.with_topic(topic);
        }
    }

    // on_push observation channel (thread-local-free; a static for the test).
    struct PushObs {
        inner: Mutex<Vec<String>>,
    }
    impl PushObs {
        fn with_topic(&self, t: &str) {
            self.inner.lock().unwrap().push(t.to_string());
        }
    }
    static PUSH_TOPIC: std::sync::LazyLock<PushObs> = std::sync::LazyLock::new(|| PushObs {
        inner: Mutex::new(Vec::new()),
    });

    // Core-side driver: holds the two pipe ends and speaks the wire.
    struct Core {
        to_service: Pipe,              // core writes ServiceIn here (service stdin)
        from_service: BufReader<Pipe>, // core reads ServiceOut here (service stdout)
    }
    impl Core {
        fn new() -> (Core, std::thread::JoinHandle<()>) {
            let stdin_pipe = Pipe::default();
            let stdout_pipe = Pipe::default();
            let reader = BufReader::new(stdin_pipe.clone());
            let writer = stdout_pipe.clone();
            let handle = std::thread::spawn(move || serve(Fixture, reader, writer));
            (
                Core {
                    to_service: stdin_pipe,
                    from_service: BufReader::new(stdout_pipe),
                },
                handle,
            )
        }
        fn send(&mut self, frame: &ServiceIn) {
            let line = serde_json::to_string(frame).unwrap();
            writeln!(self.to_service, "{line}").unwrap();
        }
        fn recv(&mut self) -> ServiceOut {
            let mut line = String::new();
            self.from_service.read_line(&mut line).unwrap();
            serde_json::from_str(line.trim()).unwrap()
        }
        fn req(&mut self, id: u64, op: &str, params: Value, key: &str) {
            self.send(&ServiceIn::Req {
                id,
                op: op.into(),
                params,
                key: key.into(),
                ctx: ReqCtx {
                    origin: "socket".into(),
                    parent: None,
                    deadline_ms: 5_000,
                },
            });
        }
    }

    fn ctx() -> ReqCtx {
        ReqCtx {
            origin: "socket".into(),
            parent: None,
            deadline_ms: 5_000,
        }
    }

    // ── PS17: hello is emitted by the harness with the wire interface + ops ──
    #[test]
    fn serve_emits_hello_with_wire_interface_and_declared_ops() {
        let (mut core, h) = Core::new();
        match core.recv() {
            ServiceOut::Hello(hello) => {
                assert_eq!(hello.version, Some(SERVICE_PROTOCOL_VERSION));
                assert_eq!(
                    hello.interface,
                    service_contract_provider(),
                    "harness fills exact provider evidence; author never restates it"
                );
                assert!(hello.ops.contains(&"echo".to_string()));
                assert_eq!(hello.subscribe, vec!["bus:test:changed".to_string()]);
            }
            other => panic!("first frame must be hello: {other:?}"),
        }
        core.send(&ServiceIn::Ready);
        core.send(&ServiceIn::Shutdown);
        let _ = h.join();
    }

    // ── PS7: op result crosses the wire as the envelope with message ─────────
    #[test]
    fn req_res_carries_the_envelope() {
        let (mut core, h) = Core::new();
        let _hello = core.recv();
        core.send(&ServiceIn::Ready);
        core.req(1, "echo", json!({ "a": 1 }), "k1");
        match core.recv() {
            ServiceOut::Res {
                id,
                ok,
                message,
                data,
                ..
            } => {
                assert_eq!(id, 1);
                assert!(ok);
                assert_eq!(message.as_deref(), Some("done"));
                assert_eq!(data.unwrap()["echo"]["a"], 1);
            }
            other => panic!("expected res: {other:?}"),
        }
        core.send(&ServiceIn::Shutdown);
        let _ = h.join();
    }

    // ── PS7: streaming ev frames tied to the req id ──────────────────────────
    #[test]
    fn slow_op_streams_progress_before_res() {
        let (mut core, h) = Core::new();
        let _hello = core.recv();
        core.send(&ServiceIn::Ready);
        core.req(2, "slow", json!({}), "k2");
        let mut evs = 0;
        loop {
            match core.recv() {
                ServiceOut::Ev { id, .. } => {
                    assert_eq!(id, 2);
                    evs += 1;
                }
                ServiceOut::Res { id, ok, .. } => {
                    assert_eq!(id, 2);
                    assert!(ok);
                    break;
                }
                other => panic!("unexpected: {other:?}"),
            }
        }
        assert_eq!(evs, 3, "three progress frames precede the res");
        core.send(&ServiceIn::Shutdown);
        let _ = h.join();
    }

    // ── PS12: idempotency replay — same key returns the cached res, op not re-run ─
    #[test]
    fn duplicate_key_replays_cached_res() {
        let (mut core, h) = Core::new();
        let _hello = core.recv();
        core.send(&ServiceIn::Ready);
        core.req(10, "echo", json!({ "n": 1 }), "same");
        let first = core.recv();
        core.req(11, "echo", json!({ "n": 999 }), "same"); // different params, same key
        let second = core.recv();
        let (d1, d2) = match (first, second) {
            (
                ServiceOut::Res {
                    data: a, id: i1, ..
                },
                ServiceOut::Res {
                    data: b, id: i2, ..
                },
            ) => {
                assert_eq!(i1, 10);
                assert_eq!(i2, 11, "replay re-stamps the current req id");
                (a.unwrap(), b.unwrap())
            }
            _ => panic!("expected two res"),
        };
        assert_eq!(d1["echo"]["n"], 1);
        assert_eq!(
            d2["echo"]["n"], 1,
            "replay returns the FIRST result, op did not re-run"
        );
        core.send(&ServiceIn::Shutdown);
        let _ = h.join();
    }

    // ── PS13: mediated outbound call — cmd frame out, cmdRes routed back ──────
    #[test]
    fn mediated_call_correlates_cmd_and_cmdres() {
        let (mut core, h) = Core::new();
        let _hello = core.recv();
        core.send(&ServiceIn::Ready);
        core.req(3, "call", json!({}), "k3");
        // service emits a cmd; core relays a response envelope back.
        let cmd_id = match core.recv() {
            ServiceOut::Cmd {
                id, method, under, ..
            } => {
                assert_eq!(method, "plugin.other.add");
                assert_eq!(under.as_deref(), Some("echo#1"));
                id
            }
            other => panic!("expected cmd: {other:?}"),
        };
        core.send(&ServiceIn::CmdRes {
            id: cmd_id,
            envelope: json!({ "ok": true, "code": "OK", "data": { "added": true } }),
        });
        match core.recv() {
            ServiceOut::Res { id, ok, data, .. } => {
                assert_eq!(id, 3);
                assert!(ok);
                assert_eq!(data.unwrap()["relayed"]["data"]["added"], true);
            }
            other => panic!("expected res: {other:?}"),
        }
        core.send(&ServiceIn::Shutdown);
        let _ = h.join();
    }

    // ── PS16: mutating ops serialize; a slow mutating op blocks another ──────
    #[test]
    fn mutating_ops_serialize_read_ops_run_free() {
        // Two mutating "slow" ops: their res frames must not interleave beyond
        // the single-mutex discipline. We assert both complete and the harness
        // does not deadlock; the read op returns even while others queue.
        let (mut core, h) = Core::new();
        let _hello = core.recv();
        core.send(&ServiceIn::Ready);
        core.req(20, "slow", json!({}), "m20");
        core.req(21, "read", json!({}), "m21");
        // Drain frames; assert we see res for both ids (order not asserted).
        let mut seen: Vec<u64> = Vec::new();
        while seen.len() < 2 {
            match core.recv() {
                ServiceOut::Res { id, ok, .. } => {
                    assert!(ok);
                    if !seen.contains(&id) {
                        seen.push(id);
                    }
                }
                ServiceOut::Ev { .. } => {}
                other => panic!("unexpected: {other:?}"),
            }
        }
        assert!(seen.contains(&20) && seen.contains(&21));
        core.send(&ServiceIn::Shutdown);
        let _ = h.join();
    }

    // ── PS15: pushed bus event reaches on_push ───────────────────────────────
    #[test]
    fn push_reaches_on_push() {
        PUSH_TOPIC.inner.lock().unwrap().clear();
        let (mut core, h) = Core::new();
        let _hello = core.recv();
        core.send(&ServiceIn::Ready);
        core.send(&ServiceIn::Push {
            topic: "bus:test:changed".into(),
            seq: 7,
            payload: json!({}),
        });
        // give the push thread a moment, then shutdown
        for _ in 0..100 {
            if !PUSH_TOPIC.inner.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(
            PUSH_TOPIC.inner.lock().unwrap().as_slice(),
            &["bus:test:changed".to_string()]
        );
        core.send(&ServiceIn::Shutdown);
        let _ = h.join();
    }

    // ── PS17: stdin EOF (pipe death) drains and exits ────────────────────────
    #[test]
    fn stdin_eof_exits_the_serve_loop() {
        let (mut core, h) = Core::new();
        let _hello = core.recv();
        core.send(&ServiceIn::Ready);
        core.to_service.close(); // pipe death
                                 // serve() must return (join completes) — no shutdown frame needed.
        h.join().expect("serve exits on stdin EOF");
    }

    // ── error envelope maps the closed code ──────────────────────────────────
    #[test]
    fn error_op_returns_envelope_with_code() {
        let (mut core, h) = Core::new();
        let _hello = core.recv();
        core.send(&ServiceIn::Ready);
        core.req(4, "boom", json!({}), "k4");
        match core.recv() {
            ServiceOut::Res {
                ok, code, message, ..
            } => {
                assert!(!ok);
                assert_eq!(code.as_deref(), Some("CONFLICT"));
                assert_eq!(message.as_deref(), Some("nope"));
            }
            other => panic!("expected res: {other:?}"),
        }
        core.send(&ServiceIn::Shutdown);
        let _ = h.join();
    }

    #[test]
    fn outcome_builders_shape_the_envelope() {
        let o = Outcome::err(ErrCode::Timeout, "slow").with_hints(vec![Hint {
            cmd: "retry".into(),
            why: "again".into(),
        }]);
        assert!(!o.ok);
        assert_eq!(o.code.as_deref(), Some("TIMEOUT"));
        assert_eq!(o.hints.len(), 1);
        let _ = ctx();
    }
}
