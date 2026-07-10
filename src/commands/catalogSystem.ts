// system.* — socket negotiation surface exposed through the command registry (single source of truth).
// system.hello: greet the app and read the socket protocol version, the oldest client protocol still
// served, and app identity. The transport answers this before the registry (so it replies even when the
// webview is wedged); the registry handler returns the same facts via the ipc_hello_info core command,
// so the command is discoverable and actually runs on every path.

import { tmsg } from "../i18n";
import { register } from "./registry";

export function registerSystemCatalog(): void {
  register("system.hello", {
    description:
      "Greet the app and read the socket protocol version, the oldest client protocol still served, and app identity (version, pid, start time, capabilities). A client sends this first to detect version skew before issuing commands. Also answered at the transport, so it replies even when the front is wedged.",
    triggers: { ko: "협상 핸드셰이크 헬로 인사 프로토콜 버전 스큐 호환 접속" },
    params: {},
    returns:
      "{ protocol, minClientProtocol, appVersion, identity, pid, startedAt, capabilities[] } — the socket protocol version, the oldest client protocol still served, and app identity.",
    message: (d) =>
      tmsg("msg.system.hello", {
        protocol: Number(d.protocol ?? 0),
        version: String(d.appVersion ?? ""),
      }),
    examples: ["sok hello"],
    // RED: 아직 transport 와 같은 소스로 위임하지 않는다 — 빈 사실을 낸다.
    handler: () => ({}),
  });
}
