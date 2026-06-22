# 워크스페이스 영속·복원 + folderpop + 우측 사이드바 밀기 — 설계 플랜

> 브랜치: `feat/workspace-restore`. 전수조사(워크플로 6감사, file:line 근거)에서 출발.

## 0. 컨텍스트

localStorage 6개 스토어(settings/theme/pluginSettings/bookmarks/plugins/패널너비)는 이미 영속한다.
하지만 **live workspace 트리 — 프로젝트·콘텐츠탭·split 레이아웃·view 파라미터·터미널 launch 명령·active 선택·탭 rename — 은 영속이 0**이다(메모리에만, `sessions.ts`). 재시작하면 `bootstrapFirstProject`(main.tsx:60, sessions.ts:828)가 빈 기본 프로젝트 하나로 매번 새로 시작한다. 이 플랜은 그 공백을 메우고, 멀티창 일관성을 app.data broadcast로 잡고, folderpop 플러그인과 우측 사이드바 밀기 모드를 추가한다.

## 1. 잠긴 결정 (사용자 확정)

- **저장소** = `app.data`(rusqlite) kv(ns=`core`). 공유 민감 스토어(settings/theme/pluginSettings/plugins consents·enabledIds)도 함께 이전 + 1회 마이그레이션 shim(`migrated` 플래그).
- **복원 범위** = 앱 재시작(quit→relaunch)까지 정확 복원.
- **키잉** = 레이아웃은 **프로젝트별 저장 + `(windowId, root)` 복합 키**(window-id 처음부터 필수 — 미래 멀티창 대비). window-manifest = `slot → {windowId, label, roots[], activeRoot}` 별도 영속. **현재 프로젝트 유니크 enforce**(1프로젝트=1창, 이미 열린 프로젝트 열면 그 창 포커스). 이 유니크 강제는 **단일 토글 가드** — 끄면 같은 root가 여러 windowId 아래 각자 레이아웃 → 멀티창, **스키마·마이그레이션 0**.
- **터미널** = cwd+shell 복원, 마지막 명령은 프롬프트에 paste(개행 없이, 실행 X). live PTY 프로세스·scrollback 복원 불가(본질적).
- **split 크기** = 전부 저장. GroupNode `sizes[]`는 이미 있음. **터미널 내부 PaneNode는 비율 필드 부재(50/50 고정) → 신규 `ratio` 필드.**
- **folderpop id** = `soksak-plugin-folderpop`.
- **사이드바 merge** = 콘텐츠 영역에서 쓰는 동일 drag-merge 머신을 좌측 사이드바로 일반화(완전 동일 동작, 별도 stack 아님).
- **우측 사이드바** = overlay ↔ push(영역차지) 토글. 설정 버튼 위 "밀기" 버튼. push 시 좌측 사이드바처럼 영역 차지.

## 1.5 횡단 규칙 — 3축(dom/command/status) 노출 [HARD]

모든 마일스톤의 모든 기능은 세 축으로 노출·관찰 가능해야 한다(soksak 표준). 마일스톤 완료 기준에 포함:

- **dom**: 사용자 조작 요소는 `data-node`(또는 contributes.nodes) → `ui.tree`/`ui.input.click`/`ui.input.fill`로 E2E 구동.
- **command**: 기능은 command registry에 등록 → CLI/MCP 자동 노출. raw invoke 금지(코어 기능=command registry 원칙). 읽기(query)도 command로.
- **status**: 닫기 가능한 뷰/작업이면 `view.status{code,message}` 보고. UI 환경설정 등 blocking 상태가 없는 기능은 N/A로 명시(고려는 필수).

각 마일스톤 proof는 가능한 한 이 축들로 자가검증(RED→GREEN). 예: C1=`sidebar.right.mode push` 커맨드 + `plugin-sidebar-push` dom 클릭 → 스냅샷.

## 2. 직렬화 스키마 (복원 단위)

```
# window-manifest (재시작 복원의 골격) — core kv: "windows"
{ slots: [ { slot, windowId, label, roots: [root...], activeRoot } ] }

# project-layout (프로젝트별 저장, window-id 필수 복합 키) — core kv: "layout/{windowId}/{root}"
{
  alias, shell?, color?,                          // root = 창무관 안정 식별자(hooks.ts)
  sidebarOpen, rightOpen, rightView, rightMode, leftTab,
  activeContentId,
  contents: [{
    title, activeGroupId, maximizedViewId?,
    layout: GroupNode                             // {split: dir, sizes[], children[]} | {leaf: group}
      leaf.group: { activeViewId, views: [View by kind] }
        terminal: { paneTree: PaneNode(+ratio), focusedPaneId, autorun?{paneIndex, command} }
        file:     { path, mode }
        browser:  { url }
        plugin:   { pluginId, view, title }
  }]
}
```

유니크 강제(현재): 한 root는 manifest의 한 slot.roots[]에만. 끄면 같은 root가 여러 (windowId,root) 레이아웃 → 멀티창(마이그레이션 0).

생략: 모든 numeric id(nextProjectId/View/Pane/Group/Split/Content = module 카운터, boot마다 재생성), live status, live pty/webview 세션.

## 3. 복원 가능 / 불가능 (확정)

| 항목 | 복원 | 근거 |
|---|---|---|
| split 구조 + GroupNode sizes[] 비율 | O plain JSON | sessions.ts:113-121 |
| 터미널 PaneNode 비율 | O (A3 신설 후) | PaneNode ratio 부재 |
| 탭/콘텐츠/view 트리 + active 체인 | O | sessions.ts:185~73 |
| 터미널 launch 명령(autorun) | O view 필드 | sessions.ts:73-76 |
| 터미널 cwd | O (project root / OSC 7·633;P) | shellIntegration.ts:95-118 |
| file path / browser url | O | sessions.ts:78-103 |
| live PTY 프로세스·진행중 program | X 매 spawn 새 child·종료시 kill_all | pty.rs:113-244 |
| scrollback/화면 버퍼 | X xterm.js에만, 디스크 미기록 | createTerminal.ts:467-479 |
| browser webview 세션 연속성 | X url 재항해만 | webviewLabels.ts:26-35 |

터미널 정확 복원의 천장 = "같은 레이아웃 + 같은 cwd + 마지막 명령 프롬프트 paste". 엔터는 사용자가 누른다.

## 4. 트랙 A — 영속·복원 인프라 (코어)

- **A1 app.data 저장 레이어** — ns=`core` kv 래퍼(JSON blob). localStorage 공유 스토어(settings/theme/pluginSettings/plugins) 이전 + 1회 shim(`core/migrated` 플래그). data-change broadcast로 멀티창 일관성. async hydrate-after-mount.
  - **설정 논리 그룹 분리 저장(forward-compat)**: `core/settings`를 platform / terminal(=`TerminalSettings`+shell, 이미 그룹화됨) / browser(homeUrl,browserNewWindow) 하위 그룹으로. terminal/browser는 아직 코어라 코어에 두되, 플러그인 추출 시 그 그룹째 plugin ns(app.data)로 이동 → 필드별 마이그레이션 0. **진짜 플랫폼 설정**(언어/탭위치/splitHeader/danger/아이콘/포커스/기본루트/탭닫기/우측모드)만 영구 core.
  - 진짜 플러그인 소유 설정은 `usePluginSettings`(이미 per-plugin·byProject)에 — 코어 settings에 안 둔다(코어 락인 금지).
  - proof: 두 창에서 한쪽 설정 변경 → 다른 창 polling 0 반영. shim 멱등(2회=동일). terminal 그룹이 단독 추출 가능한 형태로 분리 저장됨을 단언.
- **A2 워크스페이스 직렬화** — `serializeLayout(sessions) ↔ deserializeLayout(json)` 순수 함수. id 재생성. 라운드트립 단위 테스트.
  - proof: 임의 레이아웃(중첩 split·다종 view) serialize→deserialize 후 구조·순서·sizes·active 동일.
- **A3 PaneNode ratio 필드** — 터미널 pane split에 `ratio`(부모 자식 평행, 합=1). resize 시 갱신. 미지정 시 균등 폴백.
  - proof: 비대칭 분할 직렬화→복원 시 비율 유지.
- **A4 window-manifest + 프로젝트 유니크 가드** — manifest(`slot→{windowId,label,roots[],activeRoot}`) + 레이아웃(`layout/{windowId}/{root}`)을 app.data(ns=core)에 저장. 창 생성/종료/레이아웃 변경 시 갱신. label 재시작 불안정 → slot 재바인딩. 프로젝트 열기 시 cross-window 유니크 가드(이미 열린 root면 그 창 포커스) — **단일 토글**(off=멀티창).
  - proof: 다른 프로젝트 2창 → manifest 2슬롯 → 재시작 후 2창 재생성, clobber 0. 이미 열린 프로젝트 재열기 → 새 창 X, 기존 창 포커스. 가드 off 시 멀티창 허용(스키마 불변).
- **A5 boot 복원** — `bootstrapFirstProject` → manifest 슬롯별 창 재생성 + `layout/{windowId}/{root}` 로드(없으면 기본 1프로젝트). hydrate-after-mount.
  - proof: 레이아웃 만들고 재시작 → 동일 트리 복원. manifest 없으면 기본 시작.
- **A6 터미널 복원** — pane+cwd 복원 + autorun.command 프롬프트 paste(개행 X). 스냅샷 시 cwd 캡처(OSC 7/633;P).
  - proof: claude 터미널 → 재시작 → 같은 cwd 셸 + `claude` 프롬프트에 대기(미실행), 엔터로 기동.

## 5. 트랙 B — folderpop + generic 사이드바

- **B1 generic 사이드바 탭 rename** — 좌탭 라벨은 현재 manifest `view.decl.title` 단일진실(LeftSidebarHost.tsx:62), 오버라이드 채널 없음. view가 자기 탭 라벨을 set하는 generic host capability 신설(`app.ui.setViewTabLabel` 류) + 값은 view 소유 app.data. 더블클릭 인라인 편집. **folderpop 특례 금지 — 모든 사이드바 view 공용.**
  - proof: 임의 사이드바 플러그인이 탭명 변경 → 영속 → 재로드 유지.
- **B2 generic 사이드바 drag-merge** — merge 머신(drop zone, moveViewToGroup/moveGroupToGroup, GroupNode 트리)은 현재 콘텐츠 영역에만(GroupArea.tsx:204-352). 좌측 사이드바를 동일 머신으로 일반화: 사이드바 view 1개=직접, 2+=탭, 드래그로 콘텐츠와 동일하게 merge/split/reorder. `leftTab: string` 단일값 → 사이드바도 GroupNode 모델로 승격.
  - proof: 사이드바 탭 2개 드래그 merge/split이 콘텐츠 영역과 동일 동작. 레이아웃 영속에 편입.
- **B3 soksak-plugin-folderpop** — 신규 플러그인 repo. sidebar-left 뷰 + 멀티폴더 설정(각 rename, default=폴더명) + `app.fs.list`/`watch` 트리 + 탭명 "폴더팝"(B1로 rename). permissions=['ui','fs:read','data','commands']. 상태=플러그인 ns app.data(scope=projectId), data-change 자동 일관. file-tree가 작동 모델.
  - proof: 폴더 여러 개 등록·rename·선택 → 사이드바 트리 표시, CLI 커맨드 노출, 재시작 유지.

## 6. 트랙 C — 우측 사이드바 밀기

- **C1 overlay↔push 토글** — 우측 사이드바(현재 overlay)에 push(영역차지) 모드 추가. 설정 버튼 위 "밀기" 토글 버튼. push 시 좌측 사이드바처럼 flex 영역 차지(콘텐츠 폭 축소), overlay 시 기존 동작. `rightMode: "overlay"|"push"` 상태(영속 — 우선 settings, A1 후 app.data). 브라우저 hole-punch는 모드별로 rect 반영.
  - proof: 밀기 토글 → 우측 사이드바가 콘텐츠를 밀어냄(스냅샷). 다시 토글 → overlay. 모드 재시작 유지.

## 7. 마일스톤 순서 (병행)

- 독립·즉시: **C1**(우측 밀기) — 가시적, self-contained.
- 인프라 기반: **A3 → A2 → A1 → A4 → A5 → A6** (직렬화·저장이 복원의 토대).
- 사이드바: **B1 → B2 → B3** (rename·merge 일반화가 folderpop 토대).
- A·B·C는 파일 겹침 최소(C=App.tsx/CSS, A=sessions/state/app.data, B=viewRegistry/LeftSidebarHost/sessions). sessions.ts는 A·B 공유 → 순차.

## 8. 이연 / 열린 항목

- ScheduleState 영속(cron/scheduled 명령, 현재 in-memory) — 별도 결정.
- bookmarks collection 승격(향후 search/dedup) — 후순위, 당분간 kv blob.
- 패널 너비(sidebarW/railW/rightW) — localStorage 유지(drag마다 쓰기·per-window·복원가치 낮음).
- 사이드바 GroupNode 승격(B2)이 R12 파킹/hole-punch 규칙과 충돌 없는지 — B2에서 검증.

---
표준: TDD(RED→GREEN), 각 마일스톤 완결. SIDEBAR.md S1("host=frame만") 충돌하는 신규 표면(B1/B2)은 generic 설계 — 특례 금지.
