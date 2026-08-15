import { applyWindowZoom } from "../lib/zoomIntent";
import { useEffect, useState } from "react";
import { usePlugins } from "../state/plugins";
import { PluginSettings } from "./PluginSettings";
import { ContractEngineSettings } from "./ContractEngineSettings";
import { SecuritySettings } from "./SecuritySettings";
import {
  useSettings,
  type Language,
  type TabPosition,
  type FocusIndicator,
  type TabCloseConfirm,
} from "../state/settings";
import { useTheme } from "../state/theme";
import { useOverlayActive } from "../state/ui";
import { Icon } from "../ui/icons/Icon";
import { useIconRegistry } from "../ui/icons/registry";
import { localize, useT } from "../i18n";
import { useDraggableModal } from "./modalDrag";

// Settings modal — exactly as the product contract: a draggable 520px card,
// header (⠿ grip·✕), theme grid (swatch + label, active = accent border), row layout
// (label 130px + inset control), section caption, − n + stepper.

// Theme swatch: bg background + side sidebar bar + acc dot (reference markup).
function ThemeSwatch({ bg, side, acc }: { bg: string; side: string; acc: string }) {
  return (
    <span className="th-swatch" style={{ background: bg }}>
      <span className="th-swatch-side" style={{ background: side }} />
      <span className="th-swatch-dot" style={{ background: acc }} />
    </span>
  );
}

export function SettingsModal({
  onClose,
  initialSection = "general",
}: {
  onClose: () => void;
  initialSection?: string;
}) {
  const t = useT();
  // Left nav selection — "general" (preferences) or a plugin id. The sidebar shortcut deep-links through initialSection.
  const [section, setSection] = useState(initialSection);
  // Only plugins that declare a settings schema (configuration) appear in the nav.
  const configPlugins = Object.values(usePlugins((x) => x.plugins))
    .filter((p) => (p.manifest.configuration?.length ?? 0) > 0)
    .sort((a, b) => localize(a.manifest.name).localeCompare(localize(b.manifest.name)));
  // Overlay registration — blocks mouse pass-through in the browser hole while the modal is open.
  useOverlayActive();
  // Whole-store subscription exception (within the intent of principle 1): this modal renders almost every
  // field of settings and is mounted only while open (App's settingsOpen gate).
  const s = useSettings();
  // Icon set dropdown — dynamically lists registered sets (built-in + active plugins).
  const iconSets = useIconRegistry((x) => x.sets);
  const iconSetOptions = Object.values(iconSets)
    .map(({ id, name }) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const themes = useTheme((x) => x.themes);
  const themeName = useTheme((x) => x.current);
  const applyTheme = useTheme((x) => x.apply);
  const mode = useTheme((x) => x.effectiveMode);
  const { cardRef, cardStyle, onHeaderDown } = useDraggableModal();

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
        ref={cardRef}
        className="dmodal-card dmodal-settings"
        style={cardStyle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dmodal-head" onMouseDown={onHeaderDown}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            style={{ color: "var(--fg2)" }}
          >
            <line x1="2" y1="4.5" x2="14" y2="4.5" />
            <line x1="2" y1="11.5" x2="14" y2="11.5" />
            <circle cx="10.2" cy="4.5" r="1.8" />
            <circle cx="5.8" cy="11.5" r="1.8" />
          </svg>
          <span className="dmodal-title">{t("settings.title")}</span>
          <span className="dmodal-spacer" />
          <span className="dmodal-grip icon-inline">
            <Icon name="grip" />
          </span>
          <button
            type="button"
            className="icon-btn dmodal-close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>

        <div className="dmodal-2pane">
          <div className="settings-nav">
            <button
              type="button"
              className={`settings-nav-item${section === "general" ? " on" : ""}`}
              onClick={() => setSection("general")}
            >
              {t("settings.general")}
            </button>
            {configPlugins.length > 0 ? (
              <div className="settings-nav-head">{t("settings.plugins")}</div>
            ) : null}
            {configPlugins.map((p) => (
              <button
                key={p.manifest.id}
                type="button"
                className={`settings-nav-item${section === p.manifest.id ? " on" : ""}`}
                onClick={() => setSection(p.manifest.id)}
              >
                {localize(p.manifest.name)}
              </button>
            ))}
          </div>
          <div className="dmodal-body settings-detail">
            {section === "general" ? (
              <>
                <div className="dsec">{t("settings.theme")}</div>
          <div className="th-list">
            {Object.values(themes).map((th) => (
              <span
                key={th.name}
                className={`th-item${th.name === themeName ? " active" : ""}`}
                data-node={`settings/theme-cell/${th.name}`}
                onClick={() => applyTheme(th.name)}
              >
                <ThemeSwatch
                  bg={th.colors.bg}
                  side={th.colors.inset}
                  acc={th.colors.acc}
                />
                <span className="th-name">{th.name}</span>
              </span>
            ))}
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.mode")}</span>
            <select
              className="dctl"
              value={mode}
              onChange={(e) =>
                applyTheme(themeName, e.target.value as "light" | "dark")
              }
            >
              <option value="dark">{t("mode.dark")}</option>
              <option value="light">{t("mode.light")}</option>
            </select>
          </div>

          <div className="dsec">{t("settings.general")}</div>
          <div className="drow">
            <span className="drow-label">{t("settings.iconSet")}</span>
            <select
              className="dctl"
              value={s.iconSet}
              onChange={(e) => s.setIconSet(e.target.value)}
            >
              {/* Lists the registered sets (built-in + enabled plugins) dynamically. When the selected set
                  is absent from the list (its plugin is disabled) an entry is added so the value is not
                  lost — rendering falls back to lucide. */}
              {iconSetOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
              {!iconSetOptions.some((o) => o.id === s.iconSet) && (
                <option value={s.iconSet}>
                  {t("common.inactive", { id: s.iconSet })}
                </option>
              )}
            </select>
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.iconBox")}</span>
            <select
              className="dctl"
              value={s.iconBox ? "on" : "off"}
              onChange={(e) => s.setIconBox(e.target.value === "on")}
            >
              <option value="on">{t("common.on")}</option>
              <option value="off">{t("common.off")}</option>
            </select>
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.appFont")}</span>
            <input
              className="dctl"
              type="text"
              value={s.appFontFamily}
              onChange={(e) => s.setAppFontFamily(e.target.value)}
            />
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.windowZoom")}</span>
            <input
              className="dctl"
              type="number"
              min={0.5}
              max={2}
              step={0.1}
              value={s.windowZoom}
              onChange={(e) => {
                s.setWindowZoom(Number(e.target.value));
                void applyWindowZoom(useSettings.getState().windowZoom).catch((error) => {
                  console.error("window zoom apply failed:", error);
                });
              }}
            />
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.focusIndicator")}</span>
            <select
              className="dctl"
              value={s.focusIndicator}
              onChange={(e) =>
                s.setFocusIndicator(e.target.value as FocusIndicator)
              }
            >
              <option value="outline">{t("focusIndicator.outline")}</option>
              <option value="corners">{t("focusIndicator.corners")}</option>
            </select>
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.tabCloseConfirm")}</span>
            <select
              className="dctl"
              value={s.tabCloseConfirm}
              onChange={(e) =>
                s.setTabCloseConfirm(e.target.value as TabCloseConfirm)
              }
            >
              <option value="warn">{t("tabCloseConfirm.warn")}</option>
              <option value="off">{t("tabCloseConfirm.off")}</option>
            </select>
          </div>
          {/* Policy that clears a blocked vertical line under FLOW. PIN fixes both the rail and the panel. */}
          <div className="drow">
            <span className="drow-label">{t("settings.railPullFocused")}</span>
            <select
              className="dctl"
              data-node="settings/railPullFocused"
              value={s.railPullFocused ? "pull" : "travel"}
              onChange={(e) => s.setRailPullFocused(e.target.value === "pull")}
            >
              <option value="pull">{t("railPullFocused.pull")}</option>
              <option value="travel">{t("railPullFocused.travel")}</option>
            </select>
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.language")}</span>
            <select
              className="dctl"
              value={s.language}
              onChange={(e) => s.setLanguage(e.target.value as Language)}
            >
              <option value="ko">{t("settings.language.korean")}</option>
              <option value="en">English</option>
            </select>
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.workspaceTabPos")}</span>
            <select
              className="dctl"
              value={s.workspaceTabPosition}
              onChange={(e) =>
                s.setWorkspaceTabPosition(e.target.value as TabPosition)
              }
            >
              <option value="top">{t("position.top")}</option>
              <option value="left">{t("position.left")}</option>
            </select>
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.contentTabPos")}</span>
            <select
              className="dctl"
              value={s.contentTabPosition}
              onChange={(e) =>
                s.setContentTabPosition(e.target.value as TabPosition)
              }
            >
              <option value="top">{t("position.top")}</option>
              <option value="left">{t("position.left")}</option>
            </select>
          </div>
          {/* Split panel header setting — fixed to tab mode (2026-06 decision: title-bar mode is not
              exposed). To expose it again, uncomment below and restore the fixed value in GroupArea.
          <div className="drow">
            <span className="drow-label">{t("settings.splitHeader")}</span>
            <select
              className="dctl"
              value={s.splitHeaderMode}
              onChange={(e) =>
                s.setSplitHeaderMode(e.target.value as SplitHeaderMode)
              }
            >
              <option value="title">{t("splitHeader.title")}</option>
              <option value="tabs">{t("splitHeader.tabs")}</option>
            </select>
          </div>
          */}

          {/* Terminal appearance (font, size, cursor, blink, resize reflow, renderer, scrollback, shell)
              is not a core setting — the terminal plugin's settings panel (PluginSettings below) owns
              it (manifest configuration is the single source; no duplication). */}

          {/* Per-contract implementation picker (generic, contract-agnostic) — exposed automatically only
              for contracts with 2 or more enabled implementations. The core privileges no contract
              (for example soksak-spec-plugin-terminal → xterm/ghostty). */}
          <ContractEngineSettings />

          <div className="dsec">{t("settings.permission")}</div>
          <div className="drow">
            <span className="drow-label">{t("settings.remoteDestructive")}</span>
            <select
              className="dctl"
              value={s.remoteDestructive}
              onChange={(e) =>
                s.setRemoteDestructive(e.target.value as "allow" | "deny")
              }
            >
              <option value="allow">{t("policy.allow")}</option>
              <option value="deny">{t("policy.deny")}</option>
            </select>
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.remoteInject")}</span>
            <select
              className="dctl"
              value={s.remoteInject}
              onChange={(e) =>
                s.setRemoteInject(e.target.value as "allow" | "deny")
              }
            >
              <option value="allow">{t("policy.allow")}</option>
              <option value="deny">{t("policy.deny")}</option>
            </select>
          </div>

          <SecuritySettings />
              </>
            ) : (
              <PluginSettings pluginId={section} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
