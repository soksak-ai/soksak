// 오케스트레이터 자연어 콘솔의 에이전트 실행기 — 대화 턴 하나를 claude 일회 스폰으로 수행한다.
//
// 상관 원칙(docs/MESSAGE-PROTOCOL.md): 한 턴에서 비롯된 모든 실행은 그 턴의 turnId 를
// parentId 로 갖는다. 스폰 env SOKSAK_PARENT=turnId 가 sok → 소켓 meta → registry trace 로
// 관통해 command.executed 가 묶이고, 이 파일이 발행하는 chat.prompt(부모)·command.progress·
// chat.answer(닫음)가 세트를 완성한다. 일회 스폰인 이유: parent 는 spawn env 로만 정확히
// 회전한다(상주면 LLM 협조 의존). 대화 연속성은 session_id → --resume 이 잇는다.
//
// 스폰 형태는 검증 선례(구 vtuber claudeCli.ts) 그대로: 로그인셸 -lc 랩(GUI PATH 함정),
// cwd=$HOME(프로젝트 컨텍스트 누출 차단), --setting-sources ""(훅·플러그인 차단, OAuth 유지),
// --system-prompt(정체성 교체 — 유저 메시지로 주면 역할 거부). 도구는 Bash(sok:*) 만 허용.

import { Channel, invoke } from "@tauri-apps/api/core";
import { safeListen } from "../lib/safeListen";
import { useSettings } from "../state/settings";
import { publishActivity } from "../state/activityFeed";
import { AgentStreamParser } from "./agentStream";
import { execute, type CommandOutcome } from "../commands/registry";

// 대화 연속성(--resume)·리로드 고아 기록 — 같은 앱 실행 안에서만 유효해야 하므로 sessionStorage
// (window.reload 생존, 앱 재시작 시 소멸 — 재시작이면 process id 공간이 새것이라 기록이 무효).
const SESSION_KEY = "soksak.orchestrator.session";
const TURN_KEY = "soksak.orchestrator.turn";

// 폭주 상한 — stop/창닫힘이 정상 경로지만, 무인 방치 턴이 무한히 돌지 않게 하드캡.
const TURN_CAP_MS = 15 * 60_000;
// 텍스트 델타 발행 배치 — 토큰 단위 발행은 허브(링·영속)를 오염시킨다. 문장 뭉치로 흘린다.
const DELTA_FLUSH_MS = 700;
const DELTA_FLUSH_CHARS = 120;

interface ActiveTurn {
  turnId: string;
  proc: number;
}

let active: ActiveTurn | null = null;
// BUSY 게이트 — active 는 spawn 해소 후에야 서므로(그 전 중복 ask 통과 레이스) 진입 즉시 세운다.
let inFlight = false;
let cancelled = false;
let stopReason: string | null = null;

// 준비물(가르침·카탈로그) 캐시 — 명령 표면은 플러그인 생명주기에서만 바뀐다: 턴마다 재조회하지
// 않고, 활동 스트림에서 plugin.enable/disable/reload/... 실행이 관찰될 때만 무효화한다
// (이벤트 기반 — TTL·폴링 없음). 준비 조회가 매 턴 세트를 채우던 소음의 제거.
let prep: { key: string; skillDoc: string; catalog: string } | null = null;

/** 부트 1회(main) — 명령 표면 변동 관찰로 준비물 캐시를 무효화한다. */
export function watchPrepInvalidation(): void {
  safeListen<{ kind: string; payload: Record<string, unknown> }>("activity", (e) => {
    if (e.payload.kind !== "command.executed") return;
    const cmd = String((e.payload.payload as { command?: unknown })?.command ?? "");
    if (/^plugin\.(enable|disable|reload|install|remove|update)\b/.test(cmd)) prep = null;
  });
}

const nsGet = (k: string): string | null => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};
const nsSet = (k: string, v: string | null): void => {
  try {
    if (v === null) sessionStorage.removeItem(k);
    else sessionStorage.setItem(k, v);
  } catch {
    // storage 불능(하니스)은 연속성만 잃는다 — 턴 자체는 정상.
  }
};

// 로그인셸 래퍼 — GUI PATH 함정 회피 + 앱과 짝인 CLI 디렉토리(SOKSAK_CLI_DIR)를 PATH 에
// 앞세운다: 사용자 PATH 에 sok 이 없어도(신선 설치·개발 트리) `sok …` 이 해소된다.
const PATH_PRELUDE = `[ -n "$SOKSAK_CLI_DIR" ] && PATH="$SOKSAK_CLI_DIR:$PATH"; `;

// 짧은 프로세스 실행 + stdout 수집(로그인셸 — GUI PATH 함정 회피). 실패는 Error 로.
async function runCapture(shellCmd: string, env?: Record<string, string>): Promise<string> {
  // 완결 판정은 stdout 채널 하나로 — stdout 과 exit 는 서로 다른 채널이라 순서 보장이 없어,
  // 큰 출력(카탈로그 313KB)에서 exit 가 먼저 도착하면 잘린 출력을 반환했다(실측: JSON 파싱
  // 실패 → 빈 카탈로그 → 에이전트가 명령을 추측으로 더듬음). 셸이 출력 끝에 종결 sentinel
  // (+종료코드)을 같은 stdout 으로 찍고, 채널 내 순서(보장됨)로 완결·코드를 함께 읽는다.
  const SENTINEL = "__SOKSAK_CAPTURE_EOF__";
  let out = "";
  let err = "";
  const dec = new TextDecoder();
  const onStderr = new Channel<ArrayBuffer>();
  onStderr.onmessage = (m) => {
    err += dec.decode(new Uint8Array(m), { stream: true });
  };
  const done = new Promise<number>((resolve) => {
    let settled = false;
    const settle = (code: number) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };
    const onStdout = new Channel<ArrayBuffer>();
    onStdout.onmessage = (m) => {
      out += dec.decode(new Uint8Array(m), { stream: true });
      const at = out.lastIndexOf(SENTINEL);
      if (at >= 0) {
        const code = Number(out.slice(at + SENTINEL.length).trim() || "-1");
        out = out.slice(0, at);
        settle(Number.isFinite(code) ? code : -1);
      }
    };
    const onExit = new Channel<number>();
    // exit 는 폴백(스폰 실패·sentinel 이전 사망)만 — 성공 판정 권위는 sentinel 단독.
    // exit 가 마지막 stdout 배달보다 먼저 올 수 있으므로(채널 간 순서 미보장 — 이 함수가
    // 고치는 바로 그 레이스) 폴백의 "실패 선언"만 짧게 유예해 전송 중 배달을 소화한다.
    onExit.onmessage = (code) => {
      setTimeout(() => settle(code === 0 ? -1 : code), 200);
    };
    void invoke("process_spawn", {
      cmd: "/bin/sh",
      // sentinel 은 명령의 성공/실패와 무관하게 찍힌다($? 동반) — exec 불가(뒤 명령 필요).
      args: ["-lc", `${PATH_PRELUDE}{ ${shellCmd} ; }; printf '\\n${SENTINEL} %s\\n' "$?"`],
      cwd: null,
      env: env ?? null,
      envRemove: null,
      scrubAiEnv: true,
      ns: null,
      secretEnv: null,
      onStdout,
      onStderr,
      onExit,
    }).catch(() => settle(-1));
  });
  const code = await done;
  if (code !== 0) throw new Error(err.trim() || `종료 코드 ${code}`);
  return out;
}

// sok commands 응답(JSON 봉투)을 프롬프트용 한 줄 카탈로그로 압축(순수).
// 발견 왕복 제거가 목적(실측: 카탈로그 없인 --help→commands→필터 Bash 6회에 30초+).
export function compactCatalog(raw: string): string {
  try {
    const d = JSON.parse(raw) as {
      data?: { commands?: unknown[] };
      commands?: unknown[];
    };
    const cmds = (d.data?.commands ?? d.commands ?? []) as {
      name?: string;
      description?: string;
      params?: Record<string, { required?: boolean }>;
    }[];
    return cmds
      .filter((c) => typeof c.name === "string")
      .map((c) => {
        const ps = Object.entries(c.params ?? {})
          .map(([k, v]) => (v?.required ? `${k}*` : k))
          .join(", ");
        const desc = String(c.description ?? "").split(/(?<=\.)\s/)[0].slice(0, 90);
        return `${c.name}${ps ? ` {${ps}}` : ""} — ${desc}`;
      })
      .join("\n");
  } catch {
    return ""; // 카탈로그 실패는 발견 워크플로(느린 경로)로 자연 강등 — 턴은 계속된다
  }
}

// system prompt — 역할·행동 규칙 + soksak-control 가르침 원문(sok skill print, 라이브 단일진실)
// + 명령 카탈로그 전량(발견 왕복 제거). --setting-sources "" 헤드리스에선 스킬 자동로드가
// 없으므로 프롬프트에 직접 싣는 것이 정공법. sokPath = sok 실행 절대경로(있으면) — 에이전트
// Bash 의 PATH 는 신뢰 불가(실측: 자체 재구성). 가변부(무대)는 맨 뒤 — 앞부분이 턴 간 동일해야
// 프롬프트 캐시가 탄다(5분 내 재질문 가속).
function buildSystemPrompt(
  skillDoc: string,
  sokPath: string,
  catalog: string,
  stageWindow?: string,
): string {
  const stage = stageWindow
    ? `기본 무대 창이 env SOKSAK_WINDOW=${stageWindow} 로 지정되어 있다 — 창을 생략한 sok 명령은 그 창에서 실행된다.`
    : `기본 무대 창이 지정되지 않았다 — 창을 다루는 명령은 \`${sokPath} window.projects\` 로 창을 찾아 \`${sokPath} --window <label> <command>\` 로 명시 타겟하라.`;
  return [
    "당신은 soksak(터미널 앱) 오케스트레이터의 자연어 콘솔 에이전트다. 사용자의 명령을 sok CLI 로 실행해 완수하고, 결과를 한국어 한두 문장으로 보고한다.",
    "",
    "행동 규칙:",
    `- 이 환경의 sok 실행 파일: \`${sokPath}\` — 아래 문서의 \`sok\` 은 항상 이 경로로 실행한다. PATH 의 sok 을 기대하지 마라.`,
    `- 호출 형태는 정확히 \`${sokPath} <명령> '<JSON>'\` 하나다 — 파라미터는 JSON 한 덩이(작은따옴표)이며 --url 같은 플래그·키=값 인자는 존재하지 않는다(유일한 플래그: \`--window <label>\`). 예: \`${sokPath} panel.split '{"side":"right"}'\`.`,
    "- 앱 조작은 반드시 단일 sok 명령으로 한다. 파이프·&&·환경변수 프리픽스·다른 프로그램은 권한상 자동 거부된다.",
    "- 아래 카탈로그에서 명령을 바로 고른다 — 목록 재조회(sok commands) 금지. 명령이 거부되면 `help <명령>` 1회로 스키마를 확인해 고쳐 재시도한다.",
    "- 명령 응답(JSON 봉투)을 확인한 뒤 보고한다 — 추측 보고 금지.",
    "- 마지막 출력은 사용자에게 하는 답변이다: 간결한 한국어, 식별자(창 label 등) 나열 금지.",
    "",
    skillDoc.trim(),
    ...(catalog
      ? ["", "## 명령 카탈로그 (이름 {파라미터, *=필수} — 설명)", catalog]
      : []),
    "",
    stage,
  ].join("\n");
}

interface AskParams {
  text: string;
  window?: string;
}

/** 자연어 턴 실행 — orchestrator.ask 핸들러 본체. */
export async function ask(p: AskParams): Promise<CommandOutcome> {
  if (inFlight) {
    return {
      ok: false,
      code: "BUSY",
      message: "이미 진행 중인 턴이 있어요 — 완료를 기다리거나 orchestrator.stop 으로 중단하세요.",
    };
  }
  const text = p.text.trim();
  if (!text) return { ok: false, code: "INVALID_PARAMS", message: "text: 비어 있지 않아야 함" };
  inFlight = true;
  try {
    return await askInner(text, p.window);
  } finally {
    inFlight = false;
  }
}

async function askInner(text: string, explicitWindow?: string): Promise<CommandOutcome> {
  // 무대(stage) = 사용자의 실제 작업 위치 — 명시(param) > 마지막 포커스 워크스페이스 창.
  // 오케스트레이터 레일 선택은 피드 필터일 뿐 무대가 아니다(실측: 남은 선택이 남의 창에
  // 명령을 흘렸다 — 필터와 의도의 혼동). 콘솔에서 칠 때 활성 창은 main 이므로, 무대는
  // "마지막으로 일하던 워크스페이스"가 사용자 의도다.
  const stageWindow =
    explicitWindow ??
    (await invoke<string | null>("ipc_last_workspace_window").catch(() => null)) ??
    undefined;
  const turnId = crypto.randomUUID();
  publishActivity("chat.prompt", "orchestrator", { text, turnId });
  const close = (ok: boolean, code: string, answer: string): CommandOutcome => {
    publishActivity("chat.answer", "orchestrator", {
      text: answer,
      parentId: turnId,
      ok,
      code,
    });
    return ok
      ? { ok, code, message: answer, data: { turnId } }
      : { ok, code, message: answer };
  };

  // 소켓·가르침 준비 — sok 부재/앱 소켓 불능은 있는 그대로 답으로 닫는다(무음 금지).
  const socket = await invoke<string | null>("ipc_socket_path").catch(() => null);
  if (!socket) return close(false, "INTERNAL", "제어 소켓이 없어 에이전트를 시작할 수 없어요.");
  const cliDir = await invoke<string | null>("ipc_cli_dir").catch(() => null);
  const baseEnv: Record<string, string> = {
    SOKSAK_SOCKET: socket,
    ...(cliDir ? { SOKSAK_CLI_DIR: cliDir } : {}),
  };
  // 준비물(가르침·카탈로그) — 캐시가 유효하면 재조회하지 않는다(무효화 = 플러그인 생명주기
  // 관찰). 최초/무효화 후 1회만 조회하고, 그 준비 실행은 이 턴의 소산으로 세트에 접힌다.
  // 카탈로그는 무대 창 기준(플러그인 명령은 워크스페이스 창에만 로드 — main 은 컨트롤 플레인).
  const prepKey = stageWindow ?? "";
  let skillDoc: string;
  let catalog: string;
  if (prep && prep.key === prepKey) {
    ({ skillDoc, catalog } = prep);
  } else {
    try {
      skillDoc = await runCapture("sok skill print", { ...baseEnv, SOKSAK_PARENT: turnId });
    } catch (e) {
      return close(
        false,
        "INTERNAL",
        `sok CLI 를 찾지 못해 에이전트를 시작할 수 없어요 (${String(e instanceof Error ? e.message : e).slice(0, 200)})`,
      );
    }
    const catalogWindow =
      stageWindow ??
      (await execute("window.projects", {}, { remote: false, parent: turnId })
        .then((r) => (r.data as { projects?: { window?: string }[] } | undefined)?.projects?.[0]?.window)
        .catch(() => undefined));
    catalog = compactCatalog(
      await runCapture(
        `sok ${catalogWindow ? `--window ${catalogWindow} ` : ""}commands`,
        { ...baseEnv, SOKSAK_PARENT: turnId },
      ).catch(() => ""),
    );
    // 빈 카탈로그(실패)는 캐시하지 않는다 — 다음 턴이 다시 시도(느린 발견 경로로 강등만).
    if (catalog) prep = { key: prepKey, skillDoc, catalog };
  }

  const agentBin = useSettings.getState().orchestratorAgent.trim() || "claude";
  // 명령 라우팅 턴은 왕복이 잦다 — 빠른 모델이 체감을 지배(실측: opus 는 왕복당 4~6초).
  const agentModel = useSettings.getState().orchestratorModel.trim();
  // sok 은 절대경로로 지시·허용한다 — 에이전트 Bash 의 PATH 는 자체 재구성이라 신뢰 불가(실측).
  // env(SOKSAK_*)는 완전 상속됨(실측) — 상관·소켓 바인딩은 env 로 전달된다.
  const sokPath = cliDir ? `${cliDir}/sok` : "sok";
  const env: Record<string, string> = {
    ...baseEnv,
    SOKSAK_PARENT: turnId,
    ...(stageWindow ? { SOKSAK_WINDOW: stageWindow } : {}),
  };

  // 대화 이어가기(--resume)는 잔재일 수 있다(에이전트 교체·claude 측 세션 정리 — 실측: 스텁이
  // 남긴 id 로 실물이 기동 즉사 error_during_execution). 이어가기 즉사(자취 0)면 딱 한 번
  // 세션을 버리고 새 대화로 재시도한다 — 자취가 있으면 재시도 금지(명령 이중 실행 위험).
  let resume = nsGet(SESSION_KEY);
  for (let attempt = 0; ; attempt++) {
  // 프롬프트는 -p 바로 뒤(위치 인자) — --allowedTools 는 가변(<tools...>)이라 그 뒤에 두면
  // 프롬프트를 도구명으로 삼킨다(실측: "Input must be provided" 즉사).
  const args = [
    "-p",
    text,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--setting-sources",
    "",
    "--system-prompt",
    buildSystemPrompt(skillDoc, sokPath, catalog, stageWindow),
    "--allowedTools",
    "Bash(sok:*)",
    ...(cliDir ? [`Bash(${cliDir}/sok:*)`] : []),
    ...(agentModel ? ["--model", agentModel] : []),
    ...(resume ? ["--resume", resume] : []),
  ];

  const parser = new AgentStreamParser();
  const dec = new TextDecoder();
  // 클로저(채널 콜백) 대입은 TS 흐름 분석 밖 — 레코드 속성으로 담아 선언 타입이 지배하게 한다.
  const turn: { streamed: string; result: { ok: boolean; text: string } | null; session: string | null } = {
    streamed: "",
    result: null,
    session: null,
  };

  // 텍스트 델타 배치 발행 — 허브 오염 방지(토큰→문장 뭉치).
  let pendingDelta = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushDelta = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const chunk = pendingDelta.trim();
    pendingDelta = "";
    if (chunk) {
      publishActivity("command.progress", "orchestrator", {
        command: "orchestrator.ask",
        delta: chunk,
        parentId: turnId,
      });
    }
  };
  const queueDelta = (t: string) => {
    pendingDelta += t;
    if (pendingDelta.length >= DELTA_FLUSH_CHARS) flushDelta();
    else if (!flushTimer) flushTimer = setTimeout(flushDelta, DELTA_FLUSH_MS);
  };

  const onStdout = new Channel<ArrayBuffer>();
  onStdout.onmessage = (m) => {
    for (const ev of parser.feed(dec.decode(new Uint8Array(m), { stream: true }))) {
      if (ev.kind === "session") turn.session = ev.sessionId;
      else if (ev.kind === "text") {
        turn.streamed += ev.text;
        queueDelta(ev.text);
      } else if (ev.kind === "tool") {
        flushDelta();
        publishActivity("command.progress", "orchestrator", {
          command: "orchestrator.ask",
          delta: ev.detail ? `$ ${ev.detail}` : `도구 ${ev.name}`,
          parentId: turnId,
        });
      } else {
        turn.result = { ok: ev.ok, text: ev.text };
      }
    }
  };
  const stderr = { tail: "" };
  const onStderr = new Channel<ArrayBuffer>();
  onStderr.onmessage = (m) => {
    stderr.tail = (stderr.tail + dec.decode(new Uint8Array(m), { stream: true })).slice(-500);
  };
  // 빠른 종료 레이스: 초단명 프로세스(스텁 등)는 spawn invoke 해소보다 exit 채널이 먼저 올 수
  // 있다 — 종료 후 .then 이 active 를 되살리면 영구 BUSY. finished 게이트로 차단한다.
  let finished = false;
  const exited = new Promise<number>((resolve) => {
    const onExit = new Channel<number>();
    onExit.onmessage = resolve;
    void invoke<number>("process_spawn", {
      cmd: "/bin/sh",
      // claudeCli.ts 검증 형태: 로그인셸 PATH + $HOME 고정 + exec 치환. "$0"/"$@" 로 인자 무손실.
      args: ["-lc", `${PATH_PRELUDE}cd "$HOME" 2>/dev/null; exec "$0" "$@"`, agentBin, ...args],
      cwd: null,
      env,
      envRemove: null,
      scrubAiEnv: true, // 중첩 세션 가드 — AI 세션 env 정본(process.rs) 일괄 제거
      group: true, // stop 이 에이전트의 자식 트리(Bash 손자)까지 회수 — 직계만 죽이면 EOF 볼모
      ns: null,
      secretEnv: null,
      onStdout,
      onStderr,
      onExit,
    }).then(
      (id) => {
        if (finished) return; // 이미 끝난 턴 — 재점유 금지
        active = { turnId, proc: id };
        nsSet(TURN_KEY, JSON.stringify({ proc: id, turnId }));
      },
      () => resolve(-1),
    );
  });

  cancelled = false;
  const cap = setTimeout(() => {
    void stop("시간 상한(15분)으로 중단했어요.");
  }, TURN_CAP_MS);
  const code = await exited;
  finished = true;
  clearTimeout(cap);
  flushDelta();
  const wasCancelled = cancelled;
  cancelled = false;
  active = null;
  nsSet(TURN_KEY, null);
  if (turn.session) nsSet(SESSION_KEY, turn.session);

  if (wasCancelled) {
    const reason = stopReason ?? "중단했어요.";
    stopReason = null;
    return close(false, "CANCELLED", reason);
  }
  // 이어가기 즉사 감지 — resume 을 썼고 아무 자취(스트림 텍스트) 없이 오류/무응답 종료.
  // 세션을 버리고 새 대화로 1회 재시도(위 주석의 잔재 세션 자가치유).
  const stillborn = !turn.streamed && (!turn.result || !turn.result.ok);
  if (attempt === 0 && resume && stillborn) {
    resume = null;
    nsSet(SESSION_KEY, null);
    publishActivity("command.progress", "orchestrator", {
      command: "orchestrator.ask",
      delta: "이전 대화를 이어갈 수 없어 새 대화로 다시 시작",
      parentId: turnId,
    });
    continue;
  }
  if (turn.result) {
    const answer = (turn.result.text || turn.streamed).trim() || "(빈 응답)";
    return close(turn.result.ok, turn.result.ok ? "OK" : "INTERNAL", answer);
  }
  // result 없이 종료 = 스폰 실패·크래시. stderr 꼬리를 실어 있는 그대로 보고.
  const errTail = stderr.tail.trim();
  return close(
    false,
    "INTERNAL",
    `에이전트가 답 없이 종료됐어요 (코드 ${code}${errTail ? ` — ${errTail.slice(-200)}` : ""})`,
  );
  }
}

/** 진행 중 턴 중단 — orchestrator.stop 핸들러 본체. ask 쪽 exit 경로가 세트를 닫는다. */
export async function stop(reason?: string): Promise<CommandOutcome> {
  if (!active) return { ok: true, code: "NOOP", message: "진행 중인 턴이 없어요." };
  cancelled = true;
  stopReason = reason ?? "중단했어요.";
  await invoke("process_kill", { id: active.proc }).catch(() => {});
  return { ok: true, code: "OK", message: "진행 중인 턴을 중단했어요." };
}

/** 부트 1회 — 리로드 고아 정리. 이 창(main)이 리로드되면 JS 핸들은 사라지지만 자식 claude 는
 * 살아남는다(process.rs pump→drain). sessionStorage 기록은 리로드를 건너 살아남고 앱 재시작이면
 * 사라지므로(id 공간 새것 — 오살 방지), 기록이 있으면 죽이고 그 세트를 INTERRUPTED 로 닫는다. */
export function cleanupOrphanTurn(): void {
  const raw = nsGet(TURN_KEY);
  if (!raw) return;
  nsSet(TURN_KEY, null);
  try {
    const rec = JSON.parse(raw) as { proc?: number; turnId?: string };
    if (typeof rec.proc === "number") {
      void invoke("process_kill", { id: rec.proc }).catch(() => {});
    }
    if (typeof rec.turnId === "string" && rec.turnId) {
      publishActivity("chat.answer", "orchestrator", {
        text: "창이 리로드되어 진행 중이던 턴을 중단했어요.",
        parentId: rec.turnId,
        ok: false,
        code: "INTERRUPTED",
      });
    }
  } catch {
    // 손상 기록은 버린다 — 다음 턴은 정상.
  }
}
