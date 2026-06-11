# soksak 명령 레퍼런스

> 자동 생성 문서 — 원천은 앱 Command Registry(`sok docs` 로 재생성).

모든 명령: `sok <command> ['{JSON}']`. 대상 id 생략 시 호출 컨텍스트($SOKSAK_PANE) 기본.

## `bookmark.add`

즐겨찾기 추가

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `title` | string |  | 표시 이름(생략=호스트) |
| `url` | string | ✓ | URL |

**반환**: {}

```bash
sok bookmark.add '{"url":"https://example.com"}'
```

## `bookmark.list`

즐겨찾기 목록

**반환**: { bookmarks: [{url,title}] }

```bash
sok bookmark.list
```

## `bookmark.remove`

즐겨찾기 제거

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `url` | string | ✓ | URL |

**반환**: {}

```bash
sok bookmark.remove '{"url":"https://example.com"}'
```

## `browser.back`

브라우저 이전 페이지

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `view` | string |  | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { viewId }
**에러**: TARGET_NOT_FOUND

```bash
sok browser.back
```

## `browser.dom.click`

selector 첫 매칭 요소 클릭

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `selector` | string | ✓ | CSS selector |
| `view` | string |  | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { viewId, clicked }
**에러**: TARGET_NOT_FOUND, INTERNAL

```bash
sok browser.dom.click '{"selector":"button[type=submit]"}'
```

## `browser.dom.fill`

입력 요소에 값 채우기(input/change 이벤트 발화 — React 폼 호환)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `selector` | string | ✓ | CSS selector |
| `text` | string | ✓ | 입력할 값 |
| `view` | string |  | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { viewId, filled }
**에러**: TARGET_NOT_FOUND, INTERNAL

```bash
sok browser.dom.fill '{"selector":"input[name=q]","text":"soksak"}'
```

## `browser.dom.html`

페이지(또는 selector 요소)의 HTML

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `maxLength` | number |  | 최대 길이 [기본 50000] |
| `selector` | string |  | CSS selector(생략=문서 전체) |
| `view` | string |  | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { viewId, html|null }
**에러**: TARGET_NOT_FOUND, INTERNAL

```bash
sok browser.dom.html '{"selector":"form"}'
```

## `browser.dom.query`

selector 매칭 요소 요약(태그/텍스트/속성) — 페이지 구조 파악용

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `limit` | number |  | 최대 개수 [기본 20] |
| `selector` | string | ✓ | CSS selector |
| `view` | string |  | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { viewId, count, elements[] }
**에러**: TARGET_NOT_FOUND, INTERNAL

```bash
sok browser.dom.query '{"selector":"a"}'
```

## `browser.dom.submit`

폼 제출(selector=form 또는 폼 내부 요소)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `selector` | string | ✓ | CSS selector |
| `view` | string |  | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { viewId, submitted }
**에러**: TARGET_NOT_FOUND, INTERNAL

```bash
sok browser.dom.submit '{"selector":"form"}'
```

## `browser.dom.text`

페이지(또는 selector 요소)의 보이는 텍스트

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `maxLength` | number |  | 최대 길이 [기본 20000] |
| `selector` | string |  | CSS selector(생략=본문 전체) |
| `view` | string |  | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { viewId, text|null }
**에러**: TARGET_NOT_FOUND, INTERNAL

```bash
sok browser.dom.text
sok browser.dom.text '{"selector":"#main"}'
```

## `browser.dom.waitFor`

selector 가 나타날 때까지 대기(동적 페이지 — MutationObserver)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `selector` | string | ✓ | CSS selector |
| `timeoutMs` | number |  | 최대 대기(ms) [기본 5000] |
| `view` | string |  | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { viewId, found }
**에러**: TARGET_NOT_FOUND, INTERNAL

```bash
sok browser.dom.waitFor '{"selector":".results"}'
```

## `browser.eval`

브라우저 페이지에서 임의 JS 실행(async 가능, return 값이 JSON 으로 반환됨)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `js` | string | ✓ | 실행할 JS 본문(예: return document.title) |
| `view` | string |  | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { viewId, result }
**에러**: TARGET_NOT_FOUND, INTERNAL

```bash
sok browser.eval '{"js":"return document.title"}'
```

## `browser.forward`

브라우저 다음 페이지

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `view` | string |  | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { viewId }
**에러**: TARGET_NOT_FOUND

```bash
sok browser.forward
```

## `browser.navigate`

브라우저 뷰를 URL 로 이동

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `url` | string | ✓ | 이동할 URL |
| `view` | string |  | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { viewId, url }
**에러**: TARGET_NOT_FOUND

```bash
sok browser.navigate '{"url":"https://news.ycombinator.com"}'
```

## `browser.open`

브라우저 열기 — 패널 탭(where=panel) 또는 독립 OS 창(where=window)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `group` | string |  | 대상 패널(그룹) id(생략=호출 컨텍스트의 패널) |
| `url` | string |  | 시작 URL [기본 "https://www.google.com"] |
| `where` | string |  | 여는 위치 (panel|window) [기본 "panel"] |

**반환**: panel: { groupId, viewId } / window: {}
**에러**: TARGET_NOT_FOUND, INTERNAL

```bash
sok browser.open '{"url":"https://example.com"}'
```

## `browser.reload`

브라우저 새로고침

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `view` | string |  | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { viewId, url }
**에러**: TARGET_NOT_FOUND

```bash
sok browser.reload
```

## `content.activate`

컨텐츠 탭 전환

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `content` | string | ✓ | 대상 컨텐츠 id |
| `project` | string |  | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |

**반환**: {}
**에러**: TARGET_NOT_FOUND

```bash
sok content.activate '{"content":"c2"}'
```

## `content.close`

컨텐츠 탭 닫기(마지막 컨텐츠는 거부)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `content` | string | ✓ | 대상 컨텐츠 id |
| `project` | string |  | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |

**반환**: { activeContentId }
**에러**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok content.close '{"content":"c2"}'
```

## `content.create`

새 컨텐츠 탭(프로그램: 명시 > 프로젝트 설정 > 전역 설정)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `program` | string |  | 프로그램 (terminal|claude|codex|browser) |
| `project` | string |  | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |

**반환**: { contentId, groupId, viewId, paneId? }
**에러**: TARGET_NOT_FOUND

```bash
sok content.create '{"program":"browser"}'
```

## `content.list`

프로젝트의 컨텐츠 탭 목록

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `project` | string |  | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |

**반환**: { contents: [{id,title,program,active}] }
**에러**: TARGET_NOT_FOUND

```bash
sok content.list
```

## `content.rename`

컨텐츠 탭 이름 변경

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `content` | string | ✓ | 대상 컨텐츠 id |
| `project` | string |  | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |
| `title` | string | ✓ | 새 이름 |

**반환**: {}
**에러**: TARGET_NOT_FOUND

```bash
sok content.rename '{"content":"c1","title":"빌드"}'
```

## `editor.close`

에디터 뷰 닫기(view.close 와 동일)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `view` | string | ✓ | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { activeGroupId, activeViewId }
**에러**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok editor.close '{"view":"v4"}'
```

## `editor.open`

파일을 에디터 뷰로 열기(이미 열려 있으면 그 탭 활성화)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `path` | string | ✓ | 파일 절대경로 |
| `project` | string |  | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |

**반환**: { viewId, groupId, existing }
**에러**: TARGET_NOT_FOUND

```bash
sok editor.open '{"path":"/Users/me/work/src/main.rs"}'
```

## `editor.save`

에디터 뷰 저장(⌘S 와 동일)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `view` | string | ✓ | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { saved, reason? }
**에러**: TARGET_NOT_FOUND

```bash
sok editor.save '{"view":"v4"}'
```

## `pane.close`

터미널 pane 닫기(마지막 pane 은 거부 — view.close 사용)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `pane` | string | ✓ | 대상 pane id(생략=호출 컨텍스트의 pane, $SOKSAK_PANE) |

**반환**: { focusedPaneId }
**에러**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok pane.close '{"pane":"p3"}'
```

## `pane.focus`

터미널 pane 포커스

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `pane` | string | ✓ | 대상 pane id(생략=호출 컨텍스트의 pane, $SOKSAK_PANE) |

**반환**: {}
**에러**: TARGET_NOT_FOUND

```bash
sok pane.focus '{"pane":"p3"}'
```

## `pane.list`

터미널 뷰의 pane 목록

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `pane` | string |  | 대상 pane id(생략=호출 컨텍스트의 pane, $SOKSAK_PANE) |
| `view` | string |  | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { viewId, panes[], focusedPaneId }
**에러**: TARGET_NOT_FOUND

```bash
sok pane.list
```

## `pane.split`

터미널 pane 분할(row=좌우, col=상하)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `dir` | string | ✓ | 분할 방향 (row|col) |
| `pane` | string |  | 대상 pane id(생략=호출 컨텍스트의 pane, $SOKSAK_PANE) |

**반환**: { paneId(새 pane) }
**에러**: TARGET_NOT_FOUND

```bash
sok pane.split '{"dir":"row"}'
```

## `panel.close`

패널 닫기(안의 모든 탭 제거, 마지막 패널은 거부)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `group` | string | ✓ | 대상 패널(그룹) id(생략=호출 컨텍스트의 패널) |

**반환**: { activeGroupId }
**에러**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok panel.close '{"group":"g2"}'
```

## `panel.focus`

패널 활성화(포커스)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `group` | string | ✓ | 대상 패널(그룹) id(생략=호출 컨텍스트의 패널) |

**반환**: {}
**에러**: TARGET_NOT_FOUND

```bash
sok panel.focus '{"group":"g2"}'
```

## `panel.list`

컨텐츠의 패널(분할창) 목록 + rect(%) + 분할 트리

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `content` | string |  | 대상 컨텐츠 id |
| `project` | string |  | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |

**반환**: { activeGroupId, layout, panels[] }
**에러**: TARGET_NOT_FOUND

```bash
sok panel.list
```

## `panel.merge`

패널 병합 — src 패널의 모든 탭을 dst 패널로(빈 자리는 자동 정리)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `dst` | string | ✓ | 대상 패널 id |
| `project` | string |  | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |
| `src` | string | ✓ | 원본 패널 id |

**반환**: { groupId(병합된 패널) }
**에러**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok panel.merge '{"src":"g2","dst":"g1"}'
```

## `panel.move`

패널 재배치 — src 패널 통째를 dst 패널의 zone 위치로

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `dst` | string | ✓ | 대상 패널 id |
| `project` | string |  | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |
| `src` | string | ✓ | 원본 패널 id |
| `zone` | string | ✓ | 놓을 위치(center=이동/병합, 그 외=그 방향으로 분할) (center|left|right|top|bottom) |

**반환**: { groupId }
**에러**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok panel.move '{"src":"g2","dst":"g1","zone":"left"}'
```

## `panel.resize`

분할 비율 조절 — splitId(state.tree 의 layout.split.id)와 children 수만큼의 비율(합 1)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `project` | string |  | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |
| `sizes` | number[] | ✓ | 자식 비율 배열(합 1, 예: [0.7,0.3]) |
| `split` | string | ✓ | 분할 노드 id(예: s1) |

**반환**: {}
**에러**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok panel.resize '{"split":"s1","sizes":[0.7,0.3]}'
```

## `panel.split`

패널 분할 — 대상 패널 옆에 새 패널(프로그램 지정 가능)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `group` | string |  | 대상 패널(그룹) id(생략=호출 컨텍스트의 패널) |
| `program` | string |  | 프로그램 (terminal|claude|codex|browser) [기본 "terminal"] |
| `project` | string |  | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |
| `side` | string | ✓ | 분할 방향 (left|right|top|bottom) |

**반환**: { groupId(새 패널), viewId, paneId? }
**에러**: TARGET_NOT_FOUND

```bash
sok panel.split '{"side":"right"}'
sok panel.split '{"side":"bottom","program":"browser"}'
```

## `project.activate`

프로젝트 전환

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `project` | string | ✓ | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |

**반환**: {}
**에러**: TARGET_NOT_FOUND

```bash
sok project.activate '{"project":"t2"}'
```

## `project.close`

프로젝트 닫기(마지막 프로젝트는 거부)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `project` | string | ✓ | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |

**반환**: { activeProjectId }
**에러**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok project.close '{"project":"t2"}'
```

## `project.create`

새 프로젝트(루트 폴더 + 첫 화면 프로그램)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `alias` | string |  | 탭 별칭(생략=폴더명) |
| `program` | string |  | 첫 화면(생략=전역 설정) (terminal|claude|codex|browser) |
| `root` | string |  | 프로젝트 루트 디렉토리(절대경로) |

**반환**: { projectId, contentId, groupId, viewId, paneId? }

```bash
sok project.create '{"root":"/Users/me/work","program":"claude"}'
```

## `project.list`

프로젝트 목록(id/제목/root/활성)

**반환**: { projects: [{id,title,root,active}] }

```bash
sok project.list
```

## `project.rename`

프로젝트 이름 변경

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `project` | string | ✓ | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |
| `title` | string | ✓ | 새 이름 |

**반환**: {}
**에러**: TARGET_NOT_FOUND

```bash
sok project.rename '{"project":"t1","title":"백엔드"}'
```

## `project.sidebar.toggle`

파일트리 사이드바 토글

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `project` | string |  | 대상 프로젝트 id(생략=호출 컨텍스트의 프로젝트) |

**반환**: { sidebarOpen }
**에러**: TARGET_NOT_FOUND

```bash
sok project.sidebar.toggle
```

## `settings.get`

앱 설정 전체 조회

**반환**: { language, projectTabPosition, splitHeaderMode, defaultProgram, fontFamily, fontSize, cursorBlink, cursorStyle, scrollback, bg }

```bash
sok settings.get
```

## `settings.set`

설정 변경. key: language|projectTabPosition|splitHeaderMode|defaultProgram|fontFamily|fontSize|cursorBlink|cursorStyle|scrollback

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `key` | string | ✓ | 설정 키 (language|projectTabPosition|splitHeaderMode|defaultProgram|fontFamily|fontSize|cursorBlink|cursorStyle|scrollback) |
| `value` | json | ✓ | 값 — language:ko|en, projectTabPosition:top|left, splitHeaderMode:title|tabs, defaultProgram:terminal|claude|codex|browser, fontFamily:string, fontSize:number, cursorBlink:boolean, cursorStyle:block|bar|underline, scrollback:number |

**반환**: { key, value }
**에러**: INVALID_PARAMS

```bash
sok settings.set '{"key":"fontSize","value":14}'
sok settings.set '{"key":"splitHeaderMode","value":"tabs"}'
```

## `state.commands`

전체 명령 카탈로그(파라미터 스키마·반환·에러·예시) — 매뉴얼의 원천

**반환**: { commands: [{name,description,params,returns,errors,examples}] }

```bash
sok commands
```

## `state.context`

호출자 위치: $SOKSAK_PANE 이 속한 프로젝트/컨텐츠/패널/뷰(터미널 밖이면 활성 체인)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `pane` | string |  | 대상 pane id(생략=호출 컨텍스트의 pane, $SOKSAK_PANE) |

**반환**: { projectId, contentId, groupId, viewId, paneId? }
**에러**: TARGET_NOT_FOUND

```bash
sok state.context
```

## `state.tree`

전체 구조 스냅샷(주소록): 프로젝트→컨텐츠→패널(rect %)→뷰→pane 의 모든 id 와 활성 상태

**반환**: { activeProjectId, projects[] } — panels[].rect 는 컨텐츠 영역 기준 %

```bash
sok state.tree
```

## `term.cwd`

터미널의 현재 작업 디렉토리(셸 통합 기반)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `pane` | string |  | 대상 pane id(생략=호출 컨텍스트의 pane, $SOKSAK_PANE) |

**반환**: { paneId, cwd|null }
**에러**: TARGET_NOT_FOUND

```bash
sok term.cwd
```

## `term.exec`

터미널에서 명령 실행(text + Enter). 결과는 term.read 로 확인

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `cmd` | string | ✓ | 실행할 셸 명령 |
| `pane` | string |  | 대상 pane id(생략=호출 컨텍스트의 pane, $SOKSAK_PANE) |

**반환**: { paneId }
**에러**: TARGET_NOT_FOUND

```bash
sok term.exec '{"cmd":"git status"}'
```

## `term.read`

터미널 화면+스크롤백 텍스트 읽기(TUI 는 현재 화면). 실행 결과 확인용

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `lines` | number |  | 끝에서 N 줄만(생략=전체) |
| `pane` | string |  | 대상 pane id(생략=호출 컨텍스트의 pane, $SOKSAK_PANE) |

**반환**: { paneId, text }
**에러**: TARGET_NOT_FOUND

```bash
sok term.read
sok term.read '{"lines":50}'
```

## `term.send`

터미널에 raw 키 입력 주입(TUI 조작). JSON 이스케이프로 제어키 전달: \r=Enter, \u0003=^C, \u001b[A=↑

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `pane` | string |  | 대상 pane id(생략=호출 컨텍스트의 pane, $SOKSAK_PANE) |
| `text` | string | ✓ | 주입할 바이트(이스케이프 허용) |

**반환**: { paneId }
**에러**: TARGET_NOT_FOUND

```bash
sok term.send '{"text":"ls\r"}'
sok term.send '{"text":"\u0003"}'
```

## `theme.set`

배경색 변경(터미널/에디터/UI 전체가 따름. 글자색은 밝기로 자동)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `bg` | string | ✓ | 배경색(#rrggbb) |

**반환**: { bg }
**에러**: INVALID_PARAMS

```bash
sok theme.set '{"bg":"#1e2030"}'
```

## `view.activate`

뷰(탭) 활성화

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `view` | string | ✓ | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: {}
**에러**: TARGET_NOT_FOUND

```bash
sok view.activate '{"view":"v3"}'
```

## `view.close`

뷰(탭) 닫기 — 패널의 마지막 뷰면 패널도 정리(컨텐츠 마지막 뷰는 거부)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `view` | string | ✓ | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |

**반환**: { activeGroupId, activeViewId }
**에러**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok view.close '{"view":"v3"}'
```

## `view.list`

패널의 뷰(탭) 목록

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `group` | string |  | 대상 패널(그룹) id(생략=호출 컨텍스트의 패널) |

**반환**: { groupId, activeViewId, views[] }
**에러**: TARGET_NOT_FOUND

```bash
sok view.list
```

## `view.move`

뷰(탭)를 dst 패널의 zone 위치로(center=이동, 그 외=분할해 새 패널)

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `dst` | string | ✓ | 대상 패널 id |
| `view` | string | ✓ | 대상 뷰 id(생략=호출 컨텍스트의 뷰) |
| `zone` | string | ✓ | 놓을 위치(center=이동/병합, 그 외=그 방향으로 분할) (center|left|right|top|bottom) |

**반환**: { groupId(이동/생성된 패널) }
**에러**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok view.move '{"view":"v3","dst":"g1","zone":"right"}'
```

## `view.open`

패널에 새 뷰 탭(터미널/claude/codex/브라우저[url])

| 파라미터 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `group` | string |  | 대상 패널(그룹) id(생략=호출 컨텍스트의 패널) |
| `program` | string | ✓ | 프로그램 (terminal|claude|codex|browser) |
| `url` | string |  | 브라우저 시작 URL(program=browser) |

**반환**: { groupId, viewId, paneId? }
**에러**: TARGET_NOT_FOUND

```bash
sok view.open '{"program":"claude"}'
sok view.open '{"program":"browser","url":"https://example.com"}'
```

