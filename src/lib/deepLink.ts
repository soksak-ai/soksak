// 딥링크 = command URI(`soksak://cmd/<command>?<params>`). 모든 기능이 command(단일 주소면)이므로
// 알림/외부 진입을 그대로 command 실행으로 라우팅한다(오픈·규칙화). 활성화 경로 3종(알림 클릭·액션
// 버튼·외부 soksak://)이 모두 이 해석기를 거친다. 권한·danger 게이트는 remote:true 로 유지 —
// 알림으로 권한 상승 불가(파괴적 command 는 설정 게이트를 동일하게 받음).

import { execute, type CommandContext, type CommandOutcome } from "../commands/registry";
import { invoke } from "@tauri-apps/api/core";

export interface DeepLink {
  command: string;
  params: Record<string, unknown>;
}

// 값 강제: JSON 으로 파싱되면 그 값(number/bool/object), 아니면 문자열 그대로.
function coerce(v: string): unknown {
  if (v === "") return "";
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

// `soksak://cmd/<command>?<query>` → {command, params}. 형식 불일치/빈 command 는 null.
export function parseDeepLink(url: string): DeepLink | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "soksak:" || u.host !== "cmd") return null;
  const command = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!command) return null;
  const params: Record<string, unknown> = {};
  for (const [k, v] of u.searchParams) params[k] = coerce(v);
  return { command, params };
}

// command + params → soksak:// URL(알림이 실어 보낼 딥링크 생성용). null/undefined 값은 생략.
export function buildDeepLink(
  command: string,
  params: Record<string, unknown> = {},
): string {
  const sp = new URLSearchParams();
  for (const [k, val] of Object.entries(params)) {
    if (val == null) continue;
    sp.set(k, typeof val === "string" ? val : JSON.stringify(val));
  }
  const q = sp.toString();
  return `soksak://cmd/${command}${q ? `?${q}` : ""}`;
}

// 딥링크 활성화 — 앱 전면 활성화 후 command 실행. deps 주입(테스트). remote:true 로 danger 게이트 유지.
export async function resolveDeepLink(
  url: string,
  deps: {
    execute: (
      name: string,
      params: Record<string, unknown>,
      ctx: CommandContext,
    ) => Promise<CommandOutcome>;
    activate: () => Promise<void>;
  } = {
    execute,
    activate: async () => {
      await invoke("window_activate");
    },
  },
): Promise<CommandOutcome> {
  const dl = parseDeepLink(url);
  if (!dl) {
    return { ok: false, code: "INVALID_PARAMS", message: `잘못된 딥링크: ${url}` };
  }
  await deps.activate();
  return deps.execute(dl.command, dl.params, { remote: true });
}
