// webview 건강(서킷 브레이커) 커맨드 — 렌더러 프로세스 크래시 감지·자동 복구의 관측/수동
// 복구 표면(플랜 W6). 상태의 단일 진실은 코어 Rust(webview_health.rs) — 여기는 노출만.
// 자동 복구는 per-label 브레이커(60s 윈도우 상한 3회, 지수 백오프)가 코어에서 수행하고,
// 상한 소진(open)은 activity(webview.crash.exhausted)+창 배지로 드러난다 — 이 명령들이
// 에이전트/사람의 나머지 반쪽(읽기·수동 복구)이다.

import { invoke } from "@tauri-apps/api/core";
import { register, type CommandHint } from "./registry";
import { tmsg } from "../i18n";

interface LabelHealth {
  label: string;
  state: "closed" | "recovering" | "open";
  attempt: number | null;
  crashesInWindow: number;
  totalCrashes: number;
  lastCrashAgoMs: number | null;
  lastReason: string | null;
}

export function registerWebviewCatalog(): void {
  register("webview.health.query", {
    description:
      "Report webview renderer-process health per label: circuit-breaker state (closed / recovering / open), crash counts in the rolling 60s window, lifetime total, and the last termination reason if the platform provided one. Labels: a window label is that window's main webview, b-<win>-<view> is a browser child. state=open means automatic recovery is exhausted — recover it manually with webview.recover.",
    triggers: { ko: "웹뷰 건강 웹뷰 상태 크래시 조회 복구 상태" },
    params: {},
    returns:
      "{ count, entries: [{label, state, attempt, crashesInWindow, totalCrashes, lastCrashAgoMs, lastReason}] }",
    message: (d) => tmsg("msg.webview.health.query", { n: Number(d.count ?? 0) }),
    hint: (d) => {
      const entries = Array.isArray(d.entries) ? (d.entries as LabelHealth[]) : [];
      return entries
        .filter((e) => e.state === "open")
        .slice(0, 3)
        .map<CommandHint>((e) => ({
          cmd: `sok webview.recover '{"label":"${e.label}"}'`,
          why: `${e.label} 는 자동 복구가 중단된 상태(open)입니다 — 수동 복구로 되살립니다`,
        }));
    },
    examples: ["sok webview.health.query"],
    handler: async () => {
      const entries = await invoke<LabelHealth[]>("webview_health_query");
      return { count: entries.length, entries };
    },
  });

  register("webview.recover", {
    description:
      "Manually recover a webview: reset its circuit breaker (clears the crash window and the open state) and reload it in place. Use after webview.health.query shows state=open, or any time a webview is blank/wedged. The window's main webview reloads through the normal boot path (terminals survive — PTYs live in the core); a browser child (b-<win>-<view>) reloads in place without being re-created.",
    triggers: { ko: "웹뷰 복구 웹뷰 되살리기 크래시 복구 화면 복구" },
    params: {
      label: {
        type: "string",
        description:
          "webview label — a window label for that window's main webview, or b-<win>-<view> for a browser child (list via webview.health.query or window.list)",
        required: true,
      },
    },
    primary: "label",
    returns: "{ label, reloaded: true }",
    message: (d) => tmsg("msg.webview.recover", { label: String(d.label) }),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sok webview.recover \'{"label":"b-w-1234-v7"}\''],
    handler: async (p) => {
      try {
        await invoke("webview_recover", { label: p.label });
      } catch (e) {
        const msg = String(e);
        // 코어 존재 검사 실패("webview 없음")를 typed 에러로 승격(R9 — raw 에러 누출 금지).
        if (msg.includes("webview 없음"))
          return { ok: false as const, code: "TARGET_NOT_FOUND" as const, message: msg };
        throw e;
      }
      return { label: p.label, reloaded: true };
    },
  });
}
