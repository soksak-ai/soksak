# soksak AI 제어 표면 — Substrate / Channel / Teaching (v1)

soksak 의 모든 기능을 AI 에게 주는 방식의 정본 규칙. 세 가지(CLI·MCP·Skill)는 형제가 아니다. **1 substrate + 2 transport + 1 teaching** 의 계층이며, 이 파일이 그 관계와 규칙의 단일 진실이다. 코드 주석·Skill 본문·MCP 설계는 이 파일을 참조한다 — 여기서 어긋나면 코드가 틀린 것이다.

영문 정본: [AI-CONTROL.md](./AI-CONTROL.md) — 어긋나면 영문이 우선한다.

> 설치·사용 how-to 는 [`AI-CONTROL-GUIDE.md`](./AI-CONTROL-GUIDE.md)(매뉴얼). 이 파일은 설계·규칙(왜)만 다룬다.

---

## 1. 멘탈 모델

```
              ┌──────────────────────────────────────────────┐
  TEACHING    │  Skill: soksak(-dev|-debug) (SKILL.md)             │
              │  에이전트에게 '채널 사용법·발견하는 법'을 교육 │
              │  (명령 목록 복제 금지 — 발견 안내만)          │
              └───────────────┬──────────────────────────────┘
                              │ teaches how to use ↓
              ┌───────────────┴──────────────────────────────┐
  CHANNELS    │   CLI: sok            │   MCP: sok mcp         │
 (2 transport)│   터미널 내 동기 호출  │   외부 에이전트 stdio  │
              │   commands/help/run   │   (발견형 메타툴)      │
              │   (발견형)            │                        │
              └───────┬───────────────┴───────────┬──────────┘
                      │ JSON-RPC over socket       │ bridge→socket
                      ▼                            ▼
              ┌──────────────────────────────────────────────┐
  SUBSTRATE   │  Socket Server (ipc.rs)                       │
 (단일 진실)   │   ~/.soksak/*.sock · 멀티윈도우 route · seq    │
              │   · danger 게이트(remote 만 permissionGate)   │
              │   · events.subscribe push 스트림(P11)         │
              │  ────────────────────────────────────────    │
              │  Command Registry (registry.ts)               │
              │   Map<name,CommandSpec> · catalogJson()       │
              │   코어 ~140 + 플러그인 기여 → 한 Map          │
              │  Activity Hub (activity.rs)                   │
              │   링+seq · 전 창 브로드캐스트 · 영속           │
              └──────────────────────────────────────────────┘
                      ▲                            ▲
               코어 register()            플러그인 contributes.commands
```

- **Substrate(기반·단일 진실)** = Command Registry(`src/commands/registry.ts`) + Socket Server(`src-tauri/src/ipc.rs` — 와이어 계약·버전 협상 = [SOCKET-PROTOCOL.ko.md](SOCKET-PROTOCOL.ko.md)) + Activity Hub(`src-tauri/src/activity.rs` — 실행 스트림, P11–P12). 명령의 존재·스키마·권한·실행의 유일한 진실. 코어 register()(~140) + 플러그인 contributes.commands 가 한 Map 으로 수렴한다.
- **Channels(transport·접근 경로)** = CLI(`sok` 바이너리, 터미널 내 동기 호출) + MCP(`sok mcp`, 외부 에이전트 stdio 브리지). 둘 다 substrate 를 **호출만** 한다. 자기 명령 목록을 갖지 않고 전부 `catalogJson()`/`state.commands` 에서 파생한다.
- **Teaching(교육·채널 위)** = Skill(soksak — 환경별 이름). 에이전트에게 채널을 **어떻게 쓰는지** — 명령 목록이 아니라 **발견하는 법** — 을 가르친다. transport 가 아니다.

셋은 동등 형제가 아니라 substrate 를 정점으로 한 의존 계단이다. 어떤 채널도 substrate 를 우회해 명령을 정의하지 못하고, teaching 은 channel 을 통해서만 명령에 도달한다.

---

## 2. 규칙 (P1–P13)

**메타-원칙 — 규칙은 목적에 복무한다.** 규칙을 지키다 필요한 정보·동작을 잃으면 규칙이 틀린 것이다. 약화가 아니라 정정하라. 단, 정당한 정정만 — 편의를 위한 기준 약화는 배신이다.

**P1 — 단일 진실은 Command Registry 다.** `catalogJson()` 이 명령 존재·스키마·권한·실행의 유일한 진실이다. 어떤 채널도 자기 명령 목록을 수기로 관리하지 마라. CLI 도움말·MCP tool·Skill 교육·문서는 전부 이 카탈로그에서 파생하라 — 복제 금지.

**P2 — CLI·MCP 는 transport, Skill 은 teaching 이다.** 셋을 동등 형제로 다루지 마라. transport 는 substrate 를 호출만 하고, teaching 은 transport 를 통해서만 명령에 도달한다. Skill 에 명령 목록을 박지 마라 — 발견하는 법만 가르쳐라.

**P3 — 발견(discovery)이 주입(injection)을 이긴다.** 채널은 전 명령을 eager 로 노출하지 마라. 발견형 표면(목록→스키마→실행)을 제공하라. MCP `tools/list` 에 전체 명령을 평탄 노출하지 마라 — 메타툴 3개(`soksak.commands`/`soksak.help`/`soksak.run`)로 고정하라. 발견형이면 명령이 늘어도 tool 수가 불변이다.

**P4 — 권한 게이트는 substrate 에 하나만 둬라.** 채널마다 권한 로직을 재구현하지 마라. remote(CLI/MCP/socket) 호출에만 danger 게이트를 적용하고 UI(사람)는 우회한다. 플러그인 명령의 danger 분류도 같은 substrate 게이트로 흐른다.

**P5 — 스킬은 오리엔테이션이다. per-command 카탈로그를 박지 마라.** Skill 은 `.claude`/`.codex` 에 상주하는 표준 지식이다 — "`sok commands` 돌려라"만으로는 에이전트가 모르는 도메인을 발견조차 못 하므로, 스킬은 **안정적 오리엔테이션**(멘탈 모델·주소 모델·검증 워크플로 + 도메인 지도=목차)을 담는다. 휘발성·대용량·플러그인 동적인 per-command 카탈로그는 담지 않는다 — 그건 `sok commands`/`help` 다. 도메인 지도는 install 시 라이브 레지스트리에서 파생(앱 미가동 시 코어 fallback). '모든 기능을 문서화했다'고 주장하지 마라 — substrate 가 자라는 순간 거짓이 된다.

**P6 — app 과 `sok mcp` 의 경계를 흐리지 마라.** app(`ipc.rs`)은 MCP 서버가 아니라 app-internal command socket 이다. MCP 서버는 `sok mcp` 서브프로세스이며 앱 실행 중일 때만 socket 에 브리지한다. 'app 이 MCP 를 호스팅한다'고 적지 마라.

**P7 — 채널은 thin 이어야 한다.** 채널 핸들러에 로직을 두지 마라. CLI `sok`·MCP 메타툴은 `state.commands` 호출과 `request()` 패스스루만 한다. 검증·라우팅·게이트·식별자 매칭은 전부 substrate 가 한다. 채널이 두꺼워지면 채널마다 버그가 갈라진다.

**P8 — 교육 문서 전달은 채널로만. 파일시스템을 가로채지 마라.** 라이브 문서는 (a) MCP resource(`resources/read soksak://skill` stdio 서빙) 또는 (b) write-through 실파일(레지스트리 변경 시 재생성)로 전달한다. FUSE/유저스페이스 파일시스템 가로채기는 금지 — kext 마찰·플랫폼별 드라이버로 멀티플랫폼이 깨지고, "실재 안 하는 경로를 서버가 만든 내용으로 연다"는 트릭은 채택하지 않는다. 두 경로 모두 `sok commands`(P1)에서 파생하고 mac/linux/windows 동일하게 동작한다.

**P9 — 환경은 바이너리의 정체성이다. 침묵 cross-env 는 배신이다.** 앱 정체성은 3개(`com.soksak.{dev|debug|app}`)로 소켓이 분리되고, CLI 도 한 크레이트에서 함께 빌드되는 **실물 바이너리 3개**다(`sok`→app, `sok-dev`→dev, `sok-debug`→debug — 공용 lib 위의 작은 진입점이라 낡을 수 없고, 이름 기제 자체에 링크·복사가 없다(PATH 설치는 같은 이름의 실물을 심링크로 노출할 수 있다 — 제조가 아니라 노출)). 각 바이너리의 환경은 컴파일 시점에 고정된다: **사람이 바꾸는 채널은 없다**(`--env`·`SOKSAK_ENV` 폐지 — 그것이 곧 배신 통로였다). 유일한 상위 권위는 앱이 자기 PTY 에 주입하는 `SOKSAK_SOCKET`(호스트 앱의 기계적 선언)뿐이다. 그 바이너리의 환경이 미실행이면 **에러** — 대체는 없다. 다른 환경은 그 환경의 바이너리로 호출한다.

**P10 — install 은 멱등하고 소유권으로 범위가 정해진다.** 우리 것은 통째로 재생성, 사용자 것은 보존.
- **완전 소유 산출물** — 제어 스킬은 환경별 디렉토리(`soksak/`·`soksak-dev/`·`soksak-debug/`, identity 홈당 하나)에 살고, 생성 시점에 자기 바이너리 경로와 소켓을 핀한다. 대상 디렉토리는 순수 산출물로 전체 재생성된다. 저작 본문과 부속은 소스다 — 코어 레포 `src-tauri/cli/skill/`(BODY.md·references/)에 살고 CLI 에 내장(`include_str!`)되어 install/refresh 때 산출된다. 개명·표면 변화가 코드와 같은 커밋으로 함께 훑는다. 생성기가 frontmatter `name:` 을 환경 이름으로 강제하고 description 끝에 환경 문장을 잇는다. 본문은 "Working style (authored)" 절로 실린다. 설치가 identity 홈에 `skill-refresh.json` 매니페스트를 남기고, 앱은 플러그인 활성 집합이 변할 때 `sok skill refresh` 를 스폰한다 — 파일 가로채기 없는 쓰기-스루(P8).
- **공유 파일**(`.mcp.json`/codex `config.toml`/gemini `settings.json`)은 우리 항목만 upsert, 나머지 보존. MCP 등록은 네이티브 CLI(`claude/codex/gemini mcp add`)에 위임(P7).

**P11 — 이벤트 스트림은 커맨드 표면과 대칭이다.** 코어가 커맨드 표면과 대칭인 구독 표면을 소유한다 — 폴링 금지 규칙의 완성형. 허브는 Rust 싱글톤(크로스윈도우 단일진실; 항목은 단조 `seq` + epoch-ms `ts`), 소켓은 `events.subscribe` 를 transport 레벨로 처리한다(연결이 곧 스트림 — 연결 수명 = 구독 수명). `kinds` 는 서버측 필터(prefix 매칭), `since` 는 링 백필(exclusive 커서). 구독자 큐는 bounded·drop-oldest — 느린 소비자가 발행을 막지 못하고, 유실은 `seq` gap 으로 드러나 클라이언트가 `since` 재접속으로 메꾼다. 셸-리스 MCP 클라이언트는 push 대신 `activity.recent {since}` 커서 조회를 쓴다 — 요청 시점 catch-up 조회는 폴링이 아니다(결정).

**P12 — 실행 가시성.** 오케스트레이터가 soksak 에 실행시키는 모든 것 — 레지스트리 명령·터미널 명령·AI 턴 — 은 사람이 볼 수 있다. 실행 피드는 영속 기록(core/activity records, retention trim)이고 UI 는 그 기록의 뷰다. 공급 2계열: ① 플러그인 이벤트(터미널 명령 시작/종료·턴 종료·뷰 활성화) ② `registry.execute()` 계측 — 명령명·ui/remote 출처·danger 분류·소요·표준 응답 봉투(`ok`/`code`/`message`, 상세는 `data`). `message`(`CommandSpec.summarize` 산출)가 피드가 렌더하는 사람 읽는 답이고, `data`는 요청 시 펼치는 기계 페이로드다. **민감 키 값(`pass`/`token`/`secret`/`auth`…)은 마스킹되어 절대 방출되지 않는다** — 보안 불변식은 답 전체를 숨겨서가 아니라 마스킹으로 지킨다(기존 "파라미터 키만, 값은 스트림 금지"를 대체: 여기선 관찰이 1급이라 답은 보여야 하고 비밀만 마스킹). 스트리밍 명령은 `command.progress` 델타도 낸다(MESSAGE-PROTOCOL.md). 오케스트레이터가 내리는 명령이 정확히 이 경로이므로, ② 없이는 "무엇이 실행되는지 본다"가 성립하지 않는다.

**P13 — 전송 중립.** 로컬 창과 폰은 동일 스트림·동일 커맨드 표면을 소비한다. danger 게이트·remote.confirm 은 전송이 아니라 **호출 출처** 기준이다. 코어에 폰 전용 코드는 0 — 원격 전송(예: iroh 사이드카)은 `events.subscribe` 와 커맨드 소켓을 그대로 포워딩한다.

---

## 3. 채널별 리스트업 (사용대상 / 제공기능 / 제공방법 / 무엇 / 왜)

### Substrate (Registry + Socket + Activity Hub)
- **사용대상**: 세 채널 전부 + UI(사람) — 모든 호출의 종착지.
- **제공기능**: Command Registry(register/getSpec/catalogJson) + Unix socket JSON-RPC(멀티윈도우 라우팅·timeout·client-id/seq 매칭) + danger 게이트(remote 만, UI 우회) + 활동 스트림(publish/recent/subscribe). 코어 ~140 + 플러그인 기여가 한 Map.
- **제공방법**: 코어 `register()`(`catalog*.ts`) + 플러그인 `contributes.commands`→`registerCommand`. `ipc::start(app)` 가 소켓 바인드. 어떤 채널도 자기 목록을 수기 관리하지 않는다.
- **무엇**: `registry.ts`/`ipc.rs`/`activity.rs` 를 정본 substrate 로 동결. `catalogJson()` 을 유일 명령-목록 원천으로 유지.
- **왜**: 두 transport·한 teaching 이 모두 여기서 파생 → 코드와 어긋날 수 없음. 게이트가 substrate 에 있어야 채널마다 재구현되지 않는다.

### CLI (`sok`)
- **사용대상**: 터미널 안 사람 + 터미널 안 에이전트(claude/codex 가 PTY 안에서 `sok` 실행).
- **제공기능**: 임의 명령 `sok <cmd> '{json}'`, 발견 `sok commands`/`help <cmd>`/`docs`, 스트림 팔로우 `sok events [--kinds] [--since]`(JSONL, Ctrl-C 종료), MCP 브리지 `sok mcp`, 교육 설치 `sok skill install` / 출력 `sok skill print`(라이브 SKILL.md stdout — 헤드리스 에이전트의 프롬프트 재료). SOKSAK_PANE/WINDOW/SOCKET 자동 인지로 자기 위치 기본 타겟, `--window <label>` 은 타겟 창 명시 오버라이드(SOKSAK_WINDOW 보다 우선 — 셸 권한이 `sok …` 접두만 허용하는 에이전트의 창 지정 수단).
- **상관**: `SOKSAK_PARENT`(오케스트레이터가 스폰한 에이전트에 주입)가 모든 요청에 meta `parent` 로 실려 활동 엔트리 `payload.parentId` 가 된다 — 실행들이 그 대화 턴으로 묶인다(MESSAGE-PROTOCOL §4). PANE/WINDOW 와 같은 env 컨텍스트 모델, MCP `soksak.run` 도 같은 지점을 지난다.
- **제공방법**: 워크스페이스 `cli` 크레이트 → `sok` 바이너리. `resolve_socket`. `run_request`/`run_help`/`run_docs` 전부 `fetch_commands()`=`state.commands` 파생, `run_events` 는 연결을 push 스트림으로 전환.
- **무엇**: 현 구현 유지. help/docs 가 `catalogJson` 파생임을 규칙으로 고정. 정적 명령 목록 하드코딩 금지.
- **왜**: transport-1 — 터미널 내 저지연 동기 호출. 이미 발견형. 이 패턴을 MCP 에도 대칭 적용.
- **응답 대기**: `params` 의 `timeoutMs` 가 envelope 으로 hoist 되어 호출자 대기 상한이 된다. `code=TIMEOUT` 은 회신을 못 받았다는 뜻이지 명령이 실패했다는 뜻이 아니다 — 느린 executor 는 계속 돌아 자기 실행 기록을 따로 남기므로 둘 다 사실이고 code 가 구분자다. 다운로드·활성화를 동반하는 명령(`plugin.install`, 발행 번들의 첫 `plugin.enable`)은 상한을 올리고, TIMEOUT 을 받았으면 아무 일도 없었다고 단정하지 말고 상태를 다시 읽어라(`plugin.list`, `state.tree`).
- **주의 — 소켓 경유 `orchestrator.ask`**: 이 명령은 컨트롤 플레인(main)에만 등록되므로 명시 타겟(`sok --window main orchestrator.ask '{"text":"…","timeoutMs":300000}'`) + 큰 `timeoutMs` 지정 — 턴은 분 단위로 돌 수 있고 소켓 클램프 상한은 1시간(초과 턴은 계속 돌고 호출자만 TIMEOUT).

### MCP (`sok mcp`)
- **사용대상**: 외부 MCP 클라이언트의 에이전트(Claude Desktop 등 stdio MCP 연결).
- **제공기능**: `sok mcp` = stdio JSON-RPC 2.0 MCP 서버. 발견형 메타툴 3개: `soksak.commands`/`soksak.help`/`soksak.run`. 앱 실행 중일 때만 substrate 에 브리지. 셸-리스 클라이언트는 활동 스트림을 `activity.recent {since}` 커서로 읽는다(P11).
- **제공방법**: `sok mcp` 서브프로세스(앱 아님). `initialize`/`tools/list`/`tools/call`. `tools/list` 는 메타툴만, `soksak.run` 이 `request(method,args)` 로 socket 에 전달. tool 스키마는 `soksak.help` 온디맨드. 추가로 `resources/read soksak://skill` 로 라이브 SKILL.md stdio 서빙(P8).
- **무엇**: eager 평탄 노출을 메타툴 3개로 교체 완료. app vs `sok mcp` 경계 문서화.
- **왜**: transport-2 — 외부 에이전트 채널. eager 노출은 P3 위반·컨텍스트 폭증 → 발견형으로 CLI 와 일관.

### Skill (soksak — 환경별 이름)
- **사용대상**: CLI/MCP 채널을 쓰는 코딩 에이전트(claude/gemini/codex). 채널 위에서 사용법을 배움.
- **제공기능**: 주소 모델·검증 워크플로·도메인 지도·발견 명령 안내. 명령 목록이 아니라 '발견하는 법'.
- **제공방법**: `sok skill install` 가 **트리거 스킬**(SKILL.md, frontmatter name+description)을 쓴다 — `--claude`→`.claude/skills/soksak(-dev|-debug)/`, `--codex`/`--gemini`→`.agents/skills/soksak(-dev|-debug)/`(공유). 본문은 `skill_doc()` 가 라이브 도메인 지도를 파생(앱 미가동 시 코어 fallback). description 자동발동.
- **무엇**: 정적 카탈로그 → 발견형 오리엔테이션 교체 완료. 마커-블록 폐기(구식, P5).
- **왜**: teaching — transport 가 아니라 교육 계층. 목록을 복제하면 substrate 와 표류. 트리거 스킬은 task-scoped.

---

## 3.5 호출/트리거 모델 (자연어가 정석, 슬래시는 보조)

트리거는 **description(자연어)** 으로 한다. 슬래시·명시 호출을 필수로 강제하지 않는다.
- **Skill** — `SKILL.md` frontmatter `description` 이 트리거(Claude·Codex·Gemini 동일 — 2026 공식문서 확정). 모델이 작업 매칭 시 자동 발동. 슬래시 `/soksak`(또는 `/soksak-dev`, `/soksak-debug`) 은 보조.
- **MCP** — 메타툴 `description` 이 트리거. 모델이 자연어로 `soksak.commands`→`help`→`run` 호출. 슬래시 0.
- 두 소비 맥락: 셸 있는 에이전트는 Skill→`sok`(Bash), 셸 없는(Claude Desktop)은 MCP 메타툴. 둘 다 자연어. 트리거 품질 = description 품질.

클라이언트 규약(2026 공식문서 확정): 트리거 스킬 = Claude `.claude/skills/<이름>/SKILL.md`(+`~/.claude/skills/`), Codex/Gemini `.agents/skills/<이름>/SKILL.md`(공유; Gemini skills 는 preview v0.23+). MCP 등록 = 네이티브 `claude/codex/gemini mcp add --env SOKSAK_SOCKET=<sock> <name> -- sok mcp`(env 핀 = 환경 묶임 P9 일관).

---

## 4. 인벤토리 — 존재 / 부족했던 것 / 완료

### 존재하는 것 (근거 확인)
- Command Registry 단일 진실: `catalogJson()`(handler 제외 직렬화) = `sok commands`/`help`/`docs`/MCP tool 정의의 단일 원천.
- Unix socket JSON-RPC 서버: `~/.soksak/{id}.sock` 0600 바인드. 봉투 `{id?,method,params?,pane?,window?,timeoutMs?}`.
- 멀티윈도우 라우팅: `window` 를 명시하면 그 창으로 간다. 생략하면 **살아있는 창** 위에서만 사다리를 걷는다 — 포커스 기록은 창을 소유하지 않아 창보다 오래 살아남을 수 있기 때문이다. 플러그인 명령(`plugin.*`)은 플러그인을 싣지 않는 컨트롤 플레인으로 폴백하지 않는다: 마지막 포커스 워크스페이스 창(살아있으면) → 살아있는 워크스페이스 라벨 정렬 첫 항목(결정적) → `NO_WORKSPACE_WINDOW`. 그 밖의 명령: 마지막 포커스 창(살아있으면) → `main`(살아있으면) → 워크스페이스 정렬 첫 항목 → `NO_WINDOW`. 전달은 `emit_to`(타겟 창만), client id echo + 내부 seq u64 매칭.
- danger 게이트(substrate): `ctx.remote && spec.danger` 시 permissionGate, UI 우회. 플러그인 명령도 end-to-end 게이트.
- CLI 완비: `resolve_socket`/`request`/`run_request`/`run_help`/`run_docs`/`run_events`.
- MCP 구현: `sok mcp` = stdio JSON-RPC 2.0, 발견형 메타툴.
- Skill 설치기: AUTO-GENERATED 헤더의 트리거 스킬.
- PTY env 자동 주입: SOKSAK_PANE + SOKSAK_SOCKET(+ SOKSAK_WINDOW).
- 플러그인 명령 기여: `contributes.commands`→`plugin.<id>.<name>` → 같은 registry → CLI/MCP 자동 노출.
- 활동 허브(P11–P12): 링 cap 2000+단조 seq, 전 창 `activity` 브로드캐스트, core/activity 영속(retention), `activity.recent` 커맨드, `events.subscribe` 소켓 push(kinds 필터·since 백필·bounded drop-oldest 구독자), registry execute 계측(파라미터 키만).

### 부족했던 것 → v1.1 해결(전부 구현·테스트·라이브 검증 완료)
- ✅ MCP 발견형(U1), ✅ 트리거 스킬(U2), ✅ app/`sok mcp` 경계(U3), ✅ 플러그인 danger 가시성(U4), ✅ SOKSAK_WINDOW PTY 주입(U5), ✅ 환경 묶임/배신 차단(U8), ✅ MCP 클라이언트 등록(U7), ✅ 정본 규칙(U6 — 이 문서 P1–P13).

### follow-up 완료(v1.1.1)
- ✅ danger 선언 플러그인 매니페스트 반영: kanban·mailbox·lgtv-remote·dom-picker = 9 명령, 런타임 일치(reload 0-rejected).
- ✅ 동의 모달이 `dangerousCommands` 를 ⚠ 섹션으로 렌더(권한 다음 위치). PNG 시각 검증.

> 명령 총수는 고정 단언 금지(즉시 staleness). 실시간 진실은 항상 `sok commands` 다 — P1·P3 의 직접 귀결.

---

Version: 1.2.0
Source: soksak AI 제어 표면 v1 — 실측(8 에이전트 워크플로) + 적대적 검증(2 회의론자) + 클라이언트 규약 조사(Claude/Codex/Gemini 2026 공식문서). P11–P13 은 활동 허브·소켓 스트리밍(오케스트레이션 A1–A2)과 함께 추가.
