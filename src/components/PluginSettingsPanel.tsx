import { useState } from "react";
import { usePlugins } from "../state/plugins";
import { usePluginSettings, type SettingValue } from "../state/pluginSettings";
import { useSessions } from "../state/sessions";
import { localize, useT } from "../i18n";
import type { ConfigSetting, MapEntry } from "../plugins/spec";

// 플러그인 설정 패널 — 매니페스트 configuration 스키마에서 컨트롤을 자동 생성한다(단일 소스).
// 글로벌(앱 전역) / 프로젝트(현재 프로젝트 오버라이드) scope 토글.
//  글로벌 scope: 값 = 글로벌 오버라이드 ?? 기본. 편집 = 글로벌 저장.
//  프로젝트 scope: 값 = 프로젝트 ?? 글로벌 ?? 기본(effective). 편집 = 프로젝트 오버라이드 저장.

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
    // 문자열 리스트 — 행별 텍스트 + 삭제(✕) + 추가. 스칼라로 못 그리는 가변 목록.
    const list = Array.isArray(value) ? (value as string[]) : [];
    const setAt = (i: number, v: string) => onChange(list.map((x, j) => (j === i ? v : x)));
    const removeAt = (i: number) => onChange(list.filter((_, j) => j !== i));
    return (
      <div className="settings-list">
        {list.map((item, i) => (
          <div className="settings-list-row" key={i}>
            <input
              type="text"
              className="settings-input settings-list-cell"
              value={item}
              onChange={(e) => setAt(i, e.target.value)}
            />
            <button type="button" className="settings-list-remove" title="삭제" onClick={() => removeAt(i)}>
              ✕
            </button>
          </div>
        ))}
        <button type="button" className="settings-list-add" onClick={() => onChange([...list, ""])}>
          + 추가
        </button>
      </div>
    );
  }
  if (setting.type === "map") {
    // 키-값 매핑 — 행별 [키] → [값] + 삭제(✕) + 추가. 2칸 그리드 정렬(원본→미러 같은 매핑 테이블).
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
              className="settings-input settings-map-cell"
              value={row.key}
              onChange={(e) => setKey(i, e.target.value)}
            />
            <span className="settings-map-arrow">→</span>
            <input
              type="text"
              className="settings-input settings-map-cell"
              value={row.value}
              onChange={(e) => setValue(i, e.target.value)}
            />
            <button type="button" className="settings-list-remove" title="삭제" onClick={() => removeAt(i)}>
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="settings-list-add"
          onClick={() => onChange([...rows, { key: "", value: "" }])}
        >
          + 추가
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

export function PluginSettingsPanel({ pluginId }: { pluginId: string }) {
  const t = useT();
  const plugin = usePlugins((s) => s.plugins[pluginId]);
  // 전체 구독 — 값 변경 시 즉시 재렌더(모달이 열려 있는 동안만 마운트).
  const ps = usePluginSettings();
  const root = useSessions((s) => s.tabs.find((x) => x.id === s.activeId)?.root) ?? undefined;
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
            // list/map 은 여러 행짜리 복합 컨트롤 — 라벨 옆에 욱여넣지 않고 라벨·설명 아래 전체폭으로
            // 스택(블록). 단순 스칼라는 기존 라벨-좌/컨트롤-우 한 줄 유지.
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
                  {!isBlock ? resetBtn : null}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
