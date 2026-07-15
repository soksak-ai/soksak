// 자동 업데이트 오케스트레이터(update.*)는 중단 범위가 작은 축부터 적용한다.
// 플러그인 축은 인증된 owner release와 전체 plugin/sidecar/kit closure를 원자 교체한다.
// PTY daemon은 fd-handoff로 세션을 보존하고, 앱 본체는 release identity에서만 재시작한다.
import { invoke } from "@tauri-apps/api/core";
import { register } from "./registry";
import { tmsg } from "../i18n";
import { usePlugins } from "../state/plugins";
import { publishActivity } from "../state/activityFeed";
import { updateCertifiedRegistryPlugin } from "../plugins/registryInstallService";

/** 앱 본체 원격 판 조회 — release 게이트·tauri-updater latest.json 검증은 Rust 경계 소유(updater.rs). */
async function checkApp(): Promise<Record<string, unknown>> {
  return (await invoke("update_check")) as Record<string, unknown>;
}

export function registerUpdateCatalog(): void {
  register("update.check", {
    description:
      "Survey what can be updated without applying anything. Reports the app body (release channel only — a debug/dev build has no remote updater and comes back available:false), plus a count of the hot axes update.apply can roll: installed plugins and the running PTY daemon. Read this first; update.apply does the work.",
    triggers: { ko: "업데이트 점검 확인 새 버전" },
    params: {},
    returns:
      "{ channel, app: { available, version? }, plugins: { installed }, daemon: { running, sessions? } }",
    message: (d) => {
      const app = d.app as { available?: boolean } | undefined;
      return tmsg("msg.update.check", {
        app: tmsg(app?.available ? "msg.update.available" : "msg.update.uptodate"),
      });
    },
    errors: ["INTERNAL"],
    examples: ["sok update.check"],
    handler: async () => {
      const app = await checkApp();
      const installed = Object.values(usePlugins.getState().plugins).filter(
        (p) => p.source !== "dev",
      ).length;
      let daemon: Record<string, unknown> = { running: false };
      try {
        daemon = (await invoke("pty_daemon_status")) as Record<string, unknown>;
      } catch {
        // 데몬 조회 실패는 점검을 막지 않는다 — running:false 로 보고된다.
      }
      if (app.available)
        publishActivity("update.available", "core", { version: app.version });
      return {
        channel: app.channel,
        app,
        plugins: { installed },
        daemon: { running: daemon.running, sessions: daemon.sessions },
      };
    },
  });

  register("update.apply", {
    description:
      "Apply updates across every hot axis, least-disruptive first: authenticated plugin release closures, the PTY daemon with fd-handoff, then the app body in a release identity. Each result is announced on the activity bus.",
    triggers: { ko: "업데이트 적용 설치 새 버전 갱신 핫스왑" },
    params: {
      plugins: {
        type: "boolean",
        description: "Update installed plugin release closures. Default true.",
      },
      daemon: {
        type: "boolean",
        description: "Hot-upgrade the PTY daemon (fd-handoff drain). Default true.",
      },
      app: {
        type: "boolean",
        description: "Update the app body (release channel only). Default true.",
      },
    },
    returns: "{ applied: [{ axis, ... }], skipped: [{ axis, reason }] }",
    // ptyd 판올림·앱 relaunch 를 포함 — 원격/AI 호출은 권한 게이트를 거친다.
    danger: "destructive",
    message: (d) => tmsg("msg.update.apply", { n: ((d.applied as unknown[]) ?? []).length }),
    errors: ["INTERNAL"],
    examples: ["sok update.apply", 'sok update.apply \'{"app":false}\''],
    handler: async (p) => {
      const applied: Record<string, unknown>[] = [];
      const skipped: Record<string, unknown>[] = [];
      const want = (k: string) => p[k] !== false; // 생략 = 그 축 실행, false = 건너뜀.

      // ① 플러그인 — owner release와 전이 closure 전체를 검증한 뒤 원자 교체한다.
      if (want("plugins")) {
        const entries = Object.entries(usePlugins.getState().plugins).filter(
          ([, pl]) => pl.source !== "dev",
        );
        for (const [id] of entries) {
          const r = await updateCertifiedRegistryPlugin(id);
          if (r.ok) {
            applied.push({ axis: "plugin", id, version: r.version });
            publishActivity("update.applied", "core", { axis: "plugin", id });
          } else {
            skipped.push({ axis: "plugin", id, reason: r.code });
          }
        }
      }

      // ② ptyd — fd-handoff drain(라이브 셸 무손실, SIGHUP 없음).
      if (want("daemon")) {
        try {
          const r = (await invoke("pty_daemon_upgrade")) as Record<string, unknown>;
          applied.push({ axis: "daemon", sessions: r.sessions, pid: r.pid });
          publishActivity("update.applied", "core", { axis: "daemon", sessions: r.sessions });
        } catch (e) {
          skipped.push({ axis: "daemon", reason: String(e) });
        }
      }

      // ③ 앱 본체 — release identity에서 새 판이 실제로 있을 때만 설치·재시작한다.
      if (want("app")) {
        if (!usePlugins.getState().release) {
          skipped.push({ axis: "app", reason: "CHANNEL" });
          publishActivity("update.skipped", "core", { axis: "app", reason: "channel" });
        } else {
          const chk = await checkApp();
          if (chk.available) {
            const inst = (await invoke("update_apply")) as Record<string, unknown>;
            applied.push({ axis: "app", version: inst.version });
            publishActivity("update.applied", "core", { axis: "app", version: inst.version });
            // 프로세스 교체 — 반환하지 않는다(복원 사다리가 창·터미널 세션을 되살린다). HS1: 앱 본체가 최후.
            await invoke("app_relaunch");
          } else {
            skipped.push({ axis: "app", reason: "UPTODATE" });
          }
        }
      }

      return { applied, skipped };
    },
  });
}
