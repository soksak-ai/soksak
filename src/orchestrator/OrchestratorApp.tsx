// 오케스트레이터 창 셸(A3) — 사람이 오케스트레이션 전체를 지켜보는 화면(P12 의 뷰).
// 좌: 창·모니터 맵(window.monitors 팩트) / 우: 활동 피드(activity 브로드캐스트 + recent 백필)
// / 하: 명령 콘솔(레지스트리 실행). 셸은 커맨드·이벤트 표면만 소비한다 — 코어 내부 상태
// (sessions 등) 직접 참조 금지: 외부 클라이언트(폰·CLI)와 같은 자격이어야 P13 이 지켜진다.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { execute } from "../commands/registry";
import { useT } from "../i18n";

interface ActivityEntry {
  seq: number;
  ts: number;
  kind: string;
  source: string;
  payload: Record<string, unknown>;
}

interface MonitorFacts {
  monitors: { index: number; name: string; x: number; y: number; w: number; h: number; scale: number }[];
  windows: { label: string; x: number; y: number; w: number; h: number; focused: boolean; monitor: number | null }[];
}

const FEED_CAP = 500;

// 피드 한 줄 요약 — kind 별 사람이 읽는 문장(전체 payload 는 title 로).
function lineOf(e: ActivityEntry): string {
  const p = e.payload;
  switch (e.kind) {
    case "command.executed":
      return `${p.command} ${p.ok ? "✓" : `✗ ${p.code ?? ""}`} (${p.durationMs}ms)`;
    case "terminal.command.started":
      return `$ ${p.commandLine}`;
    case "terminal.command.finished":
      return `종료 ${p.exitCode ?? ""}`;
    case "turn.ended":
      return `턴 종료${p.agentKind ? ` (${p.agentKind})` : ""}${p.command ? ` — ${p.command}` : ""}`;
    case "view.activated":
      return `뷰 활성화 ${p.viewId}`;
    default:
      return e.kind;
  }
}

export function OrchestratorApp() {
  const t = useT();
  const [feed, setFeed] = useState<ActivityEntry[]>([]);
  const [facts, setFacts] = useState<MonitorFacts | null>(null);
  const [cmd, setCmd] = useState("");
  const [result, setResult] = useState<string>("");
  const feedRef = useRef<HTMLDivElement>(null);

  const refreshFacts = useCallback(() => {
    void invoke<MonitorFacts>("window_monitors")
      .then(setFacts)
      .catch(() => {});
  }, []);

  useEffect(() => {
    // 백필(커서) 후 라이브 구독 — 폴링 0. 창 배치 팩트는 부트 1회 + 수동 새로고침 +
    // 창 관련 활동이 보일 때 갱신(이벤트 기반).
    let un = () => {};
    let disposed = false;
    void invoke<ActivityEntry[]>("activity_recent", { since: null, limit: 200 }).then(
      (entries) => setFeed(entries),
    );
    void listen<ActivityEntry>("activity", (ev) => {
      const e = ev.payload;
      setFeed((cur) => {
        if (cur.length && cur[cur.length - 1].seq >= e.seq) return cur; // 백필 겹침 dedup
        const next = [...cur, e];
        return next.length > FEED_CAP ? next.slice(next.length - FEED_CAP) : next;
      });
      if (e.kind === "command.executed" && String(e.payload.command).startsWith("window."))
        refreshFacts();
    }).then((u) => {
      if (disposed) u();
      else un = u;
    });
    refreshFacts();
    return () => {
      disposed = true;
      un();
    };
  }, [refreshFacts]);

  // 새 항목 도착 시 피드 바닥 고정(사람이 위로 스크롤해 보던 중이면 방해하지 않는다).
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [feed]);

  const runCommand = useCallback(async () => {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    const sp = trimmed.indexOf(" ");
    const name = sp < 0 ? trimmed : trimmed.slice(0, sp);
    let params: Record<string, unknown> = {};
    if (sp >= 0) {
      try {
        params = JSON.parse(trimmed.slice(sp + 1)) as Record<string, unknown>;
      } catch (e) {
        setResult(`파라미터 JSON 오류: ${String(e)}`);
        return;
      }
    }
    // 콘솔은 사람의 손 — ui 출처(danger 게이트는 remote 전용). 실행 사실은 계측이 피드에 남긴다.
    const out = await execute(name, params, { remote: false });
    setResult(JSON.stringify(out, null, 2));
  }, [cmd]);

  return (
    <div className="orch-root" data-node="orch">
      <header className="orch-header" data-tauri-drag-region>
        <span className="orch-title">{t("orch.title")}</span>
        <button
          type="button"
          className="icon-btn"
          data-node="orch/refresh"
          title={t("orch.refresh")}
          onClick={refreshFacts}
        >
          ⟳
        </button>
      </header>
      <div className="orch-body">
        <section className="orch-map" data-node="orch/map">
          <h2>{t("orch.windows")}</h2>
          {facts?.monitors.map((m) => (
            <div key={m.index} className="orch-monitor">
              <div className="orch-monitor-name">
                {m.name || `monitor ${m.index}`} — {m.w}×{m.h} @{m.scale}x
              </div>
              {facts.windows
                .filter((w) => w.monitor === m.index)
                .map((w) => (
                  <button
                    type="button"
                    key={w.label}
                    className={`orch-win${w.focused ? " focused" : ""}`}
                    data-node={`orch/win/${w.label}`}
                    title={`${w.x},${w.y} ${w.w}×${w.h}`}
                    onClick={() => void invoke("window_focus", { label: w.label }).catch(() => {})}
                  >
                    {w.label}
                  </button>
                ))}
            </div>
          ))}
        </section>
        <section className="orch-feed-wrap">
          <h2>{t("orch.feed")}</h2>
          <div className="orch-feed" data-node="orch/feed" ref={feedRef}>
            {feed.map((e) => (
              <div
                key={e.seq}
                className={`orch-entry k-${e.kind.split(".").join("-")}`}
                title={JSON.stringify(e.payload)}
              >
                <span className="orch-seq">{e.seq}</span>
                <span className="orch-src">
                  {String(e.payload.window ?? "")}·{e.source}
                </span>
                <span className="orch-line">{lineOf(e)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <footer className="orch-console">
        <input
          data-node="orch/console"
          value={cmd}
          placeholder={t("orch.consoleHint")}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runCommand();
          }}
        />
        <button type="button" data-node="orch/run" onClick={() => void runCommand()}>
          {t("orch.run")}
        </button>
        {result && <pre className="orch-result">{result}</pre>}
      </footer>
    </div>
  );
}
