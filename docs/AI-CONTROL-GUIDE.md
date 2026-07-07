# soksak AI 제어 — 설치·사용 매뉴얼

코딩 에이전트(Claude·Codex·Gemini)가 soksak 을 제어하는 세 채널의 **설치·사용 how-to**.
설계 근거·규칙은 [`AI-CONTROL.md`](./AI-CONTROL.md)(정본). 이 문서는 절차만 다룬다.

## 한눈에

| 채널 | 대상 | 설치 | 트리거 |
|---|---|---|---|
| **CLI** (`sok`) | 터미널 안 사람·에이전트 | 빌드만(아래) | `sok <cmd>` 직접 |
| **Skill** (soksak(-dev|-debug)) | 셸 있는 에이전트(Claude Code·Codex·Gemini) | `sok skill install` | 자연어(SKILL.md description) |
| **MCP** (`sok mcp`) | 셸 없는 에이전트(Claude Desktop 등) | `<client> mcp add` | 자연어(메타툴 description) |

세 채널 모두 한 substrate(Command Registry + Unix socket)로 수렴 — 명령 목록을 복제하지 않고
`sok commands` 카탈로그에서 파생한다. 앱이 떠 있어야 라이브 명령이 동작한다(미가동 시 코어 fallback).

## 0. 빌드 (CLI)

```
cd src-tauri && cargo build --release -p sok
```

산출물 `src-tauri/target/release/sok`. 이 바이너리가 세 채널의 진입점이다(MCP·Skill 도 이걸 호출).

확인:
```
sok commands                 # 도메인별 명령 카탈로그(단일 진실)
sok help state.tree          # 한 명령의 스키마
sok state.tree               # 라이브 — 현재 창/패널 트리
```

## 1. Skill 주입 (셸 있는 에이전트)

스킬 폴더는 환경별로 분리된다(`soksak`·`soksak-dev`·`soksak-debug`) — 환경마다 소켓·바이너리·플러그인 집합이 달라 내용 자체가 다르다. 저작 본문의 정본은 코어 레포 소스(`src-tauri/cli/skill/` — CLI 에 내장) — 대상 폴더는 순수 산출물로 전체 재생성된다. 플러그인 활성 집합이 변하면 앱이 `sok skill refresh`를 스폰해 자동 재생성한다(설치가 남긴 `skill-refresh.json` 매니페스트 기준).

트리거 스킬 `SKILL.md`(frontmatter `name`+`description`)를 설치한다. 본문은 라이브 도메인 지도 파생 —
편집 금지(재설치 시 덮어씀), 단일 진실은 `sok commands`.

```
sok skill install --claude       # .claude/skills/soksak(-dev|-debug)/SKILL.md
sok skill install --codex        # .agents/skills/soksak(-dev|-debug)/ (codex·gemini 공유)
sok skill install --gemini       # .agents/skills/  (Gemini skills: preview v0.23+)
sok skill install --all          # 셋 다
```

설치 후 에이전트는 "soksak 창 나눠줘" 같은 자연어에 `description` 매칭으로 자동 발동 → `sok` 호출.
슬래시 `/soksak(-dev|-debug)` 은 보조.

## 2. MCP 주입 (셸 없는 에이전트)

`sok mcp` = stdio JSON-RPC 2.0 MCP 서버. 발견형 메타툴 3개만 노출(전 명령 평탄 노출 안 함):
`soksak_commands`(카탈로그) · `soksak_help`(단일 스키마) · `soksak_run`(임의 명령 디스패치) +
resource `soksak://skill`(라이브 SKILL.md). 앱 가동 중일 때만 substrate 에 브리지.

### 등록 (Claude Code)

소켓 경로를 env 로 핀(환경 묶임). 소켓은 `~/.soksak/com.soksak.<env>.sock`:
- 릴리스 앱: `com.soksak.sock`  · dev: `com.soksak.dev.sock`  · debug: `com.soksak.debug.sock`

```
SOK=/ABS/PATH/src-tauri/target/release/sok
SOCK=$HOME/.soksak/com.soksak.dev.sock

claude mcp add --scope user soksak -e SOKSAK_SOCKET="$SOCK" -- "$SOK" mcp
claude mcp get soksak        # Status: ✔ Connected 확인
```

> 주의: `claude mcp add` 는 `<name>` 을 먼저, `-e KEY=value` 를 그 뒤, 커맨드는 `--` 로 분리한다
> (버전에 따라 `-e` 가 variadic 이라 name 을 삼킬 수 있음 — 순서 엄수).

Codex·Gemini 도 동일 패턴: `codex mcp add` / `gemini mcp add` (네이티브 CLI, `--env`/`-e` 는 클라이언트 문법 따름).

### 사용 (에이전트가 자연어로)

1. `soksak_commands` → 무엇이 가능한지(도메인 지도)
2. `soksak_help {command:"panel.split"}` → 그 명령 스키마
3. `soksak_run {command:"panel.split", params:{side:"right"}}` → 실행

`soksak_run` 인자 키는 **`command`** + 선택 `params`(JSON). 잘못된 키(`method` 등)는 `command 필수` 에러.

## 3. 검증 워크플로 (always verify)

1. `sok state.tree` 로 타겟 발견(모든 id + 화면 rect).
2. 명령 실행 → 응답에서 결과 id 확인(예 `panel.split` → `{panelId, viewId, paneId}`).
3. `sok state.tree` / `sok term.read` 로 교차검증.
4. 에러는 구조적: `{ok:false, code:"TARGET_NOT_FOUND|LAST_ITEM|INVALID_PARAMS|TIMEOUT", message}`.

터미널 안에서는 `$SOKSAK_PANE`/`$SOKSAK_WINDOW` 가 자기 위치를 표시 — 타겟 id 를 생략하면 자기 위치가
기본 타겟이다.

### 기본형 문법과 응답 공통 필드

- **기본형**: `sok <명령> 값` — 값 하나는 그 명령의 유일한 필수 매개변수로 전달된다.
  예: `sok plugin.install activity`(레지스트리 단축 이름 — 설치·활성 계열 id 는 단축 이름을 받는다).
  세밀 제어가 필요하면 `'{JSON}'` 을 그대로 쓴다.
- **응답 공통 필드**: 모든 응답에 `window`(실행된 창 라벨)가 실리고, `hint`(이어서 할 수 있는 일
  `{cmd, why}` 최대 3개)가 실릴 수 있다. hint 는 지시가 아니라 가능성의 제시다 — 미지의 명령을
  호출하면 원인별 회복 명령(미설치→설치, 비활성→활성화)을 hint 로 답한다.
- **문서 언어**: `sok docs --lang en|ko`(기본 en).

## 4. danger 게이트

위험 명령(파일 삭제·창 닫기 등)은 `spec.danger` 로 표시되고, **remote(소켓/MCP) 호출만** 동의 게이트를
거친다(UI 직접 조작은 우회). 플러그인 기여 명령도 동일하게 게이트된다 — 동의 모달에 ⚠ 섹션으로 노출.

## 5. 제거

```
sok skill install ...            # 재설치(덮어씀)로 갱신
claude mcp remove soksak -s user # MCP 등록 해제
```
