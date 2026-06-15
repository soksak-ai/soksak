# Claude GUI

터미널 패널에서 `claude`(Claude Code CLI)를 실행하면 그 패널 우하단에 **Claude GUI** 버튼이 뜹니다. 누르면 패널을 덮는 GUI 오버레이가 열려 claude 대화를 cc2(claude 원본 TUI) 구성 그대로 버블로 렌더합니다. claude 가 종료되면 버튼·오버레이는 자동 회수됩니다.

모토: **cc2 TUI 의 작용을 GUI 로 그대로 이식.** 모든 claude 도메인 처리는 이 플러그인이 소유하고, 코어는 범용 소켓만 제공합니다(decoupling — 코어는 claude 를 모름).

## 데이터 평면 3개

- **① 대화 history (JSONL)** — `~/.claude/projects/<enc-cwd>/<sessionId>.jsonl` 을 offset tail + 코어 fs.watch(폴링 없음)로 증분 파싱. 메시지·도구 호출·도구 결과·thinking·todo·시스템·서브에이전트를 버블로. cc2 글리프(`⏺`·`✻`·`∴`·`⎿`) 사용.
- **② 라이브 스트림 (터미널 버퍼)** — 진행 중 응답은 JSONL 에 없으므로 `app.terminal.readBuffer` 로 화면을 읽어 라이브 표시. 완료 시 JSONL 구조 버블로 교체.
- **③ workflow/agent** — `<sessionId>/subagents/agent-*.jsonl` + `*.meta.json` + `workflows/<runId>/` 를 스캔해 중첩 패널 + 실측 진행 라인(tool 수·토큰·마지막 tool. 거짓 진행률 없음).

## 입력 3계층 큐

GUI 입력은 claude PTY 로 주입되는데, claude 가 **다이얼로그(/status 등)·thinking** 상태면 그냥 주입하면 유실되거나 다이얼로그를 오조작합니다. 그래서 3계층으로 검증합니다:

- **L1 PTY write** — 바이트 주입(전송 시도일 뿐).
- **L2 TUI 버퍼** — `readBuffer` 로 입력이 claude 입력란/큐에 실제로 나타났는지 확인.
- **L3 JSONL** — 세션 jsonl 에 user 라인이 나타나면 **실제 입력 확정 = GUI 큐에서 제거**(단일 제거점).

모달 게이트(`readBuffer` 의 `Esc to cancel` 등 dismiss 힌트로 다이얼로그 감지) → 모달이면 주입 보류. 모달이 닫히면 **FIFO 로 자동 드레인**. 4-상태(`held`→`injecting`→`awaiting`→제거), 중복 1:1, 이중주입 차단. 닫았다 열어도 대기 항목은 보존됩니다.

## 명령

- `toggle [paneId]` — GUI 켜기/끄기(생략 = 최근 claude 패널)
- `open [paneId]` / `close [paneId]` — 열기/닫기
- `send {text, [paneId]}` — 입력 + **즉시 큐 상태 반환**(JSON). 반환 = `{ classify, queue:[{text,state,reason}] }`. 비동기라 최종 "실제 입력(L3)"은 아래 `queue` 로 폴링. GUI 미오픈이면 자동 open.
- `focus [paneId]` — GUI 로 화면 이동 = 오버레이 열고 **입력창(textarea)에 포커스**. 반환 `{ focused }`.
- `type {text, [paneId]}` — **입력창에 실제 타이핑 + Enter**. `send`(큐 직접 enqueue)와 달리 textarea 값 설정 후 **진짜 Enter keydown 이벤트를 디스패치**해 GUI 의 입력 핸들러(ta.value→큐)를 그대로 태운다. 실제 GUI 입력 경로 검증용.
- `queue [paneId]` — 현재 입력 큐 스냅샷 조회(진행 폴링용)

```bash
sok plugin.soksak-plugin-claude-gui.send '{"text":"안녕"}'
# → { "classify":"modal", "queue":[{"text":"안녕","state":"held","reason":"modal"}] }
sok plugin.soksak-plugin-claude-gui.focus      # GUI 입력창으로 화면 이동
sok plugin.soksak-plugin-claude-gui.type '{"text":"안녕"}'   # 입력창에 실제 타이핑+Enter
sok plugin.soksak-plugin-claude-gui.queue
```

큐 칩 상태: `⧖ 다이얼로그 대기`(맨 앞이 다이얼로그로 막힘) · `⧖ 순번 대기 (N)`(뒤 항목) · `⤴ 전송`(주입중) · `⏳ 입력 대기`(claude 큐에서 L3 대기). 칩이 사라지는 시점 = 실제 입력 시점(L3).

## 권한

`terminal`(claude 감지) · `terminal:read`(② 라이브·입력 readiness) · `terminal:write`(입력 주입) · `fs:read`(JSONL·session-env) · `ui:statusbar` · `ui:overlay:pane` · `commands`.

`terminal:read` 가 없으면 입력 큐·라이브는 비활성(레거시 즉시 주입으로 폴백)됩니다.
