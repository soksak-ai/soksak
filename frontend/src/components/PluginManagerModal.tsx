// The plugin manager — verified release install, consent, enable/disable, update, remove, and the
// reasons a plugin was refused. A modal, mounted on document.body.
//
// It hung off the right sidebar's icon rail until 2026-08-16, together with a rail of every view
// placed right and a single active `rightView`. That was the right region carrying a rule of its
// own: `sections.link ... region=right` answered OK and the screen never changed, and unlinking
// changed nothing either (measured on the running build). A2a — a region is a place, and the
// workspace arranges what stands in it — so the region draws the standing set like the left, and
// what is left here is the manager.
//
// It opens from `plugin.manager` and from the settings modal. A surface with no way in is gone.

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/icons/Icon";
import { usePlugins, type PluginRuntime } from "../state/plugins";
import { useRegistry } from "../state/registry";
import { installState, isOfficial, type RegistryEntry } from "../plugins/registry";
import { useOverlayActive, useUi } from "../state/ui";
import { PluginConsentModal } from "./PluginConsentModal";
import { localize, useT } from "../i18n";
import { execute } from "../commands/registry";

export function PluginManagerModal() {
  const t = useT();
  const managerOpen = useUi((s) => s.pluginManagerOpen);
  const setManagerOpen = useUi((s) => s.setPluginManagerOpen);
  // The input gate every modal registers. It hung inside the right sidebar, which declared
  // `will-change: transform` and so stood above the native surfaces; mounted by App it does not, and
  // a browser's surface drew over the card — measured 2026-08-17.
  useOverlayActive(managerOpen);

  return (
    <>
      {/* Manager modal — mounted on document.body, not here. The rail's panel
          declares `will-change: transform` so the compositor keeps host chrome
          above a plugin's WebGL canvas, and that makes it the containing block
          of any `position: fixed` descendant. Rendered in place, the overlay's
          `inset: 0` was the sidebar's box and the card's `left: 50%` was half of
          it — measured 2026-08-15, the close button sat at x=962.78 on a
          1200-wide window, outside the frame.
          The promotion is load-bearing, so the mount point moves instead. Same
          reason ProgramMenu is a portal. */}
      {managerOpen && createPortal(
        <div className="dmodal-overlay" onMouseDown={() => setManagerOpen(false)}>
          <div
            className="dmodal-card dmodal-plugin-manager"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="dmodal-head">
              <span className="dmodal-title">{t("plugin.manager")}</span>
              <button
                type="button"
                className="icon-btn"
                title={t("common.close")}
                data-node="plugin-manager-close"
                onClick={() => setManagerOpen(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="dmodal-plugin-manager-body">
              <PluginManager />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Manager panel ───────────────────────────────────────────────────────────

function statusKey(p: PluginRuntime): "enabled" | "disabled" | "error" {
  return p.status;
}

// The installable list shows verified release references only. Name, description and commands come
// from the installed owner manifest; the registry does not duplicate them.
function RegistrySection({
  busy,
  run,
  installed,
}: {
  busy: boolean;
  run: (fn: () => Promise<unknown>) => void;
  installed: Record<string, PluginRuntime>;
}) {
  const t = useT();
  const entries = useRegistry((s) => s.entries);
  const status = useRegistry((s) => s.status);
  const sorted = useMemo(
    () => [...entries].sort((a, b) => a.id.localeCompare(b.id)),
    [entries],
  );
  // Which entries come from the official registry. A person deciding whether to
  // install one needs to know that; the URL the bytes arrive from is not
  // something they can act on.
  const official = useMemo(
    () => new Set(entries.filter((e) => isOfficial(entries, e.id)).map((e) => e.id)),
    [entries],
  );

  const stateOf = (e: RegistryEntry) =>
    installState(e, installed[e.id]?.manifest.version, installed[e.id]?.source);
  const doInstall = (e: RegistryEntry) =>
    run(() => execute("plugin.install", {
      registryId: e.registryId,
      pluginId: e.id,
    }, {}));
  const doUpdate = (e: RegistryEntry) =>
    doInstall(e);

  return (
    <>
      <div className="dsec dsec-row">
        {t("plugin.registry.section")}
        <button
          type="button"
          className="plugin-reload"
          title={t("common.refresh")}
          disabled={busy || status === "fetching"}
          onClick={() => useRegistry.getState().refresh(true)}
        >
          <Icon name="refresh" size="sm" />
        </button>
      </div>
      {/* Already installed and current (installed) appears only in the installed section — here only
          available and update are shown, which structurally prevents the same plugin from appearing twice. */}
      {(() => {
        const actionable = sorted.filter((e) => stateOf(e) !== "installed");
        if (actionable.length === 0) {
          return <div className="plugin-side-empty-sub">{t("plugin.registry.allInstalled")}</div>;
        }
        return actionable.map((e) => {
          const st = stateOf(e);
          return (
            <div key={e.id} className="plugin-row">
              <div className="plugin-row-title">
                <span className="plugin-row-name">{e.id}</span>
                <span className="plugin-row-ver">v{e.version}</span>
              </div>
              {/* A catalog has no description: it supplies no display metadata
                  before the release it points at is verified (catalogLabel). What
                  it does state is where the entry came from, which is what a
                  person needs before installing. The download URL was here and is
                  not user information — it is where the bytes are fetched from,
                  it cannot be acted on, and it overflowed the panel. */}
              <div className="plugin-row-desc">
                {official.has(e.id)
                  ? t("plugin.registry.official")
                  : t("plugin.registry.thirdParty", { registry: e.registryId })}
              </div>
              <div className="plugin-row-actions">
                {st === "available" && (
                  <button type="button" className="dbtn dbtn-acc" disabled={busy} onClick={() => doInstall(e)}>
                    {t("plugin.install")}
                  </button>
                )}
                {st === "update" && (
                  <button type="button" className="dbtn" disabled={busy} onClick={() => doUpdate(e)}>
                    {t("plugin.registry.update")}
                  </button>
                )}
              </div>
            </div>
          );
        });
      })()}
    </>
  );
}

function PluginManager() {
  const t = useT();
  const plugins = usePlugins((s) => s.plugins);
  const rejected = usePlugins((s) => s.rejected);
  // Source of an installed plugin (official/manual) — the set of registry-listed ids. Recomputed only
  // when entries change.
  const registryEntries = useRegistry((s) => s.entries);
  const officialIds = useMemo(
    () => new Set(registryEntries.map((e) => e.id)),
    [registryEntries],
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Consent queue — a dependency can hold strong permissions, so the unconsented chain required for
  // enabling (dependencies first) is queued and the consent popups are shown back to back (no half
  // consent). queue[0] is the current popup. pendingEnableId = the original target to enable after
  // every consent (cascade).
  const [consentQueue, setConsentQueue] = useState<PluginRuntime[]>([]);
  const [pendingEnableId, setPendingEnableId] = useState<string | null>(null);
  const consentFor = consentQueue[0] ?? null;
  // Card click = inspection-only detail modal (same permission and description info as the consent
  // screen, no consent button). Unrelated to enabling.
  const [previewFor, setPreviewFor] = useState<PluginRuntime | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = (await fn()) as { ok?: boolean; message?: string } | unknown;
      if (r && typeof r === "object" && (r as { ok?: boolean }).ok === false) {
        setMsg((r as { message?: string }).message ?? t("plugin.failed"));
      }
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doEnable = (p: PluginRuntime) =>
    run(async () => {
      const r = await usePlugins.getState().enable(p.manifest.id);
      if (!r.ok && r.code === "CONSENT_REQUIRED") {
        // Queue the unconsented chain (dependencies first) — popups run from the dependencies. Without a chain, itself only.
        const chain =
          (r.data as { pendingConsent?: string[] } | undefined)?.pendingConsent ??
          [p.manifest.id];
        const all = usePlugins.getState().plugins;
        const queue = chain.map((id) => all[id]).filter(Boolean) as PluginRuntime[];
        setConsentQueue(queue.length ? queue : [p]);
        setPendingEnableId(p.manifest.id);
        return { ok: true }; // continues into the modal — no panel error display
      }
      return r;
    });

  // Consent on the current popup → remove it from the queue. If any remain, the next popup; if
  // empty, enable the original target (cascade — dependencies first).
  const consentNext = () =>
    run(async () => {
      const [cur, ...rest] = consentQueue;
      if (!cur) return { ok: true };
      usePlugins.getState().grantConsent(cur.manifest.id);
      if (rest.length > 0) {
        setConsentQueue(rest);
        return { ok: true }; // next dependency/plugin consent popup
      }
      setConsentQueue([]);
      const target = pendingEnableId;
      setPendingEnableId(null);
      return target ? usePlugins.getState().enable(target) : { ok: true };
    });

  const cancelConsent = () => {
    setConsentQueue([]);
    setPendingEnableId(null);
  };

  const list = Object.values(plugins).sort((a, b) =>
    a.manifest.id.localeCompare(b.manifest.id),
  );

  return (
    <div className="plugin-manager">
      {msg && <div className="plugin-msg">{msg}</div>}

      <RegistrySection busy={busy} run={run} installed={plugins} />

      {/* §B7 — for a text + icon row the flex/center container owns alignment. */}
      <div className="dsec dsec-row">
        {t("plugin.installed.section")}
        <button
          type="button"
          className="plugin-reload"
          title={t("common.refresh")}
          disabled={busy}
          onClick={() => run(() => usePlugins.getState().reload().then(() => ({ ok: true })))}
        >
          <Icon name="refresh" size="sm" />
        </button>
      </div>
      {list.length === 0 && (
        <div className="plugin-side-empty-sub">{t("plugin.none")}</div>
      )}
      {/* Three-row card structure: title | version | status → description (full width) → actions.
          Fixes the description being squeezed by the action column and wrapping one word per line in a narrow sidebar. */}
      {list.map((p) => (
        <div
          key={p.manifest.id}
          className="plugin-row"
          role="button"
          tabIndex={0}
          style={{ cursor: "pointer" }}
          title={t("plugin.detail.open")}
          data-node={`plugin/${p.manifest.id}/card`}
          onClick={() => setPreviewFor(p)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setPreviewFor(p);
            }
          }}
        >
          <div className="plugin-row-title">
            <span className="plugin-row-name">{localize(p.manifest.name)}</span>
            <span className="plugin-row-ver">v{p.manifest.version}</span>
            {p.source === "dev" && <span className="plugin-badge dev">dev</span>}
            {/* Source: listed in the official registry vs manual/third party (unlisted). */}
            {p.source !== "dev" && (
              <span
                className={`plugin-badge ${officialIds.has(p.manifest.id) ? "official" : "manual"}`}
              >
                {t(officialIds.has(p.manifest.id) ? "plugin.source.official" : "plugin.source.manual")}
              </span>
            )}
            <span className={`plugin-badge ${statusKey(p)}`}>
              {t(`plugin.status.${statusKey(p)}`)}
            </span>
          </div>
          <div className="plugin-row-desc">{localize(p.manifest.description)}</div>
          {/* Role chips — derived mechanically from the verified declaration (contributes); prose
              categories are forbidden, because free metadata cannot be verified. Shows at a glance what
              is added (menu item / view / command / formatter / grammar / icon). */}
          {(() => {
            const c = p.manifest.contributes;
            const chips: { key: string; text: string }[] = [];
            for (const pr of c.programs) {
              chips.push({
                key: `prog:${pr.id}`,
                text: `${t("plugin.contrib.program")} ${pr.path ? `${localize(pr.path)} ▸ ` : ""}${localize(pr.title)}`,
              });
            }
            for (const v of c.views) {
              chips.push({
                key: `view:${v.id}`,
                text: `${t("plugin.contrib.view")} ${localize(v.title)}`,
              });
            }
            if (c.commands.length > 0) {
              chips.push({
                key: "cmds",
                text: `${t("plugin.contrib.command")} ${c.commands.length}`,
              });
            }
            for (const s of c.iconSets) {
              chips.push({
                key: `icons:${s.id}`,
                text: `${t("plugin.contrib.iconSet")} ${localize(s.title)}`,
              });
            }
            for (const ev of c.events) {
              chips.push({ key: `event:${ev}`, text: `${t("plugin.contrib.event")} ${ev}` });
            }
            return chips.length > 0 ? (
              <div className="plugin-row-contribs">
                {chips.map((ch) => (
                  <span key={ch.key} className="plugin-contrib-chip">
                    {ch.text}
                  </span>
                ))}
              </div>
            ) : null;
          })()}
          {p.error && <div className="plugin-row-err">{p.error}</div>}
          {/* Action buttons are separate from the card click (detail modal) — bubbling is stopped. */}
          <div className="plugin-row-actions" onClick={(e) => e.stopPropagation()}>
            {p.status === "enabled" ? (
              <button
                type="button"
                className="dbtn"
                data-node={`plugin/${p.manifest.id}/disable`}
                disabled={busy}
                onClick={() =>
                  run(() => usePlugins.getState().disable(p.manifest.id))
                }
              >
                {t("plugin.disable")}
              </button>
            ) : (
              <button
                type="button"
                className="dbtn dbtn-acc"
                data-node={`plugin/${p.manifest.id}/enable`}
                disabled={busy}
                onClick={() => doEnable(p)}
              >
                {t("plugin.enable")}
              </button>
            )}
            {/* Settings shortcut — only with a configuration declaration and while enabled. Deep links to that plugin panel of the unified settings modal. */}
            {p.status === "enabled" && (p.manifest.configuration?.length ?? 0) > 0 ? (
              <button
                type="button"
                className="dbtn"
                onClick={() => useUi.getState().setSettingsSection(p.manifest.id)}
              >
                {t("plugin.settings")}
              </button>
            ) : null}
            {/* Update (↑) and remove (✕) were dropped — with no full catalog browse (a reinstall path),
                removal is pointless and update is unnecessary. Only the enable/disable toggle remains. */}
          </div>
        </div>
      ))}

      {rejected.length > 0 && (
        <>
          <div className="dsec">{t("plugin.rejected.section")}</div>
          {rejected.map((r) => (
            <div key={r.dir} className="plugin-rejected">
              <div className="plugin-rejected-dir">{r.dir}</div>
              <ul>
                {r.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}

      {/* Both consent modals go to document.body for the same reason the manager
          does: this component renders inside .sidebar-right, whose compositing
          promotion makes it the containing block of a fixed descendant. */}
      {consentFor && createPortal(
        <PluginConsentModal
          plugin={consentFor}
          step={
            consentQueue.length > 1 || consentFor.manifest.id !== pendingEnableId
              ? {
                  isDependency: consentFor.manifest.id !== pendingEnableId,
                  remaining: consentQueue.length,
                  ofId: pendingEnableId ?? undefined,
                }
              : undefined
          }
          onClose={cancelConsent}
          onConsent={consentNext}
        />,
        document.body,
      )}

      {/* Card click = inspection-only detail (permissions, description, access info). Separate from the consent flow — it yields while a consent popup is open. */}
      {previewFor && !consentFor && createPortal(
        <PluginConsentModal
          plugin={previewFor}
          preview
          onClose={() => setPreviewFor(null)}
          onConsent={() => setPreviewFor(null)}
        />,
        document.body,
      )}
    </div>
  );
}
