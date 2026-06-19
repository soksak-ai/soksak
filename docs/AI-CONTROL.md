# soksak AI 제어 표면 — Substrate / Channel / Teaching (v1)

soksak 의 모든 기능을 AI 에게 주는 방식의 정본 규칙. 세 가지(CLI·MCP·Skill)는 형제가 아니다.
**1 substrate + 2 transport + 1 teaching** 의 계층이다. 이 파일이 그 관계와 규칙의 단일 진실이다.
코드 주석·Skill 본문·MCP 설계는 이 파일을 참조한다 — 여기서 어긋나면 코드가 틀린 것이다.

> 설치·사용 how-to 는 [`AI-CONTROL-GUIDE.md`](./AI-CONTROL-GUIDE.md)(매뉴얼). 이 파일은 설계·규칙(왜)만 다룬다.

---

## 1. 멘탈 모델

```
              ┌──────────────────────────────────────────────┐
  TEACHING    │  Skill: soksak-control (SKILL.md / 마커블록)  │
              │  에이전트에게 '채널 사용법·발견하는 법'을 교육 │
              │  (명령 목록 복제 금지 — 발견 명령만 안내)      │
              └───────────────┬──────────────────────────────┘
                              │ teaches how to use ↓
              ┌───────────────┴──────────────────────────────┐
  CHANNELS    │   CLI: sok            │   MCP: sok mcp         │
 (2 transport)│   터미널 내 동기 호출  │   외부 에이전트 stdio  │
              │   commands/help/run   │   (현재 eager →        │
              │   (발견형)            │    발견형 메타툴 전환)  │
              └───────┬───────────────┴───────────┬──────────┘
                      │ JSON-RPC over socket       │ bridge→socket
                      ▼                            ▼
              ┌──────────────────────────────────────────────┐
  SUBSTRATE   │  Socket Server (ipc.rs)                       │
 (단일 진실)   │   ~/.soksak/*.sock · 멀티윈도우 route · seq    │
              │   · danger 게이트(remote만 permissionGate)    │
              │  ────────────────────────────────────────    │
              │  Command Registry (registry.ts)               │
              │   Map<name,CommandSpec> · catalogJson()       │
              │   코어 ~140 + 플러그인 기여 → 한 Map          │
              └──────────────────────────────────────────────┘
                      ▲                            ▲
               코어 register()            플러그인 contributes.commands
```

- **Substrate(기반·단일 진실)** = Command Registry(`src/commands/registry.ts`: `Map<string,CommandSpec>`,
  `catalogJson()`) + Socket Server(`src-tauri/src/ipc.rs`: Unix Domain Socket JSON-RPC, 멀티윈도우 라우팅,
  danger 게이트). 명령의 존재·스키마·권한·실행의 유일한 진실. 코어 register()(~140) + 플러그인
  contributes.commands(설치분에 비례, 현재 207)가 한 Map 으로 수렴한다.
- **Channels(transport·접근 경로)** = CLI(`sok` 바이너리, 터미널 내 동기 호출) + MCP(`sok mcp`,
  외부 에이전트 stdio 브리지). 둘 다 substrate 를 **호출만** 한다. 자기 명령 목록을 갖지 않고 전부
  `catalogJson()`/`state.commands` 에서 파생한다.
- **Teaching(교육·채널 위)** = Skill(soksak-control). 에이전트에게 채널을 **어떻게 쓰는지**를 가르친다.
  명령 목록이 아니라 **발견하는 법**을 가르친다. transport 가 아니다.

셋은 동등 형제가 아니라 substrate 를 정점으로 한 의존 계단이다. 어떤 채널도 substrate 를 우회해
명령을 정의하지 못하고, teaching 은 channel 을 통해서만 명령에 도달한다.

---

## 2. 규칙 (P1–P10)

**메타-원칙 — 규칙은 목적에 복무한다.** 규칙을 지키다 필요한 정보·동작을 잃으면 규칙이 틀린 것이다.
약화가 아니라 정정하라. 단, 정당한 정정만 — 편의를 위한 기준 약화는 배신이다(§ 기준 무너뜨리기 금지).

**P1 — 단일 진실은 Command Registry 다.** `catalogJson()` 가 명령 존재·스키마·권한·실행의 유일한
진실이다. 어떤 채널도 자기 명령 목록을 수기로 관리하지 마라. CLI 도움말·MCP tool·Skill 교육·문서는
전부 이 카탈로그에서 파생하라 — 복제 금지.
근거: `registry.ts:69-103` `catalogJson()` 이 `state.commands` 로 노출되고, `cli/main.rs:152-158`
`fetch_commands()` 가 그걸 호출 → CLI/MCP/docs 전부 파생. 채널이 명령을 별도 나열하는 순간 영구 표류한다.

**P2 — CLI·MCP 는 transport, Skill 은 teaching 이다.** 셋을 동등 형제로 다루지 마라. transport 는
substrate 를 호출만 하고, teaching 은 transport 를 통해서만 명령에 도달한다. Skill 에 명령 목록을 박지
마라 — 발견하는 법만 가르쳐라.

**P3 — 발견(discovery)이 주입(injection)을 이긴다.** 채널은 전 명령을 eager 로 노출하지 마라.
발견형 표면(목록→스키마→실행)을 제공하라. MCP `tools/list` 에 전체 명령을 평탄 노출하지 마라 —
메타툴 3개(`soksak.commands`/`soksak.help`/`soksak.run`)로 고정하라.
근거: CLI 는 이미 발견형(`sok commands`/`help`). MCP 만 eager 평탄 노출(`cli/main.rs:324-340`)이라
채널 비대칭·클라이언트 컨텍스트 폭증. 발견형이면 명령이 347→500 으로 늘어도 tool 수 불변.

**P4 — 권한 게이트는 substrate 에 하나만 둬라.** 채널마다 권한 로직을 재구현하지 마라. remote(CLI/MCP/socket)
호출에만 danger 게이트를 적용하고 UI(사람)는 우회한다. 플러그인 명령도 danger 분류를 substrate 게이트로
흘려라.
근거(실태): 이미 그렇게 작동한다 — `registry.ts:159-165` 가 `ctx.remote && spec.danger` 시 permissionGate
적용, CLI 는 무권한(`cli/main.rs:15-19`). 플러그인 danger 도 `PluginCommandSpec.danger`(`api.ts:107`) →
`api.ts:735` `danger: spec.danger` → registry 게이트로 end-to-end 흐른다(`deps.ts:43`). 남은 일은 게이트
추가가 아니라 **매니페스트/동의 계층에 danger 를 노출**하는 것(§4 참조).

**P5 — 스킬은 오리엔테이션이다. per-command 카탈로그를 박지 마라.** Skill 은 `.claude`/`.codex` 에 상주하는
표준 지식이다 — "`sok commands` 돌려라"만으로는 에이전트가 *모르는 도메인을 발견조차 못 한다*. 그래서 스킬은
**안정적 오리엔테이션**(멘탈 모델·주소 모델·검증 워크플로 + 도메인 지도=목차)을 담는다. **휘발성·대용량·
플러그인 동적인 per-command 카탈로그(이름/params/returns)는 담지 않는다** — 그건 `sok commands`/`help`(목차의
본문)다. 도메인 지도는 손으로 나열(P1 위반)하지 않고 **install 시 라이브 레지스트리에서 파생**, 앱 미가동 시
코어 도메인 fallback. '모든 기능을 문서화했다'고 주장하지 마라 — substrate 가 자라는 순간 거짓이 된다.
근거: SKILL_BODY(`cli/main.rs:372` 'Every feature is exposed' + 12 도메인 하드코딩)가 13 도메인·플러그인
기여 명령을 누락한 채 망라처럼 읽힌다. 정적 카탈로그는 P1 과 모순. 도메인 지도(목차)는 자라도 안 깨진다.

**P6 — app 과 `sok mcp` 의 경계를 흐리지 마라.** app(`ipc.rs`)은 MCP 서버가 아니라 app-internal command
socket 이다. MCP 서버는 `sok mcp` 서브프로세스이며 앱 실행 중일 때만 socket 에 브리지한다.
'app 이 MCP 를 호스팅한다'고 적지 마라.
근거: `lib.rs:115` 주석 'sok CLI/MCP 의 통로'가 app=MCP-gateway 오해를 전파. MCP 구현은
`cli/main.rs:240-366` 에만 존재. app 소켓은 app-specific JSON-RPC 다.

**P7 — 채널은 thin 이어야 한다.** 채널 핸들러에 로직을 두지 마라. CLI `sok`·MCP 메타툴은 `state.commands`
호출과 `request()` 패스스루만 한다. 검증·라우팅·게이트·식별자 매칭은 전부 substrate 가 한다. 채널이
두꺼워지면 채널마다 버그가 갈라진다.
근거: `run_request`/`run_help` 는 fetch+포맷만, `ipc.rs route()` 가 window 라우팅·seq 매칭·timeout 담당.
thin 채널이라야 N 채널이 1 substrate 동작을 동일하게 상속.

**P8 — 교육 문서 전달은 채널로만. 파일시스템을 가로채지 마라.** 라이브 문서가 필요하면 (a) MCP resource
(`sok mcp` 가 stdio 로 서빙: `resources/read soksak://skill`) 또는 (b) write-through 실파일(레지스트리 변경 시
재생성) 둘 중 하나·둘 다로 전달한다. **FUSE/유저스페이스 파일시스템 가로채기는 금지** — macOS kext 마찰·
플랫폼별 드라이버로 멀티플랫폼이 깨지고, "실재 안 하는 경로를 서버가 만든 내용으로 연다"는 가상파일 트릭은
채택하지 않는다. 두 전달 경로 모두 `sok commands`(P1)에서 파생하고 mac/linux/windows 동일하게 동작한다.

**P9 — `sok` 은 한 환경에만 묶인다. 침묵 cross-env 는 배신이다.** 앱 정체성은 3개(`com.soksak.{dev|debug|app}`)
라 소켓이 분리된다(`~/.soksak/com.soksak.<env>.sock`). `sok` 은 정확히 한 환경에 묶이고, 의도하지 않은 다른
환경에 절대 침묵으로 붙지 않는다. 소켓 결정 우선순위: ① `SOKSAK_SOCKET`(앱이 PTY 에 주입, 권위) > ②
`--env`/`SOKSAK_ENV` > ③ argv0 접미사(`sok-dev`→dev, `sok-debug`→debug, `sok`→app, busybox 패턴). env 가
정해졌는데 그 소켓이 없으면 **에러** — 다른 env 소켓으로 대체 금지. "살아있는-1개-잡기" 는 폐기한다.
근거: `cli/main.rs:80-109` `find_socket` 의 단일-소켓 자동선택이 환경 경계를 침묵으로 넘는다.

**P10 — install 은 멱등하고 소유권으로 범위가 정해진다.** 우리 것은 통째로 재생성, 사용자 것은 보존.
- **완전 소유 산출물**(`soksak-control/SKILL.md` — 전용 디렉토리)은 **전체 덮어쓰기**(재생성). 손편집 보존 안 함 —
  "AUTO-GENERATED by `sok skill install`; 편집 무효(원천 = `sok commands`)" 헤더로 손편집을 막는다.
- **공유 파일**(`.mcp.json`/codex `config.toml`/gemini `settings.json` — 사용자의 다른 항목과 한 파일 공유)은
  **우리 항목만 upsert**, 나머지 보존. MCP 등록은 네이티브 CLI(`claude/codex/gemini mcp add`)에 위임 — 각 도구가
  자기 config 포맷·병합·멱등을 소유(P7). 우리가 TOML/JSON 직접 병합하면 사용자 config 손상 위험.

---

## 3. 채널별 리스트업 (사용대상 / 제공기능 / 제공방법 / 무엇 / 왜)

### Substrate (Registry + Socket)
- **사용대상**: 세 채널 전부 + UI(사람) — 모든 호출의 종착지.
- **제공기능**: Command Registry(register/getSpec/catalogJson) + Unix socket JSON-RPC(멀티윈도우 라우팅·
  timeout·client-id/seq 매칭) + danger 게이트(remote 만 permissionGate, UI 우회). 코어 ~140 + 플러그인
  기여가 한 Map.
- **제공방법**: 코어 `register()`(`catalog*.ts`) + 플러그인 `contributes.commands`→`registerCommand`.
  `ipc::start(app)` 가 소켓 바인드. 어떤 채널도 자기 목록을 수기 관리하지 않고 `catalogJson()` 에서 파생.
- **무엇**: `registry.ts`/`ipc.rs` 를 정본 substrate 로 동결. `catalogJson()` 을 유일 명령-목록 원천으로 유지.
- **왜**: 두 transport·한 teaching 이 모두 여기서 파생 → 코드와 어긋날 수 없음. 게이트가 substrate 에 있어야
  채널마다 재구현 안 됨.

### CLI (`sok`)
- **사용대상**: 터미널 안 사람 + 터미널 안 에이전트(claude/codex 가 PTY 안에서 `sok` 실행).
- **제공기능**: 임의 명령 `sok <cmd> '{json}'`, 발견 `sok commands`/`help <cmd>`/`docs`, MCP 브리지
  `sok mcp`, 교육 설치 `sok skill install`. SOKSAK_PANE/WINDOW/SOCKET 자동 인지로 자기 위치 기본 타겟.
- **제공방법**: 워크스페이스 `cli` 크레이트 → `sok` 바이너리. `find_socket`(env→`~/.soksak` 스캔).
  `run_request`/`run_help`/`run_docs` 전부 `fetch_commands()`=`state.commands` 파생.
- **무엇**: 현 구현 유지. help/docs 가 `catalogJson` 파생임을 규칙으로 고정. 정적 명령 목록 하드코딩 금지.
- **왜**: transport-1 — 터미널 내 저지연 동기 호출. 이미 발견형. 이 패턴을 MCP 에도 대칭 적용.

### MCP (`sok mcp`)
- **사용대상**: 외부 MCP 클라이언트의 에이전트(Claude Desktop 등 stdio MCP 연결). 사용자 '모두 필요' 명시.
- **제공기능(목표 구조)**: `sok mcp` = stdio JSON-RPC 2.0 MCP 서버. 발견형 메타툴 3개:
  `soksak.commands`(카탈로그), `soksak.help`(단일 스키마), `soksak.run`(임의 명령 디스패치). app 실행 중일
  때만 substrate 에 브리지.
- **제공방법**: `sok mcp` 서브프로세스(앱 아님). `initialize`/`tools/list`/`tools/call`. `tools/list` 는
  메타툴만, `soksak.run` 이 `request(method,args)` 로 socket 에 전달. tool 스키마는 `soksak.help` 가 온디맨드.
  추가로 `resources/list`+`resources/read soksak://skill` 로 라이브 SKILL.md 를 stdio 서빙(P8 — 파일/FUSE 0).
- **무엇**: 현재 전 명령 eager 평탄 노출(`cli/main.rs:324-340`)을 메타툴 3개로 교체. app vs `sok mcp` 경계 문서화.
- **왜**: transport-2 — 외부 에이전트 채널. 필수. eager 노출은 P3 위반·컨텍스트 폭증 → 발견형으로 CLI 와 일관.

### Skill (soksak-control)
- **사용대상**: CLI/MCP 채널을 쓰는 코딩 에이전트(claude/gemini/codex). 채널 위에서 사용법을 배움.
- **제공기능**: 주소 모델·검증 워크플로·도메인 지도·발견 명령 안내. 명령 목록이 아니라 '발견하는 법'.
- **제공방법**: `sok skill install` 가 **트리거 스킬**(SKILL.md, frontmatter name+description) 을 쓴다 —
  `--claude`→`.claude/skills/soksak-control/`, `--codex`/`--gemini`→`.agents/skills/soksak-control/`(둘 공유).
  본문은 단일 함수 `skill_doc()` 가 라이브 도메인 지도를 파생(앱 미가동 시 코어 fallback). description 자동발동.
- **무엇**: `SKILL_BODY` 정적 카탈로그 → 발견형 오리엔테이션. AGENTS.md/GEMINI.md 마커-블록 폐기(구식, P5).
- **왜**: teaching — transport 가 아니라 교육 계층. 목록을 복제하면 substrate 와 표류. 트리거 스킬은 task-scoped.

---

## 3.5 호출/트리거 모델 (자연어가 정석, 슬래시는 보조)

트리거는 **description(자연어)** 으로 한다. 슬래시·명시 호출을 필수로 강제하지 않는다.
- **Skill** — `SKILL.md` frontmatter `description` 이 트리거(Claude·Codex·Gemini 동일 — 2026 공식문서 확정).
  모델이 작업 매칭 시 자동 발동. 슬래시 `/soksak-control` 은 보조.
- **MCP** — 메타툴 `description` 이 트리거. 모델이 자연어로 `soksak.commands`→`help`→`run` 호출. 슬래시 0.
- 두 소비 맥락: 셸 있는 에이전트(Claude Code/Codex/Gemini 터미널)는 Skill→`sok`(Bash), 셸 없는(Claude
  Desktop)는 MCP 메타툴. 둘 다 자연어. 트리거 품질 = description 품질.

클라이언트 규약(2026 공식문서 확정): 트리거 스킬 = Claude `.claude/skills/<n>/SKILL.md`(+`~/.claude/skills/`),
Codex/Gemini `.agents/skills/<n>/SKILL.md`(공유; Gemini skills 는 preview v0.23+). MCP 등록 = 네이티브
`claude/codex/gemini mcp add --env SOKSAK_SOCKET=<sock> <name> -- sok mcp`(env 핀 = 환경 묶임 P9 일관).

---

## 4. 인벤토리 — 존재 / 부족 / 해야할 것

### 존재하는 것 (근거 확인)
- Command Registry 단일 진실: `registry.ts:69-103` `catalogJson()`(handler 제외 직렬화) = `sok commands`/
  `help`/`docs`/MCP tool 정의의 단일 원천.
- Unix socket JSON-RPC 서버: `ipc.rs:80-96` `~/.soksak/{id}.sock` 0600 바인드, `lib.rs:115-118` `ipc::start`.
  봉투 `{id?,method,params?,pane?,window?,timeoutMs?}`.
- 멀티윈도우 라우팅: `ipc.rs:148-181` `route()` = `window??LAST_FOCUSED??'main'`, `emit_to`(타겟창만,
  브로드캐스트 아님), client id echo + 내부 seq u64 매칭.
- danger 게이트(substrate): `registry.ts:159-165` `ctx.remote && spec.danger` 시 permissionGate, UI 우회.
  **플러그인 명령도 게이트 적용** — `PluginCommandSpec.danger`(`api.ts:107`) → `api.ts:735` → `deps.ts:43`,
  현재 15개 플러그인 명령이 danger 선언(10 destructive + 5 inject).
- CLI 완비: `cli/main.rs:80-238` `find_socket`/`request`(SOKSAK_PANE/WINDOW 주입)/`run_request`/`run_help`/`run_docs`.
- **MCP 이미 구현**: `cli/main.rs:240-366` `sok mcp` = stdio JSON-RPC 2.0(initialize/ping/tools/list/tools/call),
  `tools/list` 가 `fetch_commands()` 에서 동적 생성, `.`↔`_` 치환.
- Skill 설치기: `cli/main.rs:425-529` `--claude`(SKILL.md 직접)/`--gemini`/`--codex`(마커 멱등 upsert).
- PTY env 자동 주입: `pty.rs:160-165` SOKSAK_PANE + SOKSAK_SOCKET.
- 플러그인 명령 기여: `spec.ts:321-324`·`api.ts:720-740` `contributes.commands`→`plugin.<id>.<name>` 평탄,
  미선언 시 throw → 같은 registry 로 흘러 CLI/MCP 자동 노출.

### 부족했던 것 → v1.1 해결(전부 구현·테스트·라이브 검증 완료)
- ✅ **MCP 발견형**(U1): `tools/list` = 메타툴 3개(`soksak_commands`/`soksak_help`/`soksak_run`), eager 평탄
  노출 폐기. `resources/read soksak://skill` 로 라이브 SKILL.md stdio 서빙(P8). `cli/main.rs run_mcp`.
- ✅ **트리거 스킬**(U2): `SKILL_BODY`→`skill_doc()` 오리엔테이션 + 라이브 도메인 지도(fetch_commands 파생,
  앱 미가동 시 코어 fallback). per-command 카탈로그 제거(P5). claude=.claude/skills, codex+gemini=.agents/skills.
  마커-블록 폐기. AUTO-GENERATED 헤더(P10).
- ✅ **app/`sok mcp` 경계**(U3): `lib.rs:115` 주석 정정(P6).
- ✅ **플러그인 danger 가시성**(U4): `ContributedCommand.danger` + parseManifest 검증, api.ts register 가
  매니페스트 danger 권위(모순 시 거부, 미선언+런타임은 게이트 보존 fallback+warn), consentSummary.dangerousCommands
  노출. 게이트 무약화(보안 보존).
- ✅ **SOKSAK_WINDOW PTY 주입**(U5): `pty.rs spawn_terminal` 이 PANE 과 대칭 주입. 터미널 안 sok 가 자기 창 기본 타겟.
- ✅ **환경 묶임/배신 차단**(U8): `resolve_socket` — SOKSAK_SOCKET>--env>argv0, 침묵 cross-env 폐기(P9).
  앱·CLI 짝 빌드(Makefile build→sok/build-debug→sok-debug/dev→sok-dev).
- ✅ **MCP 클라이언트 등록**(U7): `sok mcp install` — 네이티브 `claude/codex/gemini mcp add` 셸아웃, env 핀.
- ✅ **정본 규칙**(U6): 이 문서(P1–P10 + 메타원칙). 코드 주석이 이 문서를 참조.

### follow-up 완료(v1.1.1)
- ✅ danger 선언 플러그인 매니페스트에 danger 추가: kanban(node.remove·reset), mailbox(delete·clear·import),
  lgtv-remote(text-input), dom-picker(selection.set·selection.clear·probe) = 9 명령. 런타임과 일치(reload
  0-rejected = 불일치 시 throw). kanban/mailbox/lgtv-remote 각 repo 로컬 커밋(푸시는 사용자 검증 후),
  dom-picker 는 local(repo 없음, 폴더 반영).
- ✅ 동의 모달이 `dangerousCommands` 를 ⚠ 섹션으로 렌더(권한 다음=가장 결정적 위치). PNG 시각 검증.

> 명령 총수는 고정 단언 금지(즉시 staleness). 코어 ~140(register 호출) + 설치 플러그인 기여(현재 207) ≈ 347.
> 실시간 진실은 항상 `sok commands` 다 — 이것이 P1·P3 의 직접 귀결이다.

---

Version: 1.1.0
Source: soksak AI 제어 표면 v1 — 실측(8 에이전트 워크플로) + 적대적 검증(2 회의론자) + 클라이언트 규약 조사
(Claude/Codex/Gemini 2026 공식문서) 교정 반영. 계획서: `~/.claude/plans/ancient-finding-wand.md`.
