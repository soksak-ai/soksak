// soksak-claude-gui — 터미널 패널에서 claude(Claude Code CLI)가 실행되면 그 패널 상태바에
// "GUI" 항목이 뜨고, 누르면 패널을 덮는 오버레이가 열려 claude 대화를 GUI 로 렌더한다.
//
// 모토: cc2(claude 원본 TUI)의 구성요소를 그대로 GUI 로 옮긴다. 메시지 종류별 마커·색·레이아웃은
//   cc2 컴포넌트 스펙을 따른다(⏺ 어시스턴트 점, ⎿ 결과 분기, ∴ thinking, 도구 이름 칩, 사용자
//   배경 밴드). 서브에이전트(별도 <sessionId>/subagents/agent-*.jsonl)·에이전트팀·태스크도 적절히
//   중첩 표현한다.
//
// 데이터: 전부 코어 범용 fs 소켓으로 — 활성 세션 JSONL 을 offset tail(폴링 없음, 코어 watcher 의
//   fs-change 구독)로 증분 파싱. cwd→트랜스크립트 디렉토리 인코딩·파싱·렌더는 전부 이 플러그인
//   소유(코어는 claude 를 모른다 — decoupled).
//
// 5H/7W 사용량 한도는 JSONL 에 없다(API 응답 헤더 → claude 메모리 → statusLine 훅에만 노출).
//   헤더엔 JSONL 로 얻는 것만: 모델·effort(settings.json)·토큰·컨텍스트·모드·세션·git 브랜치.

// ── 입력 readiness 분류기(버퍼 → 상태) — 순수함수, 테스트 노출(named export) ──────
// claude TUI(Ink, alternate screen)의 렌더 시그니처로 판별. 셸(bash/zsh/sh)과 무관 —
// readBuffer 는 term.buffer.active(=claude 화면)만 본다.
//   modal     : 입력을 가로채는 오버레이(권한·/status·선택 등). 실측 시그니처 = dismiss 힌트
//               "Esc to cancel/go back/close/dismiss/exit"(cc2 검증: PermissionPrompt.tsx:309
//               "Esc to cancel" + /status 등 19×). 이 힌트가 뜨면 입력란 focus=false 라 주입이
//               그쪽으로 소비되므로 주입 금지. (코너 글리프는 환영 배너에도 있어 오탐 → 미사용.)
//   responding: "esc to interrupt"(cc2 SpinnerAnimationRow.tsx:216) — focus=true 유지, 주입 시
//               claude 큐 적재(안전). "interrupt" 는 dismiss 힌트가 아니다.
//   prompt    : 그 외(정상 입력 대기).
// [검증] cc2 src 근거 + 단위 테스트(claudeGuiQueue.test.ts) + 실세션 스크린샷(2026-06-14 /status).
export function classifyBuffer(bufferText) {
  const buf = String(bufferText == null ? "" : bufferText);
  if (!buf) return "prompt";
  const tail = buf.split("\n").slice(-16).join("\n");
  if (/esc to (cancel|go ?back|close|dismiss|exit)/i.test(tail)) return "modal";
  if (/esc to interrupt/i.test(tail)) return "responding";
  return "prompt";
}

// ── 입력 3계층 검증 큐(D.1) — 주입형 deps(실 터미널 불요 → 테스트 가능) ─────────────
// L1 PTY 주입 → L2 버퍼 출현(claude 수신) → L3 JSONL user 라인(실제 입력 확정 = 제거점).
// 4-상태: held → injecting → awaiting → 제거. 모달 게이트로 부작용 차단, FIFO head-매칭으로
// 중복 안전(user 라인 1개당 항목 1개), injecting 단일화로 이중주입 차단.
// deps: { sendText(text), readBuffer(lines), onOutput(cb)→unsub, onRender(items),
//         setTimer(fn,ms)→h, clearTimer(h), tail?, maxTries?, timeoutMs? }
export function createInputQueue(deps) {
  const readBuffer = deps.readBuffer;
  const sendText = deps.sendText;
  const onRender = deps.onRender || function () {};
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((h) => clearTimeout(h));
  const TAIL = deps.tail || 60;
  const MAX_TRIES = deps.maxTries || 2;
  const TIMEOUT = deps.timeoutMs || 2500;
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const items = []; // {text, state, reason, tries, beforeCount}
  let injTimer = null;
  let outSub = null;

  const countOcc = (hay, needle) => {
    if (!needle) return 0;
    let n = 0;
    let i = 0;
    while ((i = hay.indexOf(needle, i)) !== -1) {
      n++;
      i += needle.length;
    }
    return n;
  };
  const bufNorm = () => norm(readBuffer(TAIL) || "");
  const snapshot = () =>
    items.map((it) => ({ text: it.text, state: it.state, reason: it.reason || null }));
  const render = () => onRender(snapshot());
  const clearInj = () => {
    if (injTimer != null) {
      clearTimer(injTimer);
      injTimer = null;
    }
  };

  // 변경 이벤트(프레임)마다: injecting head 의 L2 확인 후 다음 항목 드레인.
  function onTick() {
    if (!items.length) return;
    const inj = items.find((it) => it.state === "injecting");
    if (inj) {
      if (countOcc(bufNorm(), norm(inj.text)) > inj.beforeCount) {
        inj.state = "awaiting"; // L2: claude 수신(입력란/큐). 절대 재주입 안 함.
        clearInj();
        render();
      } else {
        return; // 미확인 — 다음 주입 보류(이중주입 방지)
      }
    }
    drainNext();
  }

  function drainNext() {
    if (items.some((it) => it.state === "injecting")) return; // 한 번에 하나만
    const next = items.find((it) => it.state === "held" && it.reason !== "stuck");
    if (!next) return;
    const st = classifyBuffer(readBuffer(TAIL) || "");
    if (st === "modal") {
      if (next.reason !== "modal") {
        next.reason = "modal";
        render();
      }
      return; // 보류 — 모달에 주입 금지(부작용 차단)
    }
    next.reason = null;
    next.state = "injecting";
    next.tries = (next.tries || 0) + 1;
    next.beforeCount = countOcc(bufNorm(), norm(next.text)); // 주입 전 동일내용 수(오확인 방지)
    render();
    sendText(next.text + "\r"); // L1
    clearInj();
    injTimer = setTimer(() => {
      injTimer = null;
      const h = items.find((it) => it.state === "injecting");
      if (!h) return;
      // L2 미확인 채 타임아웃 = lost(게이트 놓친 모달 등). 재시도 또는 보류(무한 재주입 금지).
      h.state = "held";
      if (h.tries >= MAX_TRIES) {
        h.reason = "stuck";
        render();
      } else {
        h.reason = null;
        render();
        drainNext();
      }
    }, TIMEOUT);
  }

  return {
    enqueue(text) {
      if (!text || !String(text).trim()) return;
      items.push({ text: String(text), state: "held", reason: null, tries: 0, beforeCount: 0 });
      if (!outSub) outSub = deps.onOutput(onTick); // 첫 항목에 변경 구독 시작
      render();
      drainNext();
    },
    // L3: 라이브 JSONL user 텍스트 라인 = 실제 입력 확정. 가장 오래된 동일내용 항목 1개 제거.
    confirmUserLine(text) {
      const t = norm(text);
      if (!t) return;
      const idx = items.findIndex((it) => norm(it.text) === t);
      if (idx === -1) return; // 외부 발신(TUI 직접 등) — 우리 head 아님, skip
      const wasInjecting = items[idx].state === "injecting";
      items.splice(idx, 1);
      if (wasInjecting) clearInj();
      render();
      drainNext();
    },
    snapshot,
    // 오버레이 닫힘→재오픈 사이 항목 보존(pane 레벨 persistence). awaiting 은 재주입 금지
    // (이미 claude 큐에 있음 — L3 만 대기), 그 외는 held 로 재드레인.
    restore(saved) {
      if (!saved || !saved.length) return;
      for (const it of saved) {
        const keep = it.state === "awaiting";
        items.push({
          text: it.text,
          state: keep ? "awaiting" : "held",
          reason: keep ? it.reason || null : null,
          tries: 0,
          beforeCount: 0,
        });
      }
      if (!outSub) outSub = deps.onOutput(onTick);
      render();
      drainNext();
    },
    hasPending() {
      return items.length > 0;
    },
    dispose() {
      clearInj();
      if (outSub) {
        try {
          outSub();
        } catch {
          /* noop */
        }
        outSub = null;
      }
      items.length = 0;
      render();
    },
  };
}

// ── ② 라이브 응답 파서(readBuffer 기반) — 순수, 테스트 노출 ─────────────────────
// 진행 중(응답중) claude TUI 화면에서 스트리밍 어시스턴트 텍스트·토큰·상태를 뽑는다.
// JSONL 은 완료 메시지만 담으므로(turn 종료 후), 진행 중 표시는 버퍼가 유일 소스(②평면).
// [검증] 시그니처는 cc2 src 근거(SpinnerAnimationRow.tsx:216 "esc to interrupt", figures.ts ⏺) +
// 단위테스트. 실 캡처가 최종 게이트.
export function parseLiveResponse(bufferText) {
  const buf = String(bufferText == null ? "" : bufferText);
  const responding = /esc to interrupt/i.test(buf);
  if (!responding) return { responding: false, tokens: null, text: "" };
  let tokens = null;
  const tm = buf.match(/([\d.]+)\s*(k?)\s*tokens/i);
  if (tm) {
    const n = parseFloat(tm[1]);
    if (!isNaN(n)) tokens = Math.round(tm[2] ? n * 1000 : n);
  }
  // 진행 텍스트 = 마지막 ⏺(어시스턴트 마커) 라인부터 스피너/입력박스 보더 직전까지.
  const lines = buf.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("⏺")) {
      start = i;
      break;
    }
  }
  let text = "";
  if (start !== -1) {
    const out = [];
    for (let i = start; i < lines.length; i++) {
      const ln = lines[i];
      if (/esc to interrupt/i.test(ln)) break; // 스피너 경계
      if (/^\s*[─━]{3,}/.test(ln)) break; // 입력박스 보더 경계
      out.push(ln);
    }
    text = out.join("\n").replace(/^⏺\s?/, "").replace(/\s+$/, "");
  }
  return { responding: true, tokens, text };
}

// ── ③ 에이전트 진행 합성 — 순수, 테스트 노출 ──────────────────────────────────
// agent-{id}.jsonl 엔트리 + agent-{id}.meta.json 으로 진행 라인을 합성한다. 실측만 —
// tool_use 카운트·usage 합·마지막 tool. 거짓 진행률 금지(cc2 LocalAgentTask 패턴).
export function synthAgentProgress(entries, meta) {
  const m = meta || {};
  let tools = 0;
  let tokens = 0;
  let lastTool = null;
  for (const e of entries || []) {
    if (!e || e.type !== "assistant") continue;
    const msg = e.message || {};
    const u = msg.usage || {};
    tokens += u.output_tokens || 0;
    const content = Array.isArray(msg.content) ? msg.content : [];
    for (const b of content) {
      if (b && b.type === "tool_use") {
        tools++;
        lastTool = b.name || lastTool;
      }
    }
  }
  return {
    agentType: m.agentType || "",
    description: m.description || "",
    tools,
    tokens,
    lastTool,
  };
}

// ── B: Edit/Write 구조화 diff — 순수, 테스트 노출 ─────────────────────────────
// 공통 prefix/suffix 보존 + 중간만 del/add(최소 라인 diff). cc2 의 구조화 diff 표기 대응.
export function diffLines(oldStr, newStr) {
  const oa = String(oldStr == null ? "" : oldStr);
  const ob = String(newStr == null ? "" : newStr);
  const a = oa === "" ? [] : oa.split("\n");
  const b = ob === "" ? [] : ob.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const out = [];
  for (let i = 0; i < p; i++) out.push({ type: "ctx", text: a[i] });
  for (let i = p; i < a.length - s; i++) out.push({ type: "del", text: a[i] });
  for (let i = p; i < b.length - s; i++) out.push({ type: "add", text: b[i] });
  for (let i = a.length - s; i < a.length; i++) out.push({ type: "ctx", text: a[i] });
  return out;
}

// ── B: tool_result 결과 카운트 — 순수, 테스트 노출 ───────────────────────────
// 도구가 정하는 결과 요약(Read N lines / Grep N matches). 과장 금지 — 모르는 도구는 빈값.
export function toolResultSummary(name, resultText) {
  const t = String(resultText == null ? "" : resultText);
  if (!t.trim()) return "";
  const lineCount = t.split("\n").filter((l) => l.length > 0).length;
  switch (name) {
    case "Read":
      return `${lineCount} lines`;
    case "Grep":
    case "Glob":
      return `${lineCount} matches`;
    default:
      return "";
  }
}

// 활성 세션 선택 정책 = 프로젝트 dir 에서 "활발히 append 되는 jsonl(newest mtime)".
// children = fs.list 의 항목들({ name, dir, modified(unix sec) }). since(unix sec) 이전 수정
// 파일은 후보에서 제외(startup stale 방지) — 단 resume 한 옛 세션도 append 되면 mtime 이 갱신돼
// 다시 후보가 된다. 그래서 /resume 로 다른 세션을 골라 그 세션이 쓰이면 즉시 그 세션을 고른다.
// session-env 마커는 쓰지 않는다(codex companion·서브에이전트·헤드리스로 오염, resume 미반영).
export function pickActiveSession(children, since) {
  let jsonls = (children || []).filter(
    (c) => c && !c.dir && /^[0-9a-f-]{36}\.jsonl$/.test(c.name),
  );
  if (since) jsonls = jsonls.filter((c) => (c.modified || 0) >= since);
  jsonls.sort((a, b) => (b.modified || 0) - (a.modified || 0));
  return jsonls.length ? jsonls[0].name.replace(/\.jsonl$/, "") : null;
}

// 슬래시 명령은 transcript 에 <command-name>/clear</command-name> 등으로 저장된다. raw 로 토하지
// 말고 깔끔히 렌더하기 위해 파싱한다. command(이름+인자) / stdout(출력) / null(명령 아님).
export function parseCommandTags(text) {
  const t = String(text == null ? "" : text);
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(t);
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t);
    const nm = name[1].trim();
    return { kind: "command", name: nm.startsWith("/") ? nm : "/" + nm, args: args ? args[1].trim() : "" };
  }
  const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(t);
  if (out) return { kind: "stdout", text: out[1].trim() };
  return null;
}

export default {
  activate(ctx) {
    const CLAUDE_RE = /(^|\s|\/)claude(\s|$)/;
    // 오버레이는 UI 폰트(터미널 monospace 가 아니라) — 패널에서 상속되는 폰트를 끊는다.
    const UI_FONT =
      '-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans KR",system-ui,sans-serif';
    const MONO =
      'ui-monospace,SFMono-Regular,"JetBrains Mono","SF Mono",Menlo,monospace';
    const cssEsc = (s) =>
      window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\\]]/g, "\\$&");
    const paneEl = (paneId) =>
      document.querySelector(`[data-pane-id="${cssEsc(paneId)}"]`);
    // 마지막 N 개 메시지만 DOM 으로(터미널 스크롤백처럼) — 거대 세션의 DOM 폭주 방지.
    const RENDER_CAP = 300;

    // 플러그인 자체 스타일 1회 주입(테마 토큰 사용 — 코어 CSS 헌법 영역 아님, 플러그인 소유).
    const STYLE_ID = "soksak-claude-gui-style";
    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const s = document.createElement("style");
      s.id = STYLE_ID;
      s.textContent = `
.cg-overlay{position:absolute;inset:0;z-index:40;display:flex;flex-direction:column;
  background:var(--bg,#0d1117);color:var(--fg,#e6e6e6);overflow:hidden;
  user-select:text;-webkit-user-select:text}
/* 마커·커넥터·버튼은 비선택(복사 시 글리프 오염 방지 — cc2 의도). */
.cg-dot,.cg-sys-mark,.cg-todo-i,.cg-agent-dot,.cg-caret,.cg-x,.cg-send,.cg-sep{
  user-select:none;-webkit-user-select:none}
.cg-head{display:flex;align-items:center;gap:10px;padding:7px 12px;flex:0 0 auto;
  border-bottom:1px solid var(--bd,#3a3f4b);font-size:12px}
.cg-title{font-weight:600;flex:0 0 auto}
.cg-meta{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;flex-wrap:wrap}
.cg-chip{font-size:11px;padding:1px 7px;border-radius:6px;background:var(--accbg);
  color:var(--acc);white-space:nowrap}
.cg-chip.cg-dim{background:transparent;color:inherit;opacity:.5}
.cg-session:hover{opacity:.95;text-decoration:underline}
.cg-cwd{opacity:.5;font-size:11px;max-width:32%;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;flex:0 1 auto}
.cg-x{border:none;background:none;color:inherit;cursor:pointer;font-size:13px;
  line-height:1;flex:0 0 auto;opacity:.7}
.cg-x:hover{opacity:1}
.cg-body{flex:1 1 auto;overflow:auto;padding:14px 16px 24px}
.cg-row{margin-top:12px;display:flex;flex-direction:column}
.cg-row:first-child{margin-top:0}
.cg-dim{opacity:.55}
.cg-user .cg-user-body{background:var(--accbg);border-radius:8px;padding:7px 11px;
  white-space:pre-wrap;word-break:break-word;font-size:12.5px}
.cg-cmd{align-self:flex-start;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11.5px;color:var(--acc);background:var(--accbg);border-radius:6px;padding:3px 8px}
.cg-cmd-out{font-size:12px;white-space:pre-wrap;word-break:break-word}
.cg-assistant{flex-direction:row;align-items:flex-start;gap:7px}
.cg-dot{flex:0 0 auto;color:var(--acc);font-size:12px;line-height:1.6}
.cg-md{flex:1 1 auto;min-width:0;font-size:13px;line-height:1.55;word-break:break-word}
.cg-md .cg-p{margin:0 0 6px}.cg-md .cg-p:last-child{margin-bottom:0}
.cg-md .cg-h{font-weight:700;margin:8px 0 4px}.cg-md .cg-h1{font-size:1.25em}
.cg-md .cg-h2{font-size:1.15em}.cg-md .cg-h3{font-size:1.05em}
.cg-md .cg-list{margin:2px 0 6px;padding-left:20px}.cg-md li{margin:1px 0}
.cg-md .cg-quote{border-left:2px solid var(--bd);padding-left:8px;opacity:.8;margin:4px 0}
.cg-code,.cg-md code{font-family:${MONO};font-size:.88em;background:var(--accbg);
  padding:.5px 4px;border-radius:4px}
.cg-pre{font-family:${MONO};font-size:12px;background:rgba(127,127,127,.1);
  border:1px solid var(--bd-soft);border-radius:6px;padding:8px 10px;overflow:auto;margin:4px 0}
.cg-pre code{background:none;padding:0}
.cg-link{color:var(--acc);text-decoration:underline}
/* thinking 은 기본 숨김 — cc2 처럼 답이 나오면 보이지 않는다. verbose 토글 시만 표시. */
.cg-think{display:none}
.cg-overlay.cg-verbose .cg-think{display:flex}
.cg-think .cg-think-head{display:flex;align-items:center;gap:6px;font-style:italic;
  opacity:.6;font-size:12px}
.cg-vbtn{border:none;background:none;color:inherit;cursor:pointer;font-size:13px;
  line-height:1;flex:0 0 auto;opacity:.4;padding:0 2px}
.cg-vbtn:hover{opacity:.8}
.cg-vbtn.active{opacity:1;color:var(--acc)}
.cg-caret{font-size:10px}
.cg-think-body{margin:4px 0 0 14px;opacity:.7;font-size:12px}
.cg-tool .cg-tool-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.cg-tool-name{font-weight:700;font-size:12px}
.cg-tool-name.cg-agent{background:var(--acc);color:var(--bg);padding:0 6px;border-radius:5px}
.cg-tool-arg{font-family:${MONO};font-size:11.5px;opacity:.7;word-break:break-all}
.cg-branch{margin-left:14px}
.cg-result{margin-top:3px;padding-left:10px;border-left:2px solid var(--bd-soft)}
.cg-result.cg-err{border-left-color:var(--danger)}
.cg-result-pre{font-family:${MONO};font-size:11.5px;white-space:pre-wrap;
  word-break:break-word;margin:0;opacity:.85}
.cg-result.cg-err .cg-result-pre{color:var(--danger)}
.cg-more{font-size:11px;margin-top:2px}
.cg-todos{margin:5px 0 0 20px}
.cg-todo{display:flex;gap:6px;font-size:12px;line-height:1.5}
.cg-todo-i{flex:0 0 auto}
.cg-todo-completed{opacity:.5}.cg-todo-completed .cg-todo-t{text-decoration:line-through}
.cg-todo-completed .cg-todo-i{color:var(--acc)}
.cg-todo-in_progress{font-weight:600}.cg-todo-in_progress .cg-todo-i{color:var(--acc)}
.cg-system{flex-direction:row;align-items:baseline;gap:6px;font-size:12px}
.cg-sys-mark{flex:0 0 auto;opacity:.5}
.cg-subagent{border:1px solid var(--bd-soft);border-radius:8px;padding:8px 10px;
  background:rgba(127,127,127,.05)}
.cg-sub-head{display:flex;align-items:center;gap:6px;font-weight:600;font-size:12px;
  cursor:pointer}
.cg-agent-dot{flex:0 0 auto}
.cg-sub-body{margin-top:6px;padding-left:6px;border-left:2px solid var(--bd-soft)}
.cg-sub-line{font-size:12px;line-height:1.5;margin:2px 0;word-break:break-word}
.cg-empty{padding:24px;text-align:center;white-space:pre-wrap;font-size:12px}
.cg-foot{flex:0 0 auto;display:flex;flex-direction:column;gap:6px;padding:9px 12px;
  border-top:1px solid var(--bd,#3a3f4b);background:var(--bg,#0d1117)}
.cg-inputrow{display:flex;align-items:flex-end;gap:8px}
/* 입력 3계층 큐 — 보류/전송중/대기 항목. 사라짐 = 실제 입력 확정(L3). */
.cg-queue{display:none;flex-direction:column;gap:3px}
.cg-q-item{display:flex;align-items:baseline;gap:7px;font-size:11.5px;opacity:.9}
.cg-q-state{flex:0 0 auto;color:var(--acc);white-space:nowrap;font-variant-numeric:tabular-nums}
.cg-q-held .cg-q-state,.cg-q-injecting .cg-q-state{opacity:.65;color:inherit}
.cg-q-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:${MONO};opacity:.75}
.cg-input{flex:1 1 auto;resize:none;min-height:20px;max-height:140px;font:inherit;
  font-size:13px;line-height:1.4;color:var(--fg,#e6e6e6);background:var(--accbg);
  border:1px solid var(--bd-soft);border-radius:8px;padding:7px 10px;outline:none}
.cg-input:focus{border-color:var(--acc)}
.cg-input:disabled{opacity:.5}
.cg-send{flex:0 0 auto;width:34px;height:34px;border-radius:8px;border:1px solid var(--acc);
  background:var(--acc);color:var(--bg);font-size:15px;cursor:pointer;line-height:1}
.cg-send:disabled{opacity:.4;cursor:default;background:transparent;color:inherit;
  border-color:var(--bd-soft)}
/* ② 라이브 응답 — 진행 중 표시. 완료 시 JSONL 구조 버블로 교체(parseLiveResponse). */
.cg-live{display:none;flex:0 0 auto;max-height:32%;overflow:auto;padding:8px 16px;
  border-top:1px solid var(--bd-soft)}
.cg-live-head{display:flex;align-items:center;gap:7px;font-size:12px;opacity:.75}
.cg-live-dot{color:var(--acc);animation:cg-pulse 1.2s ease-in-out infinite}
@keyframes cg-pulse{0%,100%{opacity:.25}50%{opacity:1}}
.cg-live-text{margin-top:5px;font-size:13px;line-height:1.55;opacity:.8;word-break:break-word}
/* B: Edit/Write 구조화 diff(diffLines). */
.cg-diff{margin-top:4px;font-family:${MONO};font-size:11.5px;border-radius:6px;overflow:auto;
  border:1px solid var(--bd-soft)}
.cg-diff-l{display:block;white-space:pre-wrap;word-break:break-word;padding:0 6px}
.cg-diff-del{background:rgba(248,81,73,.14)}
.cg-diff-add{background:rgba(63,185,80,.15)}
.cg-diff-ctx{opacity:.5}
.cg-result-sum{font-size:11px;opacity:.6;margin-left:6px}
/* B: ExitPlanMode 계획. */
.cg-plan{margin-top:4px;padding:8px 10px;border:1px solid var(--acc);border-radius:6px;
  background:var(--accbg);font-size:12.5px;line-height:1.5}
/* ③ 에이전트/워크플로 진행. */
.cg-agent-prog{font-weight:400;opacity:.6;font-size:11px;margin-left:auto}
.cg-wf-group{font-size:11px;opacity:.55;margin:8px 0 2px;font-weight:600}
`;
      document.head.appendChild(s);
    }
    injectStyle();

    // ── 보안: HTML 이스케이프 + 최소 마크다운 → HTML ────────────────────────────
    const esc = (s) =>
      String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // 인라인 마크다운(escape 된 텍스트 위에서): `code`, **bold**, *italic*, [t](u).
    function inlineMd(t) {
      return t
        .replace(/`([^`]+)`/g, '<code class="cg-code">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<span class="cg-link">$1</span>');
    }

    // 블록 마크다운 → HTML(코드펜스·헤딩·리스트·인용·문단). 라이브러리 없이 최소 구현.
    function mdToHtml(src) {
      const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
      let html = "";
      let i = 0;
      let listOpen = null; // 'ul' | 'ol' | null
      const closeList = () => {
        if (listOpen) {
          html += `</${listOpen}>`;
          listOpen = null;
        }
      };
      while (i < lines.length) {
        const line = lines[i];
        const fence = line.match(/^```(\w*)\s*$/);
        if (fence) {
          closeList();
          const lang = fence[1] || "";
          const body = [];
          i++;
          while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
          i++; // 닫는 펜스
          html += `<pre class="cg-pre" data-lang="${esc(lang)}"><code>${esc(
            body.join("\n"),
          )}</code></pre>`;
          continue;
        }
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) {
          closeList();
          const lv = h[1].length;
          html += `<div class="cg-h cg-h${lv}">${inlineMd(esc(h[2]))}</div>`;
          i++;
          continue;
        }
        const ul = line.match(/^\s*[-*]\s+(.*)$/);
        const ol = line.match(/^\s*\d+\.\s+(.*)$/);
        if (ul || ol) {
          const want = ul ? "ul" : "ol";
          if (listOpen !== want) {
            closeList();
            html += `<${want} class="cg-list">`;
            listOpen = want;
          }
          html += `<li>${inlineMd(esc((ul || ol)[1]))}</li>`;
          i++;
          continue;
        }
        const q = line.match(/^>\s?(.*)$/);
        if (q) {
          closeList();
          html += `<div class="cg-quote">${inlineMd(esc(q[1]))}</div>`;
          i++;
          continue;
        }
        if (line.trim() === "") {
          closeList();
          i++;
          continue;
        }
        // 일반 문단 — 연속 줄 모음.
        closeList();
        const para = [line];
        i++;
        while (
          i < lines.length &&
          lines[i].trim() !== "" &&
          !/^```|^#{1,4}\s|^\s*[-*]\s|^\s*\d+\.\s|^>/.test(lines[i])
        )
          para.push(lines[i++]);
        html += `<p class="cg-p">${inlineMd(esc(para.join("\n"))).replace(/\n/g, "<br>")}</p>`;
      }
      closeList();
      return html;
    }

    const el = (tag, cls, txt) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (txt != null) e.textContent = txt;
      return e;
    };

    // 클립보드 복사(보안 컨텍스트면 clipboard API, 아니면 execCommand 폴백).
    function copyText(t) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(t);
          return;
        }
      } catch {
        /* 폴백 */
      }
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* 무시 */
      }
      ta.remove();
    }

    // ── cwd → 트랜스크립트 디렉토리(cc2 sanitizePath: 영숫자 외 전부 '-') ───────────
    function projectDir(cwd) {
      const enc = String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
      return `~/.claude/projects/${enc}`;
    }

    // ── 도구별 인자 한 줄 요약(cc2 renderToolUseMessage 발췌 — 도구가 정함) ──────────
    function toolArgSummary(name, input) {
      const inp = input || {};
      const clip = (s, n) => {
        s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
        return s.length > (n || 80) ? s.slice(0, n || 80) + "…" : s;
      };
      switch (name) {
        case "Bash":
          return clip(inp.command, 120);
        case "Read":
        case "Write":
        case "Edit":
        case "MultiEdit":
          return clip(inp.file_path || inp.path);
        case "Glob":
          return clip(inp.pattern);
        case "Grep":
          return clip(inp.pattern) + (inp.path ? "  " + clip(inp.path, 40) : "");
        case "Task":
        case "Agent":
          return clip(inp.description || inp.prompt, 100);
        case "WebFetch":
          return clip(inp.url);
        case "WebSearch":
          return clip(inp.query);
        case "TodoWrite":
          return inp.todos ? `${inp.todos.length} todos` : "";
        default: {
          const keys = Object.keys(inp);
          if (!keys.length) return "";
          const first = inp[keys[0]];
          return clip(typeof first === "string" ? first : JSON.stringify(inp), 90);
        }
      }
    }

    // tool_result content 를 평문으로(블록 배열/문자열 모두).
    function resultText(content) {
      if (content == null) return "";
      if (typeof content === "string") return content;
      if (Array.isArray(content))
        return content
          .map((b) =>
            typeof b === "string" ? b : b && b.type === "text" ? b.text : "",
          )
          .join("\n");
      return "";
    }

    // user 엔트리에서 "실제 사용자 입력 텍스트"만 추출(주입 명령/메타/tool_result 제외). 입력 큐
    // L3 매칭용 — JSONL 에 이 텍스트가 user 라인으로 나타나면 그 입력이 실제로 들어간 것.
    function realUserText(entry) {
      if (!entry || entry.isMeta) return null;
      const c = entry.message && entry.message.content;
      if (typeof c === "string") {
        const t = c.trim();
        if (!t || /^<[a-z-]+>/.test(t)) return null; // 주입 명령(<command-*> 등) 제외
        return t;
      }
      if (Array.isArray(c)) {
        const txt = c
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return txt || null;
      }
      return null;
    }

    // ── pane 별 상태 ──────────────────────────────────────────────────────────
    // paneId → {
    //   cwd, item(Disposable|null), overlay|null, open,
    //   conv|null = {
    //     dir, path, offset, leftover, bodyEl, head{...spans}, atBottom,
    //     toolEls(Map id→{wrap, branch}), rendered([uuid...]), seen(Set uuid),
    //     stats{model, out, ctx, mode, pmode, branch, session, msgs},
    //     watchers([dispose...]), agents(Map agentId→{path, offset, leftover, listEl}),
    //   }
    // }
    const panes = new Map();
    let lastPaneId = null;

    // 상태바 항목 등록/갱신(active = 오버레이 열림). 같은 id 재호출이 교체.
    function setItem(paneId) {
      const p = panes.get(paneId);
      if (!p) return;
      p.item?.dispose(); // 이전 등록 해지(Disposable.dispose() — 함수 아님)
      p.item = ctx.app.ui.statusBarItem({
        id: paneId,
        paneId,
        label: "GUI",
        title: "Claude GUI 토글",
        active: p.open,
        onClick: () => toggle(paneId),
      });
    }

    // fresh=true: claude 가 방금 시작(command.started) → detectAt 기록. 그 이후에 생긴
    //   트랜스크립트만 "현재 세션"으로 고른다(옛 stale 세션 파일 오선택 방지).
    // fresh=false: 이미 실행 중(활성화 즉시 동기화) → detectAt=0(필터 없음, 최신 mtime).
    function ensure(paneId, cwd, fresh) {
      const at = fresh ? Date.now() / 1000 : 0;
      const existing = panes.get(paneId);
      if (existing) {
        existing.cwd = cwd;
        if (fresh) existing.detectAt = at;
        lastPaneId = paneId;
        return;
      }
      panes.set(paneId, {
        cwd,
        paneId, // 자기 키 — p 만 받는 함수(openConversation 등)가 readBuffer/onOutput 타깃에 쓴다
        detectAt: at,
        item: null,
        overlay: null,
        open: false,
        conv: null,
      });
      setItem(paneId);
      lastPaneId = paneId;
    }

    function remove(paneId) {
      const p = panes.get(paneId);
      if (!p) return;
      p.queue?.dispose();
      p.queue = null;
      teardownConv(p);
      p.item?.dispose();
      p.overlay?.remove();
      panes.delete(paneId);
      if (lastPaneId === paneId) {
        const keys = [...panes.keys()];
        lastPaneId = keys.length ? keys[keys.length - 1] : null;
      }
    }

    // ── 헤더 ────────────────────────────────────────────────────────────────
    function buildHeader(conv, cwd, onClose) {
      const head = el("div", "cg-head");
      const meta = el("div", "cg-meta");
      const sModel = el("span", "cg-chip");
      const sCtx = el("span", "cg-chip");
      const sMode = el("span", "cg-chip");
      const sBranch = el("span", "cg-chip");
      const sSession = el("span", "cg-chip cg-dim cg-session");
      sSession.style.cursor = "pointer";
      // hover = 전체 id(title), 클릭 = 복사(피드백). 전체 id 는 dataset.full 에 보관.
      sSession.addEventListener("click", () => {
        const full = sSession.dataset.full || "";
        if (!full) return;
        copyText(full);
        const prev = sSession.textContent;
        sSession.textContent = "복사됨 ✓";
        setTimeout(() => {
          sSession.textContent = prev;
        }, 900);
      });
      // verbose 토글(cc2 ctrl+o 대응) — thinking 표시/숨김. 기본 off(숨김).
      const vbtn = el("button", "cg-vbtn", "∴");
      vbtn.type = "button";
      vbtn.title = "thinking 표시/숨김 (verbose)";
      vbtn.addEventListener("click", () => {
        const ov = vbtn.closest(".cg-overlay");
        if (!ov) return;
        vbtn.classList.toggle("active", ov.classList.toggle("cg-verbose"));
      });
      const closeBtn = el("button", "cg-x", "✕");
      closeBtn.type = "button";
      closeBtn.title = "닫기";
      closeBtn.addEventListener("click", onClose);
      meta.append(sModel, sCtx, sMode, sBranch);
      // 타이틀("Claude GUI")·우측 cwd 경로는 표시 안 함(불필요 — 모델/ctx/세션만).
      head.append(meta, sSession, vbtn, closeBtn);
      conv.head = { sModel, sCtx, sMode, sBranch, sSession };
      return head;
    }

    // 하단 입력창(cc2 TUI 프롬프트 대응) — claude PTY 에 텍스트 전송. Enter 전송,
    // Shift+Enter 줄바꿈. "terminal:write" 권한 없으면 비활성 + 안내.
    function buildInput(paneId) {
      const term = ctx.app.terminal;
      const canWrite = !!(term && term.sendText);
      // terminal:read 가 있으면 3계층 검증 큐(모달 게이트 + L2/L3), 없으면 레거시 즉시 주입.
      const canRead = !!(term && term.readBuffer && term.onOutput);
      const foot = el("div", "cg-foot");
      const queueBox = el("div", "cg-queue"); // 대기 항목 — L3(실제 입력) 확정 시 사라진다
      const row = el("div", "cg-inputrow");
      const ta = el("textarea", "cg-input");
      ta.rows = 1;
      ta.placeholder = canWrite
        ? "claude 에게 입력…  (Enter 전송, Shift+Enter 줄바꿈)"
        : '입력 전송 권한 없음 — "terminal:write" 재동의 필요';
      ta.disabled = !canWrite;
      const btn = el("button", "cg-send", "↩");
      btn.type = "button";
      btn.title = "전송";
      btn.disabled = !canWrite;

      // 큐 로직은 createInputQueue(검증된 순수/주입형) — DOM 은 onRender 콜백에서만.
      let queue = null;
      if (canRead) {
        queue = createInputQueue({
          sendText: (text) => term.sendText(paneId, text),
          readBuffer: (lines) => term.readBuffer(paneId, lines),
          onOutput: (cb) => {
            const d = term.onOutput(paneId, cb);
            return () => (d && d.dispose ? d.dispose() : d && d());
          },
          onRender: (snap) => renderQueue(queueBox, snap),
          setTimer: (fn, ms) => window.setTimeout(fn, ms),
          clearTimer: (h) => window.clearTimeout(h),
        });
      }
      const send = () => {
        const v = ta.value;
        if (!v.trim() || !canWrite) return;
        if (queue) queue.enqueue(v); // 3계층 검증 큐로 — 피드백은 칩(사라짐=입력)
        else {
          term.sendText(paneId, v + "\r"); // 레거시: 검증 불가 → 즉시 주입
          flashSent(btn);
        }
        ta.value = "";
        ta.style.height = "auto";
        ta.focus();
      };
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      });
      ta.addEventListener("input", () => {
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
      });
      btn.addEventListener("click", send);
      row.append(ta, btn);
      foot.append(queueBox, row);
      foot._ta = ta;
      foot._queue = queue;
      return foot;
    }

    // 큐 칩 렌더(상태별 배지). 사라짐 = L3(실제 입력) 확정. DOM 만 여기서 — 로직은 createInputQueue.
    function renderQueue(box, snap) {
      box.replaceChildren();
      if (!snap.length) {
        box.style.display = "none";
        return;
      }
      box.style.display = "flex"; // CSS 기본 display:none 을 인라인으로 덮어야 보인다(빈 문자열 X)
      snap.forEach((it, i) => {
        const item = el("div", "cg-q-item cg-q-" + it.state);
        const badge =
          it.state === "injecting"
            ? "⤴ 전송"
            : it.state === "awaiting"
              ? "⏳ 입력 대기" // claude 큐에 들어감 — 실제 입력(L3) 전까지
              : it.reason === "modal"
                ? "⧖ 다이얼로그 대기" // 맨 앞: claude 에 다이얼로그가 떠 막힘
                : it.reason === "stuck"
                  ? "⧖ 입력 보류(확인 필요)"
                  : `⧖ 순번 대기 (${i + 1})`; // 뒤: 앞 항목 처리 후 차례
        item.append(el("span", "cg-q-state", badge), el("span", "cg-q-text", it.text));
        box.appendChild(item);
      });
    }

    // 레거시(검증 불가) 전송 피드백 — terminal:read 없을 때만.
    function flashSent(btn) {
      btn.textContent = "✓";
      setTimeout(() => {
        btn.textContent = "↩";
      }, 700);
    }

    // ② 진행 중 응답을 라이브 밴드에 표시(parseLiveResponse). 완료(JSONL)되면 숨고 구조 버블로 교체.
    function updateLive(conv) {
      const live = conv.liveEl;
      if (!live) return;
      const term = ctx.app.terminal;
      if (!term || !term.readBuffer || !conv.paneId) return;
      const r = parseLiveResponse(term.readBuffer(conv.paneId, 80) || "");
      if (!r.responding) {
        if (live.style.display !== "none") {
          live.style.display = "none";
          live.replaceChildren();
        }
        return;
      }
      live.style.display = "block"; // CSS 기본 display:none 덮기(빈 문자열은 도로 숨김)
      const head = el("div", "cg-live-head");
      head.append(el("span", "cg-live-dot", "⏺"));
      head.append(
        el("span", null, "응답 중" + (r.tokens ? ` · ${fmtTokens(r.tokens)} tokens` : "")),
      );
      live.replaceChildren(head);
      if (r.text) {
        const bodyEl = el("div", "cg-live-text cg-md");
        bodyEl.innerHTML = mdToHtml(r.text);
        live.appendChild(bodyEl);
      }
    }

    function fmtTokens(n) {
      if (!n) return "0";
      return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);
    }

    function updateHeader(conv) {
      const st = conv.stats;
      const h = conv.head;
      if (!h) return;
      h.sModel.textContent = st.model
        ? st.model.replace(/^claude-/, "") + (st.effort ? " · " + st.effort : "")
        : "claude";
      // 컨텍스트 = 마지막 어시스턴트 프롬프트 크기(input+cache). 누적 출력 토큰도.
      h.sCtx.textContent = `ctx ${fmtTokens(st.ctx)} · out ${fmtTokens(st.out)}`;
      h.sMode.textContent = st.pmode || st.mode || "";
      h.sMode.style.display = st.pmode || st.mode ? "" : "none";
      h.sBranch.textContent = st.branch ? "⎇ " + st.branch : "";
      h.sBranch.style.display = st.branch ? "" : "none";
      h.sSession.textContent = st.session ? st.session.slice(0, 8) : "";
      h.sSession.title = st.session ? `세션 ${st.session} · 클릭하면 복사` : "";
      h.sSession.dataset.full = st.session || "";
    }

    // ── 파싱 + 상태 누적 ───────────────────────────────────────────────────────
    function applyStats(conv, entry) {
      const st = conv.stats;
      const m = entry.message;
      if (entry.gitBranch) st.branch = entry.gitBranch;
      if (entry.type === "assistant" && m) {
        if (m.model) st.model = m.model;
        const u = m.usage || {};
        st.out += u.output_tokens || 0;
        const ctx =
          (u.input_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0);
        if (ctx) st.ctx = ctx;
      } else if (entry.type === "mode" && entry.mode) {
        st.mode = entry.mode === "normal" ? "" : entry.mode;
      } else if (entry.type === "permission-mode" && entry.permissionMode) {
        st.pmode = entry.permissionMode;
      }
    }

    // 버블 종류 디스패치(DOM 생성만 — 통계/dedup 은 호출자). cc2 컴포넌트 매핑.
    //   ai-title/last-prompt/mode/permission-mode/agent-name/queue-operation/
    //   file-history-snapshot/attachment 등은 버블 아님(상태만 또는 무시).
    function renderBubble(conv, entry) {
      const t = entry.type;
      if (t === "user") return renderUser(conv, entry);
      if (t === "assistant") return renderAssistant(conv, entry);
      if (t === "system") return renderSystem(conv, entry);
    }

    // 라이브 1건: dedup(uuid 있을 때만) + 통계 + 렌더.
    function renderEntry(conv, entry) {
      if (!entry) return;
      if (entry.uuid) {
        if (conv.seen.has(entry.uuid)) return;
        conv.seen.add(entry.uuid);
      }
      applyStats(conv, entry);
      conv.stats.msgs++;
      renderBubble(conv, entry);
      // L3: 라이브 user 텍스트 라인 = 실제 입력 확정 → 입력 큐 head 매칭 제거(단일 제거점).
      // 이 경로는 라이브 tail(feed) 전용 — feedInitial(과거분)은 renderEntry 를 안 거친다.
      if (entry.type === "user" && conv.queue) {
        const ut = realUserText(entry);
        if (ut) conv.queue.confirmUserLine(ut);
      }
      // 어시스턴트 완료 라인 = 그 턴 구조 버블 생성 → 라이브 밴드 재동기(보통 숨김).
      if (entry.type === "assistant" && conv.liveEl) updateLive(conv);
    }

    function appendRow(conv, node) {
      if (!node) return;
      // 첫 버블이 들어오면 "대기/안내" 빈상태 메시지를 치운다.
      const empty = conv.bodyEl.querySelector(".cg-empty");
      if (empty) empty.remove();
      conv.bodyEl.appendChild(node);
      // 캡 초과분 제거(앞에서) — 라이브 append 시 DOM 폭주 방지.
      while (conv.bodyEl.childElementCount > RENDER_CAP)
        conv.bodyEl.removeChild(conv.bodyEl.firstElementChild);
      if (conv.atBottom) conv.bodyEl.scrollTop = conv.bodyEl.scrollHeight;
    }

    function renderUser(conv, entry) {
      const m = entry.message || {};
      const c = m.content;
      // tool_result 를 품은 user 는 도구 결과 → 해당 tool_use 아래 분기로.
      if (Array.isArray(c)) {
        let appended = false;
        for (const b of c) {
          if (b && b.type === "tool_result") {
            attachResult(conv, b);
            appended = true;
          } else if (b && b.type === "text" && b.text.trim()) {
            appendRow(conv, userBubble(b.text));
            appended = true;
          } else if (b && b.type === "image") {
            appendRow(conv, userBubble("🖼 (이미지)"));
            appended = true;
          }
        }
        return appended ? true : undefined;
      }
      if (typeof c === "string" && c.trim() && !entry.isMeta) {
        // 명령/시스템 주입(<command-*>, <local-command>...)은 접어서 dim 으로.
        appendRow(conv, userBubble(c));
      }
    }

    function userBubble(text) {
      // 슬래시 명령(<command-*>)·명령 출력(<local-command-stdout>)은 raw 태그 대신 깔끔하게.
      const cmd = parseCommandTags(text);
      if (cmd) {
        if (cmd.kind === "stdout") {
          if (!cmd.text) return null; // 빈 출력은 버블 생성 안 함
          const r = el("div", "cg-row cg-user");
          r.appendChild(el("div", "cg-cmd-out cg-dim", cmd.text));
          return r;
        }
        const r = el("div", "cg-row cg-user");
        r.appendChild(el("div", "cg-cmd", cmd.name + (cmd.args ? " " + cmd.args : "")));
        return r;
      }
      const row = el("div", "cg-row cg-user");
      const body = el("div", "cg-user-body");
      const isInjected = /^<[a-z-]+>/.test(text.trim());
      if (isInjected) {
        body.classList.add("cg-dim");
        body.textContent = text.length > 400 ? text.slice(0, 400) + " …" : text;
      } else {
        body.textContent = text;
      }
      row.appendChild(body);
      return row;
    }

    function renderAssistant(conv, entry) {
      const m = entry.message || {};
      const content = Array.isArray(m.content) ? m.content : [];
      for (const b of content) {
        if (!b) continue;
        if (b.type === "text") {
          if (b.text && b.text.trim()) appendRow(conv, assistantText(b.text));
        } else if (b.type === "thinking") {
          appendRow(conv, thinkingBlock(b.thinking || ""));
        } else if (b.type === "redacted_thinking") {
          appendRow(conv, thinkingBlock("(redacted)"));
        } else if (b.type === "tool_use") {
          appendRow(conv, toolUse(conv, b));
        }
      }
    }

    function assistantText(text) {
      const row = el("div", "cg-row cg-assistant");
      row.appendChild(el("span", "cg-dot", "⏺"));
      const body = el("div", "cg-md");
      body.innerHTML = mdToHtml(text);
      row.appendChild(body);
      return row;
    }

    function thinkingBlock(text) {
      const row = el("div", "cg-row cg-think");
      const head = el("div", "cg-think-head");
      head.append(el("span", null, "∴ Thinking"));
      const body = el("div", "cg-think-body cg-md");
      body.innerHTML = mdToHtml(text);
      body.style.display = "none";
      head.style.cursor = "pointer";
      const caret = el("span", "cg-caret", "▸");
      head.appendChild(caret);
      head.addEventListener("click", () => {
        const showing = body.style.display !== "none";
        body.style.display = showing ? "none" : "";
        caret.textContent = showing ? "▸" : "▾";
      });
      row.append(head, body);
      return row;
    }

    function toolUse(conv, b) {
      const row = el("div", "cg-row cg-tool");
      const head = el("div", "cg-tool-head");
      head.appendChild(el("span", "cg-dot", "⏺"));
      const isAgent = b.name === "Task" || b.name === "Agent";
      const namePill = el("span", "cg-tool-name" + (isAgent ? " cg-agent" : ""), b.name);
      head.appendChild(namePill);
      const arg = toolArgSummary(b.name, b.input);
      if (arg) head.appendChild(el("span", "cg-tool-arg", "(" + arg + ")"));
      row.appendChild(head);
      // TodoWrite 는 결과 대신 인라인 체크리스트로.
      if (b.name === "TodoWrite" && b.input && Array.isArray(b.input.todos)) {
        row.appendChild(todoList(b.input.todos));
      }
      // Edit/MultiEdit/Write — 구조화 diff(diffLines). 평문 대신 del/add/ctx 라인.
      for (const d of toolDiffs(b.name, b.input)) row.appendChild(renderDiff(d));
      // ExitPlanMode — 계획 본문 표시(기본 도구 칩 + 계획 박스).
      if (b.name === "ExitPlanMode" && b.input && b.input.plan) {
        const plan = el("div", "cg-plan cg-md");
        plan.innerHTML = mdToHtml(String(b.input.plan));
        row.appendChild(plan);
      }
      // 결과를 붙일 분기 컨테이너(도구 id 로 매핑 — name 도 저장해 결과 카운트에 쓴다).
      const branch = el("div", "cg-branch");
      row.appendChild(branch);
      if (b.id) conv.toolEls.set(b.id, { wrap: row, branch, name: b.name });
      return row;
    }

    // 도구 입력 → diff 묶음(Edit/Write/MultiEdit). 각 항목 = diffLines 결과(del/add/ctx).
    function toolDiffs(name, input) {
      const inp = input || {};
      if (name === "Write")
        return inp.content != null ? [diffLines("", String(inp.content))] : [];
      if (name === "Edit")
        return inp.old_string != null || inp.new_string != null
          ? [diffLines(String(inp.old_string || ""), String(inp.new_string || ""))]
          : [];
      if (name === "MultiEdit" && Array.isArray(inp.edits))
        return inp.edits.map((e) =>
          diffLines(String(e.old_string || ""), String(e.new_string || "")),
        );
      return [];
    }

    function renderDiff(diff) {
      const box = el("div", "cg-diff");
      const MAX = 30;
      for (const ln of diff.slice(0, MAX)) {
        const prefix = ln.type === "del" ? "- " : ln.type === "add" ? "+ " : "  ";
        box.appendChild(el("span", "cg-diff-l cg-diff-" + ln.type, prefix + ln.text));
      }
      if (diff.length > MAX)
        box.appendChild(el("span", "cg-diff-l cg-diff-ctx", `  … +${diff.length - MAX} 줄`));
      return box;
    }

    function todoList(todos) {
      const box = el("div", "cg-todos");
      for (const t of todos) {
        const item = el("div", "cg-todo cg-todo-" + (t.status || "pending"));
        const icon =
          t.status === "completed" ? "✔" : t.status === "in_progress" ? "◼" : "◻";
        item.appendChild(el("span", "cg-todo-i", icon));
        item.appendChild(el("span", "cg-todo-t", t.content || t.subject || ""));
        box.appendChild(item);
      }
      return box;
    }

    function attachResult(conv, b) {
      const ref = conv.toolEls.get(b.tool_use_id);
      const text = resultText(b.content);
      const isErr = !!b.is_error;
      const line = el("div", "cg-result" + (isErr ? " cg-err" : ""));
      // 결과 카운트(Read N lines / Grep N matches) — 도구가 정함, 과장 금지.
      const sum = toolResultSummary(ref && ref.name, text);
      if (sum) line.appendChild(el("div", "cg-result-sum", sum));
      const MAX = 10;
      const lines = text.split("\n");
      const shown = lines.slice(0, MAX).join("\n");
      const pre = el("pre", "cg-result-pre", shown);
      line.appendChild(pre);
      if (lines.length > MAX)
        line.appendChild(el("div", "cg-dim cg-more", `… +${lines.length - MAX} 줄`));
      if (ref) {
        ref.branch.appendChild(line);
        if (conv.atBottom) conv.bodyEl.scrollTop = conv.bodyEl.scrollHeight;
      } else {
        // 부모 tool_use 가 캡 밖으로 밀려났을 때 — 독립 줄로.
        const row = el("div", "cg-row cg-tool");
        const br = el("div", "cg-branch");
        br.appendChild(line);
        row.appendChild(br);
        appendRow(conv, row);
      }
    }

    function renderSystem(conv, entry) {
      const sub = entry.subtype || "";
      let txt = typeof entry.content === "string" ? entry.content : "";
      if (sub === "compact_boundary") txt = "─── 컨텍스트 압축 ───";
      if (!txt) return;
      // 명령 출력(subtype local_command 등)은 <local-command-stdout> 태그로 옴 → 정리.
      // 빈 출력은 렌더 안 함, 출력/이름만 깔끔히.
      const cmd = parseCommandTags(txt);
      if (cmd) {
        if (cmd.kind === "stdout") {
          if (!cmd.text) return;
          txt = cmd.text;
        } else {
          txt = cmd.name + (cmd.args ? " " + cmd.args : "");
        }
      }
      const row = el("div", "cg-row cg-system");
      row.appendChild(el("span", "cg-sys-mark", "✻"));
      row.appendChild(el("span", "cg-dim", txt.length > 200 ? txt.slice(0, 200) + "…" : txt));
      return appendRow(conv, row);
    }

    // ── JSONL 증분 파싱(offset tail) ───────────────────────────────────────────
    function feed(conv, text) {
      const full = conv.leftover + text;
      const lines = full.split("\n");
      conv.leftover = lines.pop(); // 마지막(미완 가능) 줄 보류
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        renderEntry(conv, entry);
      }
      updateHeader(conv);
    }

    // 초기 전체 로딩: 통계는 전부 반영, 렌더는 마지막 RENDER_CAP 개만(거대 세션 잰크 방지).
    function feedInitial(conv, text) {
      const full = conv.leftover + text;
      const lines = full.split("\n");
      conv.leftover = lines.pop();
      const entries = [];
      for (const line of lines) {
        const s = line.trim();
        if (!s) continue;
        try {
          entries.push(JSON.parse(s));
        } catch {
          /* skip */
        }
      }
      for (const e of entries) {
        if (e.uuid) conv.seen.add(e.uuid);
        applyStats(conv, e);
      }
      conv.stats.msgs = entries.length;
      const rend = entries.filter(
        (e) => e.type === "user" || e.type === "assistant" || e.type === "system",
      );
      for (const e of rend.slice(-RENDER_CAP)) renderBubble(conv, e);
      updateHeader(conv);
    }

    async function tail(conv) {
      try {
        const r = await ctx.app.fs.readText(conv.path, conv.offset);
        if (r.totalBytes < conv.offset) {
          // 파일 축소/교체 → 처음부터 재독(드문 tombstone 재작성).
          conv.offset = 0;
          conv.leftover = "";
          conv.bodyEl.replaceChildren();
          conv.seen.clear();
          conv.toolEls.clear();
          const full = await ctx.app.fs.readText(conv.path, 0);
          conv.offset = full.totalBytes;
          feed(conv, full.text);
          return;
        }
        if (r.text) {
          conv.offset = r.totalBytes;
          feed(conv, r.text);
        }
      } catch {
        // 파일 교체 순간 등 — 다음 fs-change 에서 재시도.
      }
    }

    // ── 서브에이전트 서브폴더(<sessionId>/subagents/agent-*.jsonl) 표현 ───────────
    async function scanAgents(conv) {
      const subDir = `${conv.dir}/${conv.session}/subagents`;
      let listing;
      try {
        listing = await ctx.app.fs.list(subDir, { meta: true });
      } catch {
        return; // 아직 없음(서브에이전트 미실행)
      }
      const absSub = listing.root; // 절대 canonical — watch/경로 일치
      const children = listing.children || [];
      const files = children.filter((c) => !c.dir && /^agent-.*\.jsonl$/.test(c.name));
      const hasWorkflows = children.some((c) => c.dir && c.name === "workflows");
      // subagents 폴더 watch(처음 1회) — 새 에이전트/턴/workflow 등장 모두 잡음.
      if ((files.length || hasWorkflows) && !conv.agentsWatched) {
        conv.agentsWatched = true;
        conv.watchers.push(
          ctx.app.fs.watch(absSub, () => {
            for (const a of conv.agents.values()) tailAgent(a, conv);
            scanAgents(conv);
          }),
        );
      }
      for (const f of files) ensureAgentPanel(conv, "agent:" + f.name, absSub, f.name, null);
      // workflows/<runId>/agent-*.jsonl 재귀(census C — runAgent.ts:350 서브디렉토리).
      if (hasWorkflows) scanWorkflows(conv, `${absSub}/workflows`);
    }

    async function scanWorkflows(conv, wfDir) {
      let listing;
      try {
        listing = await ctx.app.fs.list(wfDir, { meta: true });
      } catch {
        return;
      }
      const absWf = listing.root;
      const runDirs = (listing.children || []).filter((c) => c.dir);
      if (runDirs.length && !conv.wfWatched) {
        conv.wfWatched = true;
        conv.watchers.push(ctx.app.fs.watch(absWf, () => scanWorkflows(conv, wfDir)));
      }
      for (const rd of runDirs) {
        const runAbs = `${absWf}/${rd.name}`;
        if (!conv.wfRunWatched.has(rd.name)) {
          conv.wfRunWatched.add(rd.name);
          appendRow(conv, el("div", "cg-row cg-wf-group", `▷ workflow ${rd.name.slice(0, 8)}`));
          conv.watchers.push(
            ctx.app.fs.watch(runAbs, () => {
              for (const a of conv.agents.values())
                if (a.run === rd.name) tailAgent(a, conv);
              scanRunAgents(conv, runAbs, rd.name);
            }),
          );
        }
        scanRunAgents(conv, runAbs, rd.name);
      }
    }

    async function scanRunAgents(conv, runAbs, run) {
      let listing;
      try {
        listing = await ctx.app.fs.list(runAbs, { meta: true });
      } catch {
        return;
      }
      const files = (listing.children || []).filter(
        (c) => !c.dir && /^agent-.*\.jsonl$/.test(c.name),
      );
      for (const f of files)
        ensureAgentPanel(conv, "wf:" + run + ":" + f.name, listing.root, f.name, run);
    }

    // 에이전트 패널 1개 생성(중복 dedup) + meta.json 헤더 + 진행 라인. tail 누적으로 진행 갱신.
    async function ensureAgentPanel(conv, key, absDir, fileName, run) {
      if (conv.agents.has(key)) return;
      const id = fileName.replace(/\.jsonl$/, "");
      const panel = el("div", "cg-row cg-subagent");
      const head = el("div", "cg-sub-head");
      head.append(el("span", "cg-agent-dot", "🤖"));
      const title = el("span", null, id);
      const prog = el("span", "cg-agent-prog", "");
      const caret = el("span", "cg-caret", "▾");
      head.append(title, prog, caret);
      const listEl = el("div", "cg-sub-body cg-md");
      head.style.cursor = "pointer";
      head.addEventListener("click", () => {
        const showing = listEl.style.display !== "none";
        listEl.style.display = showing ? "none" : "";
        caret.textContent = showing ? "▸" : "▾";
      });
      panel.append(head, listEl);
      appendRow(conv, panel);
      const a = {
        path: `${absDir}/${fileName}`,
        offset: 0,
        leftover: "",
        listEl,
        progEl: prog,
        seen: new Set(),
        entries: [],
        meta: null,
        run: run || null,
      };
      conv.agents.set(key, a);
      // meta.json(agentType/description) — 있을 때만 헤더 교체(추정 금지).
      try {
        const mt = await ctx.app.fs.readText(`${absDir}/${id}.meta.json`);
        const meta = JSON.parse(mt.text);
        a.meta = meta;
        if (meta.agentType) title.textContent = meta.agentType;
        if (meta.description) head.title = meta.description;
      } catch {
        /* meta 없으면 id 유지 */
      }
      tailAgent(a, conv);
    }

    // 진행 라인 = 실측만(synthAgentProgress): tool 수·토큰·마지막 tool. 거짓 진행률 금지.
    function updateAgentProgress(a) {
      const p = synthAgentProgress(a.entries, a.meta);
      const parts = [];
      if (p.tools) parts.push(`${p.tools} tools`);
      if (p.tokens) parts.push(`${fmtTokens(p.tokens)} tokens`);
      parts.push(p.lastTool || "Initializing…");
      a.progEl.textContent = parts.join(" · ");
    }

    async function tailAgent(a, conv) {
      try {
        const r = await ctx.app.fs.readText(a.path, a.offset);
        if (!r.text || r.totalBytes < a.offset) {
          a.offset = Math.min(a.offset, r.totalBytes);
          return;
        }
        a.offset = r.totalBytes;
        const full = a.leftover + r.text;
        const lines = full.split("\n");
        a.leftover = lines.pop();
        let changed = false;
        for (const line of lines) {
          if (!line.trim()) continue;
          let entry;
          try {
            entry = JSON.parse(line);
          } catch {
            continue;
          }
          if (entry.uuid && a.seen.has(entry.uuid)) continue;
          if (entry.uuid) a.seen.add(entry.uuid);
          a.entries.push(entry);
          renderAgentLine(a, entry);
          changed = true;
        }
        if (changed) updateAgentProgress(a);
        if (conv.atBottom) conv.bodyEl.scrollTop = conv.bodyEl.scrollHeight;
      } catch {
        // skip
      }
    }

    function renderAgentLine(a, entry) {
      const m = entry.message || {};
      if (entry.type === "assistant" && Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === "text" && b.text.trim()) {
            const d = el("div", "cg-sub-line");
            d.innerHTML = "⏺ " + mdToHtml(b.text);
            a.listEl.appendChild(d);
          } else if (b.type === "tool_use") {
            const d = el("div", "cg-sub-line cg-dim");
            const arg = toolArgSummary(b.name, b.input);
            d.textContent = `⎿ ${b.name}${arg ? " (" + arg + ")" : ""}`;
            a.listEl.appendChild(d);
          }
        }
      } else if (entry.type === "user" && typeof m.content === "string" && m.content.trim()) {
        const d = el("div", "cg-sub-line cg-dim");
        d.textContent =
          m.content.length > 200 ? m.content.slice(0, 200) + "…" : m.content;
        a.listEl.appendChild(d);
      }
    }

    // ── 활성 세션 찾기 + 대화 열기 ─────────────────────────────────────────────
    // 활성 세션 찾기 → { root(절대 canonical — watch/경로 일치용), session }. fs.list 의
    // root 가 canonicalize 된 절대경로라, fs-change 이벤트(절대 부모 디렉토리)와 정확히 매칭된다.
    // since(unix 초) 지정 시 그 이후 수정된 .jsonl 만 후보(현재 claude 세션). 0 이면 전체.
    // root 는 세션이 없어도 반환(빈 디렉토리도 watch 걸어 첫 세션 등장을 잡기 위함).
    async function findActive(dir, since) {
      const listing = await ctx.app.fs.list(dir, { meta: true });
      return {
        root: listing.root,
        session: pickActiveSession(listing.children, since),
      };
    }

    // 현재 세션 = findActive(프로젝트 dir 의 newest jsonl). session-env 마커는 쓰지 않는다 —
    // codex companion·서브에이전트·헤드리스 호출로 난립(실측 800+개)하고 mtime 이 세션 *생성*
    // 시각이라 /resume·대화 활동에 갱신되지 않아 활성 세션을 못 가리킨다. 활발히 append 되는
    // jsonl 이 유일하게 신뢰할 수 있는 "지금 이 팬의 세션" 신호다(pickActiveSession 참조).

    async function openConversation(p) {
      if (!ctx.app.fs || !ctx.app.fs.readText) {
        emptyState(p, '코어 fs 소켓 없음 — "fs:read" 권한을 재동의하세요.');
        return;
      }
      const conv = {
        dir: null, // 활성 세션 발견 후 절대 canonical root 로 채운다
        path: null,
        session: null,
        offset: 0,
        leftover: "",
        bodyEl: p.bodyEl,
        head: p.headRefs,
        atBottom: true,
        toolEls: new Map(),
        seen: new Set(),
        stats: { model: "", effort: "", out: 0, ctx: 0, mode: "", pmode: "", branch: "", session: "", msgs: 0 },
        watchers: [],
        agents: new Map(),
        agentsWatched: false,
        wfWatched: false, // workflows 폴더 watch 1회
        wfRunWatched: new Set(), // runId 폴더별 watch·그룹 헤더 1회
        queue: p.queue || null, // L3 매칭 대상(renderEntry → confirmUserLine)
        paneId: p.paneId, // ② readBuffer/onOutput 타깃
        liveEl: p.liveEl || null, // ② 진행 중 응답 밴드
      };
      p.conv = conv;
      // effort 는 settings.json 에서(범용 fs 로 ~ 확장).
      try {
        const s = await ctx.app.fs.readText("~/.claude/settings.json");
        const j = JSON.parse(s.text);
        if (j.effortLevel) conv.stats.effort = j.effortLevel;
      } catch {
        /* 없으면 생략 */
      }
      // 디렉토리(절대 canonical) 확보 — 세션이 없어도 watch 를 걸기 위해.
      let root = null;
      try {
        root = (await ctx.app.fs.list(projectDir(p.cwd), { meta: true })).root;
      } catch {
        /* 디렉토리 미존재 가능 */
      }
      if (!root) {
        emptyState(p, "프로젝트 트랜스크립트 디렉토리를 찾지 못함.\n" + projectDir(p.cwd));
        return;
      }
      conv.dir = root;
      conv.detectAt = p.detectAt || 0;
      // 현재 세션 = 프로젝트 dir 에서 활발히 append 되는 jsonl(newest mtime).
      const sid = (await findActive(conv.dir, conv.detectAt)).session;
      if (sid) {
        switchToSession(conv, sid); // 현재 세션 타깃(본문 비움 + path 설정)
        const first = await ctx.app.fs.readText(conv.path, 0).catch(() => null);
        if (first && first.totalBytes) {
          conv.offset = first.totalBytes;
          feedInitial(conv, first.text);
          conv.bodyEl.scrollTop = conv.bodyEl.scrollHeight;
        } else {
          // 세션은 시작됐지만 아직 턴 없음(트랜스크립트 미생성) → 대기. watch 가 잡는다.
          emptyState(p, "현재 세션 " + sid.slice(0, 8) + " — 대화가 오가면 표시됩니다.");
        }
      } else {
        // 아직 이 dir 에 트랜스크립트 jsonl 이 없음 → 대기. watch 가 첫 등장을 잡는다.
        emptyState(p, "현재 claude 세션을 찾지 못함 — 대화가 시작되면 표시됩니다.");
      }
      // 라이브 watch(폴링 없음). 현재 세션 파일 등장/갱신·세션 교체를 잡는다.
      conv.watchers.push(
        ctx.app.fs.watch(conv.dir, async () => {
          // dir 변경(resumed/신규 세션 jsonl append)마다 활성 세션 재확인 → 바뀌면 전환.
          const cur = (await findActive(conv.dir, conv.detectAt)).session;
          if (cur && cur !== conv.session) switchToSession(conv, cur); // 교체/첫 등장
          if (conv.session) await tail(conv);
          if (conv.session) scanAgents(conv);
        }),
      );
      // ② 라이브 응답 — 진행 중 버퍼를 onOutput(폴링 없음, 프레임당 1회)으로 표시.
      const lterm = ctx.app.terminal;
      if (lterm && lterm.readBuffer && lterm.onOutput && conv.paneId) {
        const d = lterm.onOutput(conv.paneId, () => updateLive(conv));
        conv.watchers.push({ dispose: () => (d && d.dispose ? d.dispose() : d && d()) });
        updateLive(conv);
      }
      if (conv.session) scanAgents(conv);
    }

    // 세션 전환(첫 등장 포함): 본문·상태 리셋 후 그 세션을 현재로.
    function switchToSession(conv, session) {
      conv.session = session;
      conv.stats.session = session;
      conv.path = `${conv.dir}/${session}.jsonl`;
      conv.offset = 0;
      conv.leftover = "";
      conv.seen.clear();
      conv.toolEls.clear();
      conv.bodyEl.replaceChildren();
      conv.agents.clear();
      conv.agentsWatched = false;
      conv.wfWatched = false;
      conv.wfRunWatched.clear();
    }

    function emptyState(p, msg) {
      const d = el("div", "cg-empty cg-dim", msg);
      p.bodyEl.replaceChildren(d);
    }

    function teardownConv(p) {
      if (!p.conv) return;
      for (const un of p.conv.watchers) {
        try {
          un.dispose ? un.dispose() : un();
        } catch {
          /* skip */
        }
      }
      p.conv = null;
    }

    // ── 오버레이 ──────────────────────────────────────────────────────────────
    function open(paneId) {
      const p = panes.get(paneId);
      if (!p || p.open) return;
      const host = paneEl(paneId);
      if (!host) return;
      const ov = el("div", "cg-overlay");
      ov.style.font = "13px/1.5 " + UI_FONT;
      const body = el("div", "cg-body");
      p.bodyEl = body;
      const headHolder = {};
      const head = buildHeader(headHolder, p.cwd, () => close(paneId));
      p.headRefs = headHolder.head; // openConversation 이 conv.head 로 받아 갱신
      const liveEl = el("div", "cg-live"); // ② 진행 중 응답 밴드(body 와 foot 사이)
      p.liveEl = liveEl;
      const foot = buildInput(paneId);
      p.queue = foot._queue; // 입력 3계층 큐(L3 확정 = renderEntry 에서 confirmUserLine)
      p.ta = foot._ta; // 입력창 textarea — focus/type 명령이 실제 DOM 경로로 구동
      if (p.queue && p.savedQueue) {
        p.queue.restore(p.savedQueue); // 이전에 닫으며 보존한 대기 항목 복원
        p.savedQueue = null;
      }
      ov.append(head, body, liveEl, foot);
      host.appendChild(ov);
      p.overlay = ov;
      p.open = true;
      // 열리면 입력창에 포커스(바로 타이핑).
      setTimeout(() => foot._ta && foot._ta.focus(), 0);
      // 스크롤 위치 추적(맨 아래면 새 메시지에 자동 따라감).
      body.addEventListener("scroll", () => {
        if (!p.conv) return;
        p.conv.atBottom =
          body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      });
      setItem(paneId);
      openConversation(p);
    }

    function close(paneId) {
      const p = panes.get(paneId);
      if (!p || !p.open) return;
      // 죽을 오버레이 DOM 에 포커스가 남으면 다음 클릭이 안 가므로 먼저 푼다(D.3).
      if (p.overlay && p.overlay.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      // 닫아도 대기 항목 보존(pane 레벨) — 재오픈 시 restore. TUI 갔다 와도 안 사라짐.
      if (p.queue && p.queue.hasPending()) p.savedQueue = p.queue.snapshot();
      p.queue?.dispose(); // onOutput 구독·타이머 해지(항목은 savedQueue 로 보존)
      p.queue = null;
      teardownConv(p);
      p.overlay?.remove();
      p.overlay = null;
      p.bodyEl = null;
      p.open = false;
      setItem(paneId);
    }

    function toggle(paneId) {
      const p = panes.get(paneId);
      if (!p) return;
      if (p.open) close(paneId);
      else open(paneId);
    }

    // ── 코어 범용 소켓 구독(폴링 없음) ───────────────────────────────────────────
    ctx.subscriptions.push(
      ctx.app.events.on("command.started", ({ paneId, commandLine, cwd }) => {
        if (CLAUDE_RE.test(commandLine)) ensure(paneId, cwd, true);
      }),
    );
    ctx.subscriptions.push(
      ctx.app.events.on("command.finished", ({ paneId }) => {
        if (panes.has(paneId)) remove(paneId);
      }),
    );

    // claude 가 이미 떠 있는 패널에서 늦게 활성화되면 started 를 놓친다 — 현재 상태 스냅샷으로
    // 즉시 동기화(설정 즉시 반영, 폴링 아님).
    if (ctx.app.terminal) {
      for (const c of ctx.app.terminal.runningCommands()) {
        if (CLAUDE_RE.test(c.commandLine)) ensure(c.paneId, c.cwd, false);
      }
    }

    // ── 명령 contributes ───────────────────────────────────────────────────────
    const pick = (p) => (p && p.paneId) || lastPaneId;
    const reg = (n, params, h) =>
      ctx.subscriptions.push(
        ctx.app.commands.register(n, { description: n, params, handler: h }),
      );
    const PANE_PARAM = {
      paneId: { type: "string", description: "대상 패널 id(생략 = 최근 claude 패널)" },
    };
    reg("toggle", PANE_PARAM, (p) => {
      const id = pick(p);
      if (id) toggle(id);
      return { paneId: id ?? null };
    });
    reg("open", PANE_PARAM, (p) => {
      const id = pick(p);
      if (id) open(id);
      return { paneId: id ?? null, open: !!id };
    });
    reg("close", PANE_PARAM, (p) => {
      const id = pick(p);
      if (id) close(id);
      return { paneId: id ?? null, open: false };
    });
    // 입력 + 즉시 상태 반환(선배 요청). 비동기 — return 은 enqueue 직후 상태(held/다이얼로그
    // 대기/awaiting), 최종 "실제 입력(L3)"은 queue 명령으로 폴링. GUI 미오픈이면 자동 open.
    reg(
      "send",
      {
        ...PANE_PARAM,
        text: { type: "string", description: "claude 에 보낼 텍스트", required: true },
      },
      (params) => {
        const id = pick(params);
        if (!id) return { paneId: null, error: "claude 패널 없음" };
        const text = String(params.text == null ? "" : params.text);
        if (!text.trim()) return { paneId: id, error: "빈 텍스트" };
        const p = panes.get(id);
        if (!p) return { paneId: id, error: "패널 상태 없음" };
        if (!p.queue) open(id); // 큐는 오버레이에서 생성 — 없으면 연다
        const q = panes.get(id)?.queue;
        if (!q) return { paneId: id, error: "큐 생성 실패(terminal:write 필요)" };
        q.enqueue(text);
        const term = ctx.app.terminal;
        const cls =
          term && term.readBuffer
            ? classifyBuffer(term.readBuffer(id, 60) || "")
            : "unknown";
        return { paneId: id, classify: cls, queue: q.snapshot() };
      },
    );
    // GUI 로 화면 이동 = 오버레이 열고 입력창(textarea)에 포커스. 사용자가 GUI 입력으로 가는 동작.
    reg("focus", PANE_PARAM, (params) => {
      const id = pick(params);
      if (!id) return { paneId: null, error: "claude 패널 없음" };
      if (!panes.get(id)?.open) open(id);
      const p = panes.get(id);
      if (!p || !p.ta) return { paneId: id, error: "입력창 없음" };
      p.ta.focus();
      return { paneId: id, open: !!p.open, focused: document.activeElement === p.ta };
    });
    // 입력창에 실제 입력 = textarea 에 값 넣고 진짜 Enter keydown 을 디스패치 → GUI 의 send
    // 핸들러(ta.value 읽어 큐 enqueue)를 그대로 실행. 우회 없이 textarea→Enter→큐 글루를 탄다.
    reg(
      "type",
      { ...PANE_PARAM, text: { type: "string", description: "입력창에 칠 텍스트", required: true } },
      (params) => {
        const id = pick(params);
        if (!id) return { paneId: null, error: "claude 패널 없음" };
        if (!panes.get(id)?.open) open(id);
        const p = panes.get(id);
        if (!p || !p.ta) return { paneId: id, error: "입력창 없음" };
        const text = String(params.text == null ? "" : params.text);
        if (!text.trim()) return { paneId: id, error: "빈 텍스트" };
        p.ta.focus();
        p.ta.value = text;
        p.ta.dispatchEvent(new Event("input", { bubbles: true }));
        p.ta.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
        return { paneId: id, queue: p.queue ? p.queue.snapshot() : [] };
      },
    );
    // 현재 큐 스냅샷(비동기 진행 폴링용). 각 항목 {text,state,reason}.
    reg("queue", PANE_PARAM, (params) => {
      const id = pick(params);
      const p = id ? panes.get(id) : null;
      return { paneId: id ?? null, queue: p && p.queue ? p.queue.snapshot() : [] };
    });
    // 오버레이 렌더 상태 introspection(e2e 결정적 단언용). DOM 을 소켓이 못 보므로 플러그인이 노출.
    reg("state", PANE_PARAM, (params) => {
      const id = pick(params);
      const p = id ? panes.get(id) : null;
      if (!p) return { paneId: id ?? null, open: false };
      const term = ctx.app.terminal;
      return {
        paneId: id,
        open: !!p.open,
        session: p.conv ? p.conv.session : null,
        dir: p.conv ? p.conv.dir : null, // 추적 중인 프로젝트 트랜스크립트 dir(테스트 오라클용)
        bubbles: p.bodyEl ? p.bodyEl.querySelectorAll(".cg-row").length : 0,
        agents: p.bodyEl ? p.bodyEl.querySelectorAll(".cg-subagent").length : 0,
        live: !!(p.liveEl && p.liveEl.style.display !== "none" && p.liveEl.childElementCount),
        queue: p.queue ? p.queue.snapshot() : [],
        classify:
          term && term.readBuffer
            ? classifyBuffer(term.readBuffer(id, 60) || "")
            : "unknown",
      };
    });

    ctx.subscriptions.push({
      dispose() {
        for (const id of [...panes.keys()]) remove(id);
      },
    });
  },
  deactivate() {},
};
