//! Killable per-plugin JavaScript runtime.
//!
//! The application renderer never receives plugin entry bytes.  The native core resolves the
//! configured unit source, reads and hashes the entry, and starts one helper process per plugin.
//! The helper owns a raw Wry webview containing a trusted wrapper and one opaque-origin
//! `sandbox="allow-scripts"` frame.  The only plugin/host channel is the transferred
//! `MessagePort`; Wry IPC is authenticated by a session secret known only to the wrapper and
//! supervisor.  Availability is a process boundary: a one-shot heartbeat deadline kills a
//! blocked helper without polling any state.

use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State, Window};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    process::Command,
    sync::{mpsc, oneshot},
    time::{self, Instant},
};
use url::Url;
use uuid::Uuid;

mod conformance;
pub use conformance::{
    conformance_requested, run_native_runtime_conformance, CONFORMANCE_ARGUMENT,
};

const HELPER_ARGUMENT: &str = "--soksak-plugin-runtime-helper";
const TRANSPORT_SPEC: &str = "soksak-native-plugin-runtime@0.0.1";
const WIRE_SPEC: &str = "soksak-spec-plugin-runtime@0.0.1";
const MAX_FRAME_BYTES: usize = 1_310_720;
const MAX_ENTRY_BYTES: usize = 1_048_576;
const STARTUP_DEADLINE: Duration = Duration::from_secs(8);
const HEARTBEAT_DEADLINE: Duration = Duration::from_millis(1_500);
const HEARTBEAT_INTERVAL_MS: u64 = 250;

/// This exact string is mirrored by the public plugin-runtime contract.
pub const BOOTSTRAP_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'self' data: blob:; child-src 'self' data: blob:; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

/// Canonical trusted document.  Plugin entry bytes are never interpolated into this artifact.
pub const BOOTSTRAP_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'self' data: blob:; child-src 'self' data: blob:; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"></head><body></body></html>"#;

/// Runs inside the opaque child frame and captures every intrinsic used by the bridge before it
/// imports untrusted plugin bytes.  The initial ambient message is accepted exactly once solely
/// to transfer one MessagePort; all later traffic uses that port.
pub const FRAME_BOOTSTRAP_MODULE: &str = r#"(() => {
  'use strict';
  const SafeObject = Object;
  const SafePromise = Promise;
  const SafeMap = Map;
  const SafeBlob = Blob;
  const safeCreateObjectURL = URL.createObjectURL.bind(URL);
  const safeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  const safeJsonStringify = JSON.stringify.bind(JSON);
  const safeStructuredClone = globalThis.structuredClone.bind(globalThis);
  const safePost = Function.call.bind(MessagePort.prototype.postMessage);
  const safeStart = Function.call.bind(MessagePort.prototype.start);
  const safeAdd = Function.call.bind(EventTarget.prototype.addEventListener);
  const safeRemove = Function.call.bind(EventTarget.prototype.removeEventListener);
  let port = null;
  let outSeq = 0;
  let moduleValue = null;
  let controllerContext = null;
  const pending = new SafeMap();
  const abort = new AbortController();

  // Raw Wry IPC is wrapper-only.  Opaque plugin code receives a MessagePort and nothing else.
  try { delete globalThis.ipc; } catch (_) {}
  try { SafeObject.defineProperty(globalThis, 'ipc', { value: undefined, configurable: false }); } catch (_) {}
  try { delete globalThis.__TAURI_INTERNALS__; } catch (_) {}
  try { delete globalThis.isTauri; } catch (_) {}

  const send = (kind, method, params, requestId) => {
    const envelope = { spec: 'soksak-spec-plugin-runtime@0.0.1', kind, seq: ++outSeq,
      requestId: requestId || `plugin.${outSeq}`, method, params };
    safePost(port, envelope);
    return envelope.requestId;
  };
  const outcomeError = (error) => ({ ok: false, code: 'PLUGIN_RUNTIME_ERROR',
    message: error instanceof Error ? error.message : String(error) });
  const makeApp = (bootstrap) => SafeObject.freeze({
    appVersion: bootstrap.params.appVersion,
    pluginId: bootstrap.params.principal.pluginId,
    windowLabel: bootstrap.params.principal.windowLabel,
    commands: SafeObject.freeze({
      execute(command, params = {}) {
        return new SafePromise((resolve, reject) => {
          const requestId = send('request', 'command.execute', { command, params });
          pending.set(requestId, { resolve, reject });
        });
      },
    }),
    events: SafeObject.freeze({
      async subscribe() { throw new Error('event subscription bridge is not enabled for this session'); },
    }),
    resources: SafeObject.freeze({
      async open() { throw new Error('resource bridge is not enabled for this session'); },
    }),
  });
  const inventory = (value) => {
    const keys = (record) => record && typeof record === 'object' ? SafeObject.keys(record).sort() : [];
    return { commands: keys(value.commands), views: keys(value.views),
      fileViewers: keys(value.fileViewers), overlays: keys(value.overlays) };
  };
  const onHostEnvelope = async (envelope) => {
    if (!envelope || envelope.spec !== 'soksak-spec-plugin-runtime@0.0.1') return;
    if (envelope.kind === 'result' || envelope.kind === 'error') {
      const waiter = pending.get(envelope.requestId);
      if (!waiter) return;
      pending.delete(envelope.requestId);
      if (envelope.kind === 'result') waiter.resolve(safeStructuredClone(envelope.value));
      else waiter.reject(new Error(envelope.error && envelope.error.message || 'host request failed'));
      return;
    }
    if (envelope.kind === 'signal' && envelope.method === 'runtime.teardown') {
      abort.abort();
      try { await moduleValue?.controller?.deactivate?.(controllerContext); } catch (_) {}
      return;
    }
    if (envelope.kind === 'request' && envelope.method === 'runtime.bootstrap') {
      if (moduleValue) return;
      const code = globalThis.__soksakPluginEntryCode;
      globalThis.__soksakPluginEntryCode = undefined;
      const url = safeCreateObjectURL(new SafeBlob([code], { type: 'text/javascript' }));
      try { moduleValue = await import(url); }
      finally { safeRevokeObjectURL(url); }
      moduleValue = moduleValue.default || moduleValue;
      const app = makeApp(envelope);
      controllerContext = SafeObject.freeze({ app, role: 'controller', signal: abort.signal,
        context: SafeObject.freeze(safeStructuredClone(envelope.params.context)) });
      send('signal', 'lifecycle.ready', { inventory: inventory(moduleValue) }, 'lifecycle.ready.1');
      try { await moduleValue.controller?.activate?.(controllerContext); }
      catch (error) { send('signal', 'runtime.fault', { code: 'ACTIVATE_FAILED', message: outcomeError(error).message }, 'runtime.fault.activate'); }
      return;
    }
    if (envelope.kind === 'request' && envelope.method === 'plugin-command.invoke') {
      const command = envelope.params.command;
      const handler = moduleValue?.commands?.[command];
      let outcome;
      try {
        if (typeof handler !== 'function') throw new Error(`plugin command is not implemented: ${command}`);
        const invocation = SafeObject.freeze({ origin: envelope.params.invocation.origin,
          parent: envelope.params.invocation.parent,
          execute: controllerContext.app.commands.execute });
        outcome = await handler(safeStructuredClone(envelope.params.params),
          SafeObject.freeze({ ...controllerContext, invocation }));
      } catch (error) { outcome = outcomeError(error); }
      send('signal', 'plugin-command.result', { outcome }, envelope.requestId);
    }
  };
  const receiveBootstrapPort = (event) => {
    safeRemove(globalThis, 'message', receiveBootstrapPort);
    if (event.source !== parent || !event.data || event.data.type !== 'soksak-runtime-port' || event.ports.length !== 1) return;
    port = event.ports[0];
    globalThis.__soksakPluginEntryCode = event.data.entryCode;
    if (!event.data.webRtc) {
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
        try { SafeObject.defineProperty(globalThis, name, { value: undefined, configurable: false }); } catch (_) {}
      }
      try { SafeObject.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: false }); } catch (_) {}
    }
    safeAdd(port, 'message', (message) => { void onHostEnvelope(message.data); });
    safeStart(port);
  };
  safeAdd(globalThis, 'message', receiveBootstrapPort);
})();"#;

/// Document-start guard injected into every child frame, including frames created by plugin code.
/// The wrapper is the only top-level document and is excluded.  The runtime policy value is
/// assigned as data immediately before this canonical module executes.
pub const FRAME_DOCUMENT_GUARD_MODULE: &str = r#"(() => {
  'use strict';
  if (globalThis === top) return;
  const SafeObject = Object;
  const webRtcAllowed = globalThis.__SOKSAK_WEBRTC_ALLOWED__ === true;
  try { delete globalThis.__SOKSAK_WEBRTC_ALLOWED__; } catch (_) {}
  for (const name of ['ipc', '__TAURI_INTERNALS__', 'isTauri']) {
    try { delete globalThis[name]; } catch (_) {}
    try { SafeObject.defineProperty(globalThis, name, { value: undefined, configurable: false }); } catch (_) {}
  }
  if (!webRtcAllowed) {
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
      try { SafeObject.defineProperty(globalThis, name, { value: undefined, configurable: false }); } catch (_) {}
    }
    try { SafeObject.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: false }); } catch (_) {}
  }
})();"#;

/// Trusted wrapper.  It owns the native IPC secret, transfers exactly one MessagePort and emits
/// heartbeat events.  The recurring timer only produces liveness events; the supervisor never
/// polls process state and uses a resettable one-shot deadline.
pub const WRAPPER_BOOTSTRAP_MODULE: &str = r#"(() => {
  'use strict';
  const start = globalThis.__SOKSAK_NATIVE_START__;
  delete globalThis.__SOKSAK_NATIVE_START__;
  const nativePost = globalThis.ipc.postMessage.bind(globalThis.ipc);
  const sendNative = (kind, value = {}) => nativePost(JSON.stringify({
    spec: start.transportSpec, kind, token: start.token, runtimeId: start.runtimeId, ...value,
  }));
  const channel = new MessageChannel();
  let delivered = false;
  Object.defineProperty(globalThis, '__soksakRuntimeDeliver', {
    configurable: false, enumerable: false,
    value(envelope) { if (delivered) channel.port1.postMessage(envelope); },
  });
  channel.port1.onmessage = (event) => sendNative('envelope', { envelope: event.data });
  channel.port1.start();
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;inset:0;border:0;width:100%;height:100%';
  const escapedBootstrap = start.frameBootstrap;
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${start.frameCsp}"></head><body><main id="soksak-plugin-root"></main><script>${escapedBootstrap}<\/script></body></html>`;
  frame.addEventListener('load', () => {
    if (delivered) return;
    delivered = true;
    frame.contentWindow.postMessage({ type: 'soksak-runtime-port', entryCode: start.entryCode,
      webRtc: start.webRtc }, '*', [channel.port2]);
    start.entryCode = '';
    sendNative('ready');
    const heartbeat = () => {
      sendNative('heartbeat');
      setTimeout(heartbeat, start.heartbeatIntervalMs);
    };
    setTimeout(heartbeat, start.heartbeatIntervalMs);
  }, { once: true });
  const mount = () => (document.body || document.documentElement).append(frame);
  if (document.body) mount();
  else globalThis.addEventListener('DOMContentLoaded', mount, { once: true });
})();"#;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePolicy {
    #[serde(default)]
    navigation_origins: Vec<String>,
    #[serde(default)]
    iframe_origins: Vec<String>,
    #[serde(default)]
    web_rtc: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePrincipal {
    runtime_id: String,
    session_id: String,
    window_label: String,
    plugin_id: String,
    generation: u64,
    role: &'static str,
    contribution_id: &'static str,
    instance_id: String,
    dom_handle_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeArtifactPart {
    sha256: String,
    bytes: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeArtifact {
    spec: &'static str,
    document: &'static str,
    sandbox_tokens: [&'static str; 1],
    csp: &'static str,
    html: RuntimeArtifactPart,
    module: RuntimeArtifactPart,
    transferred_ports: u8,
    ambient_post_message: &'static str,
    intrinsics_captured_before_plugin_import: bool,
    plugin_import_realm: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStartResult {
    principal: RuntimePrincipal,
    permissions: Vec<String>,
    required_contracts: Vec<Value>,
    provided_contracts: Vec<Value>,
    host_commands: Vec<String>,
    event_topics: Vec<String>,
    bootstrap_envelope: Value,
    artifact: RuntimeArtifact,
    entry_sha256: String,
    session_binding_sha256: String,
    runtime_policy: RuntimePolicy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestRuntime {
    id: String,
    version: String,
    #[serde(default = "default_manifest_entry")]
    entry: Option<String>,
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default)]
    consumes: Vec<Value>,
    #[serde(default)]
    implements: Vec<Value>,
    #[serde(default)]
    runtime: RuntimePolicy,
}

fn default_manifest_entry() -> Option<String> {
    Some("main.js".to_string())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperStart {
    spec: String,
    kind: String,
    token: String,
    runtime_id: String,
    entry_code: String,
    entry_sha256: String,
    frame_csp: String,
    frame_bootstrap: String,
    web_rtc: bool,
    navigation_origins: Vec<String>,
    iframe_origins: Vec<String>,
    heartbeat_interval_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperOutput {
    spec: String,
    kind: String,
    token: String,
    runtime_id: String,
    #[serde(default)]
    envelope: Option<Value>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeEnvelopeEvent<'a> {
    runtime_id: &'a str,
    plugin_id: &'a str,
    generation: u64,
    envelope: &'a Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatusEvent<'a> {
    runtime_id: &'a str,
    plugin_id: &'a str,
    generation: u64,
    status: &'a str,
    reason: Option<String>,
}

#[derive(Clone)]
struct RuntimeRecord {
    runtime_id: String,
    tx: mpsc::Sender<SupervisorCommand>,
}

enum SupervisorCommand {
    Envelope(Value),
    Stop(oneshot::Sender<()>),
}

#[derive(Clone, Default)]
pub struct PluginRuntimeManager {
    runtimes: Arc<Mutex<HashMap<String, RuntimeRecord>>>,
    generations: Arc<Mutex<HashMap<String, u64>>>,
}

impl PluginRuntimeManager {
    fn next_generation(&self, plugin_id: &str) -> Result<u64, String> {
        let mut values = self.generations.lock().map_err(|e| e.to_string())?;
        let next = values
            .get(plugin_id)
            .copied()
            .unwrap_or(0)
            .saturating_add(1);
        values.insert(plugin_id.to_string(), next);
        Ok(next)
    }

    fn take(&self, plugin_id: &str) -> Result<Option<RuntimeRecord>, String> {
        Ok(self
            .runtimes
            .lock()
            .map_err(|e| e.to_string())?
            .remove(plugin_id))
    }

    fn insert(&self, plugin_id: String, record: RuntimeRecord) -> Result<(), String> {
        self.runtimes
            .lock()
            .map_err(|e| e.to_string())?
            .insert(plugin_id, record);
        Ok(())
    }

    fn remove_if(&self, plugin_id: &str, runtime_id: &str) {
        if let Ok(mut values) = self.runtimes.lock() {
            if values
                .get(plugin_id)
                .is_some_and(|value| value.runtime_id == runtime_id)
            {
                values.remove(plugin_id);
            }
        }
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn canonical_wrapper_module_bytes() -> Vec<u8> {
    let mut bytes = WRAPPER_BOOTSTRAP_MODULE.as_bytes().to_vec();
    bytes.extend_from_slice(b"\n");
    bytes.extend_from_slice(FRAME_BOOTSTRAP_MODULE.as_bytes());
    bytes.extend_from_slice(b"\n");
    bytes.extend_from_slice(FRAME_DOCUMENT_GUARD_MODULE.as_bytes());
    bytes
}

fn frame_document_guard_script(web_rtc: bool) -> String {
    format!(
        "globalThis.__SOKSAK_WEBRTC_ALLOWED__ = {};\n{FRAME_DOCUMENT_GUARD_MODULE}",
        if web_rtc { "true" } else { "false" }
    )
}

fn runtime_artifact() -> RuntimeArtifact {
    let module = canonical_wrapper_module_bytes();
    RuntimeArtifact {
        spec: WIRE_SPEC,
        document: "about:srcdoc",
        sandbox_tokens: ["allow-scripts"],
        csp: BOOTSTRAP_CSP,
        html: RuntimeArtifactPart {
            sha256: sha256(BOOTSTRAP_HTML.as_bytes()),
            bytes: BOOTSTRAP_HTML.len(),
        },
        module: RuntimeArtifactPart {
            sha256: sha256(&module),
            bytes: module.len(),
        },
        transferred_ports: 1,
        ambient_post_message: "deny",
        intrinsics_captured_before_plugin_import: true,
        plugin_import_realm: "opaque-child-frame-only",
    }
}

fn safe_id(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn configured_plugin_dir(plugin_id: &str) -> Result<PathBuf, String> {
    if !safe_id(plugin_id) {
        return Err(format!("invalid plugin id: {plugin_id:?}"));
    }
    let development = crate::unit_dev::unit_dev_list()?;
    if let Some(unit) = development
        .into_iter()
        .find(|unit| unit.kind == "plugin" && unit.id == plugin_id)
    {
        let path = PathBuf::from(unit.source);
        crate::path_security::reject_symlink_components(&path)?;
        if !path.is_dir() {
            return Err(format!(
                "configured plugin source is missing: {}",
                path.display()
            ));
        }
        return Ok(path);
    }
    let path = crate::home::soksak_home().join("plugins").join(plugin_id);
    crate::path_security::reject_symlink_components(&path)?;
    if !path.is_dir() {
        return Err(format!("installed plugin is missing: {plugin_id}"));
    }
    Ok(path)
}

fn parse_runtime_origin(value: &str) -> Result<String, String> {
    let url =
        Url::parse(value).map_err(|error| format!("invalid runtime origin {value:?}: {error}"))?;
    let local_http = url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !local_http {
        return Err(format!(
            "runtime origin must be https or loopback http: {value}"
        ));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(format!(
            "runtime origin must contain only scheme, host and port: {value}"
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn certify_runtime_policy(mut policy: RuntimePolicy) -> Result<RuntimePolicy, String> {
    let normalize = |values: Vec<String>, label: &str| -> Result<Vec<String>, String> {
        if values.len() > 64 {
            return Err(format!("{label} has more than 64 origins"));
        }
        let mut unique = HashSet::new();
        let mut result = Vec::new();
        for value in values {
            let origin = parse_runtime_origin(&value)?;
            if !unique.insert(origin.clone()) {
                return Err(format!("{label} contains duplicate origin: {origin}"));
            }
            result.push(origin);
        }
        result.sort();
        Ok(result)
    };
    policy.navigation_origins = normalize(policy.navigation_origins, "runtime.navigationOrigins")?;
    policy.iframe_origins = normalize(policy.iframe_origins, "runtime.iframeOrigins")?;
    Ok(policy)
}

fn safe_entry_path(dir: &Path, entry: &str) -> Result<PathBuf, String> {
    let relative = Path::new(entry);
    if entry.is_empty()
        || relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
        || !matches!(
            relative.extension().and_then(|value| value.to_str()),
            Some("js" | "mjs")
        )
    {
        return Err(format!("invalid plugin entry path: {entry:?}"));
    }
    let path = dir.join(relative);
    crate::path_security::reject_symlink_components(&path)?;
    if !path.is_file() {
        return Err(format!("plugin entry is missing: {}", path.display()));
    }
    Ok(path)
}

fn load_runtime_source(plugin_id: &str) -> Result<(ManifestRuntime, String, String), String> {
    let dir = configured_plugin_dir(plugin_id)?;
    let manifest_path = dir.join("plugin.json");
    crate::path_security::reject_symlink_components(&manifest_path)?;
    let bytes = std::fs::read(&manifest_path)
        .map_err(|error| format!("{} read failed: {error}", manifest_path.display()))?;
    let manifest: ManifestRuntime = serde_json::from_slice(&bytes)
        .map_err(|error| format!("{} parse failed: {error}", manifest_path.display()))?;
    if manifest.id != plugin_id {
        return Err(format!(
            "plugin id does not match configured source: {plugin_id} != {}",
            manifest.id
        ));
    }
    if manifest.version.is_empty() {
        return Err("plugin version is empty".to_string());
    }
    let entry = manifest
        .entry
        .as_deref()
        .ok_or_else(|| "contract-only plugin has no JavaScript runtime entry".to_string())?;
    let entry_path = safe_entry_path(&dir, entry)?;
    let code = std::fs::read(&entry_path)
        .map_err(|error| format!("{} read failed: {error}", entry_path.display()))?;
    if code.is_empty() || code.len() > MAX_ENTRY_BYTES {
        return Err(format!(
            "plugin entry size must be 1..={MAX_ENTRY_BYTES} bytes"
        ));
    }
    let code =
        String::from_utf8(code).map_err(|_| "plugin entry must be UTF-8 JavaScript".to_string())?;
    let entry_sha = sha256(code.as_bytes());
    Ok((manifest, code, entry_sha))
}

fn frame_csp(policy: &RuntimePolicy) -> String {
    let frames = policy
        .iframe_origins
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    let suffix = if frames.is_empty() {
        String::new()
    } else {
        format!(" {frames}")
    };
    format!("default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src data: blob:{suffix}; child-src data: blob:{suffix}; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'")
}

fn helper_start_script(config: &HelperStart) -> Result<String, String> {
    let value = json!({
        "transportSpec": TRANSPORT_SPEC,
        "token": config.token,
        "runtimeId": config.runtime_id,
        "entryCode": config.entry_code,
        "frameCsp": config.frame_csp,
        "frameBootstrap": config.frame_bootstrap,
        "webRtc": config.web_rtc,
        "heartbeatIntervalMs": config.heartbeat_interval_ms,
    });
    let encoded = serde_json::to_string(&value).map_err(|error| error.to_string())?;
    Ok(format!(
        "globalThis.__SOKSAK_NATIVE_START__ = {encoded};\n{WRAPPER_BOOTSTRAP_MODULE}"
    ))
}

fn session_binding(
    principal: &RuntimePrincipal,
    entry_sha256: &str,
    artifact: &RuntimeArtifact,
    runtime_policy: &RuntimePolicy,
) -> Result<String, String> {
    let bytes = serde_json::to_vec(&json!({
        "principal": principal,
        "entrySha256": entry_sha256,
        "bootstrapHtmlSha256": artifact.html.sha256,
        "bootstrapModuleSha256": artifact.module.sha256,
        "runtimePolicy": runtime_policy,
    }))
    .map_err(|error| error.to_string())?;
    Ok(sha256(&bytes))
}

fn validate_interface_names(values: &[String], label: &str) -> Result<(), String> {
    if values.len() > 2_048 {
        return Err(format!("{label} exceeds 2048 entries"));
    }
    let mut seen = HashSet::new();
    for value in values {
        if value.is_empty() || value.len() > 256 || !value.is_ascii() {
            return Err(format!("{label} contains invalid interface name"));
        }
        if !seen.insert(value) {
            return Err(format!("{label} contains duplicate interface: {value}"));
        }
    }
    Ok(())
}

async fn stop_record(record: RuntimeRecord) {
    let (done_tx, done_rx) = oneshot::channel();
    let _ = record.tx.send(SupervisorCommand::Stop(done_tx)).await;
    let _ = time::timeout(Duration::from_secs(2), done_rx).await;
}

#[tauri::command]
pub async fn plugin_runtime_start(
    window: Window,
    app: AppHandle,
    manager: State<'_, PluginRuntimeManager>,
    id: String,
    host_commands: Vec<String>,
    event_topics: Vec<String>,
) -> Result<RuntimeStartResult, String> {
    validate_interface_names(&host_commands, "hostCommands")?;
    validate_interface_names(&event_topics, "eventTopics")?;
    if let Some(previous) = manager.take(&id)? {
        stop_record(previous).await;
    }

    let (mut manifest, entry_code, entry_sha256) = load_runtime_source(&id)?;
    manifest.runtime = certify_runtime_policy(manifest.runtime)?;
    let generation = manager.next_generation(&id)?;
    let runtime_id = format!("runtime.{}", Uuid::new_v4());
    let session_id = format!("session.{}", Uuid::new_v4());
    let principal = RuntimePrincipal {
        runtime_id: runtime_id.clone(),
        session_id,
        window_label: window.label().to_string(),
        plugin_id: id.clone(),
        generation,
        role: "controller",
        contribution_id: "controller",
        instance_id: format!("controller.{generation}"),
        dom_handle_id: None,
    };
    let artifact = runtime_artifact();
    let binding = session_binding(&principal, &entry_sha256, &artifact, &manifest.runtime)?;
    let bootstrap = json!({
        "spec": WIRE_SPEC,
        "kind": "request",
        "seq": 1,
        "requestId": format!("bootstrap.{generation}"),
        "method": "runtime.bootstrap",
        "params": {
            "principal": principal,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "capabilities": manifest.permissions,
            "hostCommands": host_commands,
            "events": event_topics,
            "context": {
                "revision": 1,
                "theme": { "colorMode": "system", "tokens": {} },
                "locale": "en",
                "slot": null,
                "visible": false,
                "interactive": false,
                "instance": null
            },
            "bootstrapArtifactSha256": artifact.html.sha256
        }
    });
    let token = Uuid::new_v4().simple().to_string();
    let helper = HelperStart {
        spec: TRANSPORT_SPEC.to_string(),
        kind: "start".to_string(),
        token,
        runtime_id: runtime_id.clone(),
        entry_code,
        entry_sha256: entry_sha256.clone(),
        frame_csp: frame_csp(&manifest.runtime),
        frame_bootstrap: FRAME_BOOTSTRAP_MODULE.to_string(),
        web_rtc: manifest.runtime.web_rtc,
        navigation_origins: manifest.runtime.navigation_origins.clone(),
        iframe_origins: manifest.runtime.iframe_origins.clone(),
        heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
    };
    let (tx, rx) = mpsc::channel(128);
    let (ready_tx, ready_rx) = oneshot::channel();
    let record = RuntimeRecord {
        runtime_id: runtime_id.clone(),
        tx,
    };
    manager.insert(id.clone(), record)?;
    let manager_clone = manager.inner().clone();
    let task_app = app.clone();
    let task_window = window.label().to_string();
    let task_id = id.clone();
    let task_runtime = runtime_id.clone();
    tauri::async_runtime::spawn(async move {
        run_supervisor(
            task_app,
            manager_clone,
            task_window,
            task_id,
            task_runtime,
            generation,
            helper,
            rx,
            ready_tx,
        )
        .await;
    });
    match time::timeout(STARTUP_DEADLINE + Duration::from_secs(1), ready_rx).await {
        Ok(Ok(Ok(()))) => Ok(RuntimeStartResult {
            principal,
            permissions: manifest.permissions,
            required_contracts: manifest.consumes,
            provided_contracts: manifest.implements,
            host_commands,
            event_topics,
            bootstrap_envelope: bootstrap,
            artifact,
            entry_sha256,
            session_binding_sha256: binding,
            runtime_policy: manifest.runtime,
        }),
        Ok(Ok(Err(error))) => {
            manager.remove_if(&id, &runtime_id);
            Err(error)
        }
        Ok(Err(_)) | Err(_) => {
            if let Some(record) = manager.take(&id)? {
                stop_record(record).await;
            }
            Err(format!("plugin runtime helper startup timed out: {id}"))
        }
    }
}

#[tauri::command]
pub async fn plugin_runtime_send(
    manager: State<'_, PluginRuntimeManager>,
    runtime_id: String,
    envelope: Value,
) -> Result<(), String> {
    let encoded = serde_json::to_vec(&envelope).map_err(|error| error.to_string())?;
    if encoded.len() > 131_072 {
        return Err("plugin runtime envelope exceeds 131072 bytes".to_string());
    }
    let record = manager
        .runtimes
        .lock()
        .map_err(|error| error.to_string())?
        .values()
        .find(|record| record.runtime_id == runtime_id)
        .cloned()
        .ok_or_else(|| format!("plugin runtime not found: {runtime_id}"))?;
    record
        .tx
        .send(SupervisorCommand::Envelope(envelope))
        .await
        .map_err(|_| format!("plugin runtime is closed: {runtime_id}"))
}

#[tauri::command]
pub async fn plugin_runtime_stop(
    manager: State<'_, PluginRuntimeManager>,
    id: String,
) -> Result<bool, String> {
    let Some(record) = manager.take(&id)? else {
        return Ok(false);
    };
    stop_record(record).await;
    Ok(true)
}

async fn run_supervisor(
    app: AppHandle,
    manager: PluginRuntimeManager,
    window_label: String,
    plugin_id: String,
    runtime_id: String,
    generation: u64,
    helper: HelperStart,
    mut commands: mpsc::Receiver<SupervisorCommand>,
    ready: oneshot::Sender<Result<(), String>>,
) {
    let mut ready = Some(ready);
    let result = run_supervisor_inner(
        &app,
        &window_label,
        &plugin_id,
        &runtime_id,
        generation,
        helper,
        &mut commands,
        &mut ready,
    )
    .await;
    if let Some(sender) = ready.take() {
        let _ = sender
            .send(Err(result.clone().err().unwrap_or_else(|| {
                "plugin runtime exited before readiness".to_string()
            })));
    }
    manager.remove_if(&plugin_id, &runtime_id);
    let (status, reason) = match result {
        Ok(()) => ("stopped", None),
        Err(error) => ("faulted", Some(error)),
    };
    let _ = app.emit_to(
        &window_label,
        "plugin-runtime-status",
        RuntimeStatusEvent {
            runtime_id: &runtime_id,
            plugin_id: &plugin_id,
            generation,
            status,
            reason,
        },
    );
}

async fn run_supervisor_inner(
    app: &AppHandle,
    window_label: &str,
    plugin_id: &str,
    runtime_id: &str,
    generation: u64,
    helper: HelperStart,
    commands: &mut mpsc::Receiver<SupervisorCommand>,
    ready_sender: &mut Option<oneshot::Sender<Result<(), String>>>,
) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut command = Command::new(executable);
    command
        .arg(HELPER_ARGUMENT)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .env_clear();
    for name in ["HOME", "LANG", "LC_ALL", "TMPDIR"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    configure_process_containment(&mut command)?;
    let mut child = command
        .spawn()
        .map_err(|error| format!("plugin runtime helper spawn failed: {error}"))?;
    let _process_group_guard = ProcessGroupGuard::for_child(&child);
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "helper stdin missing".to_string())?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "helper stdout missing".to_string())?;
    write_async_frame(
        &mut stdin,
        &serde_json::to_vec(&helper).map_err(|e| e.to_string())?,
    )
    .await?;

    let deadline = time::sleep(STARTUP_DEADLINE);
    tokio::pin!(deadline);
    let mut helper_ready = false;
    loop {
        tokio::select! {
            frame = read_async_frame(&mut stdout) => {
                let bytes = match frame {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        terminate_child_group(&mut child).await;
                        return Err(error);
                    }
                };
                let output: HelperOutput = match serde_json::from_slice(&bytes) {
                    Ok(output) => output,
                    Err(error) => {
                        terminate_child_group(&mut child).await;
                        return Err(format!("invalid helper frame: {error}"));
                    }
                };
                if output.spec != TRANSPORT_SPEC || output.token != helper.token || output.runtime_id != runtime_id {
                    terminate_child_group(&mut child).await;
                    return Err("helper authentication or runtime binding failed".to_string());
                }
                match output.kind.as_str() {
                    "ready" => {
                        if helper_ready {
                            terminate_child_group(&mut child).await;
                            return Err("helper emitted duplicate ready".to_string());
                        }
                        helper_ready = true;
                        deadline.as_mut().reset(Instant::now() + HEARTBEAT_DEADLINE);
                        if let Some(sender) = ready_sender.take() {
                            let _ = sender.send(Ok(()));
                        }
                    }
                    "heartbeat" if helper_ready => {
                        deadline.as_mut().reset(Instant::now() + HEARTBEAT_DEADLINE);
                    }
                    "envelope" if helper_ready => {
                        let envelope = output.envelope.ok_or_else(|| "helper envelope missing".to_string())?;
                        app.emit_to(window_label, "plugin-runtime-envelope", RuntimeEnvelopeEvent {
                            runtime_id,
                            plugin_id,
                            generation,
                            envelope: &envelope,
                        }).map_err(|error| format!("runtime envelope delivery failed: {error}"))?;
                    }
                    "fault" => {
                        terminate_child_group(&mut child).await;
                        return Err(output.message.unwrap_or_else(|| "helper fault".to_string()));
                    }
                    other => {
                        terminate_child_group(&mut child).await;
                        return Err(format!("unexpected helper frame kind: {other}"));
                    }
                }
            }
            command = commands.recv() => {
                match command {
                    Some(SupervisorCommand::Envelope(envelope)) if helper_ready => {
                        let frame = json!({
                            "spec": TRANSPORT_SPEC,
                            "kind": "envelope",
                            "token": helper.token,
                            "runtimeId": runtime_id,
                            "envelope": envelope,
                        });
                        write_async_frame(&mut stdin, &serde_json::to_vec(&frame).map_err(|e| e.to_string())?).await?;
                    }
                    Some(SupervisorCommand::Envelope(_)) => {
                        terminate_child_group(&mut child).await;
                        return Err("host envelope arrived before helper readiness".to_string());
                    }
                    Some(SupervisorCommand::Stop(done)) => {
                        let frame = json!({
                            "spec": TRANSPORT_SPEC,
                            "kind": "stop",
                            "token": helper.token,
                            "runtimeId": runtime_id,
                        });
                        let _ = write_async_frame(&mut stdin, &serde_json::to_vec(&frame).unwrap_or_default()).await;
                        terminate_child_group(&mut child).await;
                        let _ = done.send(());
                        return Ok(());
                    }
                    None => {
                        terminate_child_group(&mut child).await;
                        return Ok(());
                    }
                }
            }
            _ = &mut deadline => {
                let phase = if helper_ready { "heartbeat" } else { "startup" };
                terminate_child_group(&mut child).await;
                return Err(format!("plugin runtime {phase} deadline exceeded"));
            }
            status = child.wait() => {
                return match status {
                    Ok(status) => Err(format!("plugin runtime helper exited: {status}")),
                    Err(error) => Err(format!("plugin runtime helper wait failed: {error}")),
                };
            }
        }
    }
}

struct ProcessGroupGuard {
    #[cfg(unix)]
    process_group: Option<i32>,
}

impl ProcessGroupGuard {
    fn for_child(child: &tokio::process::Child) -> Self {
        Self {
            #[cfg(unix)]
            process_group: child.id().map(|id| id as i32),
        }
    }
}

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(process_group) = self.process_group {
            unsafe {
                libc::killpg(process_group, libc::SIGKILL);
            }
        }
    }
}

async fn terminate_child_group(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(process_group) = child.id() {
        unsafe {
            libc::killpg(process_group as i32, libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

#[cfg(unix)]
fn configure_process_containment(command: &mut Command) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    command.as_std_mut().process_group(0);
    Ok(())
}

#[cfg(windows)]
fn configure_process_containment(_command: &mut Command) -> Result<(), String> {
    // The supervisor/helper interface is process-based on every platform.  Windows packaging
    // must attach this child to the app Job Object before third-party conformance is certified.
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn configure_process_containment(_command: &mut Command) -> Result<(), String> {
    Ok(())
}

async fn read_async_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, String> {
    let length = reader
        .read_u32()
        .await
        .map_err(|error| format!("helper frame length read failed: {error}"))?
        as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(format!(
            "helper frame length outside 1..={MAX_FRAME_BYTES}: {length}"
        ));
    }
    let mut bytes = vec![0; length];
    reader
        .read_exact(&mut bytes)
        .await
        .map_err(|error| format!("helper frame body read failed: {error}"))?;
    Ok(bytes)
}

async fn write_async_frame<W: AsyncWrite + Unpin>(
    writer: &mut W,
    bytes: &[u8],
) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err(format!(
            "helper frame length outside 1..={MAX_FRAME_BYTES}: {}",
            bytes.len()
        ));
    }
    writer
        .write_u32(bytes.len() as u32)
        .await
        .map_err(|error| format!("helper frame length write failed: {error}"))?;
    writer
        .write_all(bytes)
        .await
        .map_err(|error| format!("helper frame body write failed: {error}"))?;
    writer.flush().await.map_err(|error| error.to_string())
}

fn read_sync_frame<R: Read>(reader: &mut R) -> Result<Vec<u8>, String> {
    let mut header = [0u8; 4];
    reader
        .read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(format!(
            "helper frame length outside 1..={MAX_FRAME_BYTES}: {length}"
        ));
    }
    let mut bytes = vec![0; length];
    reader
        .read_exact(&mut bytes)
        .map_err(|error| error.to_string())?;
    Ok(bytes)
}

fn write_sync_frame<W: Write>(writer: &mut W, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err(format!(
            "helper frame length outside 1..={MAX_FRAME_BYTES}: {}",
            bytes.len()
        ));
    }
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(|error| error.to_string())?;
    writer.write_all(bytes).map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

pub fn helper_requested() -> bool {
    std::env::args_os()
        .nth(1)
        .is_some_and(|value| value == HELPER_ARGUMENT)
}

#[derive(Debug)]
enum HelperUserEvent {
    Envelope(Value),
    Stop,
    InputFault(String),
}

pub fn run_helper_from_stdio() -> Result<(), String> {
    let start_bytes = read_sync_frame(&mut std::io::stdin().lock())?;
    let start: HelperStart =
        serde_json::from_slice(&start_bytes).map_err(|error| error.to_string())?;
    if start.spec != TRANSPORT_SPEC || start.kind != "start" {
        return Err("invalid helper start frame".to_string());
    }
    if sha256(start.entry_code.as_bytes()) != start.entry_sha256 {
        return Err("plugin entry digest mismatch in helper".to_string());
    }
    let policy = RuntimePolicy {
        navigation_origins: start.navigation_origins.clone(),
        iframe_origins: start.iframe_origins.clone(),
        web_rtc: start.web_rtc,
    };
    let policy = certify_runtime_policy(policy)?;
    let init_script = helper_start_script(&start)?;

    use tao::{
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoopBuilder},
        window::WindowBuilder,
    };
    use wry::{http::Request, NewWindowResponse, WebViewBuilder};

    let event_loop = EventLoopBuilder::<HelperUserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let reader_proxy = proxy.clone();
    let expected_token = start.token.clone();
    let expected_runtime = start.runtime_id.clone();
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            let bytes = match read_sync_frame(&mut input) {
                Ok(value) => value,
                Err(error) => {
                    let _ = reader_proxy.send_event(HelperUserEvent::InputFault(error));
                    return;
                }
            };
            let value: Value = match serde_json::from_slice(&bytes) {
                Ok(value) => value,
                Err(error) => {
                    let _ = reader_proxy.send_event(HelperUserEvent::InputFault(error.to_string()));
                    return;
                }
            };
            if value.get("spec").and_then(Value::as_str) != Some(TRANSPORT_SPEC)
                || value.get("token").and_then(Value::as_str) != Some(&expected_token)
                || value.get("runtimeId").and_then(Value::as_str) != Some(&expected_runtime)
            {
                let _ = reader_proxy.send_event(HelperUserEvent::InputFault(
                    "host frame authentication failed".to_string(),
                ));
                return;
            }
            match value.get("kind").and_then(Value::as_str) {
                Some("envelope") => {
                    let Some(envelope) = value.get("envelope").cloned() else {
                        let _ = reader_proxy.send_event(HelperUserEvent::InputFault(
                            "host envelope missing".to_string(),
                        ));
                        return;
                    };
                    let _ = reader_proxy.send_event(HelperUserEvent::Envelope(envelope));
                }
                Some("stop") => {
                    let _ = reader_proxy.send_event(HelperUserEvent::Stop);
                    return;
                }
                _ => {
                    let _ = reader_proxy.send_event(HelperUserEvent::InputFault(
                        "unknown host frame".to_string(),
                    ));
                    return;
                }
            }
        }
    });

    let window = WindowBuilder::new()
        .with_title(format!("soksak plugin runtime {}", start.runtime_id))
        .with_visible(false)
        .build(&event_loop)
        .map_err(|error| error.to_string())?;
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let output = stdout.clone();
    let ipc_token = start.token.clone();
    let ipc_runtime = start.runtime_id.clone();
    let handler = move |request: Request<String>| {
        let raw = request.body();
        if raw.len() > MAX_FRAME_BYTES {
            return;
        }
        let value: Value = match serde_json::from_str(raw) {
            Ok(value) => value,
            Err(_) => return,
        };
        if value.get("spec").and_then(Value::as_str) != Some(TRANSPORT_SPEC)
            || value.get("token").and_then(Value::as_str) != Some(&ipc_token)
            || value.get("runtimeId").and_then(Value::as_str) != Some(&ipc_runtime)
        {
            return;
        }
        let bytes = match serde_json::to_vec(&value) {
            Ok(bytes) => bytes,
            Err(_) => return,
        };
        if let Ok(mut writer) = output.lock() {
            let _ = write_sync_frame(&mut *writer, &bytes);
        }
    };
    let allowed_origins: HashSet<String> = policy
        .navigation_origins
        .iter()
        .chain(policy.iframe_origins.iter())
        .cloned()
        .collect();
    let navigation = move |raw: String| {
        if raw == "about:blank"
            || raw == "about:srcdoc"
            || raw.starts_with("blob:")
            || raw.starts_with("data:text/html")
        {
            return true;
        }
        Url::parse(&raw)
            .ok()
            .map(|url| allowed_origins.contains(&url.origin().ascii_serialization()))
            .unwrap_or(false)
    };
    let webview = WebViewBuilder::new()
        .with_html(BOOTSTRAP_HTML)
        .with_initialization_script_for_main_only(
            frame_document_guard_script(policy.web_rtc),
            false,
        )
        .with_initialization_script_for_main_only(init_script, true)
        .with_ipc_handler(handler)
        .with_navigation_handler(navigation)
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_incognito(true)
        .with_devtools(false)
        .build(&window)
        .map_err(|error| error.to_string())?;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(HelperUserEvent::Envelope(envelope)) => {
                if let Ok(encoded) = serde_json::to_string(&envelope) {
                    let _ = webview
                        .evaluate_script(&format!("globalThis.__soksakRuntimeDeliver({encoded});"));
                }
            }
            Event::UserEvent(HelperUserEvent::Stop) => {
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(HelperUserEvent::InputFault(message)) => {
                let value = json!({
                    "spec": TRANSPORT_SPEC,
                    "kind": "fault",
                    "token": start.token,
                    "runtimeId": start.runtime_id,
                    "message": message,
                });
                if let Ok(bytes) = serde_json::to_vec(&value) {
                    if let Ok(mut writer) = stdout.lock() {
                        let _ = write_sync_frame(&mut *writer, &bytes);
                    }
                }
                *control_flow = ControlFlow::Exit;
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_framing_is_bounded_and_round_trips() {
        let mut bytes = Vec::new();
        write_sync_frame(&mut bytes, br#"{"ok":true}"#).unwrap();
        assert_eq!(
            read_sync_frame(&mut bytes.as_slice()).unwrap(),
            br#"{"ok":true}"#
        );

        let mut oversized = Vec::new();
        oversized.extend_from_slice(&((MAX_FRAME_BYTES + 1) as u32).to_be_bytes());
        assert!(read_sync_frame(&mut oversized.as_slice()).is_err());
        assert!(write_sync_frame(&mut Vec::new(), &vec![0; MAX_FRAME_BYTES + 1]).is_err());
    }

    #[test]
    fn runtime_origins_are_exact_and_network_safe() {
        assert_eq!(
            parse_runtime_origin("https://example.com:8443").unwrap(),
            "https://example.com:8443"
        );
        assert!(parse_runtime_origin("http://example.com").is_err());
        assert!(parse_runtime_origin("https://user@example.com").is_err());
        assert!(parse_runtime_origin("https://example.com/path").is_err());
        assert!(parse_runtime_origin("file:///tmp/plugin.html").is_err());
        assert!(parse_runtime_origin("http://127.0.0.1:5173").is_ok());
    }

    #[test]
    fn canonical_artifact_hashes_its_exact_bytes() {
        let artifact = runtime_artifact();
        assert_eq!(artifact.html.sha256, sha256(BOOTSTRAP_HTML.as_bytes()));
        assert_eq!(artifact.html.bytes, BOOTSTRAP_HTML.len());
        let module = canonical_wrapper_module_bytes();
        assert_eq!(artifact.module.sha256, sha256(&module));
        assert_eq!(artifact.module.bytes, module.len());
        assert_eq!(artifact.sandbox_tokens, ["allow-scripts"]);
        assert!(String::from_utf8(module)
            .unwrap()
            .contains(FRAME_DOCUMENT_GUARD_MODULE));
    }

    #[test]
    fn helper_script_contains_data_assignment_then_canonical_module() {
        let config = HelperStart {
            spec: TRANSPORT_SPEC.to_string(),
            kind: "start".to_string(),
            token: "secret".to_string(),
            runtime_id: "runtime.test".to_string(),
            entry_code: "export default {}".to_string(),
            entry_sha256: sha256(b"export default {}"),
            frame_csp: frame_csp(&RuntimePolicy::default()),
            frame_bootstrap: FRAME_BOOTSTRAP_MODULE.to_string(),
            web_rtc: false,
            navigation_origins: Vec::new(),
            iframe_origins: Vec::new(),
            heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
        };
        let script = helper_start_script(&config).unwrap();
        assert!(script.contains("__SOKSAK_NATIVE_START__"));
        assert!(script.ends_with(WRAPPER_BOOTSTRAP_MODULE));
        assert!(!BOOTSTRAP_HTML.contains("export default"));

        let guard = frame_document_guard_script(false);
        assert!(guard.starts_with("globalThis.__SOKSAK_WEBRTC_ALLOWED__ = false;"));
        assert!(guard.ends_with(FRAME_DOCUMENT_GUARD_MODULE));
        assert!(guard.contains("RTCPeerConnection"));
        assert!(guard.contains("__TAURI_INTERNALS__"));
    }

    // srcdoc 의 <script> 는 HTML 에 정확히 </script> 로 닫혀야 실행된다. JS 템플릿에서
    // 태그 분리는 <\/script>(백슬래시 1) — raw string 에 \\ 를 쓰면 HTML 에 <\/script>
    // 텍스트가 남아 script 가 영영 닫히지 않고, frame 부트스트랩 전체가 침묵 미실행된다.
    #[test]
    fn wrapper_srcdoc_script_closer_reaches_html_as_real_end_tag() {
        assert!(
            WRAPPER_BOOTSTRAP_MODULE.contains(r"<\/script>"),
            "srcdoc closer must be the JS idiom <\\/script> (single backslash)"
        );
        assert!(
            !WRAPPER_BOOTSTRAP_MODULE.contains(r"<\\/script>"),
            "double backslash survives the raw string and corrupts the HTML end tag"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn containment_termination_reaps_the_helper_process_group() {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg("sleep 30 & wait");
        configure_process_containment(&mut command).unwrap();
        let mut child = command.spawn().unwrap();
        let process_group = child.id().unwrap() as i32;

        terminate_child_group(&mut child).await;

        assert!(child.try_wait().unwrap().is_some());
        let group_exists = unsafe { libc::killpg(process_group, 0) } == 0;
        assert!(
            !group_exists,
            "the helper process group must be empty after termination"
        );
    }
}
