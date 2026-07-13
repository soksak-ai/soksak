// 자동 업데이트 오케스트레이터(update.*) — 핫스왑 축을 HS1 순서(무중단 → 재시작)로 반영한다.
// 축: 플러그인(git pull + reload, 재시작 0) → 사이드카(reach.fetch 새 asset ensure) → ptyd(fd-handoff
// drain, 라이브 셸 무손실) → 앱 본체(tauri-updater 설치 + relaunch, release 채널만·복원 사다리로 seamless).
// 각 축은 activity 버스로 loud 고지한다(무음 금지). 앱 본체 원격 갱신은 release 홈만(HOME 정책) —
// debug/dev 는 앱 본체가 로컬 빌드라 채널 게이트가 그 축을 건너뛴다. 개별 설치 프리미티브(plugin_update·
// sidecar_ensure·pty_daemon_upgrade·update_apply)는 각 경계가 소유하고, 이 오케스트레이터는 순서·게이트·
// 고지만 얹는다.
import { invoke } from "@tauri-apps/api/core";
import { register } from "./registry";
import { tmsg } from "../i18n";
import { usePlugins } from "../state/plugins";
import { publishActivity } from "../state/activityFeed";

interface SidecarPin {
  name: string;
  url: string;
  sha256: string;
}

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
      "Apply updates across every hot axis, least-disruptive first: installed plugins (git pull + reload, zero restart), then any sidecar assets you name, then the PTY daemon (fd-handoff drain — live shells survive with no SIGHUP), then the app body last (download + install + relaunch — release channel only, the restoration ladder brings windows and terminals back). Each axis is announced on the activity bus. On a debug/dev home the app-body step is skipped (its build is local). Omit a flag to run that axis; set it false to skip it. The app body relaunches only when a newer release actually exists.",
    triggers: { ko: "업데이트 적용 설치 새 버전 갱신 핫스왑" },
    params: {
      plugins: {
        type: "boolean",
        description: "Update installed plugins (git pull + reload). Default true.",
      },
      sidecars: {
        type: "json",
        description: "Sidecar assets to ensure: [{ name, url, sha256 }]. Default none.",
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

      // ① 플러그인 — git pull + reload(재시작 0). dev 소스는 update 대상이 아니라 건너뛴다.
      if (want("plugins")) {
        const entries = Object.entries(usePlugins.getState().plugins).filter(
          ([, pl]) => pl.source !== "dev",
        );
        for (const [id] of entries) {
          const r = await usePlugins.getState().update(id);
          if (r.ok) {
            applied.push({ axis: "plugin", id, version: (r as { version?: string }).version });
            publishActivity("update.applied", "core", { axis: "plugin", id });
          } else {
            skipped.push({ axis: "plugin", id, reason: r.code });
          }
        }
      }

      // ② 사이드카 — reach.fetch 새 asset ensure(sha256 핀·원자 설치·경로 파생은 Rust 경계 소유).
      const pins = Array.isArray(p.sidecars) ? (p.sidecars as SidecarPin[]) : [];
      for (const sc of pins) {
        try {
          await invoke("sidecar_ensure", { name: sc.name, url: sc.url, sha256: sc.sha256 });
          applied.push({ axis: "sidecar", name: sc.name });
          publishActivity("update.applied", "core", { axis: "sidecar", name: sc.name });
        } catch (e) {
          skipped.push({ axis: "sidecar", name: sc.name, reason: String(e) });
        }
      }

      // ③ ptyd — fd-handoff drain(라이브 셸 무손실, SIGHUP 없음).
      if (want("daemon")) {
        try {
          const r = (await invoke("pty_daemon_upgrade")) as Record<string, unknown>;
          applied.push({ axis: "daemon", sessions: r.sessions, pid: r.pid });
          publishActivity("update.applied", "core", { axis: "daemon", sessions: r.sessions });
        } catch (e) {
          skipped.push({ axis: "daemon", reason: String(e) });
        }
      }

      // ④ 앱 본체 — release 채널만(HOME). 새 판이 실제로 있을 때만 설치 + relaunch(복원 사다리 seamless).
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
