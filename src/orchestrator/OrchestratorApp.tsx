// 오케스트레이터 창 셸(A3) — 사람이 오케스트레이션 전체를 지켜보는 화면(P12 의 뷰).
// 좌: 창·모니터 맵(window.monitors 팩트) / 우: 활동 피드(activity 브로드캐스트 + recent 백필)
// / 하: 명령 콘솔(레지스트리 실행). 셸은 커맨드·이벤트 표면만 소비한다 — 코어 내부 상태
// (sessions 등) 직접 참조 금지: 외부 클라이언트(폰·CLI)와 같은 자격이어야 P13 이 지켜진다.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { safeListen } from "../lib/safeListen";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { currentWindowLabel } from "../lib/webviewLabels";
import { execute, getSpec } from "../commands/registry";
import { Icon } from "../ui/icons/Icon";
import { NewProjectModal, type CreateProjectArgs } from "../components/NewProjectModal";
import { hasMessage, localize, useT, type MsgKey, type TFn } from "../i18n";
import { actorKeyOf, foldFeed, itemWindow, type ActivityEntry, type ChatCard } from "./feedFold";

const FEED_CAP = 500;

// 피드 한 줄 요약 — kind 별 사람이 읽는 문장(전체 payload 는 title 로).
function lineOf(e: ActivityEntry): string {
  const p = e.payload;
  switch (e.kind) {
    case "command.executed": {
      const head = `${p.command} ${p.ok ? "✓" : `✗ ${p.code ?? ""}`} (${p.durationMs}ms)`;
      return p.message ? `${head} → ${p.message}` : head;
    }
    // 진행 델타(요청→응답 사이 세부 — 사이드카 이벤트·터미널·AI thinking). textdelta 개념.
    case "command.progress":
      return `⋯ ${p.command ? `${p.command}: ` : ""}${p.delta ?? ""}`;
    case "terminal.command.started":
      return `$ ${p.commandLine}`;
    case "terminal.command.finished":
      return `종료 ${p.exitCode ?? ""}`;
    case "turn.ended":
      return `턴 종료${p.agentKind ? ` (${p.agentKind})` : ""}${p.command ? ` — ${p.command}` : ""}`;
    case "view.activated":
      return `뷰 활성화 ${p.viewId}`;
    // 대화 세트 구성원 — 카드 렌더가 정상 경로. 여기 도달 = 부모가 밀려난 고아(단독 표시).
    case "chat.prompt":
      return `💬 ${p.text ?? ""}`;
    case "chat.answer":
      return `↩ ${p.text ?? ""}`;
    case "boot.error":
      return `창 부팅 오류 — ${(p as { msg?: string }).msg ?? ""}`;
    default:
      return e.kind;
  }
}

// 명령을 사람이 읽는 라벨로 — raw 키(plugin.soksak-plugin-workflow.reconcile) 노출 금지.
// 소유 구조(18개 언어로 확장 가능한 유일한 형태):
//   · 플러그인 명령 = 매니페스트 contributes.commands 의 title(LocalizedText) — 저자가 소유·번역.
//   · 코어 명령 = 언어 테이블의 cmd.* 키(언어 추가 = 테이블 1장 추가, 정의 자리는 불변).
//     전 명령 커버리지는 commandTitles.test.ts 게이트가 강제한다 — 부분 커버리지 불가.
//   · 어느 쪽도 없으면 description(영어 산문) — raw 키는 어떤 경우에도 안 보인다.
function commandLabel(cmd: string, t: TFn, carried?: unknown): string {
  // 스트림이 나른 라벨 원본(LocalizedText) — 플러그인 명령은 실행 창에만 로드되므로 이 경로가
  // 창 경계를 넘는 유일한 라벨 공급선이다(스트림 자족성).
  if (carried && (typeof carried === "string" || typeof carried === "object"))
    return localize(carried as Parameters<typeof localize>[0]);
  const spec = getSpec(cmd);
  if (spec?.title) return localize(spec.title);
  const key = `cmd.${cmd}`;
  if (hasMessage(key)) return t(key as MsgKey);
  return spec?.description ?? cmd;
}

// 응답 media 렌더 — 봉투가 선언한 표시 미디어만 그린다(MESSAGE-PROTOCOL: 소비자는 키 추측 금지).
// base64 는 즉시 data URI, path 는 read_file_base64 로 지연 로드(실패 시 조용히 생략 — 파일 삭제됨 등).
function MediaView({ media, onZoom }: { media: unknown; onZoom: (src: string) => void }) {
  const m = media as { kind?: string; base64?: string; path?: string } | undefined;
  const isImage = typeof m?.kind === "string" && m.kind.startsWith("image/");
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    if (m?.base64) {
      setSrc(`data:${m.kind};base64,${m.base64}`);
      return;
    }
    if (m?.path) {
      let disposed = false;
      void invoke<{ mime: string; base64: string }>("read_file_base64", { path: m.path })
        .then((f) => {
          if (!disposed) setSrc(`data:${f.mime};base64,${f.base64}`);
        })
        .catch(() => {});
      return () => {
        disposed = true;
      };
    }
  }, [isImage, m?.base64, m?.path, m?.kind]);
  if (!isImage || !src) return null;
  return (
    <img
      className="orch-shot"
      alt=""
      src={src}
      data-node="orch/turn/media"
      title="클릭: 확대"
      onClick={(e) => {
        e.stopPropagation(); // 버블의 원문 JSON 토글과 분리
        onZoom(src);
      }}
    />
  );
}

// HH:MM:SS — 대화 버블 메타. 0/누락은 빈 문자열.
function fmtTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 활동 1건을 렌더 — 명령 실행은 요청/응답 대화 버블(시작·종료 시각 세움), 나머지는 단일 이벤트 줄.
// 메타의 창은 프로젝트명으로 보인다(nameOf). 요청 인자(params)는 노이즈라 버블 본문에 넣지 않고
// 전체 payload 는 title(hover)로만 — 결과 요약은 응답 버블에 남긴다.
function renderEntry(
  e: ActivityEntry,
  nameOf: (win: string) => string,
  showWho: boolean, // 프로젝트명은 "전체" 볼 때만(필터 시엔 헤더에 이미 있음)
  onToggle: (seq: number) => void, // 클릭: 원문 JSON 펼치기
  isExpanded: boolean,
  t: TFn,
  onZoom: (src: string) => void,
  deltas?: ActivityEntry[], // 이 턴에 접힌 진행 델타(MESSAGE-PROTOCOL §2 — 요청→델타→응답)
) {
  const win = String(e.payload.window ?? "");
  // 발화자 배지(§5 R3) — 파생은 actorKeyOf(단일 규칙), 라벨은 i18n 테이블 `actor.<키>` 해소
  // (명령 라벨 cmd.* 와 동일 소유 구조 — 키 추가 = 테이블 1줄, 코드 불변). 사람 손은 무배지
  // (창·콘솔 이름이 곧 발화자).
  const actorKey = actorKeyOf(e);
  const actorLabel = actorKey
    ? hasMessage(`actor.${actorKey}`)
      ? t(`actor.${actorKey}` as MsgKey)
      : actorKey
    : "";
  const who = win ? nameOf(win) : e.source;
  const meta = (ts: number) => (
    <>
      {fmtTime(ts)}
      {showWho ? ` · ${who}` : ""}
      {actorLabel && <span className="orch-actor">{actorLabel}</span>}
    </>
  );
  const raw = isExpanded ? (
    <pre className="orch-raw">{JSON.stringify(e.payload, null, 2)}</pre>
  ) : null;
  // 시스템 유래(§5 — 스케줄러 발화·부팅 부산물) — 기록은 보이되 흐림(사람 유래가 신호).
  const sys = typeof e.payload.origin === "string" && e.payload.origin ? " sys" : "";
  if (e.kind === "command.executed") {
    const p = e.payload;
    const ok = p.ok !== false;
    return (
      <div key={e.seq} className={`orch-turn${sys}`}>
        <div className="orch-bubble req" data-node="orch/turn/req">
          <div className="orch-bubble-meta">{meta(Number(p.startedAt))}</div>
          <div className="orch-bubble-body">{commandLabel(String(p.command), t, p.title)}</div>
        </div>
        {/* 진행 델타 — 요청과 응답 사이, 실행 중 "무엇을 했는지"의 흔적(§2). */}
        {deltas?.map((d) => (
          <div key={d.seq} className="orch-delta" data-node="orch/turn/delta">
            ⋯ {String((d.payload as { delta?: unknown }).delta ?? "")}
          </div>
        ))}
        {/* 응답 = 표준 답변 message. 클릭하면 원문 JSON(봉투 전체)을 펼친다. */}
        <div
          className={`orch-bubble res ${ok ? "ok" : "err"}${isExpanded ? " open" : ""}`}
          data-node="orch/turn/res"
          title="클릭: 원문 JSON"
          onClick={() => onToggle(e.seq)}
        >
          <div className="orch-bubble-meta">
            {fmtTime(Number(p.finishedAt))} · {String(p.durationMs ?? "")}ms
          </div>
          <div className="orch-bubble-body">
            {ok ? "✓" : `✗ ${String(p.code ?? "")}`} {String(p.message ?? "")}
          </div>
          {/* 응답이 media 를 선언하면 그대로 렌더(표준 — 키 추측 없음): base64 즉시, path 는 지연 로드. */}
          <MediaView media={p.media} onZoom={onZoom} />
        </div>
        {raw}
      </div>
    );
  }
  return (
    <div key={e.seq} className={`orch-event k-${e.kind.split(".").join("-")}${sys}`}>
      <div className="orch-event-line" onClick={() => onToggle(e.seq)} title="클릭: 원문 JSON">
        <span className="orch-bubble-meta">{meta(e.ts)}</span>
        <span className="orch-line">{lineOf(e)}</span>
      </div>
      {raw}
    </div>
  );
}

// 대화 세트 카드 — 질문(사용자) → 세트 구성원 seq 순(자식 명령은 그대로 renderEntry, 델타는
// 진행 줄, 답변은 응답 버블) → 미닫힘이면 진행 표시 + 중지. 카드는 부모(prompt) 창에 정박한다.
function renderChatCard(
  card: ChatCard,
  nameOf: (win: string) => string,
  showWho: boolean,
  onToggle: (seq: number) => void,
  expanded: Set<number>,
  t: TFn,
  onZoom: (src: string) => void,
  onStop: () => void,
) {
  const prompt = card.prompt;
  return (
    <div key={`chat-${prompt.seq}`} className="orch-chat" data-node="orch/chat">
      <div className="orch-bubble req chat" data-node="orch/chat/prompt">
        <div className="orch-bubble-meta">
          {fmtTime(prompt.ts)}
          {showWho ? ` · ${t("orch.console")}` : ""}
        </div>
        <div className="orch-bubble-body">{String(prompt.payload.text ?? "")}</div>
      </div>
      <div className="orch-chat-body">
        {card.body.map((e) => {
          if (e.kind === "command.progress") {
            return (
              <div key={e.seq} className="orch-delta" data-node="orch/chat/delta">
                ⋯ {String((e.payload as { delta?: unknown }).delta ?? "")}
              </div>
            );
          }
          if (e.kind === "chat.answer") {
            const ok = e.payload.ok !== false;
            const open = expanded.has(e.seq);
            return (
              <div
                key={e.seq}
                className={`orch-bubble res chat ${ok ? "ok" : "err"}${open ? " open" : ""}`}
                data-node="orch/chat/answer"
                title="클릭: 원문 JSON"
                onClick={() => onToggle(e.seq)}
              >
                <div className="orch-bubble-meta">{fmtTime(e.ts)}</div>
                <div className="orch-bubble-body">{String(e.payload.text ?? "")}</div>
                {open && <pre className="orch-raw">{JSON.stringify(e.payload, null, 2)}</pre>}
              </div>
            );
          }
          return renderEntry(e, nameOf, showWho, onToggle, expanded.has(e.seq), t, onZoom, undefined);
        })}
      </div>
      {!card.closed && (
        <div className="orch-chat-running" data-node="orch/chat/running">
          <span>⋯ {t("orch.chatRunning")}</span>
          <button type="button" data-node="orch/chat/stop" onClick={onStop}>
            {t("orch.stop")}
          </button>
        </div>
      )}
    </div>
  );
}

export function OrchestratorApp() {
  const t = useT();
  const [feed, setFeed] = useState<ActivityEntry[]>([]);
  // 좌측은 모든 프로젝트(최근 연 것 ∪ 지금 열린 것). window!=null 이면 열려 있어 그 창을 가진다.
  const [projects, setProjects] = useState<{ root: string; name: string; window: string | null }[]>([]);
  const [cmd, setCmd] = useState("");
  const [result, setResult] = useState<string>("");
  const [pinned, setPinned] = useState(false); // 핀 = always-on-top(이 창 로컬, 재열기 시 off)
  // 피드 필터 선택 — 단위는 "프로젝트"(root). 하이라이트도 root 로 매긴다: 한 창이 여러
  // 프로젝트를 호스트할 수 있어 창 단위 하이라이트는 동시 다중 선택처럼 보인다(버그 리포트).
  // 피드 이벤트는 window 라벨만 실으므로 필터는 선택 프로젝트의 창으로 수행한다.
  const [selected, setSelected] = useState<{ root: string; window: string } | null>(null);
  const [unread, setUnread] = useState(0); // 위로 스크롤해 보던 중 도착한 안읽은 항목 수
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set()); // 원문 JSON 펼친 항목(seq)
  const [zoomSrc, setZoomSrc] = useState<string | null>(null); // 이미지 확대(라이트박스)
  const feedRef = useRef<HTMLDivElement>(null);

  const toggleExpand = useCallback((seq: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }, []);
  const atBottomRef = useRef(true); // 피드 바닥 근처 여부 — 바닥이면 따라가고, 아니면 안읽음 누적

  // 피드 스크롤 추적: 바닥 근처면 계속 따라가고 안읽음을 0으로, 위로 올리면 추종 중단.
  const onFeedScroll = useCallback(() => {
    const el = feedRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottomRef.current) setUnread(0);
  }, []);

  // 핀 토글(z-order 케이스 1) — on 이면 뭘 하든 오케스트레이터가 최상단 고정.
  const togglePin = useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      void getCurrentWindow().setAlwaysOnTop(next).catch(() => {});
      return next;
    });
  }, []);

  // 좌측 창 목록은 피드 필터 선택일 뿐 — 창을 호출(포커스)하지 않는다. 항목 클릭은 그 창으로
  // 피드를 좁히고("전체" 항목은 필터 해제), 창을 앞으로 부르는 건 항목 우측 포커스 아이콘이 맡는다.
  const focusWindow = useCallback((label: string) => {
    void invoke("window_focus", { label }).catch(() => {});
  }, []);

  // 피드 메타의 창 라벨(w-<uuid>)을 프로젝트명으로 — 창 라벨은 사람에게 무의미하다.
  const nameOf = useCallback(
    (win: string) =>
      win === currentWindowLabel()
        ? t("orch.console") // 이 창(콘솔) 실행 — 프로젝트가 아니라 관제 자신의 행위
        : (projects.find((p) => p.window === win)?.name ?? win),
    [projects, t],
  );

  // 좌측 프로젝트 목록 = 최근 연 것(project.recent) ∪ 지금 열린 것(project_owners). 열린 것은
  // 소유 창(window)을 갖는다. 프로젝트 열림/닫힘마다 project-registry-change 로 자동 갱신.
  const refreshProjects = useCallback(() => {
    void (async () => {
      let recents: { root: string; alias?: string }[] = [];
      let owners: { root: string; window: string }[] = [];
      try {
        // 내부 조회(레일 채우기) — 사람 의도가 아니다(§5 origin:"internal", 무계측).
        const r = await execute("project.recent", {}, { remote: false, origin: "internal" });
        if (r.ok) recents = (r.data as { recents?: typeof recents } | undefined)?.recents ?? [];
      } catch {
        /* 무시 — 빈 목록 */
      }
      try {
        owners = (
          await invoke<{ owners: { root: string; window: string }[] }>("project_owners")
        ).owners;
      } catch {
        /* 무시 */
      }
      const ownerOf = new Map(owners.map((o) => [o.root, o.window]));
      const aliasOf = new Map(recents.map((r) => [r.root, r.alias]));
      const order: string[] = [];
      const seen = new Set<string>();
      for (const r of [...recents.map((x) => x.root), ...owners.map((x) => x.root)]) {
        if (!seen.has(r)) {
          seen.add(r);
          order.push(r);
        }
      }
      setProjects(
        order.map((root) => ({
          root,
          name: aliasOf.get(root) || root.split("/").filter(Boolean).pop() || root,
          window: ownerOf.get(root) ?? null,
        })),
      );
    })();
  }, []);

  // 안 열린 프로젝트 클릭 = 열기(그 root 로 창 생성; 이미 열려 있으면 P6 로 그 창 포커스).
  const openProject = useCallback((root: string) => {
    void execute("window.new", { root }, { remote: false }).catch(() => {});
  }, []);

  // 프로젝트 생성 — 열기·생성의 단일 표면은 컨트롤 플레인이다(워크스페이스 픽커 소멸).
  // 모달이 폴더를 준비·검증하고, 여기서는 그 root 로 새 워크스페이스 창을 연다.
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const createProject = useCallback(async (args: CreateProjectArgs) => {
    await execute(
      "window.new",
      { root: args.root, ...(args.alias ? { alias: args.alias } : {}), ...(args.shell ? { shell: args.shell } : {}) },
      { remote: false },
    );
  }, []);

  useEffect(() => {
    // 네이티브 타이틀(Dock 창 목록 구분) — 프로젝트 창과 같은 규칙: 이름만, 앱 이름 무접미.
    void getCurrentWindow().setTitle(t("orch.title")).catch(() => {});
    // 백필(커서) 후 라이브 구독 — 폴링 0. 구독/해지는 safeListen 단일 유틸(중복 해지 가드).
    void invoke<ActivityEntry[]>("activity_recent", { since: null, limit: 200 }).then(
      (entries) => setFeed(entries),
    );
    const un = safeListen<ActivityEntry>("activity", (ev) => {
      const e = ev.payload;
      setFeed((cur) => {
        if (cur.length && cur[cur.length - 1].seq >= e.seq) return cur; // 백필 겹침 dedup
        const next = [...cur, e];
        return next.length > FEED_CAP ? next.slice(next.length - FEED_CAP) : next;
      });
      if (!atBottomRef.current) setUnread((u) => u + 1); // 위로 스크롤 중이면 안읽음 누적
    });
    // 프로젝트 열림/닫힘/소유 창 변경마다 코어가 broadcast — 좌측 프로젝트 목록을 자동 갱신한다.
    const unReg = safeListen("project-registry-change", refreshProjects);
    refreshProjects();
    return () => {
      un();
      unReg();
    };
  }, [refreshProjects]);

  // 새 항목 도착 시: 바닥에 있었으면 계속 따라간다. 위로 스크롤해 보던 중이면 건드리지 않고
  // 안읽음 배지로 알린다(onFeedScroll 이 atBottomRef 를 추적).
  useEffect(() => {
    const el = feedRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [feed]);

  const runCommand = useCallback(async () => {
    const trimmed = cmd.trim();
    if (!trimmed) return;
    // `>` 접두 = raw 명령 직행(기존 콘솔 그대로 — 파워유저·E2E 경로). 기본은 자연어 턴.
    if (trimmed.startsWith(">")) {
      const rawCmd = trimmed.slice(1).trim();
      if (!rawCmd) return;
      const sp = rawCmd.indexOf(" ");
      const name = sp < 0 ? rawCmd : rawCmd.slice(0, sp);
      let params: Record<string, unknown> = {};
      if (sp >= 0) {
        try {
          params = JSON.parse(rawCmd.slice(sp + 1)) as Record<string, unknown>;
        } catch (e) {
          setResult(`파라미터 JSON 오류: ${String(e)}`);
          return;
        }
      }
      // 콘솔은 사람의 손 — ui 출처(danger 게이트는 remote 전용). 실행 사실은 계측이 피드에 남긴다.
      const out = await execute(name, params, { remote: false });
      setResult(JSON.stringify(out, null, 2));
      return;
    }
    // 자연어 턴 — 진행·답은 피드의 대화 카드가 보여준다(chat.prompt→…→chat.answer).
    // 무대는 넘기지 않는다: 레일 선택은 피드 필터일 뿐이다(필터≠의도). 기본 무대는
    // 코어가 아는 "마지막 포커스 워크스페이스 창"(orchestrator/agent.ts).
    setCmd("");
    setResult("");
    const out = await execute("orchestrator.ask", { text: trimmed }, { remote: false });
    // 세트가 열리기 전의 거절(BUSY 등)만 결과 상자로 — 세트가 닫힌 오류는 카드가 보여준다.
    if (!out.ok && (out.code === "BUSY" || out.code === "INVALID_PARAMS")) {
      setResult(`${out.code}: ${out.message}`);
    }
  }, [cmd]);

  return (
    <div className="orch-root" data-node="orch">
      <header className="orch-header" data-tauri-drag-region>
        <span className="orch-title">{t("orch.title")}</span>
        <button
          type="button"
          className={`icon-btn orch-pin${pinned ? " active" : ""}`}
          data-node="orch/pin"
          title={pinned ? t("orch.unpin") : t("orch.pin")}
          aria-pressed={pinned}
          onClick={togglePin}
        >
          <Icon name={pinned ? "pin-filled" : "pin"} />
        </button>
      </header>
      <div className="orch-body">
        <section className="orch-map" data-node="orch/map">
          <h2>{t("orch.projects")}</h2>
          {/* "전체" = 피드 필터 해제. 필터링 선택이므로 목록에 둔다(피드 우측 배지 대신). */}
          <button
            type="button"
            className={`orch-proj all${selected === null ? " selected" : ""}`}
            data-node="orch/proj/all"
            onClick={() => setSelected(null)}
          >
            {t("orch.allProjects")}
          </button>
          {projects.map((p) => {
            const open = p.window !== null;
            return (
              <div
                key={p.root}
                className={`orch-proj${open ? "" : " closed"}${
                  selected?.root === p.root ? " selected" : ""
                }`}
              >
                {/* 라벨 클릭: 열린 것 = 그 창으로 피드 필터. 안 열린 것은 열지 않는다 —
                    창 열기는 우측 아이콘만의 몫(선택이 창을 강제로 만들면 안 된다). */}
                <button
                  type="button"
                  className="orch-proj-label"
                  data-node={`orch/proj/${p.name}`}
                  title={p.root}
                  onClick={() => open && p.window && setSelected({ root: p.root, window: p.window })}
                >
                  {p.name}
                </button>
                {/* 우측 아이콘: 화살표 하나로 통일(+ 는 "추가"로 읽힌다) — 색으로 구분.
                    열린 것 = 그 창 앞으로 호출, 안 열린 것 = 새 창으로 열기. */}
                <button
                  type="button"
                  className="orch-proj-call"
                  data-node={`orch/proj-call/${p.name}`}
                  title={open ? t("orch.callWindow") : t("orch.openProject")}
                  onClick={() => (open ? focusWindow(p.window as string) : openProject(p.root))}
                >
                  <Icon name="arrow-up-right" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="orch-proj-new"
            data-node="orch/new-project"
            onClick={() => setNewProjectOpen(true)}
          >
            <Icon name="add" size="sm" /> {t("project.new")}
          </button>
        </section>
        <section className="orch-feed-wrap">
          <h2>
            {t("orch.feed")}
            {selected && (
              <span className="orch-feed-scope">
                {" — "}
                {projects.find((p) => p.root === selected.root)?.name ?? selected.window}
              </span>
            )}
          </h2>
          <div className="orch-feed" data-node="orch/feed" ref={feedRef} onScroll={onFeedScroll}>
            {(() => {
              // 접기는 필터 전 전체 피드에서(feedFold — parentId 정본 + 레거시 휴리스틱).
              // 세트 가시성 = 부모 기준: 대화 카드(부모 window=main=own)는 어떤 프로젝트를
              // 선택해도 자식(w-*)까지 완전체로 보인다 — "자기 행위는 항상 보인다"의 세트 확장.
              const own = currentWindowLabel();
              const items = foldFeed(feed);
              const visible = selected
                ? items.filter(
                    (it) => itemWindow(it) === selected.window || itemWindow(it) === own,
                  )
                : items;
              return visible.map((it) =>
                it.kind === "chat"
                  ? renderChatCard(
                      it,
                      nameOf,
                      selected === null,
                      toggleExpand,
                      expanded,
                      t,
                      setZoomSrc,
                      () => void execute("orchestrator.stop", {}, { remote: false }),
                    )
                  : renderEntry(
                      it.entry,
                      nameOf,
                      selected === null,
                      toggleExpand,
                      expanded.has(it.entry.seq),
                      t,
                      setZoomSrc,
                      it.deltas,
                    ),
              );
            })()}
          </div>
          {unread > 0 && (
            <button
              type="button"
              className="orch-unread"
              data-node="orch/unread"
              onClick={() => {
                const el = feedRef.current;
                if (el) el.scrollTop = el.scrollHeight;
                setUnread(0);
              }}
            >
              <Icon name="arrow-down" /> {t("orch.unread")} {unread}
            </button>
          )}
        </section>
      </div>
      {newProjectOpen && (
        <NewProjectModal onClose={() => setNewProjectOpen(false)} create={createProject} />
      )}
      {zoomSrc && (
        <div
          className="orch-lightbox"
          data-node="orch/lightbox"
          onClick={() => setZoomSrc(null)}
          onKeyDown={(e) => e.key === "Escape" && setZoomSrc(null)}
          role="button"
          tabIndex={0}
        >
          <img alt="" src={zoomSrc} />
        </div>
      )}
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
