// The auto-update orchestrator (update.*) applies axes smallest-disruption first.
// The plugin axis atomically swaps the authenticated owner release and the whole plugin/sidecar/kit closure.
// The PTY daemon preserves sessions with fd-handoff; the app body restarts only in a release identity.
import { invoke } from "../framework";
import { register } from "./registry";
import { tmsg, key} from "../i18n";
import { usePlugins } from "../state/plugins";
import { publishActivity } from "../state/activityFeed";
import { updateCertifiedRegistryPlugin } from "../plugins/registryInstallService";

/** Query the remote app-body version. The release gate and the tauri-updater latest.json check are owned by the core boundary (updater.rs). */
async function checkApp(): Promise<Record<string, unknown>> {
  return (await invoke("update_check")) as Record<string, unknown>;
}

export function registerUpdateCatalog(): void {
  register("update.check", {
    description: key("cmd.update.check.desc"),
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
    examples: ["update.check"],
    handler: async () => {
      const app = await checkApp();
      const installed = Object.values(usePlugins.getState().plugins).filter(
        (p) => p.source !== "dev",
      ).length;
      let daemon: Record<string, unknown> = { running: false };
      try {
        daemon = (await invoke("pty_daemon_status")) as Record<string, unknown>;
      } catch {
        // A failed daemon query does not block the check — it is reported as running:false.
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
    description: key("cmd.update.apply.desc"),
    triggers: { ko: "업데이트 적용 설치 새 버전 갱신 핫스왑" },
    params: {
      plugins: {
        type: "boolean",
        description: key("cmd.update.apply.param.plugins"),
      },
      daemon: {
        type: "boolean",
        description: key("cmd.update.apply.param.daemon"),
      },
      app: {
        type: "boolean",
        description: key("cmd.update.apply.param.app"),
      },
    },
    returns: "{ applied: [{ axis, ... }], skipped: [{ axis, reason }] }",
    // Includes the ptyd upgrade and the app relaunch — remote/AI calls pass the permission gate.
    danger: "destructive",
    message: (d) => tmsg("msg.update.apply", { n: ((d.applied as unknown[]) ?? []).length }),
    errors: ["INTERNAL"],
    examples: ["update.apply", 'update.apply \'{"app":false}\''],
    handler: async (p) => {
      const applied: Record<string, unknown>[] = [];
      const skipped: Record<string, unknown>[] = [];
      const want = (k: string) => p[k] !== false; // Omitted = run that axis, false = skip it.

      // ① Plugins — verify the owner release and the full transitive closure, then swap atomically.
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

      // ② ptyd — fd-handoff drain (live shells lossless, no SIGHUP).
      if (want("daemon")) {
        try {
          const r = (await invoke("pty_daemon_upgrade")) as Record<string, unknown>;
          applied.push({ axis: "daemon", sessions: r.sessions, pid: r.pid });
          publishActivity("update.applied", "core", { axis: "daemon", sessions: r.sessions });
        } catch (e) {
          skipped.push({ axis: "daemon", reason: String(e) });
        }
      }

      // ③ App body — install and restart only when a release identity actually has a new version.
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
            // Process replacement — never returns (the restore ladder recreates windows and terminal sessions). HS1: app body last.
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
