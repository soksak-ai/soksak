// Plugin activation consent modal — §0-2 honest disclosure: shows the permission list (Korean description
// plus caution emphasis), the contribution checklist (what this plugin adds — run/install commands verbatim,
// all derived mechanically from the manifest declaration), and the full-trust (no sandbox) notice, and
// records only an explicit human consent (§0-5). This UI is the only path that grants consent.

import { useEffect } from "react";
import {
  PERMISSION_INFO,
  pluginCommandName,
  type ContributedProgram,
} from "../plugins/spec";
import { detectPlatform, libraryInstallFor } from "../plugins/programRegistry";
import { usePlugins, type PluginRuntime } from "../state/plugins";
import { consentSummary } from "../plugins/consentSummary";
import { useOverlayActive } from "../state/ui";
import { Icon } from "../ui/icons/Icon";
import { localize, useT } from "../i18n";

// Program declaration → one-line summary on the consent screen (command verbatim — no prose rewriting).
function programSummary(
  p: ContributedProgram,
  t: ReturnType<typeof useT>,
): { text: string; cmds: string[] } {
  const title = localize(p.title);
  const where = p.path ? `${localize(p.path)} ▸ ${title}` : title;
  const cmds: string[] = [];
  let text: string;
  if (p.command) {
    text = `${where} — ${t("plugin.consent.prog.run")}`;
    cmds.push(p.command);
  } else {
    text = `${where} — ${t("plugin.consent.prog.bareTerminal")}`;
  }
  const install = p.ensure?.install[detectPlatform()];
  if (install) {
    text += ` · ${t("plugin.consent.prog.install")}`;
    cmds.push(install);
  }
  return { text, cmds };
}

export function PluginConsentModal({
  plugin,
  onConsent,
  onClose,
  preview = false,
  step,
}: {
  plugin: PluginRuntime;
  onConsent: () => void;
  onClose: () => void;
  // preview = inspection only (plugin.consent.preview command). Display without the consent button — no activation.
  preview?: boolean;
  // step = sequential consent queue info (dependencies first). isDependency = this popup is for a dependency (core). remaining = popups left.
  step?: { isDependency: boolean; remaining: number; ofId?: string };
}) {
  const t = useT();
  // Overlay registration — blocks mouse pass-through to the browser hall while the modal is up.
  useOverlayActive();
  const m = plugin.manifest;
  const installed = usePlugins((s) => s.plugins);
  // Single source of the consent display data (consentSummary). plugin.consent.summary derives from the same function.
  const summary = consentSummary(m, installed);
  const { plugins: pluginDeps, libraries: libs } = summary.dependencies;
  const exposedNodes = summary.exposedNodes;
  const dangerousCommands = summary.dangerousCommands;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="dmodal-overlay" onMouseDown={onClose}>
      <div
        className="dmodal-card plugin-consent-card"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dmodal-head">
          <span className="dmodal-title">
            {t(preview ? "plugin.detail.title" : "plugin.consent.title", {
              name: localize(m.name),
            })}
          </span>
          <span className="dmodal-spacer" />
          <button
            type="button"
            className="icon-btn dmodal-close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="dmodal-body">
          {/* Chained consent notice — when this popup is for a dependency (core, for example),
              state that the dependency also needs its permissions reviewed and consented to before
              the requested plugin can be enabled (no half consent, §0-2). */}
          {step?.isDependency && (
            <div className="plugin-consent-notice">
              {t("plugin.consent.dependencyNotice")}
              {step.remaining > 1
                ? ` ${t("plugin.consent.dependencyRemaining", { n: step.remaining })}`
                : ""}
            </div>
          )}
          <div className="plugin-consent-meta">
            {m.id} · v{m.version}
            {m.author ? ` · ${m.author}` : ""}
          </div>
          <div className="plugin-consent-desc">{localize(m.description)}</div>

          <div className="dsec">{t("plugin.consent.permissions")}</div>
          {m.permissions.length === 0 ? (
            <div className="plugin-consent-none">
              {t("plugin.consent.noPermissions")}
            </div>
          ) : (
            <ul className="plugin-consent-list">
              {m.permissions.map((p) => {
                const base = PERMISSION_INFO[p];
                // "programs" is a declaration-driven dynamic disclosure — states only what
                // this manifest actually does (menu entry only / command run / install too).
                // A uniform warning about the permission's maximum reach is over-disclosure
                // = warning fatigue (§0-2 violation).
                let info: { label: string; detail: string; caution?: true } =
                  base;
                if (p === "programs") {
                  const progs = m.contributes.programs;
                  // Every program is kind:"view" (core terminal removed). command means auto-run,
                  // ensure means install when missing — the consent screen discloses only real behavior (§0-2).
                  const runs = progs.some((x) => x.command || x.ensure);
                  const installs = progs.some((x) => x.ensure);
                  info = {
                    label: base.label,
                    detail: installs
                      ? t("perm.programs.runInstall")
                      : runs
                        ? t("perm.programs.run")
                        : t("perm.programs.menuOnly"),
                    ...(runs || installs ? { caution: true as const } : {}),
                  };
                }
                return (
                  <li
                    key={p}
                    className={`plugin-consent-item${info.caution ? " caution" : ""}`}
                  >
                    <span className="plugin-consent-label">
                      {info.caution ? "⚠ " : ""}
                      {info.label}
                    </span>
                    <span className="plugin-consent-detail">{info.detail}</span>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Dangerous commands — manifest contributes.commands.danger. Destructive/inject commands
              that are gated on a remote (sok/MCP) call are disclosed with ⚠ right before the consent
              decision (after permissions = the most decisive spot, honest disclosure §0-2). */}
          {dangerousCommands.length > 0 && (
            <>
              <div className="dsec">{t("plugin.consent.dangerousCommands")}</div>
              <ul className="plugin-consent-list">
                {dangerousCommands.map((dc) => (
                  <li
                    key={`danger:${dc.name}`}
                    className="plugin-consent-item caution"
                  >
                    <span className="plugin-consent-detail">
                      {"⚠ "}
                      {t(`plugin.consent.danger.${dc.danger}`)}
                      {" — "}
                    </span>
                    <code className="plugin-consent-cmd">
                      {pluginCommandName(m.id, dc.name)}
                    </code>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Contribution checklist — derived mechanically from the manifest declaration (no prose).
              Which commands/views/programs/formatters are added and which commands run, verbatim.
              Also states that all of it is withdrawn automatically on disable or removal. */}
          <div className="dsec">{t("plugin.consent.contributes")}</div>
          {(() => {
            const c = m.contributes;
            const rows: { key: string; text: string; cmds?: string[] }[] = [];
            for (const p of c.programs) {
              const s = programSummary(p, t);
              rows.push({
                key: `prog:${p.id}`,
                text: `${t("plugin.consent.kind.program")} — ${s.text}`,
                cmds: s.cmds,
              });
            }
            for (const v of c.views) {
              rows.push({
                key: `view:${v.id}`,
                text: `${t("plugin.consent.kind.view")} — ${localize(v.title)} (${v.surfaces.join(", ")})`,
              });
            }
            for (const cmd of c.commands) {
              rows.push({
                key: `cmd:${cmd.name}`,
                text: `${t("plugin.consent.kind.command")} — ${pluginCommandName(m.id, cmd.name)}: ${localize(cmd.title)}`,
              });
            }
            for (const s of c.iconSets) {
              rows.push({
                key: `icons:${s.id}`,
                text: `${t("plugin.consent.kind.iconSet")} — ${localize(s.title)}`,
              });
            }
            return rows.length === 0 ? (
              <div className="plugin-consent-none">
                {t("plugin.consent.noContributes")}
              </div>
            ) : (
              <>
                <ul className="plugin-consent-list">
                  {rows.map((r) => (
                    <li key={r.key} className="plugin-consent-item">
                      <span className="plugin-consent-detail">{r.text}</span>
                      {r.cmds?.map((cmd) => (
                        <code key={cmd} className="plugin-consent-cmd">
                          {cmd}
                        </code>
                      ))}
                    </li>
                  ))}
                </ul>
                <div className="plugin-consent-revoke">
                  {t("plugin.consent.revokeNote")}
                </div>
              </>
            );
          })()}

          {/* Exposed DOM — the element kinds this plugin exposes to the outside (address click,
              measurement) from manifest contributes.nodes. The user consents after seeing what is
              externally operable (honest disclosure §0-2). danger is emphasized with ⚠. */}
          {exposedNodes.length > 0 && (
            <>
              <div className="dsec">{t("plugin.consent.nodes")}</div>
              <ul className="plugin-consent-list">
                {exposedNodes.map((n) => (
                  <li
                    key={`node:${n.id}`}
                    className={`plugin-consent-item${n.danger ? " caution" : ""}`}
                  >
                    <span className="plugin-consent-detail">
                      {n.danger ? "⚠ " : ""}
                      {n.id}
                      {n.description ? ` — ${localize(n.description)}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {/* Dependencies — plugin↔plugin (dependencies, transitive ones installed along with it)
              plus external libraries (libraries, force-installed after consent when missing).
              Install commands are shown verbatim (no prose rewriting). */}
          {(pluginDeps.length > 0 || libs.length > 0) && (
            <>
              <div className="dsec">{t("plugin.consent.dependencies")}</div>
              <ul className="plugin-consent-list">
                {pluginDeps.map((dep) => (
                  <li key={`dep:${dep.id}`} className="plugin-consent-item">
                    <span className="plugin-consent-detail">
                      {t("plugin.consent.dep.plugin")} —{" "}
                      {dep.name ? `${localize(dep.name)} ` : ""}
                      {dep.id} ({dep.range ?? t("plugin.consent.dep.transitive")})
                    </span>
                    {/* The dependency's permissions are disclosed too (no half consent) — consent
                        itself is taken in the per-dependency popup, but what it can use is shown
                        here in advance. Unknown while it is not installed (consent after install). */}
                    {dep.permissions && dep.permissions.length > 0 && (
                      <span className="plugin-consent-detail">
                        {t("plugin.consent.dep.permissions")}{" "}
                        {dep.permissions
                          .map((p) => PERMISSION_INFO[p as keyof typeof PERMISSION_INFO]?.label ?? p)
                          .join(", ")}
                      </span>
                    )}
                  </li>
                ))}
                {libs.map((lib) => {
                  const cmd = libraryInstallFor(lib);
                  return (
                    <li
                      key={`lib:${lib.bin}`}
                      className="plugin-consent-item caution"
                    >
                      <span className="plugin-consent-detail">
                        ⚠ {t("plugin.consent.dep.library")} —{" "}
                        {lib.label ? localize(lib.label) : lib.name} ({lib.bin})
                      </span>
                      {cmd ? (
                        <code className="plugin-consent-cmd">{cmd}</code>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              {libs.length > 0 ? (
                <div className="plugin-consent-revoke">
                  {t("plugin.consent.dep.forceInstall")}
                </div>
              ) : null}
            </>
          )}

          {/* Full-trust notice (§0-2) — states plainly that a permission is not isolation. */}
          <div className="plugin-consent-notice">{t("plugin.consent.notice")}</div>

          <div className="plugin-consent-actions">
            <button
              type="button"
              className="dbtn"
              data-node="modal/consent/cancel"
              onClick={onClose}
            >
              {preview ? t("plugin.consent.close") : t("common.cancel")}
            </button>
            {preview ? null : (
              <button
                type="button"
                className="dbtn dbtn-acc"
                data-node="modal/consent/agree"
                onClick={onConsent}
              >
                {t("plugin.consent.agree")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
