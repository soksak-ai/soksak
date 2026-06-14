# cc2 뷰/실행 모델 전수조사 → soksak GUI 적용 (설계 참조)

cc2(Claude Code 원본 TUI) 소스를 전수조사해, claude JSONL 트랜스크립트의 모든 요소가 어떻게
표시·실행되는지와 soksak GUI 플러그인에 옮기는 법을 정리한다. 모토: cc2 구성요소를 그대로 GUI 이식.

출처: 워크플로우 `cc2-view-census`(7 에이전트, messages·tools·agents-skills·input-queue·tmux-views·special-views).

---

## A. JSONL 요소 → cc2 표시/실행

| 요소 | JSONL 필드 | cc2 표시(마커·색·레이아웃·접힘·트렁케이트) | 실행/처리 |
|---|---|---|---|
| user prompt | `user`, `content[].text` | 마커 없음, bg=userMessageBackground(light #f0f0f0/dark blackBright), pad-right 1, msg 간 margin-top 1. 10k자 캡(head 2.5k+`… +N`+tail 2.5k) | thinking 태그 추출 후 렌더 |
| user bash in | `<bash-input>` 태그 | 마커 `! `(pink/magenta), bg=bashMessageBackground | extractTag |
| user bash out | `<bash-stdout/stderr>` | OutputLine ANSI 렌더 | extractTag |
| user image | `content[].type:image` | `[Image #N]` + file:// 링크 + `⎿` | pathToFileURL |
| tool_result | `tool_result`, `is_error`, `tool_use_id` | cancel/reject/error/success 분기. 성공=박스, 에러=error 색 | tool_use_id 매칭 |
| assistant text | `assistant`, `content[].text` | 마커 없음, Markdown(marked, 테이블=flexbox). 에러문구=error 색 | whitespace-only→null |
| thinking | `content[].type:thinking` | 접힘(기본) `∴ Thinking` dim+italic. 펼침(verbose/transcript) `∴ Thinking…`+pad-left 2 markdown | verbose/transcript 시만 펼침 |
| redacted_thinking | `redacted_thinking` | `✻ Thinking…` dim+italic | non-transcript 시만 |
| tool_use | `tool_use`, id/name/input | 마커 `⏺`(macOS), 툴별 색 pill+이름+input. 진행중=loader | input 스키마 파싱(실패=raw) |
| Bash | `command` | 호출 160자/2줄 캡. 결과 stdout/stderr+실행시간/exit | streaming progress |
| Read | `file_path`,`offset`,`limit` | 경로+`· lines X-Y`. 결과 `Read N lines`/`Read image` | not-found note |
| Write | `file_path`,`content` | 경로(plan=빈). 결과 diff(create/append/overwrite) | plan 감지 |
| Edit | `file_path`,`old/new_string` | 경로. 결과 구조화 diff(context 3) | reject=EditRejectionDiff |
| Grep/Glob | `pattern`,`path` | `pattern · path`. 결과 `Found N` 컴팩트+ctrl+o | — |
| Web | `query`/`url` | `Did N searches`/`Received SIZE`. verbose=full | progress |
| MCP | key:value | 호출 80자캡. 결과 content blocks, >10k 경고 | MAX_FLAT_JSON_KEYS 12 |
| Skill | skill name | `Successfully loaded skill`+allowed 수 | SubAgentProvider |
| TodoWrite | `todos[]{status,content}` | TaskListV2 아이콘(✔/▶/✖/…/•/?/⚠)+색. >10 트렁케이트 | RECENT_COMPLETED_TTL 30s |
| Agent(subagent) | tool_use `Agent`; 전사=별도 `subagents/agent-{id}.jsonl` | 컬러 pill(agentColorManager)+볼드. 비verbose=마지막 3 progress+`+N more`, search/read 그룹 접힘 | processProgressMessages 그룹화, buildSubagentLookups |
| teammate | `<teammate-message>` | per-sender 색+이름+chevron. transcript=pad-left 2 ANSI | parseTeammateMessages regex |
| plan | user text + planContent | `Current Plan` 볼드+경로 dim | handlePlanModeTransition |
| exit plan | `ExitPlanMode` tool_use | `◆` 배지 + "awaiting approval" | setAwaitingPlanApproval |
| permission | (런타임 — JSONL 외) | 질문+Select+`Esc/Tab` | accept/reject |
| compact | `system`,`subtype:compact_boundary` | `✻ Conversation compacted (Ctrl+O)` dim | createCompactBoundaryMessage |
| microcompact | `subtype:microcompact_boundary` | **null(표시 안 함)** | clear_thinking/tool_uses |
| system 기타 | subtype: local_command/turn_duration/away_summary/agents_killed | local=bash풍, away=`※`, killed=`●`error | subtype별 |
| 커넥터 | (구조) | `  ⎿  `(U+23BF) dim, **no-select** | tool_result/image 연속 |

핵심 파싱: ① 단일진실=JSONL message 객체. `type`→content block `type` **2단 디스패치**(Message.tsx:82-432). ② tool_use↔tool_result = `id`/`tool_use_id` 매핑. ③ subagent 전사 = `{projectDir}/{sessionId}/subagents/agent-{agentId}.jsonl` 별도 파일 tail.

---

## B. soksak 적용 매핑

테마 토큰 추가 권장: 기존 `--bg/--fg/--acc/--bd` + semantic `--ok`/`--err`/`--warn`.

| 요소 | 우선 | HTML | CSS(토큰) |
|---|---|---|---|
| user prompt | 필수 | `.msg.user` | bg=accbg, pad-right, margin-top, 10k 트렁케이트 |
| assistant text | 필수 | `.msg.asst` markdown→HTML | color fg, 에러=err |
| tool_use | 필수 | `.tool > .mark ● + .tname + .tin` | mark=acc, 진행중 `.busy` 스피너 |
| tool_result | 필수 | `.tres`(tool_use 자식) | border-left bd, 에러=err |
| bash in/out | 필수 | `.bash-in ! …` + `pre.ansi` | ANSI→span |
| Read/Write/Edit | 필수 | `a.fpath` + diff pre | add=ok/del=err |
| Grep/Glob | 중요 | `.search Found N + expand` | dim, 펼침 토글 |
| TodoWrite | 필수 | `ul.todos > li[data-status]` | 아이콘 pseudo + 상태색 |
| Agent | 필수 | `.agent[data-agent-id] > .pill + view버튼` | pill bg=agent-color |
| thinking | 중요 | `details.think > summary ∴` | dim italic, 기본 접힘 |
| compact | 중요 | `.compact ✻ …` | bd, center |
| 커넥터 | 중요 | `.conn ⎿` | bd, **user-select:none** |
| microcompact | 선택 | 렌더 안 함(cc2 동일) | — |

---

## C. 이슈 0~3 근거

**(0) 입력 후 즉시 반영 없음 = 정상 + 라이브 tail 확인 필요.** cc2 는 **즉시 SEND 없음 — 전 입력이 우선순위 큐 경유**(commandQueue, module-level). 엔터→onSubmit→handlePromptSubmit→enqueue. 턴 진행 중(queryGuard)이면 dequeue 안 함, 턴 종료 시 드레인. soksak 은 PTY 로 claude TUI 에 주입하므로 **claude 자체 큐가 처리** — 입력은 도달하나 BUSY 중엔 응답 지연. GUI 가 무반응으로 보이는 건 (a) 전송 피드백 없음 (b) 라이브 tail 미갱신(검증 대상).

**(1) 큐.** claude TUI 가 이미 큐를 가짐(우리는 PTY 주입). 별도 큐 불요 — 대신 JSONL `queue-operation`(enqueue/dequeue)로 대기 상태를 표시 가능(선택). 핵심=전송 피드백 + 라이브 tail.

**(2) agent/task 뷰 전환.** cc2 상태머신: `viewingAgentTaskId`(AppStateStore), enter/exitTeammateView, 자동 퇴출(killed/failed). soksak: agent pill 클릭→`viewingAgentId` 설정→`subagents/agent-{id}.jsonl` tail→그 transcript 표시+back. agent 전사가 별도 파일이라 클릭→해당 파일 tail 이 정답.

**(3) 포커스/선택.** cc2: 마커/커넥터(`●`/`⎿`)에 user-select 회피로 복사 오염 방지. soksak: 네이티브 선택 쓰되 마커/커넥터만 `user-select:none`. (별도: 우리 PaneTree focusHost 가 xterm 포커스 탈취 — 코어 수정 필요.)
