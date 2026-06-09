import { useEffect, useRef } from "react";
import {
  createTerminal,
  type CreateTerminalOptions,
  type TerminalHandle,
} from "../terminal/createTerminal";

interface TerminalViewProps {
  options?: CreateTerminalOptions;
  /** 활성 상태일 때 포커스를 준다. */
  active?: boolean;
}

export function TerminalView({ options, active = true }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<TerminalHandle | null>(null);

  useEffect(() => {
    let disposed = false;
    const container = containerRef.current!;

    createTerminal(container, options ?? {}).then((handle) => {
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

  return (
    <div
      ref={containerRef}
      className="terminal-view"
      style={{ width: "100%", height: "100%" }}
    />
  );
}
