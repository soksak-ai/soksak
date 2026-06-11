import { useEffect } from "react";
import {
  useSettings,
  type CursorStyle,
  type DefaultProgram,
  type Language,
  type SplitHeaderMode,
  type TabPosition,
} from "../state/settings";
import { useT } from "../i18n";

// 설정 패널(모달): 언어 + 폰트(글꼴/크기) + 커서(깜빡임/모양) + 스크롤백.
// 값 변경은 즉시 스토어에 반영되고(localStorage 영속), 터미널에도 라이브 적용된다.

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const s = useSettings();

  // Esc 로 닫기.
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
    <div className="settings-overlay" onMouseDown={onClose}>
      <div className="settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">{t("settings.title")}</span>
          <button
            type="button"
            className="settings-close"
            title={t("settings.close")}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-row">
            <label>{t("settings.language")}</label>
            <select
              value={s.language}
              onChange={(e) => s.setLanguage(e.target.value as Language)}
            >
              <option value="ko">한국어</option>
              <option value="en">English</option>
            </select>
          </div>

          <div className="settings-row">
            <label>{t("settings.projectTabPos")}</label>
            <select
              value={s.projectTabPosition}
              onChange={(e) =>
                s.setProjectTabPosition(e.target.value as TabPosition)
              }
            >
              <option value="top">{t("position.top")}</option>
              <option value="left">{t("position.left")}</option>
            </select>
          </div>
          <div className="settings-row">
            <label>{t("settings.splitHeader")}</label>
            <select
              value={s.splitHeaderMode}
              onChange={(e) =>
                s.setSplitHeaderMode(e.target.value as SplitHeaderMode)
              }
            >
              <option value="title">{t("splitHeader.title")}</option>
              <option value="tabs">{t("splitHeader.tabs")}</option>
            </select>
          </div>
          <div className="settings-row">
            <label>{t("settings.defaultProgram")}</label>
            <select
              value={s.defaultProgram}
              onChange={(e) =>
                s.setDefaultProgram(e.target.value as DefaultProgram)
              }
            >
              <option value="terminal">{t("program.terminal")}</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
              <option value="browser">{t("program.browser")}</option>
            </select>
          </div>
          <div className="settings-row">
            <label>{t("settings.shell")}</label>
            {/* 콤보(datalist): 흔한 셸은 목록에서, 그 외 경로는 직접 입력. */}
            <input
              type="text"
              list="shell-options"
              value={s.shell}
              placeholder={t("shell.default")}
              onChange={(e) => s.setShell(e.target.value.trim())}
            />
            <datalist id="shell-options">
              <option value="/bin/zsh" />
              <option value="/bin/bash" />
              <option value="/bin/sh" />
              <option value="/opt/homebrew/bin/fish" />
              <option value="/opt/homebrew/bin/nu" />
            </datalist>
          </div>

          <div className="settings-section">{t("settings.font")}</div>
          <div className="settings-row">
            <label>{t("settings.fontFamily")}</label>
            <input
              type="text"
              value={s.fontFamily}
              onChange={(e) => s.setFontFamily(e.target.value)}
            />
          </div>
          <div className="settings-row">
            <label>{t("settings.fontSize")}</label>
            <input
              type="number"
              min={6}
              max={40}
              value={s.fontSize}
              onChange={(e) => s.setFontSize(Number(e.target.value))}
            />
          </div>

          <div className="settings-section">{t("settings.cursor")}</div>
          <div className="settings-row">
            <label>{t("settings.cursorBlink")}</label>
            <input
              type="checkbox"
              checked={s.cursorBlink}
              onChange={(e) => s.setCursorBlink(e.target.checked)}
            />
          </div>
          <div className="settings-row">
            <label>{t("settings.cursorStyle")}</label>
            <select
              value={s.cursorStyle}
              onChange={(e) => s.setCursorStyle(e.target.value as CursorStyle)}
            >
              <option value="block">{t("settings.cursorBlock")}</option>
              <option value="bar">{t("settings.cursorBar")}</option>
              <option value="underline">{t("settings.cursorUnderline")}</option>
            </select>
          </div>

          <div className="settings-section">{t("settings.scrollback")}</div>
          <div className="settings-row">
            <label>{t("settings.scrollback")}</label>
            <input
              type="number"
              min={0}
              max={1000000}
              step={1000}
              value={s.scrollback}
              onChange={(e) => s.setScrollback(Number(e.target.value))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
