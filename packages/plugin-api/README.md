# @soksak-ai/plugin-api — isolated runtime 0.0.1

The 0.0.1 contract separates two security boundaries. An opaque-origin iframe provides the
confidentiality/integrity boundary for a plugin's DOM, globals, storage, and
bridge access. Availability comes from a dedicated native runtime WebView or
process-pool unit that the host can terminate without terminating the shell or
another plugin. Plugin JavaScript is never imported into the main shell renderer.

The dedicated native runtime owns a trusted wrapper. That wrapper creates
`about:srcdoc` frames with only `sandbox="allow-scripts"`, transfers exactly one
`MessagePort`, captures trusted intrinsics, and only then imports plugin bytes
from a verified blob URL. Ambient `postMessage` is not a runtime channel.

The iframe is intentionally useful UI infrastructure, not a blanket UI ban. The
same provider renders a real view or a preview; a preview receives an immutable,
bounded fixture and no capability, host command, event, or resource surface.

## Static module

```ts
import { defineSoksakPlugin } from "@soksak-ai/plugin-api";

export default defineSoksakPlugin({
  controller: {
    async activate({ app }) {
      await app.events.subscribe("project.changed", () => {});
    },
  },
  commands: {
    async refresh(_params, { app }) {
      return app.commands.execute("git.status", {});
    },
  },
  views: {
    main: {
      mount({ root }) {
        root.textContent = "hello";
      },
    },
  },
});
```

`commands`, `views`, `fileViewers`, and `overlays` are static executable maps.
Their keys are checked against the real parsed `PluginManifest`. Commands with
`bind:"service"` are derived separately and must not have a JavaScript handler.
Icon sets are verified logical data assets declared by the manifest and release;
they are not executable module exports.

The controller document is non-visual. A visual provider receives an immutable
context revision containing theme tokens, color mode, locale, host-owned slot,
visibility, interactivity, and instance data. Provider `update` is driven by the
public monotonic context-update wire; no polling is involved.

## One application interface

The public Command Registry is the sole source of host functionality. The SDK
does not copy git, storage, filesystem, network, PTY, or webview APIs into a
second operation vocabulary. `app.commands.execute()` names a registered command;
the host validates that command's params, return, danger, permission, and domain
contract before injecting the authenticated principal and any namespace, path,
window label, credentials, resource handles, or placement authority.

Event subscriptions and bounded resource streams are transport primitives.
Binary data uses transferable `ArrayBuffer` chunks with acknowledgement,
backpressure, and a declared total limit. DOM automation uses frame-owned opaque
node IDs or exact manifest-declared `data-node` addresses, paged snapshots,
measure, and input. Arbitrary CSS selectors and closed shadow roots are forbidden.

## Mandatory native conformance gate

TypeScript tests cannot prove native isolation. Every platform/Tauri revision
must produce a report bound to the exact bootstrap HTML, CSP, wrapper module
digests, and sizes. Live probes must cover ambient messaging, storage/cookies,
prototype mutation, permission APIs, WebRTC/WebTransport, preconnect, raw IPC,
navigation, external requests, and all intended positive rendering/DOM paths.

The availability probe injects an infinite loop and proves that host heartbeat
and CLI remain responsive and that terminating the runtime kills only the
faulting unit. Until those live attack, positive, and unit-only termination probes
pass for a target, third-party plugins stay disabled on that target.

`soksak-spec-plugin-runtime@0.0.1` identifies the runtime, bootstrap, and
conformance identity. This pre-release baseline makes no forward or backward
compatibility promise. There is no npm publication or npm-registry dependency
path; verified GitHub Release assets are the distribution source.
