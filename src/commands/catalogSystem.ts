// system.* — socket negotiation surface exposed through the command registry (single source of truth).
// system.hello: greet the app and read the socket protocol version, the oldest client protocol still
// served, and app identity. The transport answers this before the registry (so it replies even when the
// webview is wedged); the registry handler returns the same facts via the ipc_hello_info core command,
// so the command is discoverable and actually runs on every path.

import { invoke } from "@tauri-apps/api/core";
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
    examples: ["hello"],
    // transport 즉답과 같은 hello_facts 를 내는 코어 커맨드로 위임 — 판 상수 단일 출처, 위조 복제 없음.
    handler: () => invoke("ipc_hello_info"),
  });

  register("app.environment", {
    description:
      "Read this app's compile-time core identity, isolated home, matching CLI name, build profile, updater channel, and explicitly selected development units.",
    triggers: { ko: "앱 환경 코어 빌드 홈 CLI 개발 유닛 모드" },
    params: {},
    returns:
      "{ coreBuild, identity, cli, home, buildProfile, updaterEnabled, unitMode, developmentUnits[] }",
    message: (d) =>
      tmsg("msg.app.environment", {
        core: String(d.coreBuild),
        mode: String(d.unitMode),
      }),
    examples: ["app.environment"],
    handler: () => invoke("app_environment"),
  });
}
