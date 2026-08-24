// system.* — socket negotiation surface exposed through the command registry (single source of truth).
// system.hello: greet the app and read the socket protocol version, the oldest client protocol still
// served, and app identity. The transport answers this before the registry (so it replies even when the
// webview is wedged); the registry handler returns the same facts via the ipc_hello_info core command,
// so the command is discoverable and actually runs on every path.

import { engineProvision, framework, frameworkName, invoke } from "../framework";
import { tmsg, key} from "../i18n";
import { register } from "./registry";
import { persistWindowNow } from "../state/windowPersistRequest";

export function registerSystemCatalog(): void {
  register("system.hello", {
    description: key("cmd.system.hello.desc"),
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
    // Delegates to the core command that produces the same hello_facts as the transport's direct
    // reply — one source for the protocol constants, no forged copy.
    handler: () => invoke("ipc_hello_info"),
  });

  // With no name to quit by, the harness borrows the operating system (`osascript ... to quit`) —
  // hence this command (A27). Its own death cannot be recorded after the fact, so the record is
  // written before the framework quits.
  //
  // Two apps on one home hold the same name. This command quits **the app that hosts the calling
  // window** — that is why it is window-scoped (turning windowScoped off kills both apps).
  register("app.shutdown.commit", {
    description: key("cmd.app.shutdown.commit.desc"),
    triggers: { ko: "앱 종료 끄기 quit" },
    params: {
      framework: {
        type: "string",
        required: false,
        description: key("cmd.app.shutdown.commit.param.framework"),
      },
    },
    danger: "destructive",
    returns: "{ quit, framework }",
    message: (d) =>
      d.quit ? tmsg("msg.app.quit") : tmsg("msg.app.quit.notMine", { framework: String(d.framework) }),
    examples: ["app.shutdown.commit", 'app.shutdown.commit \'{"framework":"wails"}\''],
    // Quitting is an irreversible side effect that can destroy the result reply. The native boundary
    // is called only after the socket executor finished delivering cmd_result. No renderer timer, no
    // per-framework delay.
    //
    // **Who answered is returned as a value.** In a fan-out call with no name, the caller cannot
    // tell which app died and which survived — for an irreversible command that ignorance equals
    // being unobservable.
    handler: async (params, ctx) => {
      if (!ctx.afterReply) {
        throw new Error(tmsg("msg.app.shutdown.noReplyBoundary"));
      }
      const wanted = typeof params.framework === "string" ? params.framework : null;
      // A call naming someone else does not quit this app. The answer is the same whether it already
      // quit or not (idempotent).
      if (wanted !== null && wanted !== frameworkName) {
        return { quit: false, framework: frameworkName };
      }
      // This window's record first, and awaited. It is written asynchronously and the reap below
      // ends the process, so a save started and not waited for loses the race — measured
      // 2026-08-16: a workspace window opened and quit left no ledger and no snapshot, and the
      // window did not come back with nothing reporting why.
      await persistWindowNow();
      const receipt = await invoke<{
        phase: string;
        reaped: boolean;
        processChildrenReaped: number;
        localPtysReaped: number;
        daemonPtysTransferred: number;
        daemonsReaped: number;
        servicesReaped: number;
        nativeWindowsDrained: number;
        nativeSurfacesDrained: number;
        nativePaneHostsDrained: number;
        nativeInputMonitorsDrained: number;
        nativeRemaining: number;
      }>("app_shutdown_prepare");
      const counts = [
        receipt.processChildrenReaped,
        receipt.localPtysReaped,
        receipt.daemonPtysTransferred,
        receipt.daemonsReaped,
        receipt.servicesReaped,
        receipt.nativeWindowsDrained,
        receipt.nativeSurfacesDrained,
        receipt.nativePaneHostsDrained,
        receipt.nativeInputMonitorsDrained,
        receipt.nativeRemaining,
      ];
      if (
        receipt.phase !== "reaped"
        || receipt.reaped !== true
        || counts.some((count) => !Number.isSafeInteger(count) || count < 0)
        || receipt.nativeRemaining !== 0
      ) {
        throw new Error(tmsg("msg.app.shutdown.receiptInvalid"));
      }
      ctx.afterReply(() => invoke("app_shutdown_commit"));
      return { quit: true, framework: frameworkName, shutdown: receipt };
    },
  });

  register("app.environment", {
    description: key("cmd.app.environment.desc"),
    triggers: { ko: "앱 환경 코어 빌드 홈 CLI 개발 유닛 모드" },
    params: {},
    // The owner defines the answer — identical from any window (registry.ts windowScoped).
    windowScoped: false,
    returns:
      "{ coreBuild, identity, cli, home, loginShell, buildProfile, updaterEnabled, unitMode, developmentUnits[], presentation:{ mode:'interactive'|'capture-only', desktopVisible:boolean } }",
    message: (d) =>
      tmsg("msg.app.environment", {
        core: String(d.coreBuild),
        mode: String(d.unitMode),
      }),
    examples: ["app.environment"],
    handler: async () => ({
      ...await invoke<Record<string, unknown>>("app_environment"),
      presentation: await invoke("app_presentation"),
    }),
  });

  // What the framework provides — the deciding side must be **able to query it**.
  //
  // Two frameworks keep the same guarantee in different places. "The browser view is alive" is a
  // list of native child surfaces in one and the rect of an in-page element in the other. With no
  // place to ask, the deciding side pins one shape as the answer and, on the other framework, that
  // check fails looking for something that does not exist — the criterion is not wrong, the place it
  // measures is.
  //
  // This is a capability declaration, not a name branch. name is used only in the ledger and in
  // diagnostics; decisions branch on the axes (chromium, nativeChildWebview, engineModules) — one
  // more framework leaves the deciding code unchanged.
  register("framework.provision", {
    description: key("cmd.framework.provision.desc"),
    triggers: { ko: "프레임워크 능력 제공 축 네이티브 자식 웹뷰 엔진" },
    params: {},
    returns: "{ name, chromium, nativeChildWebview, engineModules, supportsDocumentStart, supportsInputInjection }",
    message: (d) =>
      tmsg("msg.framework.provision", {
        name: String(d.name ?? ""),
        views: String(d.nativeChildWebview ? "native" : "in-page"),
      }),
    examples: ["framework.provision"],
    handler: () => ({
      name: framework.name,
      chromium: engineProvision.chromium,
      nativeChildWebview: engineProvision.nativeChildWebview,
      engineModules: engineProvision.engineModules,
      supportsDocumentStart: engineProvision.supportsDocumentStart,
      supportsInputInjection: engineProvision.supportsInputInjection,
    }),
  });
}
