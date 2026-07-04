// 활동 피드 공급자(A1) — 이 창의 실행 사실을 코어 허브(activity.rs)로 발행한다.
// 계열 ①: 플러그인 이벤트(command.started/finished·turn.ended·view.activated) — 터미널·AI 턴.
// 계열 ②: 커맨드 레지스트리 execute 계측(CommandTrace) — 오케스트레이터가 내리는 모든 명령.
// 허브가 seq/ts 를 부여하고 전 창 브로드캐스트+영속하므로 여기선 발행만 한다.

import { invoke } from "@tauri-apps/api/core";
import { currentWindowLabel } from "../lib/webviewLabels";
import { onPluginEvent } from "../plugins/hooks";
import { setCommandTraceSink } from "../commands/registry";

function publish(kind: string, source: string, payload: Record<string, unknown>): void {
  void invoke("activity_publish", {
    kind,
    source,
    payload: { ...payload, window: currentWindowLabel() },
  }).catch(() => {
    // 허브 불능(테스트 하니스 등)은 라이브 동작을 막지 않는다.
  });
}

/** 부트 1회 — 이벤트 구독과 registry 계측 sink 를 허브로 잇는다. */
export function startActivityFeed(): void {
  onPluginEvent("command.started", (p) =>
    publish("terminal.command.started", "terminal", {
      paneId: p.paneId,
      commandLine: p.commandLine,
      cwd: p.cwd,
    }),
  );
  onPluginEvent("command.finished", (p) =>
    publish("terminal.command.finished", "terminal", {
      paneId: p.paneId,
      exitCode: (p as { exitCode?: number }).exitCode,
    }),
  );
  onPluginEvent("turn.ended", (p) =>
    publish("turn.ended", p.source, {
      paneId: p.paneId,
      command: p.command,
      agentKind: (p as { agentKind?: string | null }).agentKind,
      sessionId: (p as { sessionId?: string | null }).sessionId,
    }),
  );
  onPluginEvent("view.activated", (p) =>
    publish("view.activated", "ui", { projectId: p.projectId, viewId: p.viewId }),
  );
  // 진행 델타(요청→응답 사이) — 사이드카 이벤트·AI thinking 을 소비 플러그인이 command.progress
  // 로 발행하면 활동 스트림에 얹는다(MESSAGE-PROTOCOL.md §2). textdelta 개념.
  onPluginEvent("command.progress", (p) =>
    publish("command.progress", (p as { source?: string }).source ?? "plugin", {
      command: (p as { command?: string }).command,
      delta: (p as { delta?: unknown }).delta,
    }),
  );
  // 레지스트리 계측(P12 본체) — params 는 키 목록만 도착한다(registry 가 요약).
  // activity.recent 자체는 제외: 피드를 보는 행위가 피드를 늘리는 되먹임 방지.
  setCommandTraceSink((t) => {
    if (t.command === "activity.recent") return;
    publish("command.executed", t.source, {
      command: t.command,
      title: t.title,
      danger: t.danger,
      paramKeys: t.paramKeys,
      ok: t.ok,
      code: t.code,
      message: t.message,
      durationMs: t.durationMs,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      data: t.data,
      media: t.media,
    });
  });
}
