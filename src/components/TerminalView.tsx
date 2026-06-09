import { useEffect, useRef } from "react";
import type { ITheme } from "@xterm/xterm";
import {
  createTerminal,
  type CreateTerminalOptions,
  type TerminalHandle,
} from "../terminal/createTerminal";

interface TerminalViewProps {
  options?: CreateTerminalOptions;
  /** 활성 상태일 때 포커스를 준다. */
  active?: boolean;
  /** 그리드 fg/ANSI 테마. 변경 시 라이브로 교체된다(배경은 CSS --bg). */
  theme?: ITheme;
}

export function TerminalView({ options, active = true, theme }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<TerminalHandle | null>(null);

  useEffect(() => {
    let disposed = false;
    const container = containerRef.current!;

    createTerminal(container, { ...options, theme }).then((handle) => {
      if (disposed) {
        handle.dispose();
        return;
      }
      handleRef.current = handle;
      if (active) {
        handle.focus();
      }
    });

    return () => {
      disposed = true;
      handleRef.current?.dispose();
      handleRef.current = null;
    };
    // options 는 마운트 시점 값만 사용(터미널은 세션 단위로 고정).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (active) {
      handleRef.current?.focus();
      handleRef.current?.fit();
    }
  }, [active]);

  // 테마 라이브 교체(마운트 후 변경 시).
  useEffect(() => {
    if (theme) {
      handleRef.current?.setTheme(theme);
    }
  }, [theme]);

  return (
    <div
      ref={containerRef}
      className="terminal-view"
      style={{ width: "100%", height: "100%" }}
    />
  );
}
