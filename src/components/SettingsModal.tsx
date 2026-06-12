import { useEffect } from "react";
import {
  useSettings,
  type CursorStyle,
  type ResizeReflow,
  type DefaultProgram,
  type Language,
  type TabPosition,
} from "../state/settings";
import { useTheme } from "../state/theme";
import { useSuppressBrowser } from "../state/ui";
import { Icon } from "../ui/icons/Icon";
import { useIconRegistry } from "../ui/icons/registry";
import { useT } from "../i18n";
import { useDraggableModal } from "./modalDrag";

// 설정 모달 — 디자인 레퍼런스(soksak_final) 그대로: 드래그 가능한 520px 카드,
// 헤더(⠿ 그립·✕), 테마 그리드(스와치+라벨, 활성=액센트 보더), 행 레이아웃
// (라벨 130px + inset 컨트롤), 섹션 캡션, − n + 스테퍼.

// 테마 스와치: bg 배경 + side 사이드바 막대 + acc 점(레퍼런스 마크업).
function ThemeSwatch({ bg, side, acc }: { bg: string; side: string; acc: string }) {
  return (
    <span className="th-swatch" style={{ background: bg }}>
      <span className="th-swatch-side" style={{ background: side }} />
      <span className="th-swatch-dot" style={{ background: acc }} />
    </span>
  );
}

function Stepper({
  value,
  onChange,
  step = 1,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <span className="dstepper">
      <span className="dstep-btn icon-inline" onClick={() => onChange(value - step)}>
        <Icon name="minus" size="sm" />
      </span>
      {value}
      <span className="dstep-btn icon-inline" onClick={() => onChange(value + step)}>
        <Icon name="add" size="sm" />
      </span>
    </span>
  );
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  // 네이티브 브라우저 웹뷰는 항상 DOM 위 — 모달이 떠 있는 동안 숨긴다.
  useSuppressBrowser();
  // 전체 구독 예외(원칙 1 의 의도 내): 이 모달은 settings 의 거의 모든 필드를
  // 렌더하고, 열려 있는 동안만 마운트된다(App 의 settingsOpen 게이트).
  const s = useSettings();
  // 아이콘 셋 드롭다운 — 등록 셋(내장 + 활성 플러그인) 동적 나열.
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

        <div className="dmodal-body">
          <div className="dsec">{t("settings.theme")}</div>
          <div className="th-grid">
            {Object.values(themes).map((th) => (
              <span
                key={th.name}
                className={`th-cell${th.name === themeName ? " active" : ""}`}
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
              {/* 등록된 셋(내장 + 활성 플러그인)을 동적으로 나열. 선택한 셋이
                  목록에 없으면(플러그인 비활성) 항목을 추가해 값 유실을 막는다
                  — 렌더는 lucide 로 폴백 중. */}
              {iconSetOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
              {!iconSetOptions.some((o) => o.id === s.iconSet) && (
                <option value={s.iconSet}>{s.iconSet} (비활성)</option>
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
            <span className="drow-label">{t("settings.language")}</span>
            <select
              className="dctl"
              value={s.language}
              onChange={(e) => s.setLanguage(e.target.value as Language)}
            >
              <option value="ko">한국어</option>
              <option value="en">English</option>
            </select>
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.shell")}</span>
            <input
              className="dctl dctl-mono"
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
          <div className="drow">
            <span className="drow-label">{t("settings.projectTabPos")}</span>
            <select
              className="dctl"
              value={s.projectTabPosition}
              onChange={(e) =>
                s.setProjectTabPosition(e.target.value as TabPosition)
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
          {/* 분할 패널 헤더 설정 — 탭 모드로 고정(2026-06 결정: 제목표시줄 모드
              비노출). 재노출 시 아래 주석 해제 + GroupArea 의 고정값 복원.
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
          <div className="drow">
            <span className="drow-label">{t("settings.defaultProgram")}</span>
            <select
              className="dctl"
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

          <div className="dsec">{t("settings.font")}</div>
          <div className="drow">
            <span className="drow-label">{t("settings.fontFamily")}</span>
            <input
              className="dctl dctl-mono"
              type="text"
              value={s.fontFamily}
              onChange={(e) => s.setFontFamily(e.target.value)}
            />
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.fontSize")}</span>
            <Stepper value={s.fontSize} onChange={s.setFontSize} />
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.cursor")}</span>
            <select
              className="dctl"
              value={s.cursorStyle}
              onChange={(e) => s.setCursorStyle(e.target.value as CursorStyle)}
            >
              <option value="block">{t("settings.cursorBlock")}</option>
              <option value="bar">{t("settings.cursorBar")}</option>
              <option value="underline">{t("settings.cursorUnderline")}</option>
            </select>
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.cursorBlink")}</span>
            <select
              className="dctl"
              value={s.cursorBlink ? "on" : "off"}
              onChange={(e) => s.setCursorBlink(e.target.value === "on")}
            >
              <option value="on">{t("common.on")}</option>
              <option value="off">{t("common.off")}</option>
            </select>
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.resizeReflow")}</span>
            <select
              className="dctl"
              value={s.resizeReflow}
              onChange={(e) =>
                s.setResizeReflow(e.target.value as ResizeReflow)
              }
            >
              <option value="live">{t("reflow.live")}</option>
              <option value="settle">{t("reflow.settle")}</option>
            </select>
          </div>

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

          <div className="dsec">{t("program.browser")}</div>
          <div className="drow">
            <span className="drow-label">{t("settings.homeUrl")}</span>
            <input
              className="dctl dctl-mono"
              type="text"
              value={s.homeUrl}
              onChange={(e) => s.setHomeUrl(e.target.value.trim())}
            />
          </div>
          <div className="drow">
            <span className="drow-label">{t("settings.scrollback")}</span>
            <Stepper
              value={s.scrollback}
              onChange={s.setScrollback}
              step={1000}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
