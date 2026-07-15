use super::*;
use std::{
    io::{Read as _, Write as _},
    net::{TcpListener, TcpStream},
    process::{Child, ChildStdin, Command as StdCommand},
    sync::mpsc::{self as std_mpsc, Receiver, RecvTimeoutError},
    thread,
    time::{Duration as StdDuration, Instant as StdInstant},
};

pub const CONFORMANCE_ARGUMENT: &str = "--soksak-plugin-runtime-conformance";
const PROBE_DEADLINE: StdDuration = StdDuration::from_secs(8);

pub fn conformance_requested() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|value| value == CONFORMANCE_ARGUMENT)
}

struct LiveHelper {
    child: Child,
    input: ChildStdin,
    outputs: Receiver<Result<HelperOutput, String>>,
    token: String,
    runtime_id: String,
    heartbeat_count: usize,
}

impl LiveHelper {
    fn start(entry_code: &str, policy: RuntimePolicy) -> Result<Self, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let runtime_id = format!("runtime.conformance.{}", Uuid::new_v4());
        let token = Uuid::new_v4().simple().to_string();
        let start = HelperStart {
            spec: TRANSPORT_SPEC.to_string(),
            kind: "start".to_string(),
            token: token.clone(),
            runtime_id: runtime_id.clone(),
            entry_code: entry_code.to_string(),
            entry_sha256: sha256(entry_code.as_bytes()),
            frame_csp: frame_csp(&policy),
            frame_bootstrap: FRAME_BOOTSTRAP_MODULE.to_string(),
            web_rtc: policy.web_rtc,
            navigation_origins: policy.navigation_origins,
            iframe_origins: policy.iframe_origins,
            heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
        };

        let mut command = StdCommand::new(executable);
        command
            .arg(HELPER_ARGUMENT)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .env_clear();
        for name in ["HOME", "LANG", "LC_ALL", "TMPDIR"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        configure_std_process_containment(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("conformance helper spawn failed: {error}"))?;
        let mut input = child
            .stdin
            .take()
            .ok_or_else(|| "conformance helper stdin missing".to_string())?;
        let mut output = child
            .stdout
            .take()
            .ok_or_else(|| "conformance helper stdout missing".to_string())?;
        write_sync_frame(
            &mut input,
            &serde_json::to_vec(&start).map_err(|error| error.to_string())?,
        )?;
        let (tx, outputs) = std_mpsc::channel();
        thread::spawn(move || loop {
            let frame = match read_sync_frame(&mut output) {
                Ok(frame) => frame,
                Err(error) => {
                    let _ = tx.send(Err(error));
                    return;
                }
            };
            let parsed = serde_json::from_slice::<HelperOutput>(&frame)
                .map_err(|error| format!("invalid conformance helper output: {error}"));
            if tx.send(parsed).is_err() {
                return;
            }
        });

        Ok(Self {
            child,
            input,
            outputs,
            token,
            runtime_id,
            heartbeat_count: 0,
        })
    }

    fn send_envelope(&mut self, envelope: Value) -> Result<(), String> {
        self.send(json!({
            "spec": TRANSPORT_SPEC,
            "kind": "envelope",
            "token": self.token,
            "runtimeId": self.runtime_id,
            "envelope": envelope,
        }))
    }

    fn send(&mut self, frame: Value) -> Result<(), String> {
        write_sync_frame(
            &mut self.input,
            &serde_json::to_vec(&frame).map_err(|error| error.to_string())?,
        )
    }

    fn receive_matching(
        &mut self,
        timeout: StdDuration,
        mut predicate: impl FnMut(&HelperOutput) -> bool,
    ) -> Result<HelperOutput, String> {
        let deadline = StdInstant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(StdInstant::now());
            if remaining.is_zero() {
                return Err("conformance event deadline exceeded".to_string());
            }
            let output = match self.outputs.recv_timeout(remaining) {
                Ok(Ok(output)) => output,
                Ok(Err(error)) => return Err(error),
                Err(RecvTimeoutError::Timeout) => {
                    return Err("conformance event deadline exceeded".to_string())
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("conformance helper output disconnected".to_string())
                }
            };
            if output.spec != TRANSPORT_SPEC
                || output.token != self.token
                || output.runtime_id != self.runtime_id
            {
                return Err("conformance helper authentication failed".to_string());
            }
            if output.kind == "heartbeat" {
                self.heartbeat_count += 1;
            }
            if output.kind == "fault" {
                return Err(output
                    .message
                    .clone()
                    .unwrap_or_else(|| "conformance helper fault".to_string()));
            }
            if predicate(&output) {
                return Ok(output);
            }
        }
    }

    fn ready(&mut self) -> Result<(), String> {
        self.receive_matching(PROBE_DEADLINE, |output| output.kind == "ready")?;
        Ok(())
    }

    fn envelope(&mut self, method: &str) -> Result<Value, String> {
        let output = self.receive_matching(PROBE_DEADLINE, |output| {
            output.kind == "envelope"
                && output
                    .envelope
                    .as_ref()
                    .and_then(|value| value.get("method"))
                    .and_then(Value::as_str)
                    == Some(method)
        })?;
        output
            .envelope
            .ok_or_else(|| "conformance envelope missing".to_string())
    }

    fn heartbeat_after(&mut self, baseline: usize) -> Result<(), String> {
        self.receive_matching(HEARTBEAT_DEADLINE, |_| self.heartbeat_count > baseline)?;
        Ok(())
    }

    fn expect_heartbeat_deadline(&mut self) -> Result<(), String> {
        let deadline = StdInstant::now() + HEARTBEAT_DEADLINE;
        loop {
            let remaining = deadline.saturating_duration_since(StdInstant::now());
            if remaining.is_zero() {
                return Ok(());
            }
            match self.outputs.recv_timeout(remaining) {
                Ok(Ok(output)) => {
                    if output.spec != TRANSPORT_SPEC
                        || output.token != self.token
                        || output.runtime_id != self.runtime_id
                    {
                        return Err("conformance helper authentication failed".to_string());
                    }
                    if output.kind == "heartbeat" {
                        return Err("infinite-loop helper emitted a heartbeat after injection".to_string());
                    }
                }
                Ok(Err(_)) | Err(RecvTimeoutError::Disconnected) | Err(RecvTimeoutError::Timeout) => {
                    return Ok(())
                }
            }
        }
    }

    fn terminate(&mut self) {
        terminate_std_child_group(&mut self.child);
    }
}

impl Drop for LiveHelper {
    fn drop(&mut self) {
        terminate_std_child_group(&mut self.child);
    }
}

#[cfg(unix)]
fn configure_std_process_containment(command: &mut StdCommand) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_std_process_containment(_command: &mut StdCommand) {}

fn terminate_std_child_group(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    #[cfg(unix)]
    unsafe {
        libc::killpg(child.id() as i32, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn bootstrap(runtime_id: &str, plugin_id: &str) -> Value {
    json!({
        "spec": WIRE_SPEC,
        "kind": "request",
        "seq": 1,
        "requestId": "bootstrap.conformance.1",
        "method": "runtime.bootstrap",
        "params": {
            "principal": {
                "runtimeId": runtime_id,
                "sessionId": "session.conformance.1",
                "windowLabel": "conformance",
                "pluginId": plugin_id,
                "generation": 1,
                "role": "controller",
                "contributionId": "controller",
                "instanceId": "controller.1",
                "domHandleId": null
            },
            "appVersion": env!("CARGO_PKG_VERSION"),
            "capabilities": [],
            "hostCommands": [],
            "events": [],
            "context": {
                "revision": 1,
                "theme": { "colorMode": "system", "tokens": {} },
                "locale": "en",
                "slot": null,
                "visible": false,
                "interactive": false,
                "instance": null
            },
            "bootstrapArtifactSha256": runtime_artifact().html.sha256
        }
    })
}

fn invoke_probe(sequence: u64, command: &str) -> Value {
    json!({
        "spec": WIRE_SPEC,
        "kind": "request",
        "seq": sequence,
        "requestId": format!("probe.{sequence}"),
        "method": "plugin-command.invoke",
        "params": {
            "command": command,
            "params": {},
            "invocation": { "origin": "conformance", "parent": null }
        }
    })
}

fn probe_outcome(envelope: Value) -> Result<Value, String> {
    envelope
        .get("params")
        .and_then(|value| value.get("outcome"))
        .cloned()
        .ok_or_else(|| "probe outcome missing".to_string())
}

struct ProbeServer {
    origin: String,
    observed: Receiver<String>,
}

impl ProbeServer {
    fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        let origin = format!("http://{address}");
        let (tx, observed) = std_mpsc::channel();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut request = [0u8; 2_048];
                let Ok(length) = stream.read(&mut request) else {
                    return;
                };
                let first = String::from_utf8_lossy(&request[..length])
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_string();
                if first.contains(" /shutdown ") {
                    return;
                }
                let _ = tx.send(first);
                let body = b"<!doctype html><title>capability probe</title>ok";
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(body);
                let _ = stream.flush();
            }
        });
        Ok(Self { origin, observed })
    }

    fn observed(&self, timeout: StdDuration) -> bool {
        self.observed.recv_timeout(timeout).is_ok()
    }

    fn shutdown(&self) {
        if let Ok(mut stream) = TcpStream::connect(self.origin.trim_start_matches("http://")) {
            let _ = stream.write_all(b"GET /shutdown HTTP/1.1\r\nConnection: close\r\n\r\n");
        }
    }
}

pub fn run_native_runtime_conformance() -> Result<Value, String> {
    let normal_code = r#"export default {
      controller: { activate() {} },
      commands: { ping() { return { ok: true, code: 'OK', message: 'pong' }; } }
    };"#;
    let mut normal = LiveHelper::start(normal_code, RuntimePolicy::default())?;
    normal.ready()?;
    normal.send_envelope(bootstrap(&normal.runtime_id, "conformance-normal"))?;
    let ready = normal.envelope("lifecycle.ready")?;
    if ready.pointer("/params/inventory/commands/0").and_then(Value::as_str) != Some("ping") {
        return Err("normal helper inventory mismatch".to_string());
    }
    normal.send_envelope(invoke_probe(2, "ping"))?;
    let normal_outcome = probe_outcome(normal.envelope("plugin-command.result")?)?;
    if normal_outcome.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("normal helper command failed".to_string());
    }
    let normal_heartbeat = normal.heartbeat_count;
    normal.heartbeat_after(normal_heartbeat)?;

    let attack_server = ProbeServer::start()?;
    let attack_code = format!(
        r#"const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const storageBlocked = (name) => {{ try {{ globalThis[name].setItem('x','y'); return false; }} catch (_) {{ return true; }} }};
        const localFrame = () => new Promise((resolve) => {{
          const frame = document.createElement('iframe'); frame.srcdoc = '<!doctype html><p>local</p>';
          frame.onload = () => resolve({{ loaded: true, nestedWebRtcBlocked: typeof frame.contentWindow.RTCPeerConnection === 'undefined', nestedIpcBlocked: typeof frame.contentWindow.ipc === 'undefined' }});
          frame.onerror = () => resolve({{ loaded: false, nestedWebRtcBlocked: false, nestedIpcBlocked: false }});
          document.body.append(frame); setTimeout(() => resolve({{ loaded: false, nestedWebRtcBlocked: false, nestedIpcBlocked: false }}), 1000);
        }});
        export default {{ controller: {{ activate() {{}} }}, commands: {{
          async attack() {{
            let parentDomBlocked = false; try {{ void parent.document.body; }} catch (_) {{ parentDomBlocked = true; }}
            const nested = await localFrame();
            const remote = document.createElement('iframe'); remote.src = '{}/undeclared'; document.body.append(remote);
            await delay(300);
            return {{ ok: true, code: 'OK', message: 'attack probes', data: {{
              parentDomBlocked, localStorageBlocked: storageBlocked('localStorage'), sessionStorageBlocked: storageBlocked('sessionStorage'),
              rawIpcBlocked: typeof globalThis.ipc === 'undefined', tauriBlocked: typeof globalThis.__TAURI_INTERNALS__ === 'undefined',
              webRtcBlocked: typeof globalThis.RTCPeerConnection === 'undefined', ...nested
            }} }};
          }},
          async navigate() {{ location.href = '{}/undeclared-navigation'; await delay(300); return {{ ok: true, code: 'OK', message: 'navigation blocked' }}; }}
        }} }};"#,
        attack_server.origin, attack_server.origin
    );
    let mut attack = LiveHelper::start(&attack_code, RuntimePolicy::default())?;
    attack.ready()?;
    attack.send_envelope(bootstrap(&attack.runtime_id, "conformance-attack"))?;
    attack.envelope("lifecycle.ready")?;
    attack.send_envelope(invoke_probe(2, "attack"))?;
    let attack_outcome = probe_outcome(attack.envelope("plugin-command.result")?)?;
    let attack_data = attack_outcome
        .get("data")
        .and_then(Value::as_object)
        .ok_or_else(|| "attack probe data missing".to_string())?;
    for name in [
        "parentDomBlocked",
        "localStorageBlocked",
        "sessionStorageBlocked",
        "rawIpcBlocked",
        "tauriBlocked",
        "webRtcBlocked",
        "loaded",
        "nestedWebRtcBlocked",
        "nestedIpcBlocked",
    ] {
        if attack_data.get(name).and_then(Value::as_bool) != Some(true) {
            return Err(format!("attack probe failed: {name}"));
        }
    }
    if attack_server.observed(StdDuration::from_millis(350)) {
        return Err("undeclared iframe origin reached the network".to_string());
    }
    attack.send_envelope(invoke_probe(3, "navigate"))?;
    let navigation_outcome = probe_outcome(attack.envelope("plugin-command.result")?)?;
    if navigation_outcome.get("ok").and_then(Value::as_bool) != Some(true)
        || attack_server.observed(StdDuration::from_millis(350))
    {
        return Err("undeclared navigation origin was not blocked".to_string());
    }
    attack_server.shutdown();

    let iframe_server = ProbeServer::start()?;
    let iframe_code = format!(
        r#"export default {{ controller: {{ activate() {{}} }}, commands: {{
          iframe() {{ return new Promise((resolve) => {{ const frame = document.createElement('iframe'); frame.src = '{}/declared';
            frame.onload = () => resolve({{ ok: true, code: 'OK', message: 'declared iframe loaded' }});
            frame.onerror = () => resolve({{ ok: false, code: 'IFRAME_ERROR', message: 'declared iframe failed' }});
            document.body.append(frame); setTimeout(() => resolve({{ ok: false, code: 'IFRAME_TIMEOUT', message: 'declared iframe timed out' }}), 1500);
          }}); }}
        }} }};"#,
        iframe_server.origin
    );
    let mut iframe = LiveHelper::start(
        &iframe_code,
        RuntimePolicy {
            iframe_origins: vec![iframe_server.origin.clone()],
            ..RuntimePolicy::default()
        },
    )?;
    iframe.ready()?;
    iframe.send_envelope(bootstrap(&iframe.runtime_id, "conformance-iframe"))?;
    iframe.envelope("lifecycle.ready")?;
    iframe.send_envelope(invoke_probe(2, "iframe"))?;
    let iframe_outcome = probe_outcome(iframe.envelope("plugin-command.result")?)?;
    if iframe_outcome.get("ok").and_then(Value::as_bool) != Some(true)
        || !iframe_server.observed(StdDuration::from_secs(1))
    {
        return Err("declared iframe capability failed".to_string());
    }
    iframe_server.shutdown();

    let navigation_server = ProbeServer::start()?;
    let navigation_code = format!(
        "export default {{ controller: {{ activate() {{}} }}, commands: {{ navigate() {{ location.href = '{}/declared'; return {{ ok: true, code: 'OK', message: 'navigating' }}; }} }} }};",
        navigation_server.origin
    );
    let mut navigation = LiveHelper::start(
        &navigation_code,
        RuntimePolicy {
            navigation_origins: vec![navigation_server.origin.clone()],
            ..RuntimePolicy::default()
        },
    )?;
    navigation.ready()?;
    navigation.send_envelope(bootstrap(&navigation.runtime_id, "conformance-navigation"))?;
    navigation.envelope("lifecycle.ready")?;
    navigation.send_envelope(invoke_probe(2, "navigate"))?;
    if !navigation_server.observed(StdDuration::from_secs(2)) {
        return Err("declared navigation capability failed".to_string());
    }
    navigation_server.shutdown();

    let web_rtc_code = r#"export default { controller: { activate() {} }, commands: {
      webRtc() { const frame = document.createElement('iframe'); frame.srcdoc = '<!doctype html>';
        document.body.append(frame); return { ok: typeof RTCPeerConnection === 'function' && typeof frame.contentWindow.RTCPeerConnection === 'function', code: 'OK', message: 'WebRTC capability' }; }
    } };"#;
    let mut web_rtc = LiveHelper::start(
        web_rtc_code,
        RuntimePolicy {
            web_rtc: true,
            ..RuntimePolicy::default()
        },
    )?;
    web_rtc.ready()?;
    web_rtc.send_envelope(bootstrap(&web_rtc.runtime_id, "conformance-webrtc"))?;
    web_rtc.envelope("lifecycle.ready")?;
    web_rtc.send_envelope(invoke_probe(2, "webRtc"))?;
    let web_rtc_outcome = probe_outcome(web_rtc.envelope("plugin-command.result")?)?;
    if web_rtc_outcome.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("declared WebRTC capability failed".to_string());
    }

    let loop_code = "export default { controller: { activate() { for (;;) {} } } };";
    let mut loop_helper = LiveHelper::start(loop_code, RuntimePolicy::default())?;
    loop_helper.ready()?;
    let healthy_before = normal.heartbeat_count;
    loop_helper.send_envelope(bootstrap(&loop_helper.runtime_id, "conformance-loop"))?;
    loop_helper.expect_heartbeat_deadline()?;
    loop_helper.terminate();
    normal.heartbeat_after(healthy_before)?;

    Ok(json!({
        "spec": WIRE_SPEC,
        "platform": format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        "artifact": runtime_artifact(),
        "normal": { "ready": true, "command": true, "heartbeat": true },
        "attacks": {
            "opaqueParentDom": true,
            "storage": true,
            "rawNativeGlobals": true,
            "nestedFrameGuard": true,
            "undeclaredIframe": true,
            "undeclaredNavigation": true
        },
        "capabilities": { "iframe": true, "navigation": true, "webRtc": true },
        "availability": {
            "infiniteLoopInjected": true,
            "heartbeatDeadlineDetected": true,
            "terminatedOnlyFaultingUnit": true,
            "healthyUnitHeartbeatAdvanced": true
        }
    }))
}
