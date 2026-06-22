# 뷰 Status 보고 · 닫기 가드 — status 축 capability

## 1. 배경과 문제

탭 닫기 확인을 `file dirty` · `terminal` 로 코어에 하드코딩하면 두 가지를 어긴다.

- 코어 락인 — 코어가 "무엇이 닫기 위험인지" 룰을 소유한다. 범용 capability 원칙 위반.
- 플러그인 무지 — `kind: "plugin"` 뷰의 닫기-위험을 코어가 알 길이 없다. 동기화 중인 ERD 뷰, 업로드 중인 미디어 뷰 등은 영영 보호 못 한다.

soksak 은 코어↔플러그인이 인터페이스를 세 축으로 공유한다. 이 중 **status 축**만 확립이 안 돼 있었다.

| 축 | 노출 | 소비 |
|---|---|---|
| dom | `contributes.nodes` → `data-node` | `ui.tree` / `ui.input.click` |
| command | command registry (register/dispose) | CLI / MCP |
| **status** | **`view.status = { code, message }`** (push 보고 / 신규) | 닫기 가드 · 상태 표시 · **command 회신**(CLI·MCP) |

결정: 뷰가 자기 상태를 `status = { code, message }` 로 코어에 **상시 보고**하고, 코어가 닫기 시 그것을 **조회**하며, 뷰/플러그인 dispose 시 **회수**한다. 닫기 가드는 status 의 한 응용일 뿐이다. (앞서 검토한 `isViewRisky` 하드코딩안은 폐기.)

## 2. 원칙 (규칙 — 이 문서의 단일진실)

- **R1 status 보고**: 모든 뷰는 자기 상태를 `status = { code: string; message?: string }` 로 코어에 상시 보고한다. `code` = 기계 식별자, `message` = 사람 표시. 미보고 = 상태 없음(`undefined`).
- **R2 표준 어휘 + blocking**: 코어가 status `code` 표준 어휘를 소유한다. 그중 **blocking 집합** `STATUS_BLOCKING = { "dirty", "busy", "running" }` 은 닫기 가드를 발동한다. 그 밖의 `code` 는 표시 전용 — 닫기를 막지 않는다.
- **R3 런타임 상태축**: status 는 런타임 상태다(badge 와 동형). manifest 선언이 없고 `declared ≡ actual` conformance 의 대상이 아니다. 선언이 아니라 set/clear 가 진실이다.
- **R4 회수는 코어 책임**: 뷰 unmount · 플러그인 비활성 시 코어가 그 뷰의 status 를 회수한다. status 는 `view` 에 종속하므로 뷰 삭제가 곧 status 삭제 — 별도 트래커 불필요.
- **R5 코어 내장 무특권**: 코어 내장 뷰(`file`/`terminal`/`browser`)도 같은 status 채널을 쓴다. file 의 미저장도 별도 경로가 아니라 `status.code === "dirty"` 다. 특권 경로 금지.
- **R6 판정/오케스트레이션 분리**: 닫기 위험 **판정**은 코어 순수함수(`viewCloseReason`)가 단독 소유한다 — 플러그인·UI 가 못 바꾼다. 닫기 **오케스트레이션**(판정 조회 → 확인창 → 확인 시 `closeView`)은 UI 레이어가 그 순수함수를 써서 수행한다(`closeView` 는 동기 `CmdResult` 라 그 안에서 비동기 모달 대기 불가 — §5). 설정 `tabCloseConfirm: "warn" | "off"`: `off`=blocking 무시 즉시 닫기, `warn`(기본)=blocking 이면 확인창. 설정 평가는 이 오케스트레이션 1곳에서만.
- **R7 뷰 종속(창별 sessions)**: status 는 뷰에 종속해 `sessions` 의 `view` 에 산다. 그런데 `sessions`·`projectId` 는 webview(창)별이다(hooks.ts: "projectId 는 창마다 다를 수 있어… 멀티창 안정 식별자는 root") — 따라서 status 도 그 뷰가 사는 창 기준이며 "창 무관"이 아니다. `status.query` 회신은 호출된 창의 sessions 기준이고, 멀티창에서 같은 프로젝트를 안정 식별해야 하면 `root` 로 스코프한다(`turn.ended` 선례). 읽지않음 알림 badge(`viewRegistry`, per-window 카운트)와는 자리도 의미도 다르다 — 섞지 않는다.
- **R8 보고 + 회신(양방향)**: status 는 **push(보고)** 가 진실원천이고, 코어 표준 command 가 그 캐시를 **pull(회신)** 한다. command 축에 `status.query` 를 등록 → 뷰 status 를 JSON 회신, CLI·MCP 자동 노출(AI/외부가 "지금 상태?"를 질의 가능). 플러그인은 `setStatus` push 만 책임진다 — 회신용 별도 provider 핸들러는 두지 않는다(push 캐시가 단일진실, 중복 금지). 회신이 곧 보고된 최신값이라 두 방향이 항상 일치한다.
- **R9 멀티창 race-free**: status 는 뷰별이고 PTY pane 은 창 바인딩(`pty.rs` `SOKSAK_WINDOW`/`SOKSAK_PANE`, 없으면 `ipc.rs` route 가 활성 창)이라, 같은 프로젝트(root)를 여러 창에 열어도 각 창은 자기 sessions·pane·status 만 본다 — 두 창이 같은 status 를 동시에 쓰는 race 가 구조적으로 없다. `command.started`/`status.query` 도 기존 창 라우팅(`SOKSAK_WINDOW` / `ipc.rs` route)을 그대로 따른다 — 새 라우팅을 발명하지 않는다. 교차창으로 같은 논리 상태를 보여야 하는 플러그인은 status(뷰축)가 아니라 `app.data`(Rust 싱글톤 broadcast — 메모리 교차창 규칙)로 공유하고, 코어 status 는 그 미러를 보고할 뿐이다. **status 를 root 스코프 공유 상태로 승격하는 것을 금지** — 그 순간 race 가 생긴다. 닫기는 멱등(`closeView` = `TARGET_NOT_FOUND` no-op)이라 두 창 동시 닫기도 1회만 효과.

## 3. 인터페이스 (계약)

```
// sessions (모든 뷰 — 코어/플러그인 공통 자리)
interface View { ...; status?: { code: string; message?: string } }
setViewStatus(projectId, viewId, status: { code, message? } | null): CmdResult

// 플러그인 뷰 컨텍스트 (setBadge 바로 옆, sessions 로 위임)
PluginViewContext.setStatus(status: { code, message? } | null): void

// 코어 표준 어휘 + 순수 조회 (닫기 가드의 단일 판정)
const STATUS_BLOCKING = ["dirty", "busy", "running"] as const
viewCloseReason(view): string | null          // status.code ∈ BLOCKING → message ?? 표준문구(code); else null
contentCloseReasons(content): string[]         // 안의 뷰들 viewCloseReason 모음(빈 배열 = 가드 없음)

// 회신 (command 축 — push 캐시를 pull. command registry 등록 → CLI/MCP 자동 노출)
"status.query"(params?: { viewId?: string }): Array<{ viewId, code, message }>
```

`viewCloseReason` · `contentCloseReasons` 는 IO 0 순수함수 — 단위테스트의 1급 대상이다.

## 4. 코어 내장 매핑 (레거시 통합)

- **file**: 미저장 → `setViewStatus({ code: "dirty", message })`. **레거시 `view.dirty` 를 status 로 단일화** — `view.dirty` 는 `status.code === "dirty"` 의 파생으로 흡수한다(탭 dirty 점도 status 파생으로 그린다). `setFileDirty` 는 `setViewStatus` 를 호출하는 얇은 래퍼가 된다. 이중 진실(dirty 플래그 + status) 금지.
- **terminal**: foreground 명령을 status 로 보고. **기존 인프라 재사용** — `shellIntegration.ts`(OSC 133/633 파싱)의 `onCommandStart(commandLine)`/`onCommandFinished()` 와 hooks `command.started`{commandLine}·`command.finished` 이벤트가 이미 있다. `command.started` → `{ code: "running", message: commandLine }`(명령라인 전체, 예 `npm run dev` · `vim foo.txt`), `command.finished` → clear(idle, 즉시 닫힘). 폴링 0(이벤트). 신규 셸 통합 주입·`tcgetpgrp`·`libproc` 전부 불필요 — 구독만. close guard 는 running 일 때만 발동, 같은 데이터를 탭 툴팁·상태바에도 쓴다.
- **browser / plugin**: 각자 보고한 만큼만.

## 5. 닫기 경로 (판정=코어 순수함수, 오케스트레이션=UI)

`closeView`/`closeContent` 는 동기 `CmdResult` store 액션이라 그 안에서 확인창(비동기 사용자 대기)을 띄울 수 없다. 그래서 **판정과 실행을 분리**한다:

- 판정: `viewCloseReason(view)` / `contentCloseReasons(content)` — 코어 순수함수. 위험 여부·이유의 단일 진실.
- 오케스트레이션(닫기 요청 핸들러, UI 레이어 — App 또는 전용 훅): `tabCloseConfirm === "warn"` 이고 판정 결과가 있으면 `ConfirmModal` 표시 → 확인 시 `closeView`/`closeContent` 호출. `off` 거나 위험 없음 → 즉시 호출.
- ContentTabs/ViewTabs 의 x 는 이 닫기 요청 핸들러를 부를 뿐, 위험 판정 로직을 자체로 갖지 않는다(판정은 코어 순수함수 1곳). `closeContent` 는 안의 뷰 중 하나라도 blocking 이면 막는다.

## 6. 확인창

`ConfirmModal.tsx` 신규 — 기존 `dmodal` 패턴 재사용(`useDraggableModal` · Escape · overlay · `dmodal-card`). props: `title` · `reasons: string[]` · `confirmLabel` · `onConfirm` · `onCancel`. 범용 — 닫기 외 다른 확인에도 재사용 가능하게 설계.

## 7. 설정

`settings.ts`: `type TabCloseConfirm = "warn" | "off"`. interface 필드 + `DEFAULTS.tabCloseConfirm = "warn"` + `setTabCloseConfirm` + `save()` 목록 + `SettingsModal` 일반 섹션 `.drow` 한 줄.

## 8. 회수 계약 (R4 구체화)

- 뷰 해제: `closeView` 가 `views[key]` 를 지울 때 그 안 `status` 도 동반 소멸(뷰 종속이라 자동).
- 플러그인 비활성: 그 플러그인 뷰들이 unmount → 각 뷰 삭제 → status 소멸.
- badge(`viewRegistry`)는 별도 store 라 명시 delete 가 필요했지만(viewRegistry.ts:67), status 는 view 에 종속이라 별도 정리 코드가 필요 없다 — 이게 R7(자리 분리)의 이득.

## 9. conformance

status 는 런타임축(R3)이라 manifest 선언/검증 대상이 아니다(badge 선례). 닫기 동작은 코어 경로(§5)라 플러그인이 우회·무력화할 수 없다 — 선언이 아니라 코어 게이트가 강제력의 자리다.

## 10. 단계 (각 완결, RED → GREEN, 꼼수·스텁 금지)

- **M1 — 규칙 + 순수 판정.** `STATUS_BLOCKING` 어휘 + `viewCloseReason` / `contentCloseReasons` 순수함수 + `settings.tabCloseConfirm`. 단위테스트로 RED→GREEN. UI 무변경.
- **M2 — status 채널 + 레거시 통합.** `sessions` `view.status` + `setViewStatus`. file `dirty` 를 status 로 통합 — `view.dirty` 사용처 3곳(`ViewTabs.tsx:159` 탭 점 · `GroupStatusBar.tsx:69` 상태바 · `catalog.ts:263` 회신)을 `status.code==="dirty"` 파생으로 재배선하고 `setFileDirty` 는 `setViewStatus` 래퍼로. 매핑 단위테스트.
- **M3 — 확인창 + 닫기 배선 + 설정 UI.** `ConfirmModal` + `closeView`/`closeContent` 게이트 + `SettingsModal` 항목 + i18n. snapshot 시각검증.
- **M4 — 플러그인 setStatus(보고) + status.query(회신) + E2E.** `PluginViewContext.setStatus` + 코어 표준 command `status.query`(command registry 등록 → CLI/MCP 자동 노출) + 예제 플러그인이 `{code:"busy"}` 보고 + 소켓 하니스 E2E.
- **M5 — terminal status (기존 이벤트 구독).** 후속이 아니다 — 인프라가 이미 있다. hooks `command.started`{projectId, paneId, commandLine}·`command.finished` 를 구독해 해당 pane 의 뷰에 `setViewStatus({ code: "running", message: commandLine })` / clear(idle) 로 매핑한다. `shellIntegration.ts` 의 OSC 633;E·133 파싱이 이 이벤트의 원천 — 신규 셸 통합 주입·`tcgetpgrp`·`libproc` 없음. raw·미통합 셸은 `command.started` 가 안 와 running 미보고 → 즉시 닫힘(가드 없음, 안전). 폴링 fallback 도 두지 않는다(코어 원칙 — 셸 통합이 정공법이고 미통합 셸은 보호 대상에서 빠지는 것을 받아들인다).

## 11. 검증 (기준 — 약화 금지)

- 순수함수 단위: `viewCloseReason`(미보고 / 표시전용 code / blocking code 각각), `contentCloseReasons`(0건·1건·다건 집계), 설정 `off` 일 때 게이트 무시.
- 매핑 단위: `setFileDirty(true/false)` ↔ `status.code==="dirty"` 동기, 탭 점이 status 파생인지.
- 회수: `closeView` 후 해당 status 부재.
- 멀티창 race: 같은 프로젝트(root)를 두 창에 열고 각 창에서 status set·close — 서로 간섭 없음(창별 sessions). `status.query` 는 호출 창(`SOKSAK_WINDOW`/route) 기준으로만 회신. 두 창 동시 close 가 1회만 효과(멱등).
- E2E(소켓): 예제 플러그인 `setStatus({code:"busy"})` → `ctab`/`view` x → 확인창 출현; clear 후 즉시 닫힘. 이어 `status.query` 호출 → 보고한 status 가 그대로 회신되는지(보고 == 회신 일치) 검증.
- 시각: 확인창 snapshot → Read 로 직접 확인(미스타일·색 미분화 점검).

## 12. i18n (src/i18n.ts, ko/en)

`settings.tabCloseConfirm`, `tabCloseConfirm.warn|off`, `confirm.closeTitle`, `confirm.cancel`, `confirm.close`, 표준 문구 `status.dirty|busy|running`.

## 13. 트레이드오프 (숨김 없음)

- terminal status 는 기존 셸 통합(OSC 133/633 이벤트)에 얹는다 — 폴링 0. 셸 통합 스크립트가 안 먹는 raw·미지원 셸은 `command.started` 가 안 와 running 을 모른다 → 그 터미널은 즉시 닫힘(가드 없음). 이걸 폴링으로 메우지 않는다(코어 원칙) — 셸 통합이 정공법이고 미통합 셸이 보호에서 빠지는 것을 받아들인다.
- `command.started` 의 message 는 명령라인 전체(`vim foo.txt`)다 — 프로세스명만이 아니라 더 유용. 다만 파이프라인·서브셸 내부의 세부 foreground 는 셸 통합이 보고하는 범위로 한정된다.
- terminal 닫기 가드는 M5 에서 붙는다(기존 인프라라 후속이 아닌 정규 단계). file·플러그인 뷰는 M2~M4 에서 보호된다.
- status 는 런타임축이라 정적 conformance 로 검증 불가 — 런타임/E2E 만이 증명 표면(badge 와 동일 한계, R3 의 필연적 대가).
- blocking 어휘 3종 고정 — 플러그인이 새 blocking 의미가 필요하면 어휘 확장은 코어 변경을 거친다(의도적 게이트, 무분별 차단 코드 난립 방지).
