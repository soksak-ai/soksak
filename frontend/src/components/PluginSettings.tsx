import { useState } from "react";
import { usePlugins } from "../state/plugins";
import { usePluginSettings, type SettingValue } from "../state/pluginSettings";
import { useSessions } from "../state/sessions";
import { localize, useT } from "../i18n";
import type { ConfigSetting, MapEntry } from "../plugins/spec";

// Plugin settings panel — generates controls from the manifest configuration schema (single source).
// Scope toggle: global (app-wide) / project (current project override).
//  global scope: value = global override ?? default. Editing writes the global.
//  project scope: value = project ?? global ?? default (effective). Editing writes the project override.

type Scope = "global" | "project";

function Control({
  setting,
  value,
  onChange,
}: {
  setting: ConfigSetting;
  value: SettingValue;
  onChange: (v: SettingValue) => void;
}) {
  const t = useT();
  if (setting.type === "boolean") {
    return (
      <button
        type="button"
        className={`settings-toggle${value ? " on" : ""}`}
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={value === true}
      >
        <span className="settings-toggle-knob" />
      </button>
    );
  }
  if (setting.type === "number") {
    return (
      <input
        type="number"
        className="settings-input"
        value={Number(value)}
        min={setting.min}
        max={setting.max}
        onChange={(e) => {
          let n = Number(e.target.value);
          if (Number.isNaN(n)) return;
          if (setting.min !== undefined) n = Math.max(setting.min, n);
          if (setting.max !== undefined) n = Math.min(setting.max, n);
          onChange(n);
        }}
      />
    );
  }
  if (setting.type === "enum") {
    const labels = setting.enumLabels;
    return (
      <select
        className="settings-select"
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        {(setting.enum ?? []).map((opt, i) => (
          <option key={opt} value={opt}>
            {labels?.[i] ? localize(labels[i]) : opt}
          </option>
        ))}
      </select>
    );
  }
  if (setting.type === "list") {
    // String list — per-row text + remove (✕) + add. A variable-length list a scalar control cannot render.
    const list = Array.isArray(value) ? (value as string[]) : [];
    const setAt = (i: number, v: string) => onChange(list.map((x, j) => (j === i ? v : x)));
    const removeAt = (i: number) => onChange(list.filter((_, j) => j !== i));
    return (
      <div className="settings-list">
        {list.map((item, i) => (
          <div className="settings-list-row" key={i}>
            <input
              type="text"
              className="settings-input settings-list-field"
              value={item}
              onChange={(e) => setAt(i, e.target.value)}
            />
            <button type="button" className="settings-list-remove" title={t("settings.list.remove")} onClick={() => removeAt(i)}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" className="settings-list-add" onClick={() => onChange([...list, ""])}>
          + {t("settings.list.add")}
        </button>
      </div>
    );
  }
  if (setting.type === "map") {
    // Key-value mapping — per-row [key] → [value] + remove (✕) + add. Two-column grid (mapping table like source→mirror).
    const rows = Array.isArray(value) ? (value as MapEntry[]) : [];
    const setKey = (i: number, k: string) =>
      onChange(rows.map((r, j) => (j === i ? { ...r, key: k } : r)));
    const setValue = (i: number, v: string) =>
      onChange(rows.map((r, j) => (j === i ? { ...r, value: v } : r)));
    const removeAt = (i: number) => onChange(rows.filter((_, j) => j !== i));
    return (
      <div className="settings-list">
        {rows.map((row, i) => (
          <div className="settings-map-row" key={i}>
            <input
              type="text"
              className="settings-input settings-map-field"
              value={row.key}
              onChange={(e) => setKey(i, e.target.value)}
            />
            <span className="settings-map-arrow">→</span>
            <input
              type="text"
              className="settings-input settings-map-field"
              value={row.value}
              onChange={(e) => setValue(i, e.target.value)}
            />
            <button type="button" className="settings-list-remove" title={t("settings.list.remove")} onClick={() => removeAt(i)}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="settings-list-add"
          onClick={() => onChange([...rows, { key: "", value: "" }])}
        >
          + {t("settings.list.add")}
        </button>
      </div>
    );
  }
  // string
  return (
    <input
      type="text"
      className="settings-input settings-input-text"
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function PluginSettings({ pluginId }: { pluginId: string }) {
  const t = useT();
  const plugin = usePlugins((s) => s.plugins[pluginId]);
  // Full subscription — re-render immediately on value change (mounted only while the modal is open).
  const ps = usePluginSettings();
  const root = useSessions((s) => s.projects.find((x) => x.id === s.activeId)?.root) ?? undefined;
  const [scope, setScope] = useState<Scope>("global");
  if (!plugin) return null;
  const schema = plugin.manifest.configuration ?? [];

  const effectiveScope: Scope = scope === "project" && !root ? "global" : scope;
  const valueOf = (c: ConfigSetting): SettingValue =>
    effectiveScope === "project"
      ? ps.effective(pluginId, c.key, c.default, root)
      : ps.getGlobal(pluginId, c.key) ?? c.default;
  const isOverridden = (c: ConfigSetting): boolean =>
    effectiveScope === "project"
      ? !!root && ps.getProject(root, pluginId, c.key) !== undefined
      : ps.getGlobal(pluginId, c.key) !== undefined;
  const setVal = (c: ConfigSetting, v: SettingValue) => {
    if (effectiveScope === "project" && root) ps.setProject(root, pluginId, c.key, v);
    else ps.setGlobal(pluginId, c.key, v);
  };
  const reset = (c: ConfigSetting) => {
    if (effectiveScope === "project" && root) ps.resetProject(root, pluginId, c.key);
    else ps.resetGlobal(pluginId, c.key);
  };

  return (
    <div className="settings-plugin">
      <div className="dsec">{localize(plugin.manifest.name)}</div>
      {schema.length === 0 ? (
        <div className="plugin-consent-none">{t("settings.plugin.none")}</div>
      ) : (
        <>
          <div className="settings-scope">
            <button
              type="button"
              className={effectiveScope === "global" ? "on" : ""}
              onClick={() => setScope("global")}
            >
              {t("settings.scope.global")}
            </button>
            <button
              type="button"
              className={effectiveScope === "project" ? "on" : ""}
              onClick={() => setScope("project")}
              disabled={!root}
              title={root ?? t("settings.scope.noProject")}
            >
              {t("settings.scope.project")}
            </button>
          </div>
          {schema.map((c) => {
            // list/map are multi-row composite controls — not crammed next to the label but stacked
            // full-width below the label and description (block). Plain scalars keep the existing
            // one-line label-left/control-right layout.
            const isBlock = c.type === "list" || c.type === "map";
            const resetBtn = isOverridden(c) ? (
              <button
                type="button"
                className="settings-reset"
                onClick={() => reset(c)}
                title={t("settings.reset")}
              >
                ↺
              </button>
            ) : null;
            return (
              <div key={c.key} className={"settings-row" + (isBlock ? " settings-row--block" : "")}>
                <div className="settings-row-label">
                  <span className="settings-row-title">
                    {localize(c.title)}
                    {isOverridden(c) ? (
                      <span className="settings-dot" title={t("settings.overridden")} />
                    ) : null}
                    {isBlock ? resetBtn : null}
                  </span>
                  {c.description ? (
                    <span className="settings-row-desc">{localize(c.description)}</span>
                  ) : null}
                </div>
                <div className="settings-row-control">
                  <Control setting={c} value={valueOf(c)} onChange={(v) => setVal(c, v)} />
                  {!isBlock ? (
                    <span className="settings-reset-col">{resetBtn}</span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
