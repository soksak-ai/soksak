---
kind: translation
status: active
canonical: ./NAMING.md
---

# 이름

여기의 모든 규칙에는 검사가 있습니다. 검사 이름은 규칙과 함께 적습니다.

## N1. 식별자 형식

형식: `<세 글자>-<base32 여섯 자>`. 예: `pan-7k2qx3`.

접두사는 정확히 세 글자입니다. 한두 글자로는 이 제품의 종류들이 구분되지 않습니다. `s-` 는 space,
split, session 에 모두 맞고, `v-` 는 view 와 value 에, `w-` 는 window, webview, workspace 에
맞습니다.

본문은 RFC 4648 소문자 base32(`a-z`, `2-7`) 여섯 자입니다. 숫자 `0` 과 `1` 은 그 알파벳에 없으므로
`o`·`l` 과 혼동되지 않습니다. 여섯 자는 약 10⁹ 개의 값입니다. 충돌은 후보와 함께 `AMBIGUOUS` 로
해결합니다.

식별자는 카운터가 아닙니다. 카운터는 창마다, 실행마다 1 에서 다시 시작하므로 같은 값이 두 곳에서
서로 다른 것을 이름 짓습니다.

| 종류 | 접두사 | 발급자 |
| --- | --- | --- |
| workspace | `wsp-` | `frontend/src/state/ids.ts` |
| space | `spc-` | 같음 |
| pane | `pan-` | 같음 |
| tab | `tab-` | 같음 |
| split node | `spl-` | 같음 |
| shell session | `shl-` | 같음 |
| window | `win-` | `frameworks/wails/window_id.go`(본문), `frameworks/wails/window_rules.go`(접두사) |

split node 가 표에 있는 이유는 그 식별자가 저장되며 `canonicalLayout` 의 일부로 `state.tree` 에
나타나기 때문입니다.

창 이름은 호스트가 발급하며, 다른 종류는 발급하지 않습니다. 창은 그 안의 문서보다 오래 유지되므로
어떤 문서도 창 이름을 만들 수 없습니다. 그 이름은 스냅샷 저장소에서 `window/<name>` 의 키이므로
양쪽에서 wire 사실입니다.

`ids.ts` 밖에서 발급한다고 해서 다르게 표기해도 되는 것은 아닙니다. 2026-08-16 실측: `newWindowID` 가
16진수 열여섯 자를 만들어, 이 제품에는 식별자 형식이 둘이었고 이 표가 잘못 기술한 종류는 창
하나였습니다. 그날부터 base32 여섯 자를 만듭니다. `frontend/src/state/ids.ts` 의 `WINDOW_ID_RE` 는
`^win-[0-9a-f]{16}$` 이며 그 파일 밖의 어떤 소스도 그것을 읽지 않습니다(2026-08-16 실측). 이 형식과
맞추거나 제거합니다.

검사: `frontend/src/state/ids.test.ts`(형식, 종류마다 접두사 하나),
`frontend/src/state/idScope.test.ts`(접두사 표, 세 글자 접두사),
`frameworks/wails/window_rules_test.go`(창 접두사), `frameworks/wails/window_id_test.go`(창 본문:
여섯 자, 그 알파벳 밖의 문자 없음, 4096회 추출에서 중복 없음).

## N1a. 명령 이름

형태: `<group>_<subject>_<verb>`, 소문자와 밑줄. group 이 곧 subject 이면 subject 는 생략합니다:
`daemon_start`, `data_delete`, `clipboard_read`, `app_shutdown_commit`.

동사는 이미 쓰이는 집합에서 가져옵니다: `list`, `get`, `set`, `read`, `write`, `delete`, `remove`,
`create`, `close`, `start`, `stop`, `status`, `send`, `spawn`, `scan`, `verify`, `sync`. 같은 동작에
두 번째 낱말을 쓰면 어휘가 갈라집니다 — `create` 옆의 `new` 가 2026-08-15 에 측정한 사례입니다.

명령은 자기 자원과 동작을 이름 짓습니다. 공개 명령은 `plugin.install.local` 같은 점 표기를 쓰고,
백엔드 명령은 `artifact_install_begin` 같은 snake case 를 씁니다. 자원이 Plugin 이나 Sidecar 일 때는
일반 자원 이름을 쓰지 않습니다. local 과 registry 는 릴리즈 전송과 설치 선택을 이름 지을 뿐, 두 번째
구현 계약이 아닙니다.

## N2. 자연 키

접두사 있는 식별자는 레이아웃 개체와 shell 세션에만 적용합니다. 다음 축은 자기 키를 유지합니다:
`schedule`, `secret`, `daemon`, `settings`, `theme`, `registry`, `process`, `sidecar`, `webview`,
`data.kv`, `data.encrypt`, `ui.projection`, `ai.session`. 이들의 키는 사용자가 정한 이름 또는
`(ns, key)` 쌍이며, 그것으로 이미 항목이 식별됩니다.

검사: `idScope.test.ts` 가 `ids.ts` 에서 두 표를 읽습니다. 한 축이 양쪽에 나타나면 실패하고, 접두사
있는 식별자가 발급자 밖에서 발급되면 실패합니다.

### N2a. 식별자는 유지하고, 조회는 자연 키를 쓴다

규칙 둘이며 어느 하나가 다른 하나를 대신하지 않습니다.

**식별자는 유지합니다.** 유일하도록 발급하며 재시작을 넘어 살아남습니다. 상태가 거기에 매달리기
때문입니다. 터미널 세션의 키는 `windowLabel + "|" + paneId` 이므로, 새 id 를 받아 돌아온 pane 은 쓰던
shell 에 다시 붙을 수 없습니다(`docs/tech/RESTORE.md` R3). 유지가 유일성과 상충하지 않습니다.
카운터가 충돌하는 이유는 다시 시작하기 때문이지 유지되기 때문이 아니며, `t1` 이 서로 다른 창 스냅샷
셋의 workspace id 였던 이유도 그것입니다. `crypto.getRandomValues` 에서 나온 N1 본문은 유지되는 한
유일합니다.

**조회는 자연 키를 씁니다.** 무엇인지로 찾는 일은 id 를 지나지 않습니다. 창 원장은 `roots[]` 와
`activeRoot` 를 저장하고, P5 는 `t.root === opts.root` 로 중복 workspace 를 거부하며, P6 은
`claimRoots(workspaces.map(t => t.root))` 로 전역 단일 열기를 확보하고, `state.fingerprint` 는 이름이
아니라 root 를 해시합니다. 프로젝트 열기가 멱등한 이유가 그것입니다 — 같은 root 를 두 번 요청하면
그것을 이미 보유한 workspace 를 반환합니다.

즉 id 는 주소이고, 자연 키는 식별입니다. id 만 쓰는 제품은 "이 프로젝트가 이미 열려 있는가" 에 답을
낼 수 없고, 자연 키만 쓰는 제품은 세션이 매달릴 대상이 없습니다.

예외 없이 모든 종류에 적용합니다: workspace, space, pane, tab, split node 모두. 예외가 있으면 리더는
이름이 그대로 남는지 판단하기 전에 자기가 어떤 종류를 들고 있는지 먼저 알아야 하고, split node 의
예외는 — 직렬화조차 되지 않았으므로 — 그 비용에 대해 아무것도 얻지 못했습니다.

검사: `frontend/src/state/restoreKeepsIds.test.ts`, `restore_gate_test.go`(실제 바이너리로, 실제 종료와
재시작을 넘어 같은 것을 검사).

## N3. 복합 식별자

복합 식별자는 이미 발급된 식별자들로 만든 값 하나입니다. 이 제품에는 하나 있습니다. 네이티브 표면
label 이며, 창 하나, view 하나에 대한 종류 하나의 표면 하나를 이름 짓습니다.

문법: `<kind>.<window>.<view>`. 필드 셋, 구분자 하나, 그 순서.

### 구분자는 `.` 이며 어떤 필드도 그것을 담지 않는다

N1 본문은 `a-z2-7`, N1 접두사는 세 글자입니다. 창 이름 본문은 `a-zA-Z0-9`, `-`, `_` 를
받습니다(`validWindowName`, `frameworks/wails/window_rules.go`). kind 는 소문자, 숫자, `-` 입니다.
따라서 `-` 는 세 필드 안에 모두 나타나므로 구분자가 될 수 없습니다. `/` 는 저장소 키
`window/<name>` 와 위상 경로의 구분자이며, 그것을 담은 label 은 주소 세그먼트를 하나 더합니다.

남은 것 중 `.` 이 공개 노드 주소가 유지하는 문자입니다.
`contentViewNodePath`(`frontend/src/lib/compositionParticipants.ts`)는 `[a-z0-9.-]` 밖의 모든 문자를
`-` 로 접으므로 `:`, `~`, `@`, `|` 는 모두 주소에서 `-` 가 되어 모호함을 원장이 구분하던 지점으로
되돌립니다.

주소는 복합 식별자가 아닙니다. `window/<name>/view/<id>/content/<label>` 은 경로이고, 구분자는 `/`
이며, 각 세그먼트는 그것을 만드는 한 곳에서 퍼센트 인코딩합니다(`contentCompositionTopologyPath`).
세그먼트를 인코딩하는 것과 어떤 필드도 담지 않는 구분자를 고르는 것은 같은 실패에 대한 두 답이며,
단일 필드로 이동하는 값은 두 번째를 씁니다.

### 순서는 kind, window, view

넓은 범위가 먼저입니다. view id 는 창 하나 안에서 유일하고, 창 이름이 값을 애플리케이션 전체에서
유일하게 만들며, kind 는 그 위에서 플러그인들을 나눕니다. 이 순서면 앞의 두 필드 비교로 창 하나의
kind 하나짜리 표면들을 선택하고(`surfaceLabelPrefixIn`), 정렬된 목록도 같은 방식으로 묶입니다.

### 리더는 분리하며, 훑지 않는다

구분자로 정확히 세 필드로 나눈 뒤 인덱스로 접근합니다. 개수가 셋이 아니면 이 문법의 label 이 아니며,
리더는 어느 필드가 무엇인지 고르는 대신 아무것도 반환하지 않습니다.

훑기가 이 규칙이 존재하는 이유인 실패입니다. `indexOf("-" + window + "-")` 는 창 이름이 나타나는
아무 위치에나 일치하므로, 창 이름과 같은 문자열로 끝나는 kind 는 잘못된 필드에서 가져온 view id 를 만듭니다.
AGENTS 3-4 — 찾아야만 하는 구조는 실패입니다.

2026-08-16 실행 중인 애플리케이션에서 실측, 이전: `surface.composition` 이
`browser-win-8ed56cd7d9305935-tab-2trqyu` 를 반환했습니다. 세 필드를 `-` 로 이었고 각 필드가 그것을
담았으므로, `viewIdFromSurfaceLabel` 은 `indexOf("-" + windowLabel + "-")` 로 view 를 찾았고
`orphanSurfaceLabels` 는 `includes("-" + name + "-")` 로 창을 맞췄습니다. 둘 다 값을 분해하지
않았습니다.

이후, 같은 창에서 같은 명령: `browser.win-8ed56cd7d9305935.tab-2trqyu`, 그리고 두 리더 모두 구분자로
나눈 뒤 인덱스로 접근합니다.

### 문법이 정의된 곳, 그리고 첫 필드가 무엇인지

`frontend/src/lib/surfaceLabels.ts`, 2026-08-16 부터입니다. 그날까지는
`frontend/src/lib/webviewLabels.ts` 가 그것을 담았고, 지금은 하나만 담습니다 — 이 문서가 속한 창의
이름. 다른 곳에서 다시 만들면 창 필드가 빠지고, 창 둘이 값 하나를 만들며, 두 번째 창이 첫 번째 창의
표면을 주소로 잡습니다.

첫 필드는 `brw-` 가 아닙니다. 표면을 선언한 플러그인의 낱말입니다 — `soksak-plugin-browser-wails3`
에서 온 `browser` 이며, 선언이 `data-native-surface` 에 넣는 낱말과 같습니다(2026-08-16 실측). 코어는
kind 를 기록하지 않습니다. `brw-` 는 플러그인 하나의 표면에 대한 코어 자신의 이름이었으므로, 그
플러그인을 교체하려면 코어를 고쳐야 했고, 두 번째 종류의 표면은 label 을 얻을 곳이 없었습니다. N1 의
세 글자 접두사는 두 번째·세 번째 필드를 만드는 식별자에 적용되며, kind 에는 적용되지 않습니다.

검사:

- `history_gate_test.go` — `TestTheCoreWritesDownNoSurfaceKind` 는 폐기된 kind `brw` 가 `core/`,
  `frameworks/`, `frontend/src` 아래에 있으면 빌드를 실패시킵니다. 그 낱말 하나를 거부하며,
  `browser` 나 `video` 를 기록하는 코어는 통과합니다(2026-08-16 실측).
- `frontend/src/lib/surfaceLabels.test.ts` — 형태, 그리고 이 코어가 이름 짓지 않는 kind 도 view 로
  되읽히는지.
- `frontend/src/lib/webviewLabels.test.ts` — 폐기된 한두 글자 접두사(`b-`, `w-`, `pv-`, `cv-`)가
  fixture 를 포함한 `src` 아래 어디에도 없는지.
- `frontend/src/lib/surfaceLabelGrammar.test.ts` — 구분자, 필드 알파벳, 리더가 훑지 않고 나누는지,
  그리고 label 이 소유자 밖에서는 조립되지 않는지. 단일 출처 규칙은 `webviewLabels.ts` 를 예외로 둔
  `` `brw-${` `` 검색으로 검사했는데, 2026-08-16 에 kind 와 소유 파일이 둘 다 바뀌면서 아무것도
  일치하지 않게 됐고, 규칙 뒤에 아무것도 없는 상태가 됐습니다.

구분자를 판정하는 검사는 없습니다. 2026-08-16 실측: 이 저장소의 어떤 것도 구분자를 담은 필드를
거부하지 않으며, 훑는 리더도 거부하지 않습니다. 그 검사는 `frontend/src/lib/surfaceLabels.test.ts` 에
들어가며 세 가지를 거부합니다.

1. 자기 알파벳 밖의 필드 — `.` 를 담은 kind, 또는 소문자·숫자·`-` 가 아닌 것. 조립기는 아무것도
   분해할 수 없는 값을 반환하는 대신 throw 합니다.
2. 정확히 세 필드로 나뉘지 않는 값. 리더는 필드 넷에 대해서도 둘에 대해서와 같이 null 을 반환합니다.
3. label 에 대한 `indexOf`, `includes`, `search`, `match` — `frontend/src/lib/surfaceLabels.ts` 의
   소스에서 읽습니다. 어떤 훑기도 강제하지 않는 훑기 금지 규칙은 산문입니다.

## N4. Fixture

테스트 fixture 는 제품이 발급하는 형식을 씁니다. `t1` 로 쓴 fixture 는 제품이 만들지 않는 형태를
실행하므로, 접두사를 읽는 코드는 한 번도 실행되지 않습니다.

검사: `frontend/src/state/idLiterals.test.ts` 가 테스트 파일에서 카운터 모양 문자열을 담은 식별자
필드(`id`, `activeId`, `paneId`, `tabId`, `viewId` 등)를 훑습니다.

## N5. 공개 어휘

DOM 선언, 주소, 명령 예시는 코어의 것입니다. 코어는 자기가 어느 호스트에서 실행되는지 기록하지
않으므로 이 이름들에는 프레임워크 이름이 없습니다: `data-<vendor>-native-surface` 가 아니라
`data-native-surface`. 주소는 그것을 만드는 쪽이 발급하며, 코어는 거기서 vendor 세그먼트를 파싱하지
않습니다.

검사: `frontend/src/framework/seamSweep.ts` 와 그 테스트가 vendor 선언 목록을 담습니다. 이런 선언은
조용히 새어 나갑니다 — vendor 가 읽지 않는 속성은 무시되고 아무것도 throw 하지 않습니다.

## N6. 폴더 이름

프레임워크와 무관한 코드는 프레임워크 이름 아래에 놓지 않습니다. 프레임워크는 형제입니다: `core/` 와
`frameworks/wails/`. `frameworks/wails/` 아래의 패키지는 Wails 를 참조할 수 있습니다. 그 위의 패키지는
참조할 수 없습니다.
