// The auto-update orchestrator (update.*) applies axes smallest-disruption first.
// The plugin axis atomically swaps each authenticated plugin release.
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
      // The daemon axis was this application's own PTY daemon. A shell belongs to a sidecar now, and
      // open sidecars are reported by `sidecar_status`. Whether one has a newer release is answered
      // by whatever installed the sidecar, not by a check written here for one
      // of them.
      const daemon: Record<string, unknown> = { running: false };
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

      // ① Plugins — verify and atomically install each owner release.
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

      // ② The daemon axis upgraded this application's own PTY daemon in place, handing its file
      // descriptors over so live shells survived. A shell belongs to a sidecar now, and upgrading
      // that sidecar is an install rather than an application command written for one
      // one of them.
      //
      // Named as skipped rather than dropped, so a caller that asked for the axis is told it was
      // not done instead of reading an empty applied list as success.
      if (want("daemon")) {
        skipped.push({
          axis: "daemon",
          reason:
            "a shell belongs to a declared sidecar now, and a sidecar is upgraded by installing it — this " +
            "application holds no daemon of its own to hand descriptors over",
        });
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
